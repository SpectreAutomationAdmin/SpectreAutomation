// Sprint 3 · Checkpoint 15Z (2026-08-04) — vendor-independence
// acceptance matrix + architecture guards.
//
// Founder rule §2: a reliable printed gross total must not be
// hidden because another field (currency, vendor match, GL, tax)
// is unresolved.
//
// Founder rule §3: four independent AP dimensions
//   documentFacts / vendorResolution / codingProposal / postingReadiness
// must not overwrite or blank each other.
//
// Founder rule §11: no acceptance-specific strings in production
// code; no vendor-match gates on amount / supported category.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(process.cwd(), "src");
const EMAIL_INTAKE_CARD = readFileSync(
  resolve(ROOT, "components/mission-control/EmailIntakeCard.tsx"),
  "utf8",
);
const PROJECTION = readFileSync(
  resolve(ROOT, "lib/mission-control/intelligence-review-intakes.ts"),
  "utf8",
);
const FIELD_QUALITY = readFileSync(
  resolve(ROOT, "lib/ap-intelligence/field-quality/index.ts"),
  "utf8",
);
const STRUCTURAL = readFileSync(
  resolve(ROOT, "lib/ap-intelligence/structural-quality.ts"),
  "utf8",
);
const POSITIONED = readFileSync(
  resolve(ROOT, "lib/ap-intelligence/positioned-extract.ts"),
  "utf8",
);
const ANALYSE = readFileSync(
  resolve(ROOT, "lib/ap-intelligence/analyse.ts"),
  "utf8",
);

// -----------------------------------------------------------------------------
// §2 — amount independence
// -----------------------------------------------------------------------------

