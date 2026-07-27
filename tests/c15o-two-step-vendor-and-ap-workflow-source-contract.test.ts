// Sprint 3 · Checkpoint 15O (2026-07-27) — source-contract locks for
// the founder-approved corrective workflow:
//
//   • Provisional vendor timeline REMOVED entirely.
//   • Create Vendor & Post modal is now a TWO-STEP guided flow.
//   • Step 1 (Create vendor) and Step 2 (Post AP invoice) each run
//     inside their own Prisma transaction — never combined.
//   • Vendor timeline has a hard lower bound: no event predates the
//     Vendor.createdAt timestamp.
//   • Left sidebar widened so the full club name is legible.
//
// See docs for the checkpoint brief.

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function read(p: string) { return readFileSync(join(process.cwd(), p), "utf8"); }
function exists(p: string) { return existsSync(join(process.cwd(), p)); }

const CARD          = read("src/components/mission-control/EmailIntakeCard.tsx");
const MODAL         = read("src/components/mission-control/CreateVendorAndPostModal.tsx");
const TIMELINE_LIB  = read("src/lib/vendor-timeline.ts");
const STEP1_ACTION  = read("src/app/app/admin/ap/_create-vendor-actions.ts");
const STEP2_ACTION  = read("src/app/app/admin/ap/_post-ap-invoice-actions.ts");
const RETIRED       = read("src/app/app/admin/ap/_create-vendor-and-post-actions.ts");
const SIDEBAR       = read("src/components/spectre/SpectreSidebar.tsx");
const GLOBALS_CSS   = read("src/app/globals.css");

// ---------------------------------------------------------------------------
// Provisional vendor timeline is REMOVED
// ---------------------------------------------------------------------------

describe("15O — provisional vendor timeline is removed", () => {
  it("the /app/admin/ap/vendors/provisional page file does not exist", () => {
    expect(exists("src/app/app/admin/ap/vendors/provisional/page.tsx")).toBe(false);
  });
  it("loadProvisionalVendorTimeline is no longer exported (any import errors at compile time)", () => {
    // The 15M helper is entirely removed. A stale import will fail
    // TypeScript resolution — a plainer, more truthful shape than
    // keeping a runtime stub around.
    expect(TIMELINE_LIB).not.toMatch(/export async function loadProvisionalVendorTimeline/);
    expect(TIMELINE_LIB).not.toMatch(/export const loadProvisionalVendorTimeline/);
    expect(TIMELINE_LIB).not.toMatch(/export function loadProvisionalVendorTimeline/);
  });
  it("VendorTimelineResult no longer carries a `provisional` field (header is required)", () => {
    // The header is required — the interface is only reachable when
    // a real Vendor exists.
    expect(TIMELINE_LIB).toMatch(/header: VendorTimelineHeader;\s+events: VendorTimelineEvent\[\]/);
    // Ensure the pre-15O optional `provisional?:` shape is gone.
    const iface = TIMELINE_LIB.slice(
      TIMELINE_LIB.indexOf("export interface VendorTimelineResult"),
      TIMELINE_LIB.indexOf("// ---", TIMELINE_LIB.indexOf("export interface VendorTimelineResult")),
    );
    expect(iface).not.toMatch(/provisional\?:/);
  });
});

// ---------------------------------------------------------------------------
// Card behaviour: vendor name link → matched vendor timeline OR modal
// ---------------------------------------------------------------------------

describe("15O — vendor name click behaviour on the AP card", () => {
  it("MATCHED vendor renders an <a> link to /app/admin/ap/vendors/[id]/timeline", () => {
    expect(CARD).toMatch(/matchedVendorId\)\s*\}\/timeline/);
    expect(CARD).toMatch(/data-testid="ap-title-vendor-link"/);
  });
  it("UNMATCHED vendor renders a <button> that OPENS the Create Vendor modal (no provisional route)", () => {
    expect(CARD).toMatch(/data-testid="ap-title-vendor-button"/);
    expect(CARD).toMatch(/onClick=\{\(e\) => \{ e\.stopPropagation\(\); onVendorClick\(\); \}\}/);
    // Nothing routes to /provisional any longer.
    expect(CARD).not.toMatch(/\/app\/admin\/ap\/vendors\/provisional/);
  });
  it("onVendorClick opens the modal (setCvapModalOpen(true))", () => {
    expect(CARD).toMatch(/renderApCollapsedBody\(data, ap, expanded, \(\) => setCvapModalOpen\(true\)\)/);
  });
});

