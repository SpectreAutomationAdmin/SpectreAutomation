// Operating Stewardship Scorecard service — Jonas-readiness tests.
//
// Per the Jonas-readiness audit (Tier 2, item 8), the operating
// scorecard previously consumed `SILVER_SPRINGS_OPERATING_INPUTS` as
// a hardcoded constant and the two NOI rows carried a hardcoded
// `status: "on-track"` literal. These tests prove the rebuilt
// `OperatingScorecardSnapshot` contract is the live path:
//
//   1. Two mocked datasets (favourable + unfavourable accounting
//      results) produce DIFFERENT row VALUES + STATUSES.
//   2. Per-row `dataSource` reflects the snapshot's per-row
//      provenance map (no more global "demo" tag everywhere).
//   3. NOI row STATUS is now derived from snapshot.noi numerics,
//      not hardcoded. Favourable NOI → `on-track`; weak NOI →
//      `monitor` / `action`.
//   4. The package builder (`monthly-package.ts`) no longer
//      consumes the legacy `SILVER_SPRINGS_OPERATING_INPUTS`
//      constant directly — the consumption path now flows through
//      `buildDemoOperatingScorecardSnapshot()`.
//   5. The `buildOperatingScorecardSnapshotFromAccounting()`
//      contract accepts typed accounting atoms and computes the
//      worse-of provenance per row.

import { describe, it, expect } from "vitest";

import { buildOperatingScorecardData } from "@/lib/reporting/scorecard-metrics";
import {
  buildDemoOperatingScorecardSnapshot,
  buildOperatingScorecardSnapshotFromAccounting,
  classifyNoiPctRevenueStatus,
  classifyNoiVarianceStatus,
  type AccountingOperatingScorecardAtoms,
  type OperatingScorecardSnapshot,
} from "@/lib/reporting/operating-scorecard-service";

// Standard NOI labels used by all scorecard tests — these are
// pre-formatted by formatOperatingDashboard. The tests only care
// about how the scorecard service consumes them.
const OPS_LABELS_FAV = {
  ytdNoiLabel:        "$245K",
  budgetGoalLabel:    "$0",
  noiPctRevenueLabel: "1.6%",
};
const OPS_LABELS_UNF = {
  ytdNoiLabel:        "($750K)",
  budgetGoalLabel:    "$0",
  noiPctRevenueLabel: "(5.0%)",
};

// ---------------------------------------------------------------------------
// Helpers — two contrasting mocked accounting-backed datasets.
// ---------------------------------------------------------------------------

/** Favourable dataset — every operating signal in the green band. */
function makeFavourableSnapshot(): OperatingScorecardSnapshot {
  return {
    inputs: {
      duesRevenue:                  10_500_000, // 70% of 15M
      duesRevenueBudget:            10_080_000, // 67.2% of 15M
      totalOperatingRevenue:        15_000_000,
      totalOperatingRevenueBudget:  15_000_000,
      initiationFeeSubsidy:                  0, // no posting violation
      initiationFeeSubsidyBudget:            0,
      payrollBenefitsExpense:        8_400_000, // 56% of 15M
      payrollBenefitsExpenseBudget:  8_550_000,
      fbSubsidy:                     1_400_000,
      duesForFbRatio:                9_800_000,
      golfRoundsActual:                  7_200,
      golfRoundsBudget:                  6_000,
      fbCoversActual:                   31_000,
      fbCoversBudget:                   29_000,
    },
    noi: {
      // Strong YTD NOI well above budget; within break-even corridor
      // (+1.6 %) — both NOI rows should classify on-track.
      ytdNoi:               245_000,
      ytdBudgetNoi:          50_000,
      ytdRevenue:        15_000_000,
      breakEvenLowerPct:     -0.028,
      breakEvenUpperPct:      0.033,
    },
    perRowDataSource: {
      "dues-to-revenue":         "accounting",
      "initiation-fee-subsidy":  "accounting",
      "payroll-benefits-ratio":  "accounting",
      "noi-variance-to-budget":  "accounting",
      "noi-pct-revenue":         "accounting",
      "fb-subsidy-pct-dues":     "accounting",
      "golf-rounds-vs-budget":   "operational",
      "fb-covers-vs-budget":     "operational",
    },
  };
}

