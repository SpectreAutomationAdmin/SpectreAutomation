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

describe("15L — AP projection cache must invalidate when the COA changes", () => {
  it("cache key includes a per-club COA revision fingerprint", () => {
    expect(IRI).toMatch(/apSummaryCacheKey\(intakeId: string, docId: string \| null, coaRevision: string\)/);
    expect(IRI).toMatch(/`\$\{intakeId\}::\$\{docId \?\? "no-doc"\}::\$\{coaRevision\}`/);
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
    expect(CARD).toMatch(/"VENDOR_MATCH_REQUIRED":\s+return \{ label: "Create vendor & post" \}/);
  });
  it("card wires the modal only for VENDOR_MATCH_REQUIRED; other workflows keep the pre-15L expand path", () => {
    expect(CARD).toMatch(/if \(ap\?\.workflowState === "VENDOR_MATCH_REQUIRED"\) \{\s+setCvapModalOpen\(true\)/);
  });
  it("the modal opens without creating or posting — the confirm button is disabled until vendor mode + coding are filled", () => {
    expect(MODAL).toMatch(/useState<"CREATE_NEW" \| "USE_EXISTING" \| null>/);
    expect(MODAL).toMatch(/const canConfirm =[\s\S]{0,400}vendorMode !== null/);
    expect(MODAL).toMatch(/coding\.glAccountNumber\.trim\(\)\.length > 0/);
    expect(MODAL).toMatch(/disabled=\{!canConfirm \|\| submitting \|\| !onConfirm\}/);
  });
  it("the modal NEVER auto-populates an employee-forward sender as the vendor's main contact", () => {
    // Explicit note in the source + the safety guard: the initial
    // profile.email is null unless the sender was on the vendor's
    // own domain. We assert the safety comment lives in the
    // component so a future refactor can't silently regress.
    expect(MODAL).toMatch(/internal forwarders are provenance only/i);
    // Initial profile.email defaults to null — comes from the
    // extraction, not from ap.sender.email.
    expect(MODAL).toMatch(/email: null,\s+addressLine1: null/);
  });
  it("the modal's primary label adapts: 'Create vendor & post' vs 'Use selected vendor & post'", () => {
    expect(MODAL).toMatch(/const primaryLabel =[\s\S]{0,200}Use selected vendor & post/);
    expect(MODAL).toMatch(/: "Create vendor & post"/);
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