// ---------------------------------------------------------------------------
// Modal is TWO STEPS
// ---------------------------------------------------------------------------

describe("15O — modal is a two-step guided flow", () => {
  it("modal defines a Step union of PROFILE / AP_CODING / SAVED_FOR_LATER", () => {
    expect(MODAL).toMatch(/type Step = "PROFILE" \| "AP_CODING" \| "SAVED_FOR_LATER"/);
    expect(MODAL).toMatch(/const \[step, setStep\] = useState<Step>\("PROFILE"\)/);
  });
  it("step indicator renders 1 Vendor profile / 2 AP coding", () => {
    expect(MODAL).toMatch(/data-testid="cvap-step-indicator"/);
    expect(MODAL).toMatch(/<span className="lbl">Vendor profile<\/span>/);
    expect(MODAL).toMatch(/<span className="lbl">AP coding<\/span>/);
  });
  it("modal renders a distinct title per step", () => {
    expect(MODAL).toMatch(/step === "PROFILE" \? "Create vendor"/);
    expect(MODAL).toMatch(/step === "AP_CODING" \? "Review and post invoice"/);
  });
  it("Step 1 primary action is 'Create vendor' OR 'Use selected vendor', NOT 'Create vendor & post'", () => {
    expect(MODAL).toMatch(/vendorMode === "USE_EXISTING" \? "Use selected vendor" : "Create vendor"/);
    // The combined 15M label must not appear as a primary Step 1 action.
    expect(MODAL).not.toMatch(/data-testid="cvap-step1-primary"[\s\S]{0,200}Create vendor & post/);
  });
  it("Step 1 has a secondary 'Save vendor and finish later' action", () => {
    expect(MODAL).toMatch(/data-testid="cvap-save-and-finish-later"/);
    expect(MODAL).toMatch(/Save vendor and finish later/);
    // Finish-later sets step to SAVED_FOR_LATER, not AP_CODING.
    expect(MODAL).toMatch(/if \(result\.finishedLater\) \{\s*setStep\("SAVED_FOR_LATER"\)/);
  });
  it("Step 2 primary action is 'Post invoice'", () => {
    expect(MODAL).toMatch(/data-testid="cvap-post-invoice"/);
    expect(MODAL).toMatch(/\{submitting \? "Posting…" : "Post invoice"\}/);
  });
  it("Step 2 is only reachable AFTER createdVendorId is set (guarded)", () => {
    expect(MODAL).toMatch(/if \(!createdVendorId \|\| !canStep2Post\) return/);
  });
  it("Step 2 has a 'Back to vendor profile' secondary action", () => {
    expect(MODAL).toMatch(/data-testid="cvap-back-to-profile"/);
  });
});

// ---------------------------------------------------------------------------
// Vendor profile fields (Phase 3)
// ---------------------------------------------------------------------------

describe("15O — Step 1 vendor profile fields", () => {
  const requiredFields: Array<string> = [
    "Legal name", "Operating name", "Currency",
    "Address line 1", "Address line 2", "City", "Province / state", "Postal / ZIP", "Country",
    "Main contact name", "Main contact title", "Main contact phone", "Main contact email",
    "Vendor email (general)", "Phone (general)", "AR email", "AP / remittance email", "Website",
    "Payment terms (days)", "Tax registration #",
    "Notes",
  ];
  for (const label of requiredFields) {
    it(`Step 1 renders the "${label}" field`, () => {
      // Each label appears verbatim inside a ProfileField label prop.
      expect(MODAL).toContain(`label="${label}"`);
    });
  }
  it("EFT / remittance subsection is present with the honest 'add after creation' message", () => {
    expect(MODAL).toMatch(/EFT \/ remittance/);
    expect(MODAL).toMatch(/EFT details can be added after vendor creation/);
  });
});

// ---------------------------------------------------------------------------
// Internal-forwarder rule (Phase 4)
// ---------------------------------------------------------------------------

describe("15O — internal-forwarder rule preserved", () => {
  it("EMPLOYEE_FORWARD sender is NEVER pre-populated as vendor's main contact", () => {
    expect(MODAL).toMatch(/mainContactName: ap\.sender\.relationship === "VENDOR" \? ap\.sender\.name : null/);
    expect(MODAL).toMatch(/mainContactEmail: ap\.sender\.relationship === "VENDOR" \? ap\.sender\.email : null/);
  });
  it("Source section explains the forwarder is provenance only", () => {
    expect(MODAL).toMatch(/internal forwarders are provenance only/);
  });
});

// ---------------------------------------------------------------------------
// Possible matches (Phase 5)
// ---------------------------------------------------------------------------

describe("15O — possible existing matches", () => {
  it("Step 1 loads possible matches from the tenant-scoped API", () => {
    expect(MODAL).toMatch(/\/api\/vendors\/search\?q=/);
    // The choose-new option flips vendorMode to CREATE_NEW.
    expect(MODAL).toMatch(/data-testid="cvap-choose-new"/);
  });
  it("USE_EXISTING mode goes straight to Step 2 without a fresh Vendor create", () => {
    // The Step 1 action supports USE_EXISTING via existingVendorId
    // and the server action skips vendor creation.
    expect(STEP1_ACTION).toMatch(/if \(input\.vendorMode === "USE_EXISTING"\)/);
    expect(STEP1_ACTION).toMatch(/if \(!input\.existingVendorId\) throw new ValidationError/);
    expect(STEP1_ACTION).toMatch(/vendorCreated = false/);
  });
});

// ---------------------------------------------------------------------------
// Server actions — each step is its own transaction
// ---------------------------------------------------------------------------

describe("15O — Step 1 server action", () => {
  it("createVendorAction exists in _create-vendor-actions.ts and is 'use server'", () => {
    expect(STEP1_ACTION).toMatch(/"use server"/);
    expect(STEP1_ACTION).toMatch(/export async function createVendorAction/);
  });
  it("Step 1 does NOT resolve the Work Intake item (Step 2 does)", () => {
    // No RESOLVED transition inside Step 1.
    expect(STEP1_ACTION).not.toMatch(/status: "RESOLVED"/);
    // Explicit comment locking the invariant.
    expect(STEP1_ACTION).toMatch(/Step 1 does NOT resolve the Work Intake item/);
  });
  it("Step 1 wraps its writes in prisma.$transaction with explicit timeout options", () => {
    expect(STEP1_ACTION).toMatch(/prisma\.\$transaction\(async \(tx\) =>/);
    expect(STEP1_ACTION).toMatch(/timeout: 30_000/);
    expect(STEP1_ACTION).toMatch(/maxWait: 10_000/);
  });
  it("Step 1 supports finishLater with an explicit return field", () => {
    expect(STEP1_ACTION).toMatch(/finishLater: z\.boolean\(\)\.optional\(\)/);
    expect(STEP1_ACTION).toMatch(/finishedLater: input\.finishLater === true/);
  });
});

describe("15O — Step 2 server action", () => {
  it("postApInvoiceAction exists in _post-ap-invoice-actions.ts and is 'use server'", () => {
    expect(STEP2_ACTION).toMatch(/"use server"/);
    expect(STEP2_ACTION).toMatch(/export async function postApInvoiceAction/);
  });
  it("Step 2 REQUIRES an existing vendorId (Step 1 must have run first)", () => {
    expect(STEP2_ACTION).toMatch(/vendorId: z\.string\(\)\.min\(1\)/);
    expect(STEP2_ACTION).toMatch(/const vendor = await prisma\.vendor\.findFirst/);
    // Blocked vendors rejected.
    expect(STEP2_ACTION).toMatch(/vendor\.status === "BLOCKED"/);
  });
  it("Step 2 detects duplicate invoices inside the transaction", () => {
    const tx = STEP2_ACTION.slice(STEP2_ACTION.indexOf("prisma.$transaction"));
    expect(tx).toMatch(/tx\.aPInvoice\.findFirst/);
    expect(tx).toMatch(/vendorReference: input\.coding\.invoiceNumber/);
  });
  it("Step 2 resolves the Work Intake item (RESOLVED + resolvedAt + resolvedByUserId)", () => {
    expect(STEP2_ACTION).toMatch(/status: "RESOLVED"/);
    expect(STEP2_ACTION).toMatch(/resolvedAt: new Date\(\)/);
    expect(STEP2_ACTION).toMatch(/resolvedByUserId: principal\.id/);
  });
  it("Step 2 wraps its writes in prisma.$transaction with explicit timeout options", () => {
    expect(STEP2_ACTION).toMatch(/prisma\.\$transaction\(async \(tx\) =>/);
    expect(STEP2_ACTION).toMatch(/timeout: 60_000/);
    expect(STEP2_ACTION).toMatch(/maxWait: 15_000/);
  });
  it("Step 2 audits the AP invoice + WI resolution separately", () => {
    expect(STEP2_ACTION).toMatch(/action: "ap\.invoice\.create"/);
    expect(STEP2_ACTION).toMatch(/action: "work-intake\.resolve"/);
  });
  it("Step 2 returns links to the vendor timeline and the AP invoice", () => {
    expect(STEP2_ACTION).toMatch(/timelineUrl: `\/app\/admin\/ap\/vendors\/\$\{encodeURIComponent\(vendor\.id\)\}\/timeline`/);
    expect(STEP2_ACTION).toMatch(/apInvoiceUrl:\s+`\/app\/admin\/ap\/invoices\/\$\{encodeURIComponent\(result\.invoiceId\)\}`/);
  });
});

describe("15O — retired combined action still errors loudly at compile time", () => {
  it("_create-vendor-and-post-actions.ts is a stub that throws on call", () => {
    expect(RETIRED).toMatch(/createVendorAndPostAction was retired in Checkpoint 15O/);
    expect(RETIRED).toMatch(/throw new Error/);
  });
});

// ---------------------------------------------------------------------------
// Timeline lower bound (Phase 10)
// ---------------------------------------------------------------------------

describe("15O — vendor timeline has a hard lower bound at Vendor.createdAt", () => {
  it("the loader clamps every event ts to >= vendor.createdAt", () => {
    expect(TIMELINE_LIB).toMatch(/const eventTs = new Date\(e\.ts\)\.getTime\(\)/);
    expect(TIMELINE_LIB).toMatch(/const floor = vendor\.createdAt\.getTime\(\)/);
    expect(TIMELINE_LIB).toMatch(/eventTs < floor \? \{ \.\.\.e, ts: vendor\.createdAt\.toISOString\(\) \} : e/);
  });
  it("the loader sorts newest-first after clamping", () => {
    expect(TIMELINE_LIB).toMatch(/clamped\.sort\(\(a, b\) => b\.ts\.localeCompare\(a\.ts\)\)/);
  });
  it("the vendor-created event is always emitted with the vendor.createdAt timestamp (the lower boundary)", () => {
    expect(TIMELINE_LIB).toMatch(/id: `vendor-created-\$\{vendorId\}`/);
    expect(TIMELINE_LIB).toMatch(/ts: vendorCreatedAt\.toISOString\(\)/);
    expect(TIMELINE_LIB).toMatch(/title: `Vendor created`/);
  });
});

// ---------------------------------------------------------------------------
// Sidebar width (Phase 11)
// ---------------------------------------------------------------------------

describe("15O — left sidebar widened + club name allowed to wrap", () => {
  it("expanded sidebar width increased from 248 to 288 px", () => {
    expect(GLOBALS_CSS).toMatch(/--spectre-sidebar-w-expanded: 288px/);
    expect(GLOBALS_CSS).not.toMatch(/--spectre-sidebar-w-expanded: 248px/);
  });
  it("collapsed sidebar width unchanged at 72 px", () => {
    expect(GLOBALS_CSS).toMatch(/--spectre-sidebar-w-collapsed: 72px/);
  });
  it("club identity div drops `truncate` in favour of a two-line clamp", () => {
    // The pre-15O `truncate` on the club name div is gone.
    const idBlock = SIDEBAR.slice(SIDEBAR.indexOf("Identity block"), SIDEBAR.indexOf("Search entry"));
    expect(idBlock).not.toMatch(/leading-tight truncate/);
    expect(idBlock).toMatch(/spectre-sidebar-club-name/);
    expect(idBlock).toMatch(/data-testid="spectre-sidebar-club-name"/);
    // Full name preserved as title attr for tooltip fallback.
    expect(idBlock).toMatch(/title=\{clubName\}/);
  });
  it("CSS defines a 2-line clamp for the club name", () => {
    const rule = GLOBALS_CSS.slice(GLOBALS_CSS.indexOf(".spectre-sidebar-club-name"));
    expect(rule).toMatch(/-webkit-line-clamp: 2/);
    expect(rule).toMatch(/word-break: break-word/);
  });
});