/** Unfavourable dataset — operating below plan; NOI off-budget;
 *  payroll edges past dues; rounds + covers below budget;
 *  initiation-fee posting violation. */
function makeUnfavourableSnapshot(): OperatingScorecardSnapshot {
  return {
    inputs: {
      duesRevenue:                   9_100_000, // 60.7% of 15M — barely above benchmark
      duesRevenueBudget:            10_080_000,
      totalOperatingRevenue:        15_000_000,
      totalOperatingRevenueBudget:  15_000_000,
      // Material posting violation.
      initiationFeeSubsidy:          1_200_000,
      initiationFeeSubsidyBudget:    1_040_000,
      // Payroll above dues ratio — triggers action status.
      payrollBenefitsExpense:        9_300_000, // 62% of 15M > 60.7% dues
      payrollBenefitsExpenseBudget:  8_730_000,
      fbSubsidy:                     2_300_000,
      duesForFbRatio:                9_100_000,
      golfRoundsActual:                  4_800,
      golfRoundsBudget:                  6_000,
      fbCoversActual:                   22_500,
      fbCoversBudget:                   29_000,
    },
    noi: {
      // Materially negative NOI — −5.0 % of revenue, well below
      // the −2.8 % corridor lower edge so noi-pct-revenue
      // classifies `action` (and well beyond the $50K NOI variance
      // cushion).
      ytdNoi:              -750_000,
      ytdBudgetNoi:               0,
      ytdRevenue:        15_000_000,
      breakEvenLowerPct:     -0.028,
      breakEvenUpperPct:      0.033,
    },
    perRowDataSource: {
      "dues-to-revenue":         "accounting",
      "initiation-fee-subsidy":  "accounting",
      "payroll-benefits-ratio":  "accounting",
      "noi-variance-to-budget":  "accounting",
      "noi-pct-revenue":         "accounting",
      "fb-subsidy-pct-dues":     "accounting",
      "golf-rounds-vs-budget":   "operational",
      "fb-covers-vs-budget":     "operational",
    },
  };
}

const rowOf =
  (rows: ReturnType<typeof buildOperatingScorecardData>["rows"]) =>
  (key: string) =>
    rows.find((r) => r.key === key)!;

// ---------------------------------------------------------------------------
// Status-derivation helpers (replace the old hardcoded `"on-track"`)
// ---------------------------------------------------------------------------

describe("operating-scorecard-service — NOI status derivation", () => {
  it("classifyNoiVarianceStatus — on-track when NOI >= budget; monitor inside cushion; action outside", () => {
    expect(classifyNoiVarianceStatus(100_000, 0)).toBe("on-track");
    expect(classifyNoiVarianceStatus(0, 0)).toBe("on-track"); // 0-delta
    // Below budget by <= max($50K, 5% of |budget|): monitor.
    expect(classifyNoiVarianceStatus(-40_000, 0)).toBe("monitor");
    // Below by more than the cushion: action.
    expect(classifyNoiVarianceStatus(-500_000, 0)).toBe("action");
    // Cushion scales with the budget magnitude — `max($50K, 5% of
    // |budget|)`. For a $1M budget, the cushion is $50K; anything
    // below the cushion is `action`. 10 % below is well beyond
    // that → action.
    expect(classifyNoiVarianceStatus(960_000, 1_000_000)).toBe("monitor"); // 4 % below ($40K)
    expect(classifyNoiVarianceStatus(900_000, 1_000_000)).toBe("action");  // 10 % below
    expect(classifyNoiVarianceStatus(500_000, 1_000_000)).toBe("action");
  });

  it("classifyNoiPctRevenueStatus — on-track inside the break-even corridor; monitor within 1pt; action outside", () => {
    // Inside (-2.8 % to +3.3 %): on-track.
    expect(classifyNoiPctRevenueStatus(15_000, 1_000_000, -0.028, 0.033)).toBe("on-track");
    // Within 1pt of the lower edge.
    expect(classifyNoiPctRevenueStatus(-35_000, 1_000_000, -0.028, 0.033)).toBe("monitor");
    // Well outside (below).
    expect(classifyNoiPctRevenueStatus(-100_000, 1_000_000, -0.028, 0.033)).toBe("action");
    // Well outside (above).
    expect(classifyNoiPctRevenueStatus(100_000, 1_000_000, -0.028, 0.033)).toBe("action");
    // Zero-revenue guard.
    expect(classifyNoiPctRevenueStatus(100_000, 0, -0.028, 0.033)).toBe("monitor");
  });
});

