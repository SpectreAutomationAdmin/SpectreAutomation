// Capital Stewardship Scorecard service — Jonas-readiness tests.
//
// Per the Jonas-readiness audit (Tier 2, items 5–9), the capital
// scorecard previously consumed `SILVER_SPRINGS_CAPITAL_INPUTS` as
// a hardcoded constant, the `equity-cagr` row carried a hardcoded
// `status: "on-track"` literal, and the `long-term-debt-equity`
// row fell back to a misleading `"on-track"` when `longTermDebt`
// was null. These tests prove the rebuilt
// `CapitalScorecardSnapshot` contract is the live path:
//
//   1. Four contrasting datasets (healthy / aging-facility /
//      debt-laden / capital-shortfall) produce DIFFERENT row
//      VALUES + STATUSES.
//   2. Per-row `dataSource` reads from the snapshot's per-row
//      provenance map.
//   3. Equity Growth CAGR row STATUS is now derived from
//      snapshot.equity bps; flips on-track → monitor → action
//      across the configured CAGR thresholds.
//   4. Long-Term Debt-to-Equity row STATUS is now derived:
//      null debt → monitor (was: misleading on-track); known
//      debt classified by ratio.
//   5. `monthly-package.ts` no longer consumes
//      `SILVER_SPRINGS_CAPITAL_INPUTS` directly — the consumption
//      path flows through `buildDemoCapitalScorecardSnapshot()`.
//   6. The accounting-atoms factory accepts typed atoms and
//      computes worse-of provenance.

import { describe, it, expect } from "vitest";

import { buildCapitalScorecardData } from "@/lib/reporting/scorecard-metrics";
import {
  buildDemoCapitalScorecardSnapshot,
  buildCapitalScorecardSnapshotFromAccounting,
  classifyEquityCagrStatus,
  classifyLongTermDebtStatus,
  type AccountingCapitalScorecardAtoms,
  type CapitalScorecardSnapshot,
} from "@/lib/reporting/capital-scorecard-service";

const EQ_LABELS_STRONG = {
  actualCagrLabel:      "7.4%",
  bestInClassCagrLabel: "5.5%",
};
const EQ_LABELS_WEAK = {
  actualCagrLabel:      "2.1%",
  bestInClassCagrLabel: "5.5%",
};

// ---------------------------------------------------------------------------
// Four contrasting datasets exercising different scorecard rows
// ---------------------------------------------------------------------------

/** HEALTHY — every capital signal in the green band. */
function makeHealthySnapshot(): CapitalScorecardSnapshot {
  return {
    inputs: {
      totalAssets:                40_000_000,
      totalEquity:                32_000_000, // 80 % equity-to-assets
      equityToAssetsGoal:              0.77,
      capitalReserveBalance:       6_000_000, // 15 % of assets
      capitalReserveGoal:              0.14,
      netAvailableCapital:         4_500_000, // 30 % of revenue
      operatingRevenueForCapital: 15_000_000,
      netAvailableCapitalGoal:         0.35,
      netCapital:                  5_200_000, // > depreciation
      depreciation:                4_200_000,
      longTermDebt:                  500_000, // ratio = 1.6 % — well under 25 %
      netPPE:                     15_000_000, // 60 % net/gross PPE
      grossPPE:                   25_000_000,
      netPPEGoal:                      0.55,
      totalCapitalIncomeActual:    6_500_000, // above budget
      totalCapitalIncomeBudget:    6_000_000,
    },
    equity: {
      actualCagrBps:          820,
      bestInClassCagrBps:     550,
      minimumRequiredCagrBps: 300,
    },
    perRowDataSource: {
      "equity-cagr":                    "accounting",
      "equity-to-assets":               "accounting",
      "capital-reserve-pct":            "accounting",
      "net-available-capital":          "accounting",
      "net-capital-vs-depreciation":    "accounting",
      "long-term-debt-equity":          "accounting",
      "net-ppe-to-gross-ppe":           "accounting",
      "total-capital-income-vs-budget": "accounting",
    },
  };
}

