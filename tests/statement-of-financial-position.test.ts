// Statement of Financial Position (Balance Sheet) service tests —
// shape + reactive notes + stewardship ratio tones + reconciliation
// + period sensitivity. Per CLAUDE.md the React surface renders
// only; this suite proves the service owns all numerics, tones,
// notes commentary, AND the Total Assets = Total L&E reconciliation.
//
// As of the Reporting-Ledger refactor (chapter VII is the first
// fully-ledger-driven section) every value in the rendered output
// traces back to a `BalanceSheetSnapshot` line. The Silver Springs
// wrapper still seeds the snapshot via
// `src/lib/reporting/seeds/silver-springs-balance-sheet-seed.ts` so
// the rendered output remains visually identical to the Saguaro
// reference.

import { describe, it, expect } from "vitest";

import {
  buildSilverSpringsStatementOfFinancialPosition,
  buildBalanceSheetNotes,
} from "@/lib/reporting/statement-of-financial-position";
import { buildReportingPeriod } from "@/lib/reporting/reporting-period";

const MAY_2026 = buildReportingPeriod(new Date(Date.UTC(2026, 4, 31)));
const SILVER_SPRINGS = "Silver Springs Golf & Country Club";

describe("buildBalanceSheetNotes — reactive notes generator", () => {
  it("ships note 1 (structural), note 2 (PP&E aging quoting snapshot ratio), deferred-init-fee note when present, and a working-capital note", () => {
    const notes = buildBalanceSheetNotes({
      netToGrossPpePctLabel: "44%",
      depreciatedPctLabel: "56%",
      grossReplacementCostLabel: "$7.9M",
      deferredInitiationFeeLabel: "$820,000",
      workingCapitalRatio: 1.95,
      netToGrossPpe: 0.44,
      hasDeferredInitFees: true,
    });
    expect(notes).toHaveLength(4);
    expect(notes[0].number).toBe(1);
    expect(notes[0].body).toMatch(/two-fund structure/);
    expect(notes[1].number).toBe(2);
    expect(notes[1].body).toMatch(/Net-to-Gross PP&E ratio of 44%/);
    expect(notes[1].body).toMatch(/approximately 56% depreciated/);
    expect(notes[1].body).toMatch(/replacement cost of approximately \$7\.9M/);
    expect(notes[2].number).toBe(3);
    expect(notes[2].body).toMatch(/Deferred initiation fees of \$820,000/);
    expect(notes[3].number).toBe(4);
    expect(notes[3].body).toMatch(/Working capital ratio of 1\.95x/);
  });

  it("omits the deferred-init-fee note when the snapshot has no such balance", () => {
    const notes = buildBalanceSheetNotes({
      netToGrossPpePctLabel: "44%",
      depreciatedPctLabel: "56%",
      grossReplacementCostLabel: "$7.9M",
      deferredInitiationFeeLabel: "$0",
      workingCapitalRatio: 1.95,
      netToGrossPpe: 0.44,
      hasDeferredInitFees: false,
    });
    expect(notes).toHaveLength(3);
    // Working capital note shifts to slot 3.
    expect(notes[2].body).toMatch(/Working capital ratio/);
    expect(notes.find((n) => /Deferred initiation fees/.test(n.body))).toBeUndefined();
  });

  it("REGRESSION: PP&E note BRANCHES based on snapshot PP&E age — heavily-depreciated vs young", () => {
    const heavy = buildBalanceSheetNotes({
      netToGrossPpePctLabel: "35%",
      depreciatedPctLabel: "65%",
      grossReplacementCostLabel: "$9.4M",
      deferredInitiationFeeLabel: "$0",
      workingCapitalRatio: 1.95,
      netToGrossPpe: 0.35,
      hasDeferredInitFees: false,
    });
    const young = buildBalanceSheetNotes({
      netToGrossPpePctLabel: "75%",
      depreciatedPctLabel: "25%",
      grossReplacementCostLabel: "$9.4M",
      deferredInitiationFeeLabel: "$0",
      workingCapitalRatio: 1.95,
      netToGrossPpe: 0.75,
      hasDeferredInitFees: false,
    });
    expect(heavy[1].body).toMatch(/35%/);
    expect(heavy[1].body).toMatch(/materially aged/);
    expect(young[1].body).toMatch(/75%/);
    expect(young[1].body).toMatch(/relatively young/);
    expect(heavy[1].body).not.toBe(young[1].body);
  });

  it("REGRESSION: working-capital note BRANCHES on ratio bands (< 1.0 / 1.0–1.5 / 1.5–2.5 / > 2.5)", () => {
    const branch = (wc: number) =>
      buildBalanceSheetNotes({
        netToGrossPpePctLabel: "50%",
        depreciatedPctLabel: "50%",
        grossReplacementCostLabel: "$5M",
        deferredInitiationFeeLabel: "$0",
        workingCapitalRatio: wc,
        netToGrossPpe: 0.5,
        hasDeferredInitFees: false,
      }).at(-1)!.body;
    expect(branch(0.5)).toMatch(/below the 1\.0x liquidity floor/);
    expect(branch(1.2)).toMatch(/below the 1\.5x policy target/);
    expect(branch(2.0)).toMatch(/comfortably exceeds the 1\.5x policy target/);
    expect(branch(3.0)).toMatch(/well above the 1\.5x policy target/);
  });
});