// ---------------------------------------------------------------------------
// Two-dataset proof — values + statuses + dataSource all differ.
// ---------------------------------------------------------------------------

describe("operating-scorecard-service — favourable vs unfavourable dataset", () => {
  it("ALL 8 row VALUES differ between favourable and unfavourable datasets", () => {
    const fav = buildOperatingScorecardData(makeFavourableSnapshot(), OPS_LABELS_FAV);
    const unf = buildOperatingScorecardData(makeUnfavourableSnapshot(), OPS_LABELS_UNF);
    expect(fav.rows.map((r) => r.key)).toEqual(unf.rows.map((r) => r.key));
    for (let i = 0; i < fav.rows.length; i++) {
      const key = fav.rows[i].key;
      // Each row's `actual` value must differ between datasets.
      expect(
        fav.rows[i].actual,
        `row ${key} actual must differ between datasets`,
      ).not.toBe(unf.rows[i].actual);
    }
  });

  it("favourable dataset → most rows on-track", () => {
    const card = buildOperatingScorecardData(makeFavourableSnapshot(), OPS_LABELS_FAV);
    const r = rowOf(card.rows);
    expect(r("dues-to-revenue").status).toBe("on-track");      // 70 % >= 60 %
    expect(r("initiation-fee-subsidy").status).toBe("on-track"); // $0 subsidy
    expect(r("payroll-benefits-ratio").status).toBe("on-track"); // 56 % vs 70 % dues
    expect(r("noi-variance-to-budget").status).toBe("on-track"); // NOI > budget
    expect(r("noi-pct-revenue").status).toBe("on-track");        // +1.6 % inside corridor
    expect(r("golf-rounds-vs-budget").status).toBe("on-track");
    expect(r("fb-covers-vs-budget").status).toBe("on-track");
  });

  it("unfavourable dataset → multiple rows in action/monitor", () => {
    const card = buildOperatingScorecardData(makeUnfavourableSnapshot(), OPS_LABELS_UNF);
    const r = rowOf(card.rows);
    expect(r("initiation-fee-subsidy").status).toBe("action");     // $1.2M posting violation
    expect(r("payroll-benefits-ratio").status).toBe("action");     // payroll > dues
    expect(r("noi-variance-to-budget").status).toBe("action");     // NOI well below budget
    expect(r("noi-pct-revenue").status).toBe("action");            // outside −2.8 % corridor
    expect(r("fb-covers-vs-budget").status).toBe("action");        // 22.5K vs 29K budget
  });

  it("NOI row statuses FLIP between favourable and unfavourable (no longer hardcoded)", () => {
    const fav = buildOperatingScorecardData(makeFavourableSnapshot(), OPS_LABELS_FAV);
    const unf = buildOperatingScorecardData(makeUnfavourableSnapshot(), OPS_LABELS_UNF);
    expect(rowOf(fav.rows)("noi-variance-to-budget").status).toBe("on-track");
    expect(rowOf(unf.rows)("noi-variance-to-budget").status).toBe("action");
    expect(rowOf(fav.rows)("noi-pct-revenue").status).toBe("on-track");
    expect(rowOf(unf.rows)("noi-pct-revenue").status).toBe("action");
  });

  it("NOI row ACTUAL suffix changes with classified status (fav. → watch → unf.)", () => {
    const fav = buildOperatingScorecardData(makeFavourableSnapshot(), OPS_LABELS_FAV);
    const unf = buildOperatingScorecardData(makeUnfavourableSnapshot(), OPS_LABELS_UNF);
    expect(rowOf(fav.rows)("noi-variance-to-budget").actual).toMatch(/ fav\.$/);
    expect(rowOf(unf.rows)("noi-variance-to-budget").actual).toMatch(/ unf\.$/);
  });

  it("per-row dataSource reads from snapshot.perRowDataSource (accounting → 'live')", () => {
    const card = buildOperatingScorecardData(makeFavourableSnapshot(), OPS_LABELS_FAV);
    // Every row in the favourable snapshot is sourced from
    // accounting or operational → all rows tag as "live".
    for (const row of card.rows) {
      expect(row.dataSource, `row ${row.key} dataSource`).toBe("live");
    }
    // Top-level dataSource rolls up to "live" because every row is "live".
    expect(card.dataSource).toBe("live");
  });
});

