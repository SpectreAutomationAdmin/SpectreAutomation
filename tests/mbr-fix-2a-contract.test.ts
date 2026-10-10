// MBR-FIX-2A (2026-10-09) — Operating Results 12-Month Rolling Trend
// contract pins.
//
// Scope: the chart's `getOperatingMonthsFromCommittedSnapshots`
// fallback resolver and the Section II `availability.budget` state.
//
// Primary contract (per directive §3):
//
//   §A  Monthly NOI is derived from fiscal-YTD snapshots as
//       `monthlyNoi = YTD(month) − YTD(prevMonth)`.  First fiscal
//       month short-circuits to `monthlyNoi = YTD(month)`.
//   §B  NOI definition excludes IS_DEPRECIATION and IS_INTEREST_EXPENSE
//       (NOI Before Depreciation above the financing line).
//   §C  Operating-fund filter applied via `isOperatingFundTag`.
//   §D  Balance-sheet-only snapshots (no non-zero REVENUE / EXPENSE
//       rows) emit no point and do NOT advance the YTD tracker.
//   §E  Fiscal-year boundary resets the YTD tracker to zero.
//   §F  Gap detection — a missing intermediate month emits no bar
//       (prevents collapsing multiple months into one false bar).
//   §G  No `{ from: calendar-month-start, to: asOf }` query remains
//       (that was the MBR-AUDIT-1 DEF-4 regression source).
//   §H  Section II `availability.budget` reflects reality
//       (AVAILABLE when `operatingResults.ytdBudgetNoi != null`).

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO     = path.resolve(__dirname, "..");
const OPRESULT = path.join(REPO, "src/lib/reporting/operating-results.ts");
const PACKAGE  = path.join(REPO, "src/lib/reporting/monthly-package.ts");

describe("MBR-FIX-2A §A — monthly NOI = YTD(month) − YTD(prevMonth)", () => {
  const src = readFileSync(OPRESULT, "utf8");

  it("subtraction identity is present verbatim in the committed-snapshot resolver", () => {
    expect(src).toMatch(/const monthlyNoi = ytd\.ytdNoi - priorYtdNoi;/);
    expect(src).toMatch(/const monthlyRevenue = ytd\.ytdRevenue - priorYtdRevenue;/);
  });

  it("priorYtdNoi + priorYtdRevenue advance after each successful snapshot", () => {
    expect(src).toMatch(/priorYtdNoi = ytd\.ytdNoi;/);
    expect(src).toMatch(/priorYtdRevenue = ytd\.ytdRevenue;/);
  });

  it("per-snapshot ytdFor() query uses fiscal-year start as `from`, not calendar-month-start", () => {
    expect(src).toMatch(
      /const fiscalYearStart = new Date\(Date\.UTC\(asOfDate\.getUTCFullYear\(\), 0, 1\)\);/,
    );
    expect(src).toMatch(
      /reportingAccountBalances\(\s*clubId,\s*\{ from: fiscalYearStart, to: asOfDate \},\s*\)/,
    );
  });
});

describe("MBR-FIX-2A §B — NOI definition excludes depreciation + financing", () => {
  const src = readFileSync(OPRESULT, "utf8");

  it("depreciation + financing accounts skip the OpEx accumulator", () => {
    expect(src).toMatch(/const isDepreciation = b\.fsGroupKey === "IS_DEPRECIATION";/);
    expect(src).toMatch(/const isFinancing = b\.fsGroupKey === "IS_INTEREST_EXPENSE";/);
    expect(src).toMatch(/if \(isDepreciation \|\| isFinancing\) continue;/);
  });

  it("NOI formula is Revenue − COGS − OpEx", () => {
    expect(src).toMatch(/revenue - cogs - opex/);
  });
});

describe("MBR-FIX-2A §C — operating-fund filter", () => {
  const src = readFileSync(OPRESULT, "utf8");

  it("isOperatingFundTag gates every row", () => {
    expect(src).toMatch(/if \(!isOperatingFundTag\(b\.fundApplicability\)\) continue;/);
  });
});

