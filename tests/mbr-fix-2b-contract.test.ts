// MBR-FIX-2B (2026-10-10) — Executive Operations briefing restoration.
//
// Root defect: `computeOperationsPartialAvailability` queried
// `reportingAccountBalances({ from: periodStart, to: periodEnd })`
// where `periodStart = current-month start`.  Jonas TB snapshots
// carry `snapshot.periodStart = fiscal-year start`, so the YTD-slice
// `sameDay(periodStart, filter.from)` gate silently dropped every
// income-statement row on Feb+ periods, leaving the Operations
// briefing stuck at "Unavailable".  This is the same DEF-4 pattern
// MBR-FIX-1 corrected in the ratio-registry.
//
// Contract pins:
//   §A  fiscal-YTD query — `from: Date.UTC(year, 0, 1)` → periodEnd
//   §B  authoritative NOI definition — operating-fund only,
//       IS_DEPRECIATION + IS_INTEREST_EXPENSE carved out of OpEx
//   §C  operating-fund gate applied to Revenue + Dues + Expense
//   §D  budget resolver wired via `resolveBudgetIncomeStatement`
//   §E  variance helpers emit DERIVED when both sides exist
//   §F  reactive narrative in `buildOperationsBriefing` interpolates
//       variance figures and suppresses the stale hardcoded
//       "Budget comparison unavailable" sentence when budget is
//       DERIVED
//   §G  stale sub-label "Jan 2026 Jonas TB" is gone from coverMetrics

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO    = path.resolve(__dirname, "..");
const PARTIAL = path.join(REPO, "src/lib/reporting/january-partial-availability.ts");
const PACKAGE = path.join(REPO, "src/lib/reporting/monthly-package.ts");

describe("MBR-FIX-2B §A — fiscal-YTD query", () => {
  const src = readFileSync(PARTIAL, "utf8");

  it("derives fiscalYearStart from periodEnd.getUTCFullYear()", () => {
    expect(src).toMatch(
      /const fiscalYearStart = new Date\(Date\.UTC\(periodEnd\.getUTCFullYear\(\), 0, 1\)\);/,
    );
  });

  it("reportingAccountBalances is called with `from: fiscalYearStart, to: periodEnd`", () => {
    expect(src).toMatch(
      /reportingAccountBalances\(\s*clubId,\s*\{ from: fiscalYearStart, to: periodEnd \},\s*\)/,
    );
  });

  it("the pre-fix `from: periodStart` call is gone", () => {
    expect(src).not.toMatch(/reportingAccountBalances\(\s*clubId,\s*\{ from: periodStart, to: periodEnd \},\s*\)/);
  });
});

describe("MBR-FIX-2B §B — authoritative NOI (IS_DEPRECIATION + IS_INTEREST_EXPENSE carved out)", () => {
  const src = readFileSync(PARTIAL, "utf8");

  it("depreciation + financing expenses are excluded from OpEx accumulator", () => {
    expect(src).toMatch(/if \(key === "IS_DEPRECIATION" \|\| key === "IS_INTEREST_EXPENSE"\) continue;/);
  });

  it("NOI = Revenue − COGS − OpEx (same identity as the Operating Results chart)", () => {
    expect(src).toMatch(/const noi = revenue\.minus\(cogs\)\.minus\(opex\);/);
  });
});

