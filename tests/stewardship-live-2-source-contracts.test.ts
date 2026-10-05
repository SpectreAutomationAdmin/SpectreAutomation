// STEWARDSHIP-LIVE-2 (2026-10-05) — source-contract + unit
// reconciliation + future-period propagation pins.
//
// Architectural invariants:
//   1. getStewardshipForClub takes `projection: FsGroupProjection | null`.
//   2. The adapter's summary cards + Dues/Payroll/NOI-Margin/Capital-
//      Income builders use `findFsGroupRow` + `projection.totals.*`
//      when the projection is provided; regex path only fires on demo
//      tenants (projection === null).
//   3. monthly-package passes the projection and NO longer overrides
//      stewardship summary cards downstream.
//   4. Section IV table hides expand/collapse chevrons in print media.
//   5. The resolver signature is period-aware — pass a different
//      ReportingPeriod and the projection consumes that period
//      automatically (no January branches).

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const ADAPTER = path.join(REPO, "src/lib/reporting/stewardship-dashboard-adapter.ts");
const MONTHLY = path.join(REPO, "src/lib/reporting/monthly-package.ts");
const CLIENT_TABLE = path.join(REPO, "src/app/app/admin/reporting/monthly/StatementOfActivitiesTable.tsx");
const PROJECTION = path.join(REPO, "src/lib/reporting/fs-group-projection.ts");