/** AGING FACILITY — Net PPE has dropped well below the 40 %
 *  benchmark (heavy accumulated depreciation, deferred capex);
 *  net capital can no longer cover depreciation; equity CAGR has
 *  fallen below the minimum required. */
function makeAgingSnapshot(): CapitalScorecardSnapshot {
  const base = makeHealthySnapshot();
  return {
    ...base,
    inputs: {
      ...base.inputs,
      netCapital:               3_500_000, // < depreciation
      depreciation:             4_200_000,
      netPPE:                   6_000_000,  // 24 % — well below 40 %
      grossPPE:                25_000_000,
    },
    equity: {
      actualCagrBps:          280, // below 300 minimum → action
      bestInClassCagrBps:     550,
      minimumRequiredCagrBps: 300,
    },
  };
}

/** DEBT LADEN — large long-term debt relative to equity; the
 *  debt row tips into action. Other capital signals stay green so
 *  the test isolates debt-row classification. */
function makeDebtLadenSnapshot(): CapitalScorecardSnapshot {
  const base = makeHealthySnapshot();
  return {
    ...base,
    inputs: {
      ...base.inputs,
      longTermDebt: 12_000_000, // ratio = 37.5 % — > 30 % action band
    },
  };
}

/** CAPITAL SHORTFALL — Capital reserve has thinned to ~3 % of
 *  assets; net-available-capital ratio has dropped below 15 %;
 *  capital-income variance materially below budget. */
function makeCapitalShortfallSnapshot(): CapitalScorecardSnapshot {
  const base = makeHealthySnapshot();
  return {
    ...base,
    inputs: {
      ...base.inputs,
      capitalReserveBalance:       1_200_000, // 3 % of assets
      netAvailableCapital:         1_500_000, // 10 % of revenue
      totalCapitalIncomeActual:    3_000_000,
      totalCapitalIncomeBudget:    6_000_000,
    },
    equity: {
      actualCagrBps:          400, // monitor band (between min & best)
      bestInClassCagrBps:     550,
      minimumRequiredCagrBps: 300,
    },
  };
}

const rowOf =
  (rows: ReturnType<typeof buildCapitalScorecardData>["rows"]) =>
  (key: string) =>
    rows.find((r) => r.key === key)!;

// ---------------------------------------------------------------------------
// Status-derivation classifiers
// ---------------------------------------------------------------------------

describe("capital-scorecard-service — status classifiers", () => {
  describe("classifyEquityCagrStatus", () => {
    it("≥ best-in-class → on-track", () => {
      expect(classifyEquityCagrStatus(740, 550, 300)).toBe("on-track");
      expect(classifyEquityCagrStatus(550, 550, 300)).toBe("on-track"); // at edge
    });
    it("between minimum-required and best-in-class → monitor", () => {
      expect(classifyEquityCagrStatus(400, 550, 300)).toBe("monitor");
      expect(classifyEquityCagrStatus(300, 550, 300)).toBe("monitor"); // at min edge
    });
    it("below minimum-required → action", () => {
      expect(classifyEquityCagrStatus(250, 550, 300)).toBe("action");
      expect(classifyEquityCagrStatus(0, 550, 300)).toBe("action");
    });
  });

  describe("classifyLongTermDebtStatus", () => {
    it("null debt → monitor (NEW — was misleading on-track)", () => {
      expect(classifyLongTermDebtStatus(null, 31_000_000)).toBe("monitor");
    });
    it("zero equity → monitor (divide-by-zero guard)", () => {
      expect(classifyLongTermDebtStatus(500_000, 0)).toBe("monitor");
    });
    it("< 25 % ratio → on-track", () => {
      // 5M / 25M = 20 %.
      expect(classifyLongTermDebtStatus(5_000_000, 25_000_000)).toBe("on-track");
    });
    it("25–30 % ratio → monitor", () => {
      // 7M / 25M = 28 %.
      expect(classifyLongTermDebtStatus(7_000_000, 25_000_000)).toBe("monitor");
    });
    it("> 30 % ratio → action", () => {
      // 10M / 25M = 40 %.
      expect(classifyLongTermDebtStatus(10_000_000, 25_000_000)).toBe("action");
    });
  });
});

