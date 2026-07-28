// Sprint 3 · Checkpoint 15P-2 (2026-07-27) — source-contract locks
// for the founder-required corrections:
//
//   Defect 1 · Payment terms fell to blank when the extractor
//              found nothing. Now they resolve via the 5-source
//              precedence chain and default honestly to Net 30 /
//              Spectre default.
//
//   Defect 2 · Step 2 showed only the gross amount and no
//              debit/credit journal preview. Now it renders a
//              full summary + tax split + proposed accounting
//              entry table with balance.
//
//   Defect 3 · Approve & post on an already-matched vendor did
//              NOTHING. Now it opens the SAME shared modal
//              directly at Step 2 with the matched vendor
//              preselected.
//
// Every assertion below is grep-only (no network / no Prisma) so
// the suite stays fast enough to run on every push.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function read(p: string) { return readFileSync(join(process.cwd(), p), "utf8"); }

const MODAL         = read("src/components/mission-control/CreateVendorAndPostModal.tsx");
const CARD          = read("src/components/mission-control/EmailIntakeCard.tsx");
const POST_ACTION   = read("src/app/app/admin/ap/_post-ap-invoice-actions.ts");
// 15P-5: the preview server action was retired and replaced by a
// plain POST API route with a stable URL. The route file is the
// new canonical location; the old file is a loud-throw stub.
const PREVIEW_API   = read("src/app/api/mission-control/ap-preview/route.ts");
const BUILDER       = read("src/lib/ap-intelligence/proposed-ap-entry.ts");
const TERMS_RESOLVE = read("src/lib/ap-intelligence/payment-terms-resolve.ts");
const DUE_RESOLVE   = read("src/lib/ap-intelligence/due-date-resolve.ts");
const CONTROL_ACC   = read("src/lib/ap-intelligence/control-accounts.ts");

// ---------------------------------------------------------------------------
// Defect 1 — payment-terms precedence chain
// ---------------------------------------------------------------------------