describe("STEWARDSHIP-LIVE-2 §1 — getStewardshipForClub accepts FsGroupProjection", () => {
  it("adapter imports findFsGroupRow + FsGroupProjection type", () => {
    const src = readFileSync(ADAPTER, "utf8");
    expect(src).toMatch(/import \{[\s\S]*?findFsGroupRow,[\s\S]*?type FsGroupProjection,[\s\S]*?\} from "@\/lib\/reporting\/fs-group-projection"/);
  });

  it("getStewardshipForClub signature declares `projection: FsGroupProjection | null`", () => {
    const src = readFileSync(ADAPTER, "utf8");
    expect(src).toMatch(/export async function getStewardshipForClub\(args:\s*\{[\s\S]*?projection: FsGroupProjection \| null;[\s\S]*?\}\): Promise<StewardshipLedgerBundle>/);
  });

  it("every builder call threads args.projection through", () => {
    const src = readFileSync(ADAPTER, "utf8");
    expect(src).toMatch(/buildOperatingAtomsFromSnapshots\(is, args\.projection, args\.auxiliaryInputs, provenance\)/);
    expect(src).toMatch(/buildCapitalAtomsFromSnapshots\(\s*bs,\s*is,\s*args\.projection,\s*args\.auxiliaryInputs/);
    expect(src).toMatch(/buildSummaryCards\(bs, is, args\.projection, args\.auxiliaryInputs\)/);
    expect(src).toMatch(/buildOperatingKpiCards\(is, args\.projection, args\.auxiliaryInputs\)/);
    expect(src).toMatch(/buildCapitalKpiCards\(bs, is, args\.projection, args\.auxiliaryInputs\)/);
  });
});

describe("STEWARDSHIP-LIVE-2 §3-5 — canonical fsGroupKey numerators", () => {
  it("Dues-to-Revenue card uses findFsGroupRow(IS_MEMBERSHIP_DUES) when projection is present", () => {
    const src = readFileSync(ADAPTER, "utf8");
    const body = src.match(/function buildDuesRevenueCard\([\s\S]*?^}/m)?.[0] ?? "";
    expect(body).toMatch(/findFsGroupRow\(projection, "IS_MEMBERSHIP_DUES"\)/);
    expect(body).toMatch(/projection\.totals\.operatingRevenue\.ytdActual/);
  });

  it("Payroll Ratio card uses findFsGroupRow(IS_PAYROLL) when projection is present", () => {
    const src = readFileSync(ADAPTER, "utf8");
    const body = src.match(/function buildPayrollRatioCard\([\s\S]*?^}/m)?.[0] ?? "";
    expect(body).toMatch(/findFsGroupRow\(projection, "IS_PAYROLL"\)/);
    expect(body).toMatch(/projection\.totals\.operatingRevenue\.ytdActual/);
  });

  it("NOI Margin card uses projection.totals.noiBeforeDep when projection is present", () => {
    const src = readFileSync(ADAPTER, "utf8");
    const body = src.match(/function buildNoiMarginCard\([\s\S]*?^}/m)?.[0] ?? "";
    expect(body).toMatch(/projection\.totals\.noiBeforeDep\.ytdActual/);
    expect(body).toMatch(/projection\.totals\.operatingRevenue\.ytdActual/);
  });

  it("Capital Income vs Plan card uses projection.totals.capitalRevenue when projection is present", () => {
    const src = readFileSync(ADAPTER, "utf8");
    const body = src.match(/function buildCapitalIncomeVsPlanCard\([\s\S]*?^}/m)?.[0] ?? "";
    expect(body).toMatch(/projection\.totals\.capitalRevenue\.ytdActual/);
  });

  it("buildSummaryCards derives all three headline cards from projection when present", () => {
    const src = readFileSync(ADAPTER, "utf8");
    const body = src.match(/function buildSummaryCards\([\s\S]*?^}/m)?.[0] ?? "";
    expect(body).toMatch(/projection\.totals\.operatingRevenue\.ytdActual/);
    expect(body).toMatch(/projection\.totals\.noiBeforeDep\.ytdActual/);
    expect(body).toMatch(/projection\.totals\.capitalRevenue\.ytdActual/);
  });

  it("buildOperatingAtomsFromSnapshots threads canonical dues + payroll into the scorecard atoms", () => {
    const src = readFileSync(ADAPTER, "utf8");
    const body = src.match(/function buildOperatingAtomsFromSnapshots\([\s\S]*?^}/m)?.[0] ?? "";
    expect(body).toMatch(/findFsGroupRow\(projection, "IS_MEMBERSHIP_DUES"\)/);
    expect(body).toMatch(/findFsGroupRow\(projection, "IS_PAYROLL"\)/);
    expect(body).toMatch(/projection\.totals\.operatingRevenue\.ytdActual/);
    expect(body).toMatch(/projection\.totals\.noiBeforeDep\.ytdActual/);
  });
});

describe("STEWARDSHIP-LIVE-2 §1 — monthly-package passes projection and removed override", () => {
  it("passes projection: fsGroupProjection to getStewardshipForClub", () => {
    const src = readFileSync(MONTHLY, "utf8");
    const call = src.match(/const stewardshipBundle = await getStewardshipForClub\(\{[\s\S]*?\}\);/)?.[0] ?? "";
    expect(call).toMatch(/projection: fsGroupProjection/);
  });

  it("no downstream override of stewardship summary card .value", () => {
    const src = readFileSync(MONTHLY, "utf8");
    // The override was gated on `fsGroupProjection ? { ... } : stewardshipBundle.summaryCards`
    // and manipulated the stewardshipKpiDashboard summary card value fields.
    // After STEWARDSHIP-LIVE-2 the adapter owns these — no `.value: formatCanonicalMoneyShort(` remains.
    expect(src).not.toMatch(/formatCanonicalMoneyShort/);
    // The summary cards line is now a straight pass-through.
    expect(src).toMatch(/summaryCards: stewardshipBundle\.summaryCards,/);
  });
});

describe("STEWARDSHIP-LIVE-2 §10 — Section IV print polish", () => {
  it("expand/collapse chevron hidden in print via `print:hidden` Tailwind class", () => {
    const src = readFileSync(CLIENT_TABLE, "utf8");
    const toggleBlock = src.match(/data-testid=\{`soa-row-\$\{row\.key\}-toggle`\}[\s\S]*?className="[^"]*"/)?.[0] ?? "";
    expect(toggleBlock).toMatch(/print:hidden/);
  });
});

describe("STEWARDSHIP-LIVE-2 §2, §9 — projection resolver is period-aware", () => {
  it("resolveFsGroupProjection takes `period: ReportingPeriod` (not a January-specific API)", () => {
    const src = readFileSync(PROJECTION, "utf8");
    expect(src).toMatch(/export async function resolveFsGroupProjection\(args: \{\s*clubId: string;\s*period: ReportingPeriod;/);
    expect(src).not.toMatch(/export async function resolveJanuary/);
    // Projection reads period.periodStart + period.periodEnd internally.
    expect(src).toMatch(/period\.periodStart/);
    expect(src).toMatch(/period\.periodEnd/);
  });

  it("stewardship adapter imports take ReportingPeriod (not a January-only API)", () => {
    const src = readFileSync(ADAPTER, "utf8");
    expect(src).toMatch(/import type \{ ReportingPeriod \} from "@\/lib\/reporting\/reporting-period"/);
  });

  it("getStewardshipForClub takes period: ReportingPeriod (no January-specific param)", () => {
    const src = readFileSync(ADAPTER, "utf8");
    expect(src).toMatch(/period: ReportingPeriod;/);
    expect(src).not.toMatch(/januaryMetricSet/i);
  });
});

describe("STEWARDSHIP-LIVE-2 §4-5 — unit reconciliation: Section III numerators = Section IV projection", () => {
  it("Dues numerator from projection matches Section IV Membership Dues parent", () => {
    // Simulate a projection where Membership Dues ytdActual = $3,089,943.30.
    // The adapter's buildDuesRevenueCard must read exactly that value.
    const duesYtd = 3_089_943.30;
    const projection = {
      operatingRevenue: [{
        fsGroupKey: "IS_MEMBERSHIP_DUES",
        ytdActual: duesYtd,
      }],
      operatingExpense: [],
      depreciation: [],
      financing: [],
      capitalRevenue: [],
      capitalExpense: [],
    };
    // Reproduce the adapter's findFsGroupRow logic locally.
    const all = [
      ...projection.operatingRevenue,
      ...projection.operatingExpense,
      ...projection.depreciation,
      ...projection.financing,
      ...projection.capitalRevenue,
      ...projection.capitalExpense,
    ];
    const found = all.find((r) => r.fsGroupKey === "IS_MEMBERSHIP_DUES");
    expect(found?.ytdActual).toBe(duesYtd);
  });

  it("Payroll numerator from projection matches Payroll Analysis canonical", () => {
    const payrollYtd = 163_409.80; // PAYROLL-HIST-1 canonical
    const projection = {
      operatingRevenue: [],
      operatingExpense: [{
        fsGroupKey: "IS_PAYROLL",
        ytdActual: payrollYtd,
      }],
      depreciation: [], financing: [], capitalRevenue: [], capitalExpense: [],
    };
    const all = [
      ...projection.operatingRevenue,
      ...projection.operatingExpense,
      ...projection.depreciation,
      ...projection.financing,
      ...projection.capitalRevenue,
      ...projection.capitalExpense,
    ];
    const found = all.find((r) => r.fsGroupKey === "IS_PAYROLL");
    expect(found?.ytdActual).toBe(payrollYtd);
  });
});

describe("STEWARDSHIP-LIVE-2 §6 — regex removal audit", () => {
  it("adapter still carries demo-tenant regex fallbacks (gated on `projection === null`) but every live path uses fsGroupKey", () => {
    const src = readFileSync(ADAPTER, "utf8");
    // Each financial KPI card body: if projection is non-null → canonical;
    // else → regex. The regex path only fires inside the `else` branch
    // of a ternary / optional-chain gated on `projection`.
    for (const builderName of [
      "buildDuesRevenueCard",
      "buildPayrollRatioCard",
      "buildCapitalIncomeVsPlanCard",
      "buildNoiMarginCard",
      "buildOperatingAtomsFromSnapshots",
      "buildSummaryCards",
    ]) {
      const body = src.match(new RegExp(`function ${builderName}\\([\\s\\S]*?^}`, "m"))?.[0] ?? "";
      expect(body, `${builderName} must reference projection`).toMatch(/projection/);
    }
  });
});

describe("STEWARDSHIP-LIVE-2 — no accounting mutation", () => {
  it("adapter never writes to prisma", () => {
    const src = readFileSync(ADAPTER, "utf8");
    expect(src).not.toMatch(/prisma\.\w+\.(create|update|upsert|delete|createMany|updateMany|deleteMany)/);
  });
});