describe("MBR-FIX-2B §C — operating-fund gate", () => {
  const src = readFileSync(PARTIAL, "utf8");

  it("isOperating(fundApplicability) helper exists", () => {
    expect(src).toMatch(/const isOperating = \(fund: string \| null\): boolean => \{/);
    expect(src).toMatch(/\.includes\("OPERATING"\)/);
  });

  it("Revenue, OpEx, and Dues loops all gate on isOperating", () => {
    // 3 call sites expected inside computeOperationsPartialAvailability.
    const matches = src.match(/if \(!isOperating\(b\.fundApplicability\)\) continue;/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });
});

describe("MBR-FIX-2B §D — budget resolver wired", () => {
  const src = readFileSync(PARTIAL, "utf8");

  it("resolveBudgetIncomeStatement is imported dynamically inside the resolver", () => {
    expect(src).toMatch(/await import\("@\/lib\/reporting\/budget-resolver"\)/);
    expect(src).toMatch(/resolveBudgetIncomeStatement\(/);
  });

  it("budget call passes fiscalYear + throughMonth (= periodEnd.month + 1)", () => {
    expect(src).toMatch(/fiscalYear: periodEnd\.getUTCFullYear\(\),/);
    expect(src).toMatch(/const throughMonth = periodEnd\.getUTCMonth\(\) \+ 1;/);
    expect(src).toMatch(/throughMonth,/);
  });

  it("budget provenance flips to DERIVED when b.budget is non-null", () => {
    expect(src).toMatch(/availability: "DERIVED",\s*source: `Committed FY\$\{periodEnd\.getUTCFullYear\(\)\} Budget v\$\{b\.budget\.version\}/);
  });
});

describe("MBR-FIX-2B §E — variance derivations", () => {
  const src = readFileSync(PARTIAL, "utf8");

  it("revenueVariance = actual − budget", () => {
    expect(src).toMatch(/revenueVariance = \{ value: d, provenance: \{ availability: "DERIVED", source: "Actual YTD Revenue − Budget YTD Revenue" \} \};/);
  });

  it("noiVariance = actual − budget", () => {
    expect(src).toMatch(/noiVariance = \{ value: d, provenance: \{ availability: "DERIVED", source: "Actual YTD NOI − Budget YTD NOI" \} \};/);
  });

  it("variance % uses |budget| as the denominator (safe division)", () => {
    expect(src).toMatch(/\(d \/ Math\.abs\(budgetRevenueVal\)\) \* 100,/);
    expect(src).toMatch(/\(d \/ Math\.abs\(budgetNoiVal\)\) \* 100,/);
  });

  it("budgetRevenue / budgetNoi / revenueVariance / noiVariance / status all appear on the Operations return", () => {
    // File carries two `return {` blocks (Operations + Financial
    // Health).  Scope to the Operations one by anchoring on the
    // nearby `duesToRevenuePct:` field.
    const anchor = src.lastIndexOf("duesToRevenuePct:");
    expect(anchor).toBeGreaterThan(0);
    const returnStart = src.lastIndexOf("return {", anchor);
    expect(returnStart).toBeGreaterThan(0);
    const block = src.slice(returnStart, returnStart + 3000);
    expect(block).toMatch(/budgetRevenue:/);
    expect(block).toMatch(/budgetNoi:/);
    expect(block).toMatch(/revenueVariance,/);
    expect(block).toMatch(/revenueVariancePct,/);
    expect(block).toMatch(/noiVariance,/);
    expect(block).toMatch(/noiVariancePct,/);
    expect(block).toMatch(/budgetComparison: budgetProv,/);
  });
});

describe("MBR-FIX-2B §F — reactive narrative in buildOperationsBriefing", () => {
  const src = readFileSync(PACKAGE, "utf8");

  it("fmtVariance helper + budgetAvailable gate present", () => {
    expect(src).toMatch(/const fmtVariance = \(v: number\): string => \{/);
    expect(src).toMatch(/const budgetAvailable = partial\?\.budgetComparison\.availability === "DERIVED";/);
  });

  it("revenue variance sentence interpolates fmtVariance + pct", () => {
    expect(src).toMatch(/Revenue variance \$\{fmtVariance\(d\)\} \(\$\{Math\.abs\(pct\)\.toFixed\(1\)\}% \$\{direction\} Budget of /);
  });

  it("NOI variance sentence interpolates fmtVariance + pct", () => {
    expect(src).toMatch(/NOI variance \$\{fmtVariance\(d\)\} \(\$\{Math\.abs\(pct\)\.toFixed\(1\)\}% \$\{direction\} Budget of /);
  });

  it("the pre-fix hardcoded 'Budget comparison is unavailable' sentence is gone", () => {
    expect(src).not.toContain('"Budget comparison is unavailable — no budget source has been loaded for this tenant."');
  });

  it("the fallback sentence is only emitted when !budgetAvailable", () => {
    expect(src).toMatch(/if \(!budgetAvailable\) \{/);
    expect(src).toMatch(/Budget comparison unavailable — no committed Budget for this fiscal year on this tenant\./);
  });
});

describe("MBR-FIX-2B §G — stale sub-labels replaced", () => {
  const src = readFileSync(PACKAGE, "utf8");

  it("coverMetrics no longer sub-labels Revenue with \"Jan 2026 Jonas TB\"", () => {
    expect(src).not.toMatch(/"Jan 2026 Jonas TB"/);
  });

  it("coverMetrics Revenue sub = \"Fiscal YTD · committed TB\" when DERIVED", () => {
    expect(src).toMatch(/sub: partial\?\.revenue\.provenance\.availability === "DERIVED"\s*\?\s*"Fiscal YTD · committed TB"/);
  });

  it("coverMetrics NOI sub labels the authoritative definition", () => {
    expect(src).toMatch(/"Rev − COGS − OpEx \(ex-dep, ex-fin\)"/);
  });
});