describe("buildSilverSpringsStatementOfFinancialPosition — service contract", () => {
  it("ships the Saguaro header chrome — period flows from ReportingPeriod (no Q1/March hardcodes)", () => {
    const sofp = buildSilverSpringsStatementOfFinancialPosition({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(sofp.eyebrow).toBe("Silver Springs Golf & Country Club · Balance Sheet");
    expect(sofp.title).toBe("Statement of Financial Position");
    expect(sofp.periodLabel).toBe("May 2026 · For the period ended May 31, 2026 · Year to Date");
    expect(sofp.periodLabel).not.toMatch(/Q1/);
    expect(sofp.periodLabel).not.toMatch(/March/);
    expect(sofp.statementNumber).toBe("Statement 09 of 14");
    expect(sofp.documentChip).toBe("Balance Sheet");
    expect(sofp.preparedFor).toBe("Finance Committee");
    expect(sofp.introNote).toMatch(/The club's complete financial position/);
  });

  it("column headers — Current / Comparative period derived from ReportingPeriod (May 2026 → May 2026 / May 2025)", () => {
    const sofp = buildSilverSpringsStatementOfFinancialPosition({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(sofp.assetsColumnHeaders.category).toBe("Assets");
    expect(sofp.assetsColumnHeaders.current).toBe("May 2026");
    expect(sofp.assetsColumnHeaders.comparative).toBe("May 2025");
    expect(sofp.liabilitiesColumnHeaders.category).toBe("Liabilities & Members' Equity");
    expect(sofp.liabilitiesColumnHeaders.current).toBe("May 2026");
    expect(sofp.liabilitiesColumnHeaders.comparative).toBe("May 2025");
  });

  it("REGRESSION: column headers update with the reporting period (Dec 2027 → Dec 2027 / Dec 2026)", () => {
    const DEC_2027 = buildReportingPeriod(new Date(Date.UTC(2027, 11, 31)));
    const sofp = buildSilverSpringsStatementOfFinancialPosition({ clubName: SILVER_SPRINGS, period: DEC_2027 });
    expect(sofp.periodLabel).toBe("December 2027 · For the period ended December 31, 2027 · Year to Date");
    expect(sofp.assetsColumnHeaders.current).toBe("Dec 2027");
    expect(sofp.assetsColumnHeaders.comparative).toBe("Dec 2026");
    expect(sofp.liabilitiesColumnHeaders.current).toBe("Dec 2027");
    expect(sofp.liabilitiesColumnHeaders.comparative).toBe("Dec 2026");
  });

  it("Assets section ships all 3 sub-sections + their bands + a Total Assets row", () => {
    const sofp = buildSilverSpringsStatementOfFinancialPosition({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const kinds = sofp.assetsRows.map((r) => `${r.kind}:${r.key}`);
    expect(kinds).toContain("section-band-operating:band-current-assets");
    expect(kinds).toContain("subtotal:total-current-assets");
    expect(kinds).toContain("section-band-capital:band-capital-fund-assets");
    expect(kinds).toContain("subtotal:total-capital-fund-assets");
    expect(kinds).toContain("section-band-operating:band-ppe");
    expect(kinds).toContain("subtotal:net-ppe");
    expect(kinds).toContain("total:total-assets");
  });

  it("Liabilities & Equity section ships all 3 sub-sections + Total Liabilities mid + Total L&E final", () => {
    const sofp = buildSilverSpringsStatementOfFinancialPosition({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const kinds = sofp.liabilitiesEquityRows.map((r) => `${r.kind}:${r.key}`);
    expect(kinds).toContain("section-band-operating:band-current-liabilities");
    expect(kinds).toContain("subtotal:total-current-liabilities");
    expect(kinds).toContain("section-band-capital:band-long-term-liabilities");
    expect(kinds).toContain("subtotal:total-long-term-liabilities");
    expect(kinds).toContain("total-mid:total-liabilities");
    expect(kinds).toContain("section-band-operating:band-members-equity");
    expect(kinds).toContain("total-mid:total-members-equity");
    expect(kinds).toContain("total:total-liabilities-and-equity");
  });

  it("seeded values flow from the BalanceSheetSnapshot — cash, reserve fund, accumulated depreciation, totals", () => {
    const sofp = buildSilverSpringsStatementOfFinancialPosition({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    // Row keys are now derived from account codes (acct-XXXX) since
    // the section is snapshot-driven. Cash = 1010, Reserve Fund = 1810,
    // Accum Depr = 1990.
    const cash = sofp.assetsRows.find((r) => r.key === "acct-1010")!;
    expect(cash.current).toBe(1_896_328);
    expect(cash.comparative).toBe(1_842_100);
    const reserve = sofp.assetsRows.find((r) => r.key === "acct-1810")!;
    expect(reserve.current).toBe(4_820_000);
    const accumDep = sofp.assetsRows.find((r) => r.key === "accum-depr-1990")!;
    expect(accumDep.current).toBe(-20_480_000);
    expect(accumDep.comparative).toBe(-19_450_000);
    const totalAssets = sofp.assetsRows.find((r) => r.key === "total-assets")!;
    expect(totalAssets.current).toBe(30_201_528);
    expect(totalAssets.comparative).toBe(29_218_500);
  });

  it("RECONCILIATION: Total Assets equals Total Liabilities & Members' Equity in the seeded period", () => {
    const sofp = buildSilverSpringsStatementOfFinancialPosition({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(sofp.reconciliation.balances).toBe(true);
    expect(sofp.reconciliation.totalAssetsCurrent).toBe(30_201_528);
    expect(sofp.reconciliation.totalLiabilitiesAndEquityCurrent).toBe(30_201_528);
    expect(sofp.reconciliation.totalAssetsCurrent).toBe(sofp.reconciliation.totalLiabilitiesAndEquityCurrent);
  });

  it("Stewardship ratios ship the 6 reference rows with the correct tone classification", () => {
    const sofp = buildSilverSpringsStatementOfFinancialPosition({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const tones = Object.fromEntries(sofp.stewardshipRatios.rows.map((r) => [r.key, r.tone]));
    expect(tones["working-capital-ratio"]).toBe("favorable");
    expect(tones["ar-current-rate"]).toBe("favorable");
    // Dues-to-Revenue at 65.9% above the 60% floor renders as risk in the Saguaro reference.
    expect(tones["dues-to-revenue-ratio"]).toBe("risk");
    // Reserve coverage gets the slate-blue capital tone.
    expect(tones["reserve-coverage-ratio"]).toBe("capital");
    // Net-to-Gross PP&E at 44% sits below the 50% floor → risk.
    expect(tones["net-to-gross-ppe-ratio"]).toBe("risk");
    expect(tones["debt-service-coverage"]).toBe("favorable");
  });

  it("Stewardship ratios — bar geometry and pass/fail flag track the underlying values", () => {
    const sofp = buildSilverSpringsStatementOfFinancialPosition({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const wc = sofp.stewardshipRatios.rows.find((r) => r.key === "working-capital-ratio")!;
    expect(wc.actualLabel).toBe("1.95x");
    expect(wc.targetLabel).toBe("≥1.5x");
    expect(wc.passesTarget).toBe(true);
    // 1.95x / 3.0x scale ≈ 0.65 bar fill; 1.5x / 3.0x = 0.50 target tick.
    expect(wc.barFillPct).toBeCloseTo(1.95 / 3, 2);
    expect(wc.barTargetPct).toBeCloseTo(0.5, 3);

    const ppe = sofp.stewardshipRatios.rows.find((r) => r.key === "net-to-gross-ppe-ratio")!;
    expect(ppe.passesTarget).toBe(false);
    // 44% Reserve-Study override preserves the Saguaro visual semantic.
    expect(ppe.actualLabel).toBe("44%");
  });

  it("Balance sheet notes are REACTIVE — note 2 quotes the seeded net-to-gross PP&E ratio + complementary depreciated %; note 4 quotes working capital", () => {
    const sofp = buildSilverSpringsStatementOfFinancialPosition({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(sofp.balanceSheetNotes.notes).toHaveLength(4);
    expect(sofp.balanceSheetNotes.notes[1].body).toMatch(/44%/);
    expect(sofp.balanceSheetNotes.notes[1].body).toMatch(/56% depreciated/);
    expect(sofp.balanceSheetNotes.notes[2].body).toMatch(/\$820,000/);
    expect(sofp.balanceSheetNotes.notes[3].body).toMatch(/1\.95x/);
  });
});