// ---------------------------------------------------------------------------
// Demo factory preserves visual layout
// ---------------------------------------------------------------------------

describe("operating-scorecard-service — demo factory preserves Silver Springs visuals", () => {
  it("buildDemoOperatingScorecardSnapshot returns the historical 14 inputs", () => {
    const snap = buildDemoOperatingScorecardSnapshot();
    expect(snap.inputs.duesRevenue).toBe(9_885_000);
    expect(snap.inputs.totalOperatingRevenue).toBe(15_000_000);
    expect(snap.inputs.payrollBenefitsExpense).toBe(8_880_000);
    expect(snap.inputs.initiationFeeSubsidy).toBe(1_070_000);
    expect(snap.inputs.golfRoundsActual).toBe(6_483);
    expect(snap.inputs.fbCoversActual).toBe(24_207);
    expect(snap.inputs.fbSubsidy).toBeNull();
    expect(snap.inputs.duesForFbRatio).toBeNull();
  });

  it("demo snapshot → all 8 rows tagged 'demo' (legacy rollup)", () => {
    const card = buildOperatingScorecardData(buildDemoOperatingScorecardSnapshot(), OPS_LABELS_FAV);
    for (const row of card.rows) {
      expect(row.dataSource, `row ${row.key} dataSource`).toBe("demo");
    }
    expect(card.dataSource).toBe("demo");
  });

  it("demo snapshot → NOI row classifies on-track (preserves historical visual)", () => {
    const card = buildOperatingScorecardData(buildDemoOperatingScorecardSnapshot(), OPS_LABELS_FAV);
    expect(rowOf(card.rows)("noi-variance-to-budget").status).toBe("on-track");
    expect(rowOf(card.rows)("noi-pct-revenue").status).toBe("on-track");
  });
});

// ---------------------------------------------------------------------------
// Accounting-atoms factory contract — Phase 1 wiring path
// ---------------------------------------------------------------------------