// ---------------------------------------------------------------------------
// Multi-dataset proof — statuses flip across scenarios
// ---------------------------------------------------------------------------

describe("capital-scorecard-service — multi-dataset status changes", () => {
  it("HEALTHY → every status is on-track", () => {
    const card = buildCapitalScorecardData(makeHealthySnapshot(), EQ_LABELS_STRONG);
    const r = rowOf(card.rows);
    expect(r("equity-cagr").status).toBe("on-track");
    expect(r("equity-to-assets").status).toBe("on-track");
    expect(r("capital-reserve-pct").status).toBe("on-track");
    expect(r("net-available-capital").status).toBe("on-track");
    expect(r("net-capital-vs-depreciation").status).toBe("on-track");
    expect(r("long-term-debt-equity").status).toBe("on-track");
    expect(r("net-ppe-to-gross-ppe").status).toBe("on-track");
    expect(r("total-capital-income-vs-budget").status).toBe("on-track");
  });

  it("AGING facility → PPE/net-cap-vs-dep/equity-CAGR all flip to action", () => {
    const card = buildCapitalScorecardData(makeAgingSnapshot(), EQ_LABELS_WEAK);
    const r = rowOf(card.rows);
    expect(r("net-capital-vs-depreciation").status).toBe("action"); // 3.5M ≤ 4.2M
    expect(r("net-ppe-to-gross-ppe").status).toBe("action");         // 24 % < 35 %
    expect(r("equity-cagr").status).toBe("action");                  // 280 bps < 300 min
    // Healthy rows in this dataset stay on-track.
    expect(r("equity-to-assets").status).toBe("on-track");
    expect(r("capital-reserve-pct").status).toBe("on-track");
  });

  it("DEBT-LADEN → debt row flips to action; other rows unchanged from healthy", () => {
    const healthy = buildCapitalScorecardData(makeHealthySnapshot(), EQ_LABELS_STRONG);
    const debt = buildCapitalScorecardData(makeDebtLadenSnapshot(), EQ_LABELS_STRONG);
    expect(rowOf(healthy.rows)("long-term-debt-equity").status).toBe("on-track");
    expect(rowOf(debt.rows)("long-term-debt-equity").status).toBe("action");
    expect(rowOf(debt.rows)("long-term-debt-equity").actual).toBe("37.5%");
    // No other capital row changed status between the two datasets.
    const otherKeys = healthy.rows
      .filter((r) => r.key !== "long-term-debt-equity")
      .map((r) => r.key);
    for (const key of otherKeys) {
      expect(
        rowOf(debt.rows)(key).status,
        `row ${key} should be unchanged between healthy and debt-laden datasets`,
      ).toBe(rowOf(healthy.rows)(key).status);
    }
  });

  it("CAPITAL SHORTFALL → reserve/net-cap/cap-income/CAGR all flip away from on-track", () => {
    const card = buildCapitalScorecardData(makeCapitalShortfallSnapshot(), EQ_LABELS_WEAK);
    const r = rowOf(card.rows);
    // 3 % reserve vs 14 % benchmark = action.
    expect(r("capital-reserve-pct").status).toBe("action");
    // 10 % net-avail vs 20 % benchmark = action.
    expect(r("net-available-capital").status).toBe("action");
    // 400 bps actual CAGR: below 550 best, above 300 min → monitor.
    expect(r("equity-cagr").status).toBe("monitor");
    // Capital income $3M vs $6M budget — $3M short, beyond $2M slack → action.
    expect(r("total-capital-income-vs-budget").status).toBe("action");
  });

  it("NULL debt → 'monitor' (no more misleading 'on-track' verdict)", () => {
    // Demo snapshot has longTermDebt: null. The audit specifically
    // flagged the prior `status: "on-track"` literal as misleading
    // here. After the fix, it classifies `monitor`.
    const card = buildCapitalScorecardData(buildDemoCapitalScorecardSnapshot(), EQ_LABELS_STRONG);
    const ltDebt = rowOf(card.rows)("long-term-debt-equity");
    expect(ltDebt.actual).toBe("—");
    expect(ltDebt.status).toBe("monitor");
  });
});

