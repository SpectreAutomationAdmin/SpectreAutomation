// Sprint 3 · Checkpoint 15L (2026-07-27) — source-contract locks for
// the vendor-first AP drafting workflow.
//
// Origin incident: After the Coulee Ridge COA commit completed with
// 237 accounts, the Microsoft AP intake card still reported CATEGORY —
// with 40% confidence. Two root causes, both fixed here:
//
//   1. src/lib/ap-intelligence/gl-recommend.ts — the OPERATING branch
//      returned NONE whenever no vendor record existed. Rewritten to
//      run a name-keyword search against the actual COA even when the
//      vendor is absent.
//
//   2. src/lib/mission-control/intelligence-review-intakes.ts — the
//      apSummaryCache had no COA-revision dimension in its key, so a
//      pre-commit projection stayed cached for up to 90 seconds after
//      the founder committed the chart. Cache key now includes a
//      cheap per-club `count@max(updatedAt)` fingerprint that
//      naturally invalidates on any Account row change.
//
// This test locks the source shape of both fixes + the founder-
// approved workflow rules (primary action label, hover fix, modal
// wiring, no-forwarder-as-vendor rule).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function read(p: string) { return readFileSync(join(process.cwd(), p), "utf8"); }

const GL_RECOMMEND    = read("src/lib/ap-intelligence/gl-recommend.ts");
const IRI             = read("src/lib/mission-control/intelligence-review-intakes.ts");
const CARD            = read("src/components/mission-control/EmailIntakeCard.tsx");
const MODAL           = read("src/components/mission-control/CreateVendorAndPostModal.tsx");
const GLOBALS_CSS     = read("src/app/globals.css");
const VENDORS_SEARCH  = read("src/app/api/vendors/search/route.ts");

describe("15L — GL recommender must run without a vendor record", () => {
  it("recommends via COA-name search when vendorId is null (Phase 2 + 3)", () => {
    // The recommender must not short-circuit to NONE just because
    // no vendor id was supplied. Signal 3 (NAME_KEYWORD) walks every
    // active Account on the club and scores against SEMANTIC_GROUPS.
    expect(GL_RECOMMEND).toMatch(/Signal 3: name-keyword semantic search/);
    expect(GL_RECOMMEND).toMatch(/for \(const group of SEMANTIC_GROUPS\)/);
    // The IT_SOFTWARE group must catch Microsoft-style vendor names.
    expect(GL_RECOMMEND).toMatch(/microsoft\|adobe\|google\\s\*workspace/);
    // The GL recommender must return alternates for the modal.
    expect(GL_RECOMMEND).toMatch(/candidates: GlCandidate\[\]/);
  });

  it("consults prior-coding history for matched vendors as a stronger signal than name-keyword", () => {
    expect(GL_RECOMMEND).toMatch(/prior-coding/);
    expect(GL_RECOMMEND).toMatch(/PRIOR_CODING/);
  });

  it("preserves VENDOR_DEFAULT as the top signal when the matched vendor has a default expense account", () => {
    expect(GL_RECOMMEND).toMatch(/vendor\.defaultExpenseAccount/);
    expect(GL_RECOMMEND).toMatch(/VENDOR_DEFAULT/);
  });

  it("guards against empty COA — returns a well-formed NONE recommendation instead of crashing", () => {
    expect(GL_RECOMMEND).toMatch(/if \(accounts\.length === 0\)/);
    expect(GL_RECOMMEND).toMatch(/emptyRecommendation/);
  });

  it("only considers ASSET and EXPENSE accounts as plausible AP destinations", () => {
    expect(GL_RECOMMEND).toMatch(/a\.type === "EXPENSE" \|\| a\.type === "ASSET"/);
  });

  it("passes the extraction into the recommender via analyse.ts", () => {
    const ANALYSE = read("src/lib/ap-intelligence/analyse.ts");
    expect(ANALYSE).toMatch(/recommendGlAccount\(\{[\s\S]{0,1000}extraction,?\s*\}\)/);
  });
});