describe("15Z · §2 amount displays regardless of currency", () => {
  it("formatAmountReadout falls back to bare-amount when currency is null", () => {
    // Source-contract: the guard is present and the bare-amount
    // helper exists.
    expect(EMAIL_INTAKE_CARD).toMatch(/formatBareAmount\s*\(/);
    // The former `if (!amount || !currency) return "—"` MUST be
    // replaced by the amount-only guard.
    expect(EMAIL_INTAKE_CARD).not.toMatch(/if \(!amount \|\| !currency\)\s*return "—"/);
  });

  it("callers do not gate the amount token on currency presence", () => {
    // The former pattern `ap.gross.amount && ap.gross.currency`
    // that hid the amount is gone.
    expect(EMAIL_INTAKE_CARD).not.toMatch(/ap\.gross\.amount && ap\.gross\.currency\s*\?\s*formatOperationalMoney/);
  });

  it("projection falls through to club default currency when extractor did not classify one", () => {
    expect(PROJECTION).toMatch(/loadClubDefaultCurrency\s*\(\s*clubId\s*\)/);
    expect(PROJECTION).toMatch(/ClubProfile\.defaultCurrency|clubProfile\.findFirst/);
  });
});

// -----------------------------------------------------------------------------
// §3 — four independent dimensions
// -----------------------------------------------------------------------------

describe("15Z · §3 four independent dimensions", () => {
  it("ApWorkCardFacts interface is exported with the four dimensions", () => {
    expect(PROJECTION).toMatch(/export interface ApWorkCardFacts/);
    expect(PROJECTION).toMatch(/documentFacts:\s*\{/);
    expect(PROJECTION).toMatch(/vendorResolution:\s*\{/);
    expect(PROJECTION).toMatch(/codingProposal:\s*\{/);
    expect(PROJECTION).toMatch(/postingReadiness:\s*\{/);
  });

  it("projection populates workCardFacts on the returned invoiceSummary", () => {
    expect(PROJECTION).toMatch(/workCardFacts:\s*buildWorkCardFacts/);
    expect(PROJECTION).toMatch(/function buildWorkCardFacts/);
  });

  it("documentFacts.grossTotalPresent computed independently from vendorResolution.state", () => {
    // Structural check: the grossTotalPresent line must derive ONLY
    // from extraction?.total, never from vendor state.
    // Skip the interface declaration; grab the computation inside
    // buildWorkCardFacts by preceding it with `!!` (boolean coercion
    // of extraction fields).
    const grossLine = PROJECTION.match(/grossTotalPresent:\s*!![^\n,]+/);
    expect(grossLine, "expected computed grossTotalPresent line (with !! coercion)").not.toBeNull();
    expect(grossLine![0]).not.toMatch(/vendor(Match|Resolution|State)/i);
    expect(grossLine![0]).toMatch(/extraction|total/);
  });

  it("vendorResolution enum uses the founder-approved names", () => {
    const enumMatch = PROJECTION.match(/vendorResolution:\s*\{\s*state:\s*[\s\S]*?\}/);
    // The enum values must include all four states from §3.
    expect(PROJECTION).toMatch(/"EXISTING_MATCH"/);
    expect(PROJECTION).toMatch(/"NEW_VENDOR_REQUIRED"/);
    expect(PROJECTION).toMatch(/"AMBIGUOUS_MATCH"/);
    expect(PROJECTION).toMatch(/"SUPPLIER_UNRESOLVED"/);
  });

  it("codingProposal enum uses the founder-approved names", () => {
    expect(PROJECTION).toMatch(/"SINGLE"/);
    expect(PROJECTION).toMatch(/"MULTIPLE"/);
    expect(PROJECTION).toMatch(/"PROVISIONAL"/);
    expect(PROJECTION).toMatch(/"UNSUPPORTED"/);
  });
});

// -----------------------------------------------------------------------------
// §11 — architecture guards
// -----------------------------------------------------------------------------

describe("15Z · §11 architecture guards", () => {
  const ACCEPTANCE_SPECIFIC_STRINGS = [
    "Oakcreek",
    "1091559",
    "1087769",
    "830535936RT0001",
    "3816 64th Avenue",
    "T2C 2B4",
    "cbb3900e",
    "5ed48c9d",
  ];

  const PRODUCTION_FILES = [
    { name: "EmailIntakeCard.tsx", body: EMAIL_INTAKE_CARD },
    { name: "intelligence-review-intakes.ts", body: PROJECTION },
    { name: "field-quality/index.ts", body: FIELD_QUALITY },
    { name: "structural-quality.ts", body: STRUCTURAL },
    { name: "positioned-extract.ts", body: POSITIONED },
    { name: "analyse.ts", body: ANALYSE },
  ];

  for (const s of ACCEPTANCE_SPECIFIC_STRINGS) {
    it(`no production file names the acceptance token "${s}"`, () => {
      for (const f of PRODUCTION_FILES) {
        expect(f.body, `${f.name} names the acceptance token "${s}"`).not.toContain(s);
      }
    });
  }

  it("no production file conditions on filename equality", () => {
    for (const f of PRODUCTION_FILES) {
      // Guard against pattern like `filename === "..." ` or
      // `filename.includes("1087")` — invoice-specific branches.
      expect(f.body).not.toMatch(/filename\s*(?:===|==)\s*["'][^"']+\.pdf["']/);
      expect(f.body).not.toMatch(/filename\.includes\(["'](?:1087|1091)/);
    }
  });

  it("no production file hard-codes an exact PDF x/y coordinate branch", () => {
    for (const f of PRODUCTION_FILES) {
      // Guard against hardcoded coordinate thresholds like `y > 194.672`
      // (the observed 1091559 supplier position). Fractional-coordinate
      // ranges are OK (documentClass thresholds); specific 3+ digit
      // decimals are the smell.
      expect(f.body).not.toMatch(/y\s*[<>=!]{1,2}\s*\d{3}\.\d{3,}/);
      expect(f.body).not.toMatch(/x\s*[<>=!]{1,2}\s*\d{3}\.\d{3,}/);
    }
  });

  it("provider-call idempotency: strategy-router refuses inline provider calls", () => {
    const router = readFileSync(
      resolve(ROOT, "lib/ap-intelligence/document-extractors/strategy-router.ts"),
      "utf8",
    );
    // ocrProviderCallsThisTurn must be exclusively 0 — the router
    // never invokes a paid provider synchronously.
    expect(router).toMatch(/ocrProviderCallsThisTurn:\s*0/);
    // The only allowed provider caller is the worker via
    // runTextractExpense from ocr/worker.ts. Strategy router imports
    // from ocr/enqueue (persistence + queue), not from
    // aws-textract-expense directly.
    expect(router).not.toMatch(/from ["'][^"']*aws-textract-expense["']/);
  });

  it("TEXT_HEALTHY docs invoke Textract only via the structural-escalation trigger", () => {
    // The escalation trigger only fires when structural quality
    // recommends AWS_TEXTRACT_EXPENSE.
    expect(ANALYSE).toMatch(/structural\.recommendedEscalation === "AWS_TEXTRACT_EXPENSE"/);
    expect(ANALYSE).toMatch(/requestOcrExtraction/);
    // The strategy router itself does NOT enqueue for TEXT_HEALTHY.
    const router = readFileSync(
      resolve(ROOT, "lib/ap-intelligence/document-extractors/strategy-router.ts"),
      "utf8",
    );
    // For TEXT_HEALTHY, router reads persisted extraction if
    // present but does not enqueue — proof: the TEXT_HEALTHY branch
    // has no `requestOcrExtraction` call.
    const healthyBranch = router.match(/if \(assessment\.documentClass === "TEXT_HEALTHY"\)[\s\S]*?^\s{0,4}\}\s*$/m);
    expect(healthyBranch).not.toBeNull();
    expect(healthyBranch![0]).not.toContain("requestOcrExtraction");
  });
});

// -----------------------------------------------------------------------------
// §6 — acceptance matrix (source-contract flavour, not full DB)
// -----------------------------------------------------------------------------

describe("15Z · §6 acceptance-matrix invariants (source contract)", () => {
  it("amount is not gated on vendor-match state anywhere in the card", () => {
    // No line of the form:
    //   ap.vendorMatch.state === "..." && (amount|gross)
    // or
    //   ap.gross.amount when vendor is X
    // that would hide amount based on vendor state.
    const suspicious = EMAIL_INTAKE_CARD.match(/ap\.vendorMatch\.state[\s\S]{0,60}(?:amount|gross)/g) ?? [];
    // Two allowed occurrences: display of matched-vendor name (line
    // 904 area) and workflow-state derived text. Neither should
    // wrap the amount cell.
    for (const s of suspicious) {
      expect(s, `amount must not be gated on vendorMatch.state: ${s.slice(0, 120)}`).not.toMatch(/vendorMatch\.state[\s\S]*?(gross\.amount|Amount)/);
    }
  });

  it("category label is derived from GL/allocation/capital signals, not from vendor-match", () => {
    // buildWorkCardFacts codingProposal.state may be UNSUPPORTED
    // when there is no coding signal, but it must NOT default to
    // UNSUPPORTED just because vendorResolution is NEW_VENDOR_REQUIRED
    // or SUPPLIER_UNRESOLVED.
    const codingState = PROJECTION.match(/const codingState:[\s\S]*?\}\)\(\);/);
    expect(codingState).not.toBeNull();
    // The IIFE that computes codingState must not read vendorResolutionState.
    expect(codingState![0]).not.toMatch(/vendorResolutionState/);
  });
});