// ---------------------------------------------------------------------------
// Per-row dataSource flows from the snapshot
// ---------------------------------------------------------------------------

describe("capital-scorecard-service — per-row dataSource", () => {
  it("HEALTHY snapshot (all accounting) → every row tagged 'live'; scorecard tagged 'live'", () => {
    const card = buildCapitalScorecardData(makeHealthySnapshot(), EQ_LABELS_STRONG);
    for (const row of card.rows) {
      expect(row.dataSource, `row ${row.key} dataSource`).toBe("live");
    }
    expect(card.dataSource).toBe("live");
  });

  it("DEMO snapshot → equity-cagr 'live', other 7 rows 'demo'; scorecard 'demo'", () => {
    const card = buildCapitalScorecardData(buildDemoCapitalScorecardSnapshot(), EQ_LABELS_STRONG);
    expect(rowOf(card.rows)("equity-cagr").dataSource).toBe("live");
    const others = card.rows.filter((r) => r.key !== "equity-cagr");
    for (const r of others) {
      expect(r.dataSource, `row ${r.key} dataSource`).toBe("demo");
    }
    expect(card.dataSource).toBe("demo");
  });
});

// ---------------------------------------------------------------------------
// Demo factory preserves the historical visual layout
// ---------------------------------------------------------------------------

describe("capital-scorecard-service — demo factory preserves Silver Springs visuals", () => {
  it("preserves the historical 14 inputs", () => {
    const snap = buildDemoCapitalScorecardSnapshot();
    expect(snap.inputs.totalAssets).toBe(40_155_000);
    expect(snap.inputs.totalEquity).toBe(31_000_000);
    expect(snap.inputs.capitalReserveBalance).toBe(4_698_000);
    expect(snap.inputs.netAvailableCapital).toBe(3_930_000);
    expect(snap.inputs.netCapital).toBe(4_700_000);
    expect(snap.inputs.depreciation).toBe(4_200_000);
    expect(snap.inputs.longTermDebt).toBeNull();
    expect(snap.inputs.netPPE).toBe(8_060_000);
    expect(snap.inputs.grossPPE).toBe(26_000_000);
    expect(snap.inputs.totalCapitalIncomeActual).toBe(4_440_000);
    expect(snap.inputs.totalCapitalIncomeBudget).toBe(6_030_000);
  });

  it("preserves equity-CAGR on-track classification (historical visual)", () => {
    const card = buildCapitalScorecardData(buildDemoCapitalScorecardSnapshot(), EQ_LABELS_STRONG);
    expect(rowOf(card.rows)("equity-cagr").status).toBe("on-track"); // 740 bps ≥ 550
  });
});

// ---------------------------------------------------------------------------
// Accounting-atoms factory contract — Phase 1 wiring path
// ---------------------------------------------------------------------------

