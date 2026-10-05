// CAPITAL-LIVE-1 (2026-10-05) — source-contract pins for Section V
// canonical wiring + reserve availability closeout.
//
// Invariants:
//   §3  Section V Actuals come from the canonical FS-Group projection
//       (same source Section IV + Section III use).
//   §4  Transfer from Operations is NOT a residual catch-all. The
//       builder returns `null` when transferFromOpsSourceConnected is
//       false.
//   §5-7 Reserve Coverage / Reserve Balance / Replacement Cost / PP&E
//       ratio / Debt Service all respect availability signals and
//       render precise unavailable (never zero) when disconnected.
//   §9  Stress test is replaced with an availability statement when
//       any required input is unavailable.
//   §12 All classification is fsGroupKey-driven (no name regex when
//       the projection is provided — regex path preserved only for
//       the demo-tenant fallback).

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const ADAPTER = path.join(REPO, "src/lib/reporting/capital-fund-adapter.ts");
const PROJECTION = path.join(REPO, "src/lib/reporting/fs-group-projection.ts");
const MONTHLY = path.join(REPO, "src/lib/reporting/monthly-package.ts");
const STEWARDSHIP = path.join(REPO, "src/lib/reporting/stewardship-dashboard-adapter.ts");

describe("CAPITAL-LIVE-1 §3 — Section V consumes canonical FS-Group projection", () => {
  it("CapitalFundAvailabilityInputs type exports the six availability signals", () => {
    const src = readFileSync(ADAPTER, "utf8");
    expect(src).toMatch(/capitalBudgetConnected: boolean/);
    expect(src).toMatch(/reserveStudyConnected: boolean/);
    expect(src).toMatch(/capitalProjectsConnected: boolean/);
    expect(src).toMatch(/ppeSplitAvailable: boolean/);
    expect(src).toMatch(/debtServiceSourceConnected: boolean/);
    expect(src).toMatch(/transferFromOpsSourceConnected: boolean/);
  });

  it("getCapitalFundForClub signature declares projection + availability", () => {
    const src = readFileSync(ADAPTER, "utf8");
    expect(src).toMatch(/projection: FsGroupProjection \| null;/);
    expect(src).toMatch(/availability: CapitalFundAvailabilityInputs \| null;/);
  });

  it("builder imports findFsGroupRow from the canonical projection module", () => {
    const src = readFileSync(ADAPTER, "utf8");
    expect(src).toMatch(/import \{[\s\S]*?findFsGroupRow,[\s\S]*?type FsGroupProjection,[\s\S]*?\} from "@\/lib\/reporting\/fs-group-projection"/);
  });

  it("Capital Dues row uses findFsGroupRow(IS_CAPITAL_ASSESSMENTS) when projection is present", () => {
    const src = readFileSync(ADAPTER, "utf8");
    expect(src).toMatch(/findRow\("IS_CAPITAL_ASSESSMENTS"\)/);
  });

  it("Initiation Fees row uses findFsGroupRow(IS_ENTRANCE_FEES) when projection is present", () => {
    const src = readFileSync(ADAPTER, "utf8");
    expect(src).toMatch(/findRow\("IS_ENTRANCE_FEES"\)/);
  });

  it("Investment Income row uses findFsGroupRow(IS_INTEREST_INCOME) when projection is present", () => {
    const src = readFileSync(ADAPTER, "utf8");
    expect(src).toMatch(/findRow\("IS_INTEREST_INCOME"\)/);
  });

  it("Total Capital Sources equals projection.totals.capitalRevenue.ytdActual (Section IV parity)", () => {
    const src = readFileSync(ADAPTER, "utf8");
    expect(src).toMatch(/projection\.totals\.capitalRevenue\.ytdActual/);
  });
});

describe("CAPITAL-LIVE-1 §4 — Transfer from Operations is NEVER a residual catch-all", () => {
  it("live path returns null when transferFromOpsSourceConnected is false", () => {
    const src = readFileSync(ADAPTER, "utf8");
    expect(src).toMatch(/availability!\.transferFromOpsSourceConnected \? 0 : null/);
  });

  it("Other Capital Revenue row explicitly captures the capital-tagged residual (not labeled 'Transfer')", () => {
    const src = readFileSync(ADAPTER, "utf8");
    expect(src).toMatch(/key: "other-capital-revenue"/);
    expect(src).toMatch(/label: "Other Capital Revenue"/);
  });
});

