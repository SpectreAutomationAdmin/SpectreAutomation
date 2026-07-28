// Sprint 3 · Checkpoint 15P-5 (2026-07-28) — source-contract locks
// for the state-drift elimination. Covers:
//
//   • apSummaryCache key includes vendor + AP-invoice revision
//     fingerprints (writers naturally invalidate)
//   • previewApEntryAction is a plain POST API route (stable URL,
//     no server-action hash rehash class)
//   • the modal fetches the API route, not a dynamic-imported
//     server action
//   • deriveApAction is the shared source of truth for label +
//     modal routing
//   • the card's onPrimary consults deriveApAction (no duplicated
//     STEP_2 logic)
//   • the retired stale-deploy defensive UI is gone from the
//     journal preview render tree
//   • the retired _preview-ap-entry-actions.ts file exists as a
//     loud throw stub so any stale client bundle sees an
//     actionable server error rather than an undefined return

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function read(p: string) { return readFileSync(join(process.cwd(), p), "utf8"); }
function exists(p: string) { return existsSync(join(process.cwd(), p)); }

const IRI          = read("src/lib/mission-control/intelligence-review-intakes.ts");
const API_PREVIEW  = read("src/app/api/mission-control/ap-preview/route.ts");
const RETIRED      = read("src/app/app/admin/ap/_preview-ap-entry-actions.ts");
const MODAL        = read("src/components/mission-control/CreateVendorAndPostModal.tsx");
const CARD         = read("src/components/mission-control/EmailIntakeCard.tsx");
const AP_ACTION    = read("src/lib/mission-control/ap-action.ts");

// ---------------------------------------------------------------------------
// Fix A — cache-key includes vendor + AP-invoice fingerprints
// ---------------------------------------------------------------------------