describe("capital-scorecard-service — accounting-atoms snapshot factory", () => {
  function makeAtoms(): AccountingCapitalScorecardAtoms {
    return {
      totalEquity:                { value: 32_000_000, dataSource: "accounting" },
      totalAssets:                { value: 40_000_000, dataSource: "accounting" },
      capitalReserveBalance:      { value:  6_000_000, dataSource: "accounting" },
      netAvailableCapital:        { value:  4_500_000, dataSource: "accounting" },
      operatingRevenueForCapital: { value: 15_000_000, dataSource: "accounting" },
      netCapital:                 { value:  5_200_000, dataSource: "accounting" },
      depreciation:               { value:  4_200_000, dataSource: "accounting" },
      longTermDebt:               { value:    500_000, dataSource: "accounting" },
      netPPE:                     { value: 15_000_000, dataSource: "accounting" },
      grossPPE:                   { value: 25_000_000, dataSource: "accounting" },
      totalCapitalIncome:         { actual: 6_500_000, budget: 6_000_000, dataSource: "accounting" },
      goals: {
        equityToAssets:      0.77,
        capitalReserve:      0.14,
        netAvailableCapital: 0.35,
        netPPE:              0.55,
      },
      equity: {
        actualCagrBps:          820,
        bestInClassCagrBps:     550,
        minimumRequiredCagrBps: 300,
        dataSource:             "accounting",
      },
    };
  }

  it("flattens atoms into CapitalScorecardInputs shape", () => {
    const snap = buildCapitalScorecardSnapshotFromAccounting(makeAtoms());
    expect(snap.inputs.totalEquity).toBe(32_000_000);
    expect(snap.inputs.totalAssets).toBe(40_000_000);
    expect(snap.inputs.capitalReserveBalance).toBe(6_000_000);
    expect(snap.inputs.netAvailableCapital).toBe(4_500_000);
    expect(snap.inputs.totalCapitalIncomeActual).toBe(6_500_000);
    expect(snap.inputs.totalCapitalIncomeBudget).toBe(6_000_000);
    expect(snap.inputs.longTermDebt).toBe(500_000);
    expect(snap.equity.actualCagrBps).toBe(820);
  });

  it("null longTermDebt atom flows through to null input", () => {
    const atoms = makeAtoms();
    atoms.longTermDebt = { value: null, dataSource: "accounting" };
    const snap = buildCapitalScorecardSnapshotFromAccounting(atoms);
    expect(snap.inputs.longTermDebt).toBeNull();
    // And the row still classifies monitor (no misleading on-track).
    const card = buildCapitalScorecardData(snap, EQ_LABELS_STRONG);
    expect(rowOf(card.rows)("long-term-debt-equity").status).toBe("monitor");
  });

  it("worse-of provenance for multi-input rows", () => {
    const atoms = makeAtoms();
    // Demote totalAssets to demo; equity-to-assets and
    // capital-reserve-pct should both collapse to demo.
    atoms.totalAssets.dataSource = "demo";
    const snap = buildCapitalScorecardSnapshotFromAccounting(atoms);
    expect(snap.perRowDataSource["equity-to-assets"]).toBe("demo");
    expect(snap.perRowDataSource["capital-reserve-pct"]).toBe("demo");
    // Single-input rows unaffected.
    expect(snap.perRowDataSource["equity-cagr"]).toBe("accounting");
    expect(snap.perRowDataSource["total-capital-income-vs-budget"]).toBe("accounting");
  });

  it("end-to-end — accounting atoms → snapshot → scorecard, every row 'live'", () => {
    const snap = buildCapitalScorecardSnapshotFromAccounting(makeAtoms());
    const card = buildCapitalScorecardData(snap, EQ_LABELS_STRONG);
    for (const r of card.rows) {
      expect(r.dataSource, `row ${r.key} dataSource`).toBe("live");
    }
    expect(card.dataSource).toBe("live");
  });
});

// ---------------------------------------------------------------------------
// Package builder no longer carries SILVER_SPRINGS_CAPITAL_INPUTS
// ---------------------------------------------------------------------------

describe("capital-scorecard-service — monthly-package.ts is detached from the legacy constant", () => {
  it("monthly-package.ts no longer imports or references SILVER_SPRINGS_CAPITAL_INPUTS", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/reporting/monthly-package.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/\bSILVER_SPRINGS_CAPITAL_INPUTS\b/);
    expect(src).toMatch(/buildDemoCapitalScorecardSnapshot\(\)/);
  });
});
