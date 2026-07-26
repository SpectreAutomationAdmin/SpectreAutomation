// Sprint 3 Checkpoint 15I-3 (2026-07-27) — Source-contract locks for
// the corrective checkpoint:
//   • The COA import modal must build its submitted FormData from the
//     React file state, NOT from `new FormData(form)`, so files added
//     via drag-and-drop are actually included.
//   • The AR-aging loader must NOT hardcode a Silver Springs email
//     as a fallback (that misrepresents the tenant on non-SS clubs).
//   • The AP card intelligence projection must carry a
//     CHART_OF_ACCOUNTS_REQUIRED runtime state, override the workflow
//     when the tenant has zero Account rows, and NOT invent a GL
//     category in that state.
//   • The card must map the new state to a pill label + primary
//     action label so the founder sees truthful language.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MODAL     = read("src/components/data-workspace/ChartOfAccountsImportModal.tsx");
const IMPORT_ACT = read("src/app/app/admin/coa/_import-actions.ts");
const AR_LOADER = read("src/lib/mission-control/index.ts");
const PROJECTOR = read("src/lib/mission-control/intelligence-review-intakes.ts");
const CARD      = read("src/components/mission-control/EmailIntakeCard.tsx");

function read(p: string) {
  return readFileSync(join(process.cwd(), p), "utf8");
}

describe("COA upload — file bytes reach the server for both drop and click paths", () => {
  it("modal builds FormData from React state (fd.append('file', file, file.name)), not from `new FormData(form)`", () => {
    // The drop path never populates <input>.files, so `new FormData(form)`
    // would submit an empty file. Reading from React state closes both
    // paths deterministically.
    expect(MODAL).toMatch(/const fd = new FormData\(\);/);
    expect(MODAL).toMatch(/fd\.append\("file", file, file\.name\)/);
    // The old, defective path is gone.
    expect(MODAL).not.toMatch(/const fd = new FormData\(form\)/);
  });
  it("modal's handleSubmit no longer needs the form element parameter", () => {
    // Corollary of the fix — handleSubmit derives everything from
    // React state, so the form ref isn't threaded.
    expect(MODAL).toMatch(/const handleSubmit = \(\) => \{/);
    expect(MODAL).toMatch(/onSubmit=\{\(e\) => \{\s*e\.preventDefault\(\);\s*handleSubmit\(\);\s*\}\}/);
  });
  it("<input type='file' name='file'> is still present in the modal (click-picker path unaffected)", () => {
    // The click-picker path still relies on the native file input
    // populating input.files via user interaction. Keep it in the
    // form's tree (unchanged from pre-15I-3) so browsers accept the
    // native picker click via `fileInputRef.current?.click()`.
    expect(MODAL).toMatch(/type="file"[\s\S]{0,60}name="file"/);
    expect(MODAL).toMatch(/fileInputRef\.current\?\.click\(\)/);
  });
  it("server action tolerates common Windows CSV MIME types by relying on extension + magic bytes, not MIME", () => {
    // The action uses looksLikeXlsx + isLikelyTextual — extension +
    // ZIP magic bytes + text sniff. Never grabs Content-Type from
    // the multipart headers.
    expect(IMPORT_ACT).toMatch(/looksLikeXlsx\(file\.name, buf\)/);
    expect(IMPORT_ACT).toMatch(/isLikelyTextual\(buf\)/);
    expect(IMPORT_ACT).not.toMatch(/file\.type ===|file\.type\.includes/);
  });
});

describe("Tenant identity — no hardcoded Silver Springs assumption in production paths", () => {
  it("AR-aging loader's fallback `from` is tenant-agnostic (not ar@silversprings.club)", () => {
    // The old fallback `"ar@silversprings.club"` rendered on tenants
    // that are not Silver Springs. Replaced with a role label.
    expect(AR_LOADER).not.toMatch(/"ar@silversprings\.club"/);
    expect(AR_LOADER).toMatch(/acc\.member\?\.email \?\? "Accounts receivable"/);
  });
  it("branding.getActiveBranding continues to derive displayName from Club.wordmark ?? Club.name (tenant-driven)", () => {
    const branding = read("src/lib/branding/index.ts");
    expect(branding).toMatch(/const displayName = club\.wordmark \?\? club\.name/);
  });
});

describe("AP no-COA truthful state — CHART_OF_ACCOUNTS_REQUIRED", () => {
  it("workflowState union carries the runtime CHART_OF_ACCOUNTS_REQUIRED value", () => {
    expect(PROJECTOR).toMatch(/"CHART_OF_ACCOUNTS_REQUIRED"/);
    // Guard: it's part of the union, not a separate persisted enum.
    const iface = PROJECTOR.slice(PROJECTOR.indexOf("workflowState:"));
    expect(iface).toMatch(/"CHART_OF_ACCOUNTS_REQUIRED"/);
  });
  it("summariseApIntake counts the tenant's accounts + overrides workflow state to CHART_OF_ACCOUNTS_REQUIRED when zero", () => {
    expect(PROJECTOR).toMatch(/const accountCount = await prisma\.account\.count\(\{ where: \{ clubId \} \}\)/);
    expect(PROJECTOR).toMatch(/const noCoa = accountCount === 0/);
    expect(PROJECTOR).toMatch(/const workflowState = noCoa[\s\S]{0,120}"CHART_OF_ACCOUNTS_REQUIRED"[\s\S]{0,120}deriveApWorkflowState\(analysis\)/);
  });
  it("summariseApIntake blanks the category label + GL fields when noCoa (never invents a GL)", () => {
    expect(PROJECTOR).toMatch(/label: noCoa \? null : categoryLabel/);
    expect(PROJECTOR).toMatch(/glAccountNumber: noCoa \? null : \(gl\?\.accountNumber \?\? null\)/);
    expect(PROJECTOR).toMatch(/glAccountName: noCoa \? null : \(gl\?\.accountName \?\? null\)/);
  });
  it("workflowReason renders truthful no-COA language, not a generic em dash", () => {
    expect(PROJECTOR).toMatch(/"GL coding unavailable — no chart of accounts is loaded/);
  });
  it("card pill + primary-action switch on the new state", () => {
    expect(CARD).toMatch(/"CHART_OF_ACCOUNTS_REQUIRED":[\s\S]{0,80}"Chart of accounts required"/);
    expect(CARD).toMatch(/"CHART_OF_ACCOUNTS_REQUIRED":[\s\S]{0,80}"Import chart of accounts"/);
  });
});

describe("Tenant identity is derived, not hardcoded", () => {
  it("MC page falls back to Club.name via user.club.name, never to a hardcoded string", () => {
    const page = read("src/app/app/admin/page.tsx");
    // The clubName resolution reads Club.name via user.club and a
    // Prisma lookup; no string literal for the tenant.
    expect(page).toMatch(/user\.club\?\.name/);
    expect(page).not.toMatch(/["']Silver Springs["']/);
    expect(page).not.toMatch(/["']Spectre Automation - Staging Platform["']/);
    expect(page).not.toMatch(/["']Coulee Ridge["']/);
  });
});