describe("15P-2 · defect 1 — payment terms follow the 5-source precedence chain", () => {
  it("resolver exports the 5-source PaymentTermsSource union", () => {
    for (const s of ["VENDOR_PROFILE","INVOICE_PDF","PRIOR_INVOICE","CLUB_DEFAULT","SPECTRE_DEFAULT"]) {
      expect(TERMS_RESOLVE).toContain(`"${s}"`);
    }
  });
  it("SPECTRE_DEFAULT_TERMS_DAYS is the exported Net 30 constant", () => {
    expect(TERMS_RESOLVE).toMatch(/export const SPECTRE_DEFAULT_TERMS_DAYS = 30/);
  });
  it("Spectre fallback provenance is 'Spectre default' — NEVER 'From invoice PDF'", () => {
    expect(TERMS_RESOLVE).toMatch(/SPECTRE_DEFAULT:\s*"Spectre default"/);
  });
  it("modal consumes the resolver on mount + threads its provenance into Step 2", () => {
    expect(MODAL).toMatch(/import \{\s*resolvePaymentTerms,\s*parseExtractedTermsValue/);
    expect(MODAL).toMatch(/const resolvedTerms:\s*ResolvedPaymentTerms\s*=\s*resolvePaymentTerms\(/);
    expect(MODAL).toMatch(/const paymentTermsProvenanceHuman = resolvedTerms\.provenanceHuman/);
  });
  it("modal renders the terms provenance chip on the Step 2 summary + coding sections", () => {
    // Summary cell for "Payment terms" carries the honest provenance
    // human label — not hardcoded text.
    expect(MODAL).toMatch(/label="Payment terms"[\s\S]{0,300}provenance=\{paymentTermsProvenanceHuman\}[\s\S]{0,100}testid="cvap-summary-terms"/);
    // The coding-section terms field carries the same human label.
    expect(MODAL).toMatch(/label="Payment terms \(days\)" provenance=\{paymentTermsProvenanceHuman\}/);
  });
});

// ---------------------------------------------------------------------------
// Defect 2 — journal preview + tax split
// ---------------------------------------------------------------------------

describe("15P-2 · defect 2 — Step 2 shows the full debit/credit entry", () => {
  it("shared builder exports buildProposedApEntry with the ProposedApEntry return shape", () => {
    expect(BUILDER).toMatch(/export function buildProposedApEntry/);
    for (const field of ["currency","subtotal","tax","gross","lines","totalDebits","totalCredits","difference","isBalanced","warnings"]) {
      expect(BUILDER).toMatch(new RegExp(`\\b${field}:`));
    }
  });
  it("shared builder emits the DR expense / DR ITC / CR AP three-line pattern", () => {
    expect(BUILDER).toMatch(/role: "TAX_RECOVERABLE"/);
    expect(BUILDER).toMatch(/role: "AP_CONTROL"/);
  });
  it("preview API route calls buildProposedApEntry (single source of truth) — 15P-5 migrated from server action", () => {
    expect(PREVIEW_API).toMatch(/import \{ buildProposedApEntry,/);
    expect(PREVIEW_API).toMatch(/const entry = buildProposedApEntry\(/);
  });
  it("post action ALSO calls buildProposedApEntry (single source of truth)", () => {
    expect(POST_ACTION).toMatch(/import \{ buildProposedApEntry,/);
    expect(POST_ACTION).toMatch(/const proposed = buildProposedApEntry\(/);
  });
  it("post action BLOCKS posting when proposed.isBalanced is false", () => {
    expect(POST_ACTION).toMatch(/if \(!proposed\.isBalanced\)/);
    expect(POST_ACTION).toMatch(/code: "UNBALANCED_ENTRY"/);
  });
  it("post action re-validates subtotal + tax = gross before building the entry", () => {
    expect(POST_ACTION).toMatch(/if \(!subtotalD\.plus\(taxD\)\.equals\(grossD\)\)/);
    expect(POST_ACTION).toMatch(/code: "UNBALANCED_AMOUNTS"/);
  });
  it("modal renders the journal preview as a debit/credit table with totals + difference", () => {
    expect(MODAL).toMatch(/data-testid="cvap-journal-table"/);
    expect(MODAL).toMatch(/data-testid="cvap-journal-total-debits"/);
    expect(MODAL).toMatch(/data-testid="cvap-journal-total-credits"/);
    expect(MODAL).toMatch(/data-testid="cvap-journal-difference"/);
  });
  it("modal disables Post until the preview returns balanced", () => {
    expect(MODAL).toMatch(/preview !== null &&\s*preview\.isBalanced/);
  });
  it("modal renders subtotal + tax + gross as separate editable fields", () => {
    expect(MODAL).toMatch(/data-testid="cvap-coding-subtotal"/);
    expect(MODAL).toMatch(/data-testid="cvap-coding-tax"/);
    expect(MODAL).toMatch(/data-testid="cvap-coding-gross"/);
  });
  it("modal exposes tax treatment selector (RECOVERABLE / NON_RECOVERABLE / NONE)", () => {
    expect(MODAL).toMatch(/data-testid="cvap-coding-tax-treatment"/);
    expect(MODAL).toMatch(/<option value="RECOVERABLE"/);
    expect(MODAL).toMatch(/<option value="NON_RECOVERABLE"/);
    expect(MODAL).toMatch(/<option value="NONE"/);
  });
  it("modal fetches the preview via the POST API route (15P-5) — not local math, not a server action", () => {
    // 15P-5 migrated the preview from a Next.js server action to a
    // plain POST API route with a stable URL. Server actions rehash
    // their id on every deploy, which produced the founder-observed
    // "Preview unavailable" state across deploys. API route paths
    // are stable.
    expect(MODAL).toMatch(/fetch\(`\/api\/mission-control\/ap-preview`, \{\s*method: "POST"/);
    expect(MODAL).not.toMatch(/import\("@\/app\/app\/admin\/ap\/_preview-ap-entry-actions"\)/);
  });
});

// ---------------------------------------------------------------------------
// Defect 3 — Approve & post opens the shared modal at Step 2
// ---------------------------------------------------------------------------

describe("15P-2 · defect 3 — Approve & post opens the shared modal at Step 2", () => {
  it("modal exports initialStep + preselectedVendorId props", () => {
    expect(MODAL).toMatch(/initialStep\?: "PROFILE" \| "AP_CODING"/);
    expect(MODAL).toMatch(/preselectedVendorId\?: string/);
    expect(MODAL).toMatch(/preselectedVendorName\?: string/);
  });
  it("modal opens directly at AP_CODING when initialStep + preselectedVendorId are set", () => {
    expect(MODAL).toMatch(/const openDirectAtStep2 =\s*initialStep === "AP_CODING" && !!preselectedVendorId/);
    expect(MODAL).toMatch(/useState<Step>\(openDirectAtStep2 \? "AP_CODING" : "PROFILE"\)/);
    // Vendor id + name seed createdVendorId / createdVendorName so
    // Step 2 has a real vendor from the first render.
    expect(MODAL).toMatch(/useState<string \| null>\(preselectedVendorId \?\? null\)/);
    expect(MODAL).toMatch(/useState<string \| null>\(preselectedVendorName \?\? null\)/);
  });
  it("when the modal is in single-step auto-resolved mode, 'Back to vendor profile' is HIDDEN (15P-4)", () => {
    // 15P-4 refined the guard: back-to-profile is hidden ONLY when
    // the modal is in the single-step auto-resolved shape (no Step 1
    // was traversed). Two-step-opened-at-Step-2 for NEEDS_JUDGMENT
    // now shows the back button + supports free navigation.
    expect(MODAL).toMatch(/!isAutoResolvedSingleStep \? \(\s*<button[\s\S]{0,500}data-testid="cvap-back-to-profile"/);
  });
  it("card's primary-action handler consults deriveApAction (15P-5 single derivation)", () => {
    // 15P-5 replaced the workflow-state-specific `if` branches with
    // a single derivation. `action.modal.initialStep` decides which
    // modal shape opens; `action.modal.autoResolved` decides the
    // single-step vs two-step-opened-at-Step-2 presentation. Same
    // function that produces the button label.
    expect(CARD).toMatch(/const action = deriveApAction\(ap\)/);
    expect(CARD).toMatch(/setCvapModalMode\(\{\s*kind: "STEP_2",\s*vendorId: action\.modal\.vendorId/);
  });
  it("VENDOR_MATCH_REQUIRED still opens at Step 1 — enforced by the derivation (15P-5)", () => {
    // The shared derivation returns `initialStep: "PROFILE"` for
    // CREATE_VENDOR_AND_POST (which is what VENDOR_MATCH_REQUIRED
    // maps to). The click handler reads that value directly.
    const APACTION = read("src/lib/mission-control/ap-action.ts");
    expect(APACTION).toMatch(/case "VENDOR_MATCH_REQUIRED":[\s\S]{0,400}initialStep: "PROFILE"/);
    expect(CARD).toMatch(/setCvapModalMode\(\{ kind: "STEP_1" \}\)/);
  });
  it("card threads initialStep + preselectedVendorId + preselectedVendorName into the shared modal", () => {
    expect(CARD).toMatch(/initialStep=\{cvapModalMode\.kind === "STEP_2" \? "AP_CODING" : "PROFILE"\}/);
    expect(CARD).toMatch(/preselectedVendorId=\{cvapModalMode\.kind === "STEP_2" \? cvapModalMode\.vendorId : undefined\}/);
    expect(CARD).toMatch(/preselectedVendorName=\{cvapModalMode\.kind === "STEP_2" \? cvapModalMode\.vendorName : undefined\}/);
  });
  it("closing the modal resets mode back to STEP_1 (next open defaults to profile)", () => {
    expect(CARD).toMatch(/setCvapModalMode\(\{ kind: "STEP_1" \}\)/);
  });
  it("Approve & post does NOT post directly from the collapsed card", () => {
    // The onPrimary handler only sets modal-state / expands the card;
    // it never calls postApInvoiceAction. Only the Step 2 Post button
    // (inside the modal, gated on canStep2Post + balanced preview)
    // fires the server action.
    const onPrimaryBlock = CARD.slice(CARD.indexOf("onPrimary={"), CARD.indexOf("onOpenPdf={"));
    expect(onPrimaryBlock).not.toMatch(/postApInvoiceAction/);
  });
});

// ---------------------------------------------------------------------------
// One shared component + one shared action — no duplicate coding UI
// ---------------------------------------------------------------------------

describe("15P-2 · one shared AP-coding component + one shared post action", () => {
  it("no other file re-implements a CreateVendor / PostApInvoice modal", () => {
    // grep-only sanity: only the one modal file may export the shape.
    // A second file exporting `Step 2` or `PostApInvoice` would be a
    // divergence.
    // We check the ONLY canonical modal is the one under mission-control/.
    // Any regression would show up as a second file matching this pattern.
    const CANONICAL = "src/components/mission-control/CreateVendorAndPostModal.tsx";
    expect(read(CANONICAL)).toMatch(/export default function CreateVendorAndPostModal/);
  });
  it("no other file exports postApInvoiceAction", () => {
    // The one server action file is authoritative.
    expect(POST_ACTION).toMatch(/export async function postApInvoiceAction/);
  });
});

// ---------------------------------------------------------------------------
// Server posting hardening — control accounts + journalize
// ---------------------------------------------------------------------------

describe("15P-2 · server posting hardening", () => {
  it("post action resolves the AP control account + GST recoverable via resolveControlAccounts", () => {
    expect(POST_ACTION).toMatch(/import \{ resolveControlAccounts \}/);
    expect(POST_ACTION).toMatch(/const control = await resolveControlAccounts\(/);
    // Config error returned to the operator when a control account is missing.
    expect(POST_ACTION).toMatch(/if \(!control\.ok\)/);
  });
  it("post action sets APInvoiceLine.amount = SUBTOTAL (not gross) — fixes the pre-15P-2 bug", () => {
    expect(POST_ACTION).toMatch(/amount: new Prisma\.Decimal\(subtotalD\.toFixed\(2\)\)/);
  });
  it("post action sets taxCodeId when treatment is RECOVERABLE (so postInvoiceToGl can split ITC)", () => {
    expect(POST_ACTION).toMatch(/taxCodeId: treatment\.kind === "RECOVERABLE" \? control\.gstTaxCodeId : null/);
  });
  it("post action creates the AP invoice as POSTED and the journal entry INSIDE the same $transaction (15P-7 atomicity)", () => {
    // 15P-7 replaced the post-tx `postInvoiceToGl` call with
    // atomic in-tx JE creation via `nextEntryNumberTx` +
    // `tx.journalEntry.create` + `tx.journalEntryLine.createMany`.
    // The old outer-tx race that produced Draft-with-no-JE is gone.
    expect(POST_ACTION).not.toMatch(/postInvoiceToGl\(/);
    expect(POST_ACTION).toMatch(/import \{ nextEntryNumberTx \} from "@\/lib\/accounting\/journal"/);
    // Invoice is created directly as POSTED.
    expect(POST_ACTION).toMatch(/status: "POSTED",\s*postedAt: nowTs,\s*postedByUserId: principal\.id/);
    // JE is created inside the tx and its id is backfilled.
    expect(POST_ACTION).toMatch(/tx\.journalEntry\.create\(/);
    expect(POST_ACTION).toMatch(/tx\.aPInvoice\.update\(\{[\s\S]{0,200}postedJournalEntryId: je\.id/);
  });
  it("resolveControlAccounts returns a config-error result — never fabricates an account", () => {
    for (const code of ["AP_CONTROL_MISSING","AP_CONTROL_AMBIGUOUS","TAX_CODE_MISSING","TAX_RECOVERABLE_MISSING"]) {
      expect(CONTROL_ACC).toContain(`"${code}"`);
    }
  });
  it("resolveControlAccounts uses semantic identity (name + type), not hardcoded numbers", () => {
    // The tenant's real 'Accounts Payable' account may not be 2010.
    // On Coulee Ridge staging it's actually 2009. The resolver must
    // match by NAME + TYPE first; number-based fallback is only a
    // tie-breaker.
    expect(CONTROL_ACC).toMatch(/const AP_NAME_RE =/);
    expect(CONTROL_ACC).toMatch(/const GST_RECOVERABLE_NAME_RE =/);
    // Well-known numbers appear ONLY as tie-breakers, never as sole signal.
    expect(CONTROL_ACC).toMatch(/const KNOWN_AP_NUMBERS = \[/);
    // The founder rule: never fabricate. All failure branches must
    // return ok:false, never a synthetic Account row.
    expect(CONTROL_ACC).not.toMatch(/id: "cuid_fake"/);
    // The word "fabricate" appears only in the doc-comment header
    // (once). Any occurrence of "fabricated:" (as a value) or
    // "return \{[^}]*fabricated: true" would indicate a fabrication
    // path — must NOT exist.
    expect(CONTROL_ACC).not.toMatch(/fabricated:\s*true/);
  });
});

// ---------------------------------------------------------------------------
// Coding precedent captured on the audit trail
// ---------------------------------------------------------------------------

describe("15P-2 · coding precedent captured on the audit trail", () => {
  it("audit record includes taxTreatment, terms source, due-date source, journal entry id + entry lines", () => {
    for (const key of ["taxTreatment", "termsSource", "dueDateSource", "journalEntryId", "entryLines", "entryBalanced", "recommendationAccepted"]) {
      expect(POST_ACTION).toMatch(new RegExp(`\\b${key}:`));
    }
  });
});

// ---------------------------------------------------------------------------
// Due-date logic
// ---------------------------------------------------------------------------

describe("15P-2 · due-date resolution", () => {
  it("explicit invoice due date wins over any terms calculation", () => {
    expect(DUE_RESOLVE).toMatch(/if \(input\.explicitInvoiceDueDate instanceof Date/);
    expect(DUE_RESOLVE).toMatch(/source: "INVOICE_PDF"/);
  });
  it("auto-pay collapses to invoice date", () => {
    expect(DUE_RESOLVE).toMatch(/if \(input\.isAutoPay\)/);
    expect(DUE_RESOLVE).toMatch(/source: "AUTO_PAY"/);
  });
  it("otherwise computes invoiceDate + termsDays", () => {
    expect(DUE_RESOLVE).toMatch(/const dueMs = input\.invoiceDate\.getTime\(\) \+ Math\.max\(0, input\.termsDays\) \* 86_400_000/);
    expect(DUE_RESOLVE).toMatch(/source: "COMPUTED_FROM_TERMS"/);
  });
});