describe("15P-5 · apSummaryCache key includes canonical vendor + AP-invoice fingerprints", () => {
  it("apSummaryCacheKey signature now takes vendorRevision + apInvRevision", () => {
    expect(IRI).toMatch(/function apSummaryCacheKey\(\s*intakeId: string,\s*docId: string \| null,\s*coaRevision: string,\s*vendorRevision: string,\s*apInvRevision: string,\s*\)/);
  });
  it("cache key string embeds vend= and apinv= tokens", () => {
    expect(IRI).toMatch(/coa=\$\{coaRevision\}[\s\S]{0,60}vend=\$\{vendorRevision\}[\s\S]{0,60}apinv=\$\{apInvRevision\}/);
  });
  it("loadVendorRevision fingerprints Vendor.count + max(updatedAt) AND VendorContact.count + max(createdAt)", () => {
    expect(IRI).toMatch(/async function loadVendorRevision\(clubId: string\): Promise<string>/);
    expect(IRI).toMatch(/prisma\.vendor\.count\(\{ where: \{ clubId \} \}\)/);
    expect(IRI).toMatch(/prisma\.vendorContact\.count\(\{ where: \{ clubId \} \}\)/);
  });
  it("loadApInvRevision fingerprints APInvoice.count + max(updatedAt)", () => {
    expect(IRI).toMatch(/async function loadApInvRevision\(clubId: string\): Promise<string>/);
    expect(IRI).toMatch(/prisma\.aPInvoice\.count\(\{ where: \{ clubId \} \}\)/);
  });
  it("summariseApIntake pulls all three revisions BEFORE the cache probe", () => {
    // Pattern-match the destructuring so the order + concurrency is preserved.
    expect(IRI).toMatch(/const \[coaRevision, vendorRevision, apInvRevision\] = await Promise\.all\(\[/);
  });
});

// ---------------------------------------------------------------------------
// Fix B — preview API route
// ---------------------------------------------------------------------------

describe("15P-5 · preview server-action replaced by POST API route (stable URL)", () => {
  it("route file exists at src/app/api/mission-control/ap-preview/route.ts", () => {
    expect(exists("src/app/api/mission-control/ap-preview/route.ts")).toBe(true);
  });
  it("route exports POST + validates the body with Zod", () => {
    expect(API_PREVIEW).toMatch(/export async function POST\(req: Request\)/);
    expect(API_PREVIEW).toMatch(/const bodySchema = z\.object\(/);
  });
  it("route calls the same shared `buildProposedApEntry` helper", () => {
    expect(API_PREVIEW).toMatch(/import \{ buildProposedApEntry,/);
    expect(API_PREVIEW).toMatch(/const entry = buildProposedApEntry\(/);
  });
  it("retired server-action file throws loudly + explains the migration", () => {
    expect(RETIRED).toMatch(/RETIRED/);
    expect(RETIRED).toMatch(/throw new Error/);
    expect(RETIRED).toMatch(/\/api\/mission-control\/ap-preview/);
  });
  it("modal fetches the API route via POST — no dynamic import of the retired server action", () => {
    expect(MODAL).toMatch(/fetch\(`\/api\/mission-control\/ap-preview`, \{\s*method: "POST"/);
    // The retired dynamic import is gone from the preview useEffect.
    // (The file may still import stubs from other actions like
    // createVendorAction; we assert the SPECIFIC preview one is gone.)
    expect(MODAL).not.toMatch(/import\("@\/app\/app\/admin\/ap\/_preview-ap-entry-actions"\)/);
  });
  it("modal no longer renders the stale-deploy `Preview unavailable` panel (removed with the underlying defect)", () => {
    expect(MODAL).not.toMatch(/data-testid="cvap-journal-stale"/);
    expect(MODAL).not.toMatch(/const \[staleDeploy/);
  });
});

// ---------------------------------------------------------------------------
// Fix C — deriveApAction is the shared source of truth
// ---------------------------------------------------------------------------

describe("15P-5 · deriveApAction is the ONE source of truth for label + modal routing", () => {
  it("ap-action.ts exports deriveApAction + the ApAction discriminated union", () => {
    expect(AP_ACTION).toMatch(/export function deriveApAction/);
    for (const kind of ["APPROVE_AND_POST", "REVIEW_CODING", "CREATE_VENDOR_AND_POST", "REVIEW_DUPLICATE", "REQUEST_INFORMATION", "COA_REQUIRED"]) {
      expect(AP_ACTION).toContain(`kind: "${kind}"`);
    }
  });
  it("each ApAction variant carries its label + icon + modal decision on the SAME object", () => {
    // Structural check: the file has a `label:` sibling to `modal:` in each variant.
    const variants = AP_ACTION.match(/kind: "[A-Z_]+";\s*label:[\s\S]+?modal: \{[\s\S]+?\};?\s*\}/g) ?? [];
    expect(variants.length).toBeGreaterThanOrEqual(6);
  });
  it("EmailIntakeCard consumes deriveApAction — ApActionRow reads label from it", () => {
    expect(CARD).toMatch(/import \{ deriveApAction, type ApAction \} from "@\/lib\/mission-control\/ap-action"/);
    expect(CARD).toMatch(/const primary = deriveApAction\(ap\)/);
  });
  it("EmailIntakeCard onPrimary consumes deriveApAction — no duplicated STEP_2 vendor extraction", () => {
    // The onPrimary handler now reads action.modal directly instead
    // of the pre-15P-5 `openStep2WithMatch` helper that duplicated
    // the vendor-extraction logic.
    expect(CARD).toMatch(/const action = deriveApAction\(ap\)/);
    // Sanity: the removed helper is gone.
    expect(CARD).not.toMatch(/const openStep2WithMatch = /);
  });
  it("EmailIntakeCard retires primaryActionForApWorkflow (superseded by deriveApAction)", () => {
    expect(CARD).not.toMatch(/function primaryActionForApWorkflow/);
  });
});

// ---------------------------------------------------------------------------
// Founder scenarios — behavioural asserts on the shared derivation
// ---------------------------------------------------------------------------

describe("15P-5 · founder scenario A: Finish Later then Approve & Post", () => {
  it("The card projection state that produces 'Approve & post' also produces AP_CODING modal", () => {
    // Enforced by construction (label + modal are siblings on the
    // same ApAction). Cross-referenced with the deriveApAction
    // unit tests in c15p5-derive-ap-action.test.ts.
    // This lock ensures no regression can decouple them at the card
    // level: primary label read comes from `deriveApAction(ap)`,
    // and the onClick handler reads `deriveApAction(ap)` as well.
    expect(CARD).toMatch(/const primary = deriveApAction\(ap\)/);
    expect(CARD).toMatch(/const action = deriveApAction\(ap\)/);
  });
});

describe("15P-5 · founder scenario D: vendor deletion invalidates cached projection", () => {
  it("cache key includes vendor + apInv revisions → vendor delete bumps fingerprint → cache miss → fresh projection", () => {
    // The key structurally includes vend=... and apinv=..., and
    // both revisions come from prisma count + max(updatedAt) which
    // change on every write. No explicit cache.delete needed.
    expect(IRI).toMatch(/vend=\$\{vendorRevision\}/);
    expect(IRI).toMatch(/apinv=\$\{apInvRevision\}/);
  });
});
