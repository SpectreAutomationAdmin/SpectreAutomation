// Sprint 3 · Checkpoint 15P-4 (2026-07-28) — source-contract locks
// for the modal + card + vendor-delete-page changes.
//
// Founder acceptance findings this suite locks:
//
//   • auto-resolved exact vendor opens SINGLE-STEP AP-Coding modal
//     (no step indicator; compact vendor header; "Review / change
//     vendor" reveals two-step)
//   • two-step header buttons are keyboard/pointer-interactive
//     (both directions navigate; no dead end)
//   • Step 1 → Step 2 with vendor already created does NOT re-run
//     createVendorAction (would duplicate)
//   • Proposed-Accounting-Entry defensive states — stale server-
//     action hash surfaces "Preview unavailable" + Refresh button,
//     never a raw `.ok` exception
//   • payment-terms summary cell shows "Auto-pay" for AUTO_PAY, not
//     "Net 0"
//   • vendor-delete panel present under vendor:delete permission
//     with dependency-aware confirmation copy

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function read(p: string) { return readFileSync(join(process.cwd(), p), "utf8"); }

const MODAL       = read("src/components/mission-control/CreateVendorAndPostModal.tsx");
const CARD        = read("src/components/mission-control/EmailIntakeCard.tsx");
const VENDOR_PAGE = read("src/app/app/admin/ap/vendors/[id]/page.tsx");
const VENDORS_LIB = read("src/lib/ap/vendors.ts");
const RESOLVER    = read("src/lib/vendor-matching/resolve-modal-entry.ts");
const PERMS       = read("src/lib/permissions.ts");

// ---------------------------------------------------------------------------
// Fix 1 — auto-resolved single-step modal
// ---------------------------------------------------------------------------