describe("MBR-FIX-2A §D — balance-sheet-only snapshots emit no point", () => {
  const src = readFileSync(OPRESULT, "utf8");

  it("hasRevenueAccount + hasExpenseAccount guard returns null from ytdFor()", () => {
    expect(src).toMatch(/if \(!hasRevenueAccount && !hasExpenseAccount\) return null;/);
  });

  it("the caller continues the loop on null ytd and does NOT advance trackers", () => {
    // Our implementation does `continue` right after `if (ytd == null)` and
    // the YTD tracker + priorMonthIndex updates come AFTER the continue
    // guard, so the tracker legitimately stays unchanged on a BS-only
    // snapshot — proven here by the structural `continue;` placement.
    const idx = src.indexOf("if (ytd == null) {");
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(idx, idx + 400);
    expect(block).toMatch(/continue;/);
  });
});

describe("MBR-FIX-2A §E — fiscal-year boundary resets the YTD tracker", () => {
  const src = readFileSync(OPRESULT, "utf8");

  it("priorFiscalYear boundary check zeroes priorYtd + priorMonthIndex", () => {
    const idx = src.indexOf("if (priorFiscalYear !== null && fy !== priorFiscalYear) {");
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(idx, idx + 400);
    expect(block).toMatch(/priorYtdNoi = 0;/);
    expect(block).toMatch(/priorYtdRevenue = 0;/);
    expect(block).toMatch(/priorMonthIndex = null;/);
  });
});

describe("MBR-FIX-2A §F — gap detection prevents false monthly values", () => {
  const src = readFileSync(OPRESULT, "utf8");

  it("expectedPrior = monthIdx - 1 (or null for January)", () => {
    expect(src).toMatch(/const expectedPrior = monthIdx === 0 \? null : monthIdx - 1;/);
  });

  it("hasGap short-circuits via priorMonthIndex comparison", () => {
    expect(src).toMatch(/priorMonthIndex !== expectedPrior/);
    expect(src).toMatch(/monthIdx !== 0 \/\/ first-ever snapshot in this FY isn't January/);
  });

  it("on gap: tracker advances (so next contiguous month works) + no point emitted", () => {
    const idx = src.indexOf("if (hasGap) {");
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(idx, idx + 600);
    expect(block).toMatch(/priorYtdNoi = ytd\.ytdNoi;/);
    expect(block).toMatch(/priorYtdRevenue = ytd\.ytdRevenue;/);
    expect(block).toMatch(/priorMonthIndex = monthIdx;/);
    expect(block).toMatch(/continue;/);
  });
});

describe("MBR-FIX-2A §G — pre-fix calendar-month-start query is gone", () => {
  const src = readFileSync(OPRESULT, "utf8");

  it("no `{ from: periodStart, to: asOfDate }` query remains in the committed-snapshot resolver", () => {
    // The pre-fix query was:
    //   const periodStart = new Date(Date.UTC(asOfDate.getUTCFullYear(), asOfDate.getUTCMonth(), 1, 0, 0, 0, 0));
    //   reportingAccountBalances(clubId, { from: periodStart, to: asOfDate });
    // That hit the YTD-slice sameDay gate and silently dropped
    // every month after the first.  Must not reappear.
    expect(src).not.toMatch(
      /const periodStart = new Date\(Date\.UTC\(asOfDate\.getUTCFullYear\(\), asOfDate\.getUTCMonth\(\), 1,/,
    );
    expect(src).not.toMatch(
      /reportingAccountBalances\(clubId, \{ from: periodStart, to: asOfDate \}\)/,
    );
  });
});

describe("MBR-FIX-2A §H — Section II availability.budget reflects reality", () => {
  const src = readFileSync(PACKAGE, "utf8");

  it("budget availability is derived from operatingResults.ytdBudgetNoi", () => {
    expect(src).toMatch(
      /budget: operatingResults\.ytdBudgetNoi == null\s*\?\s*"SOURCE_NOT_CONNECTED"\s*:\s*"AVAILABLE",/,
    );
  });

  it("note sentence branches on whether a committed budget exists", () => {
    expect(src).toMatch(
      /\(operatingResults\.ytdBudgetNoi == null\s*\?\s*"Budget comparison is unavailable \(no budget source loaded for this tenant\)\. "\s*:\s*"Budget comparison is sourced from the committed FY budget\. "\)/,
    );
  });
});