describe("operating-scorecard-service — accounting-atoms snapshot factory", () => {
  function makeAccountingAtoms(): AccountingOperatingScorecardAtoms {
    return {
      dues:                  { actual: 10_500_000, budget: 10_080_000, dataSource: "accounting" },
      totalOperatingRevenue: { actual: 15_000_000, budget: 15_000_000, dataSource: "accounting" },
      initiationFeeSubsidy:  { actual:          0, budget:          0, dataSource: "accounting" },
      payrollBenefits:       { actual:  8_400_000, budget:  8_550_000, dataSource: "accounting" },
      fbSubsidy:             { actual:  1_400_000, duesForRatio: 9_800_000, dataSource: "accounting" },
      golfRounds:            { actual:      7_200, budget:      6_000, dataSource: "operational" },
      fbCovers:              { actual:     31_000, budget:     29_000, dataSource: "operational" },
      noi: {
        ytdNoi:               245_000,
        ytdBudgetNoi:          50_000,
        ytdRevenue:        15_000_000,
        breakEvenLowerPct:     -0.028,
        breakEvenUpperPct:      0.033,
        dataSource: "accounting",
      },
    };
  }

  it("flattens atoms into OperatingScorecardInputs shape preserving every value", () => {
    const snap = buildOperatingScorecardSnapshotFromAccounting(makeAccountingAtoms());
    expect(snap.inputs.duesRevenue).toBe(10_500_000);
    expect(snap.inputs.totalOperatingRevenue).toBe(15_000_000);
    expect(snap.inputs.initiationFeeSubsidy).toBe(0);
    expect(snap.inputs.payrollBenefitsExpense).toBe(8_400_000);
    expect(snap.inputs.fbSubsidy).toBe(1_400_000);
    expect(snap.inputs.duesForFbRatio).toBe(9_800_000);
    expect(snap.inputs.golfRoundsActual).toBe(7_200);
    expect(snap.inputs.fbCoversActual).toBe(31_000);
  });

  it("null fbSubsidy atom → null fbSubsidy + null duesForFbRatio in flattened inputs", () => {
    const atoms = makeAccountingAtoms();
    atoms.fbSubsidy = null;
    const snap = buildOperatingScorecardSnapshotFromAccounting(atoms);
    expect(snap.inputs.fbSubsidy).toBeNull();
    expect(snap.inputs.duesForFbRatio).toBeNull();
    expect(snap.perRowDataSource["fb-subsidy-pct-dues"]).toBe("demo");
  });

  it("per-row provenance — two-input rows take the worse of their atoms", () => {
    const atoms = makeAccountingAtoms();
    // Demote totalOperatingRevenue to demo; dues-to-revenue and
    // payroll-benefits-ratio should both collapse to demo because
    // they consume the (now demo) revenue atom.
    atoms.totalOperatingRevenue.dataSource = "demo";
    const snap = buildOperatingScorecardSnapshotFromAccounting(atoms);
    expect(snap.perRowDataSource["dues-to-revenue"]).toBe("demo");
    expect(snap.perRowDataSource["payroll-benefits-ratio"]).toBe("demo");
    // The initiation-fee row is single-input, unaffected.
    expect(snap.perRowDataSource["initiation-fee-subsidy"]).toBe("accounting");
  });

  it("end-to-end — accounting atoms → snapshot → scorecard, every row tagged 'live'", () => {
    const snap = buildOperatingScorecardSnapshotFromAccounting(makeAccountingAtoms());
    const card = buildOperatingScorecardData(snap, OPS_LABELS_FAV);
    for (const row of card.rows) {
      expect(row.dataSource, `row ${row.key} dataSource`).toBe("live");
    }
    expect(card.dataSource).toBe("live");
  });
});

// ---------------------------------------------------------------------------
// Package builder no longer carries SILVER_SPRINGS_OPERATING_INPUTS
// ---------------------------------------------------------------------------

describe("operating-scorecard-service — monthly-package.ts is detached from the legacy constant", () => {
  it("monthly-package.ts no longer imports or references SILVER_SPRINGS_OPERATING_INPUTS in its operating-scorecard call", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/reporting/monthly-package.ts"),
      "utf8",
    );
    // The legacy constant must NOT appear in any monthly-package.ts
    // import or call. (`SILVER_SPRINGS_OPERATING_DUES` — a separate
    // constant used by the payroll service — is allowed.)
    expect(src).not.toMatch(/\bSILVER_SPRINGS_OPERATING_INPUTS\b/);
    // The new path is wired:
    expect(src).toMatch(/buildDemoOperatingScorecardSnapshot\(\)/);
  });
});