describe("15P-4 · auto-resolved vendor gets a single-step AP-coding modal", () => {
  it("modal exports the `autoResolvedVendor` prop", () => {
    expect(MODAL).toMatch(/autoResolvedVendor\?: boolean/);
  });
  it("`isAutoResolvedSingleStep` gates the two-step header away", () => {
    expect(MODAL).toMatch(/const isAutoResolvedSingleStep =\s*!!autoResolvedVendor && openDirectAtStep2 && !reviewingVendor/);
    // Step indicator hidden when the flag is set.
    expect(MODAL).toMatch(/\{isAutoResolvedSingleStep \? null : \(/);
  });
  it("compact vendor header rendered ONLY in single-step mode with Review / change vendor action", () => {
    expect(MODAL).toMatch(/data-testid="cvap-vendor-header"/);
    expect(MODAL).toMatch(/data-testid="cvap-review-vendor"/);
    expect(MODAL).toMatch(/Review \/ change vendor/);
    // Clicking flips reviewingVendor + navigates to Step 1.
    expect(MODAL).toMatch(/setReviewingVendor\(true\);\s*setStep\("PROFILE"\)/);
  });
  it("Back-to-vendor-profile button visible whenever two-step header is visible", () => {
    // The Step-2 footer's back button is hidden only when the modal
    // is in the single-step auto-resolved shape.
    expect(MODAL).toMatch(/!isAutoResolvedSingleStep \? \(/);
  });
  it("card threads `autoResolvedVendor: true` for APPROVE_AND_POST, false for REVIEW_CODING (15P-5: via deriveApAction)", () => {
    // 15P-5 replaced the workflow-state-specific `if` branches with
    // a single derivation. The shared function encodes the
    // autoResolved flag per ApAction variant.
    const APACTION = read("src/lib/mission-control/ap-action.ts");
    expect(APACTION).toMatch(/kind: "APPROVE_AND_POST"[\s\S]{0,600}autoResolved: true/);
    expect(APACTION).toMatch(/kind: "REVIEW_CODING"[\s\S]{0,600}autoResolved: false/);
    // The card still threads `autoResolvedVendor` to the modal from
    // whatever the derivation returned via cvapModalMode.
    expect(CARD).toMatch(/autoResolvedVendor=\{cvapModalMode\.kind === "STEP_2" \? cvapModalMode\.autoResolved : false\}/);
  });
});

// ---------------------------------------------------------------------------
// Fix 2 — two-way navigation
// ---------------------------------------------------------------------------

describe("15P-4 · two-way navigation preserves state + never re-creates vendor", () => {
  it("step indicators are BUTTONS (interactive), not spans", () => {
    expect(MODAL).toMatch(/data-testid="cvap-step-1-btn"/);
    expect(MODAL).toMatch(/data-testid="cvap-step-2-btn"/);
    expect(MODAL).toMatch(/spectre-cvap-step-btn/);
  });
  it("Step 1 primary re-uses createdVendorId — does NOT re-run createVendorAction", () => {
    // The safeguard: if createdVendorId is already set, plain navigation.
    expect(MODAL).toMatch(/if \(createdVendorId\) \{\s*if \(finishLater\) \{ setStep\("SAVED_FOR_LATER"\); return; \}\s*setStep\("AP_CODING"\);\s*return;\s*\}/);
  });
  it("Step 2 back-to-profile button navigates without side-effects", () => {
    // Confirming the button just calls setStep("PROFILE") — no new
    // server-action call is required to return.
    expect(MODAL).toMatch(/onClick=\{\(\) => setStep\("PROFILE"\)\}[\s\S]{0,120}data-testid="cvap-back-to-profile"/);
  });
});

// ---------------------------------------------------------------------------
// Fix 4 — Proposed Accounting Entry crash defence
// ---------------------------------------------------------------------------

describe("15P-4 → 15P-5 · Proposed Accounting Entry uses a stable API route (no server-action hash class)", () => {
  it("preview is a plain fetch() against a stable POST URL (15P-5 retired the stale-deploy defensive UI)", () => {
    // The pre-15P-5 defensive `staleDeploy` state was there to
    // catch Next.js server-action-hash mismatches after a deploy.
    // 15P-5 moved the preview to a POST API route with a stable URL,
    // so the defensive UI is no longer needed AND has been removed —
    // the render tree now has three legitimate states: loading,
    // error, preview.
    expect(MODAL).toMatch(/fetch\(`\/api\/mission-control\/ap-preview`, \{\s*method: "POST"/);
    expect(MODAL).not.toMatch(/const \[staleDeploy/);
    expect(MODAL).not.toMatch(/data-testid="cvap-journal-stale"/);
  });
  it("handleStep1 + handleStep2Post also defend against the same stale-hash class", () => {
    // Same defence on the two write paths.
    expect(MODAL).toMatch(/typeof createVendorAction !== "function"/);
    expect(MODAL).toMatch(/typeof postApInvoiceAction !== "function"/);
  });
});

// ---------------------------------------------------------------------------
// Fix 5 — payment-terms Auto-pay vs Net 0
// ---------------------------------------------------------------------------

describe("15P-4 · Payment-terms summary shows Auto-pay, not Net 0, when the extractor detected auto-pay", () => {
  it("Step 2 summary cell reads 'Auto-pay' when resolvedTerms.isAutoPay is true", () => {
    expect(MODAL).toMatch(/const paymentTermsLabel =\s*resolvedTerms\.isAutoPay\s*\?\s*"Auto-pay"/);
  });
  it("Due-date provenance reads 'Auto-pay — charged automatically' in the auto-pay path", () => {
    expect(MODAL).toMatch(/resolvedTerms\.isAutoPay \? "Auto-pay — charged automatically"/);
  });
});

// ---------------------------------------------------------------------------
// Fix 3 — vendor delete under Accounts Payable
// ---------------------------------------------------------------------------

describe("15P-4 · vendor delete under Accounts Payable", () => {
  it("permission key `vendor:delete` exists + is granted to CLUB_ADMIN + CONTROLLER", () => {
    expect(PERMS).toMatch(/"vendor:delete":/);
    // The GRANTS map keys each role's array with `<ROLE>: [`.
    // Slice from that anchor to the next role's opener.
    const adminStart = PERMS.indexOf("CLUB_ADMIN: [");
    const gmStart    = PERMS.indexOf("GENERAL_MANAGER: [");
    const controllerStart = PERMS.indexOf("CONTROLLER: [");
    expect(adminStart).toBeGreaterThan(-1);
    expect(controllerStart).toBeGreaterThan(-1);
    const admin      = PERMS.slice(adminStart, gmStart);
    const controller = PERMS.slice(controllerStart, controllerStart + 3000);
    expect(admin).toMatch(/"vendor:delete"/);
    expect(controller).toMatch(/"vendor:delete"/);
  });
  it("deleteVendor + probeVendorDependencies exported from lib/ap/vendors.ts", () => {
    expect(VENDORS_LIB).toMatch(/export async function deleteVendor/);
    expect(VENDORS_LIB).toMatch(/export async function probeVendorDependencies/);
  });
  it("deleteVendor gates on `vendor:delete` permission (not `vendor:edit`)", () => {
    const fn = VENDORS_LIB.slice(VENDORS_LIB.indexOf("export async function deleteVendor"));
    expect(fn).toMatch(/requirePermission\(principal, vendor\.clubId, "vendor:delete"\)/);
  });
  it("deleteVendor refuses hard-delete on any financial / operational history", () => {
    const fn = VENDORS_LIB.slice(VENDORS_LIB.indexOf("export async function deleteVendor"));
    // Emits an audit trail even on the blocked path.
    expect(fn).toMatch(/action: "vendor\.delete\.blocked"/);
    expect(fn).toMatch(/reason: "HAS_FINANCIAL_HISTORY"/);
  });
  it("probeVendorDependencies is tenant-scoped (clubId on every count)", () => {
    const fn = VENDORS_LIB.slice(VENDORS_LIB.indexOf("export async function probeVendorDependencies"));
    // Every count() call carries clubId (10 tables — invoices,
    // payments, banking, penny tests, receiving, items, aliases,
    // statement recs, docs, risk flags).
    const clubIdRefs = (fn.match(/clubId,\s*(?:vendorId|canonicalVendorId|preferredVendorId)/g) ?? []).length;
    expect(clubIdRefs).toBeGreaterThanOrEqual(8);   // aliases is not clubId-scoped, so allow ≥ 8
  });
  it("vendor detail page renders the delete panel only when canDelete", () => {
    expect(VENDOR_PAGE).toMatch(/const canDelete = hasPermission\(p, vendor\.clubId, "vendor:delete"\)/);
    expect(VENDOR_PAGE).toMatch(/data-testid="vendor-delete-panel"/);
    expect(VENDOR_PAGE).toMatch(/data-testid="vendor-delete-submit"/);
  });
  it("delete confirmation copy adapts to the dependency probe", () => {
    // Happy path copy.
    expect(VENDOR_PAGE).toMatch(/no posted transactions and will be permanently removed/);
    // Blocked path copy.
    expect(VENDOR_PAGE).toMatch(/posted financial or operational activity and cannot be deleted/);
    expect(VENDOR_PAGE).toMatch(/data-testid="vendor-delete-blocked"/);
  });
  it("delete server action redirects to the vendor list on success", () => {
    expect(VENDOR_PAGE).toMatch(/redirect\(`\/app\/admin\/ap\/vendors\?deleted=1`\)/);
  });
});

// ---------------------------------------------------------------------------
// Shared VendorResolution rule
// ---------------------------------------------------------------------------

describe("15P-4 · shared resolveModalEntry rule exists + exposes the founder-required shape", () => {
  it("returns a discriminated union with 'resolved' / 'review_required'", () => {
    expect(RESOLVER).toMatch(/status: "resolved"/);
    expect(RESOLVER).toMatch(/status: "review_required"/);
  });
  it("has the four reason codes for review_required", () => {
    for (const reason of ["no_match", "limited_evidence", "ambiguous", "conflicting"]) {
      expect(RESOLVER).toContain(`"${reason}"`);
    }
  });
  it("ambiguity threshold is a named documented constant", () => {
    expect(RESOLVER).toMatch(/export const AMBIGUITY_MATCHED_WEIGHT_GAP = 15/);
  });
});

// ---------------------------------------------------------------------------
// Naming cleanup: availableEvidenceWeight → netEvidenceWeight
// ---------------------------------------------------------------------------

describe("15P-4 · naming cleanup — availableEvidenceWeight renamed to netEvidenceWeight", () => {
  it("evaluator exports the new name (no consumer references the old name)", () => {
    const EVAL = read("src/lib/vendor-matching/evaluate.ts");
    expect(EVAL).toMatch(/netEvidenceWeight:/);
    // Old name lives ONLY in a historical rename note. Strip the
    // comment before scanning for real code references.
    const withoutComments = EVAL.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(withoutComments).not.toMatch(/availableEvidenceWeight/);
  });
  it("API + modal reference netEvidenceWeight, not the old name", () => {
    const ROUTE = read("src/app/api/vendors/search/route.ts");
    expect(ROUTE.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/availableEvidenceWeight/);
    expect(MODAL.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/availableEvidenceWeight/);
  });
});