describe("15L + 15P-1 — AP projection cache must invalidate when the COA OR extractor changes", () => {
  it("cache key includes a per-club COA revision fingerprint", () => {
    // 15P-1: the signature is unchanged (intakeId, docId, coaRevision)
    // but the returned key now also embeds the extractor version so
    // a new deploy invalidates every AP projection cached under the
    // pre-15P-1 extractor without a Fly restart.
    expect(IRI).toMatch(/function apSummaryCacheKey\(\s*intakeId: string,\s*docId: string \| null,\s*coaRevision: string,\s*\)/);
    expect(IRI).toMatch(/coa=\$\{coaRevision\}::vpx=\$\{VENDOR_PROFILE_EXTRACTOR_VERSION\}/);
  });

  it("15P-1: vendor-profile extractor version is imported and threaded into the cache key", () => {
    expect(IRI).toMatch(/import \{ EXTRACTOR_VERSION as VENDOR_PROFILE_EXTRACTOR_VERSION \} from "@\/lib\/ap-intelligence\/vendor-profile-extract"/);
  });

  it("loadCoaRevision computes count@max(updatedAt) — any Account change bumps the fingerprint", () => {
    expect(IRI).toMatch(/async function loadCoaRevision\(clubId: string\): Promise<string>/);
    expect(IRI).toMatch(/prisma\.account\.count/);
    expect(IRI).toMatch(/prisma\.account\.findFirst\([\s\S]{0,200}orderBy: \{ updatedAt: "desc" \}/);
    expect(IRI).toMatch(/`\$\{count\}@\$\{latest\?\.updatedAt\.getTime\(\) \?\? 0\}`/);
  });

  it("the summariser pulls the revision BEFORE probing the cache", () => {
    const order = IRI.indexOf("const coaRevision = await loadCoaRevision(clubId);");
    const probe = IRI.indexOf("const cacheKey = apSummaryCacheKey(intakeId, docRef, coaRevision);");
    expect(order).toBeGreaterThan(0);
    expect(probe).toBeGreaterThan(order);
  });
});

describe("15L — projection payload carries provenance for the card + modal", () => {
  it("category has source + alternates for the modal's alternate-picker", () => {
    expect(IRI).toMatch(/source: "VENDOR_DEFAULT" \| "PRIOR_CODING" \| "NAME_KEYWORD" \| "CAPITAL_CLASS_MAP" \| "NONE" \| null/);
    expect(IRI).toMatch(/alternates: Array<\{\s+accountNumber: string;\s+accountName: string;\s+confidence: number;\s+\}>/);
  });
  it("gstVerification captures the arithmetic-reconciliation outcome (not a hardcoded rate)", () => {
    expect(IRI).toMatch(/gstVerification: "VERIFIED" \| "EXTRACTED_UNVERIFIED" \| "NOT_PRESENT" \| "INSUFFICIENT_DATA" \| null/);
    expect(IRI).toMatch(/function classifyGstVerification/);
    expect(IRI).toMatch(/supportedRates = \[5, 7, 8, 12, 13, 14\.975, 15\]/);
  });
  it("paymentTermsSource distinguishes EXTRACTED / VENDOR_PROFILE / null (no invented net-30)", () => {
    expect(IRI).toMatch(/paymentTermsSource: "EXTRACTED" \| "VENDOR_PROFILE" \| "PRIOR_INVOICE" \| null/);
    expect(IRI).toMatch(/async function resolvePaymentTerms/);
  });
  it("cadence falls back to normalised-name counting when no vendor record exists", () => {
    expect(IRI).toMatch(/async function countInvoicesThisQuarterByName/);
  });
});

describe("15L — card render matches the Ace Foods intelligence model", () => {
  it("the summary paragraph renders Spectre as bold and emphasises the gross + GL tokens", () => {
    expect(CARD).toMatch(/function ApWorkSummary/);
    expect(CARD).toMatch(/<span className="a"[\s\S]{0,80}><strong>Spectre<\/strong><\/span>/);
    expect(CARD).toMatch(/data-testid="ap-work-gross-ref"/);
    expect(CARD).toMatch(/data-testid="ap-work-gl-ref"/);
  });
  it("GST language appears ONLY when gstVerification === VERIFIED — never a generic '5%' claim", () => {
    expect(CARD).toMatch(/ap\.gstVerification === "VERIFIED"[\s\S]{0,120}Verified GST at/);
    expect(CARD).toMatch(/ap\.gstVerification === "EXTRACTED_UNVERIFIED"[\s\S]{0,120}rate could not be reconciled/);
    expect(CARD).toMatch(/ap\.gstVerification === "NOT_PRESENT"[\s\S]{0,80}No GST detected/);
  });
  it("PO / variance / payment terms are only rendered when present", () => {
    expect(CARD).toMatch(/ap\.purchaseOrder\.poNumber \? \(/);
    expect(CARD).toMatch(/ap\.purchaseOrder\.variance != null/);
    expect(CARD).toMatch(/ap\.paymentTerms\s*\?\s*<>/);
  });
});

describe("15L — primary action + modal wiring", () => {
  it("VENDOR_MATCH_REQUIRED primary action is 'Create vendor & post' (Phase 5)", () => {
    // Sprint 3 · Checkpoint 15M added an `icon` field to the return
    // shape; the label invariant stays.
    expect(CARD).toMatch(/"VENDOR_MATCH_REQUIRED":\s+return \{ label: "Create vendor & post",\s+icon: "vendor-plus" \}/);
  });
  it("card wires the modal only for VENDOR_MATCH_REQUIRED; other workflows keep the pre-15L expand path", () => {
    expect(CARD).toMatch(/if \(ap\?\.workflowState === "VENDOR_MATCH_REQUIRED"\) \{\s+setCvapModalOpen\(true\)/);
  });
  it("the modal opens without creating or posting — Step 1 primary is disabled until a legal name is present (superseded by 15O two-step split, refined in 15P-1)", () => {
    // 15P-1: the radio-gate was removed. CREATE_NEW is now the
    // default mode, so the profile grid is visible on open. The
    // "nothing runs until valid" invariant is preserved via the
    // legal-name / picked-match check on canStep1Continue.
    expect(MODAL).toMatch(/useState<"CREATE_NEW" \| "USE_EXISTING">\("CREATE_NEW"\)/);
    expect(MODAL).toMatch(/const canStep1Continue =\s+vendorMode === "USE_EXISTING"[\s\S]{0,200}profile\.legalName\.trim\(\)\.length > 0/);
    expect(MODAL).toMatch(/disabled=\{!canStep1Continue \|\| submitting\}/);
  });
  it("the modal NEVER auto-populates an employee-forward sender as the vendor's main contact (superseded by 15O, refined in 15P-1)", () => {
    // 15P-1 replaced the standalone "Source" section with an
    // inline dim note. The rule and the wording still hold.
    expect(MODAL).toMatch(/internal forwarder, not populated as vendor contact/i);
    // 15O initialises the main-contact fields via a ternary on
    // sender.relationship — only VENDOR-domain senders populate.
    expect(MODAL).toMatch(/mainContactName: ap\.sender\.relationship === "VENDOR" \? ap\.sender\.name : null/);
    expect(MODAL).toMatch(/mainContactEmail: ap\.sender\.relationship === "VENDOR" \? ap\.sender\.email : null/);
  });
  it("Step 1 primary label adapts: 'Create vendor & continue' vs 'Use selected vendor' (superseded by 15O, refined in 15P-1)", () => {
    // 15P-1: the primary is now "Create vendor & continue" to make
    // it explicit the flow proceeds to AP coding.
    expect(MODAL).toMatch(/usingExisting \? "Use selected vendor" : "Create vendor & continue"/);
  });
});

describe("15L — hover-fill removal", () => {
  it("the .spectre-mc-item-surface:hover rule sets background: transparent (no grey wash)", () => {
    expect(GLOBALS_CSS).toMatch(/\.spectre-mc-item-surface:hover\s*\{\s*background: transparent;\s*\}/);
  });
  it("the pre-15L color-mix hover rule is gone", () => {
    // Extract just the surface:hover block (bounded by the closing
    // brace) so a later color-mix elsewhere in globals.css can't
    // false-trip this guard.
    const idx = GLOBALS_CSS.indexOf(".spectre-mc-item-surface:hover");
    expect(idx).toBeGreaterThan(-1);
    const block = GLOBALS_CSS.slice(idx, idx + 200);
    expect(block).not.toMatch(/color-mix/);
  });
  it("focus-visible outline stays intact for keyboard users", () => {
    expect(GLOBALS_CSS).toMatch(/\.spectre-mc-item-surface:focus-visible\s*\{\s*outline: 2px solid/);
  });
});

describe("15L — vendor search endpoint is tenant-scoped and never exposes bank details", () => {
  it("filters by activeClubId and returns 401 without a principal", () => {
    expect(VENDORS_SEARCH).toMatch(/const principal = await getCurrentPrincipal\(\)/);
    expect(VENDORS_SEARCH).toMatch(/if \(!principal\) return NextResponse\.json\(\{ matches: \[\] \}, \{ status: 401 \}\)/);
    expect(VENDORS_SEARCH).toMatch(/clubId,\s*OR: \[/);
  });
  it("select clause never asks for banking / EFT fields", () => {
    // The select is explicit. Grepping the FULL select block:
    const selectBlock = VENDORS_SEARCH.slice(VENDORS_SEARCH.indexOf("select: {"), VENDORS_SEARCH.indexOf("take: 10"));
    expect(selectBlock).not.toMatch(/bank|routing|iban|eft|remit/i);
  });
});