describe("CAPITAL-LIVE-1 §5-7 — Reserve Coverage obeys availability", () => {
  it("Reserve Coverage % is null (unavailable) when Reserve Study not connected", () => {
    const src = readFileSync(ADAPTER, "utf8");
    expect(src).toMatch(/reserveCoveragePct: number \| null/);
    expect(src).toMatch(/reserveStudyOn && reserveFundBalance != null && aux\.totalAssetReplacementCost > 0/);
  });

  it("reserveCoverage label renders '—' + 'Reserve Study not connected' when unavailable", () => {
    const src = readFileSync(ADAPTER, "utf8");
    expect(src).toMatch(/currentPctLabel: reserveCoveragePct == null \? "—"/);
    expect(src).toMatch(/"Reserve Study not connected"/);
  });

  it("Reserve adequacy rows render '—' (not $0) when Reserve Study is not connected", () => {
    const src = readFileSync(ADAPTER, "utf8");
    expect(src).toMatch(/reserveFundBalance == null \? unavailableValueLabel\("—"\)/);
    expect(src).toMatch(/reserveStudyOn \? dollarsLabel\(aux\.totalAssetReplacementCost\) : "—"/);
  });

  it("Net-to-Gross PP&E ratio is null when ppeSplitAvailable is false", () => {
    const src = readFileSync(ADAPTER, "utf8");
    expect(src).toMatch(/netToGrossPpe: number \| null = ppeSplitOn && grossPpe > 0/);
    expect(src).toMatch(/valueLabel: netToGrossPpe == null \? "—"/);
  });
});

describe("CAPITAL-LIVE-1 §8 — Debt Service availability", () => {
  it("Debt Service YTD is null when debtServiceSourceConnected is false", () => {
    const src = readFileSync(ADAPTER, "utf8");
    expect(src).toMatch(/availability!\.debtServiceSourceConnected \? 0 : null/);
  });
});

describe("CAPITAL-LIVE-1 §9 — Stress test availability", () => {
  it("stress test replaced with precise availability statement when inputs missing", () => {
    const src = readFileSync(ADAPTER, "utf8");
    expect(src).toMatch(/const stressInputsAvailable =/);
    expect(src).toMatch(/Stress-test unavailable — this analysis requires an authoritative Reserve Study/);
  });
});

describe("CAPITAL-LIVE-1 §2 — Capital Budget availability", () => {
  it("Budget column renders null when capitalBudgetConnected is false (no $0 substitution)", () => {
    const src = readFileSync(ADAPTER, "utf8");
    expect(src).toMatch(/availability!\.capitalBudgetConnected/);
    expect(src).toMatch(/\? sumAnnualBudget\(findRow\("IS_ENTRANCE_FEES"\)\)[\s\S]{0,20}: null/);
  });

  it("monthly-package passes capitalBudgetConnected: true to Section V (Capital BudgetLines audited)", () => {
    const src = readFileSync(MONTHLY, "utf8");
    const capCall = src.match(/const capitalFundBundle = await getCapitalFundForClub\([\s\S]*?\}\);/)?.[0] ?? "";
    expect(capCall).toMatch(/capitalBudgetConnected: true/);
    expect(capCall).toMatch(/reserveStudyConnected: false/);
    expect(capCall).toMatch(/capitalProjectsConnected: false/);
    expect(capCall).toMatch(/ppeSplitAvailable: false/);
    expect(capCall).toMatch(/debtServiceSourceConnected: false/);
    expect(capCall).toMatch(/transferFromOpsSourceConnected: false/);
  });

  it("STEWARDSHIP-LIVE-2A capitalBudgetConnected flipped to true (Section III Capital Income vs Plan can reconcile)", () => {
    const src = readFileSync(MONTHLY, "utf8");
    // The STEWARDSHIP block passes capitalBudgetConnected: true now.
    const stewardCall = src.match(/const stewardshipBundle = await getStewardshipForClub\([\s\S]*?\}\);/)?.[0] ?? "";
    expect(stewardCall).toMatch(/capitalBudgetConnected: true/);
  });

  it("Section III Capital Income vs Plan reads Budget from projection.totals.capitalRevenue.ytdBudget", () => {
    const src = readFileSync(STEWARDSHIP, "utf8");
    const body = src.match(/function buildCapitalIncomeVsPlanCard\([\s\S]*?^}/m)?.[0] ?? "";
    expect(body).toMatch(/projection\.totals\.capitalRevenue\.ytdBudget/);
  });
});

describe("CAPITAL-LIVE-1 §12 — projection carries annualBudget for Section V annual column", () => {
  it("FsGroupProjectionRow + FsGroupAccountRow declare annualBudget: number", () => {
    const src = readFileSync(PROJECTION, "utf8");
    const rowType = src.match(/export type FsGroupProjectionRow = \{[\s\S]*?\};/)?.[0] ?? "";
    expect(rowType).toMatch(/annualBudget: number/);
    const acctType = src.match(/export type FsGroupAccountRow = \{[\s\S]*?\};/)?.[0] ?? "";
    expect(acctType).toMatch(/annualBudget: number/);
  });

  it("projection resolver computes annualBudget from the 12-month monthlyTotals sum", () => {
    const src = readFileSync(PROJECTION, "utf8");
    expect(src).toMatch(/a\.annualBudget \+= sign \* b\.monthlyTotals\.reduce/);
  });
});

describe("CAPITAL-LIVE-1 — no accounting-data mutation", () => {
  it("no changed file writes to prisma", () => {
    for (const f of [ADAPTER, PROJECTION, STEWARDSHIP]) {
      const src = readFileSync(f, "utf8");
      expect(src, `${path.basename(f)} must not call prisma writes`)
        .not.toMatch(/prisma\.\w+\.(create|update|upsert|delete|createMany|updateMany|deleteMany)/);
    }
  });
});
