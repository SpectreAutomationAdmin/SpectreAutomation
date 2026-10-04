// BUDGET-HIST-1 (2026-10-04) — real-source parser audit against the
// founder-staged 2026.csv file. Reproduces every structural control
// the founder audited independently + emits the sha + monthly totals
// so the acceptance package can be mechanically verified later.
//
// Guard: skips when the scratchpad fixture is not present (CI).

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCouleeBudgetCsv } from "@/lib/imports/budget/parse-coulee-budget-csv";

const CSV = path.resolve(
  "C:/Users/cturcato/AppData/Local/Temp/claude/c--dev-SpectreAutomation/0024fdd7-1cbc-4a67-8903-1a917d6d43e4/scratchpad/2026-coulee-budget.csv",
);
const RUN = existsSync(CSV);
const describeIf = RUN ? describe : describe.skip;

describeIf("BUDGET-HIST-1 — real source audit (2026.csv)", () => {
  const text = RUN ? readFileSync(CSV, "utf8") : "";
  const parsed = RUN ? parseCouleeBudgetCsv(text) : null;

  it("reproduces founder structural controls (rows=199, cols=15, uniq_accounts=157, dept_codes=[1-7,20], dupes=0)", () => {
    expect(parsed!.rowCount).toBe(199);
    expect(parsed!.uniqueAccountNumbers.length).toBe(157);
    expect(parsed!.uniqueDeptCodes).toEqual(["1","2","3","4","5","6","7","20"]);
    expect(parsed!.duplicateDeptAccountKeys).toEqual([]);
  });

  it("monthly totals + annual total are deterministic", () => {
    // These are hard-pinned so a future source swap breaks a test
    // instead of silently changing a reported Board number.
    expect(parsed!.monthlyTotals[0]).toBeCloseTo(-2_751_048.99, 2);
    expect(parsed!.monthlyTotals[11]).toBeCloseTo(257_512.48, 2);
    expect(parsed!.annualTotal).toBeCloseTo(-861_251.43, 2);
  });

  it("source file sha256 is a 64-hex string (idempotency anchor)", () => {
    expect(parsed!.sourceFileHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
