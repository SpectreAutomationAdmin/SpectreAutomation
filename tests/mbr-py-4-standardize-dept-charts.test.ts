// MBR-PY-4 — standardize departmental payroll chart sorting + colours
// across Chapter II (Financial Performance, Illustrated) and
// Chapter XII (Departmental Payroll Analysis).
//
// Shape + behaviour tests on the pure data layer verifying:
//   • Shared payroll-dept-chart-config exports the authoritative
//     hex + Tailwind palette + sort comparator.
//   • Both chapters import and use the shared palette.
//   • Both chapters sort departments by current-year YTD actual
//     DESCENDING with alphabetical tie-break.
//   • Mar 2026 Coulee produces identical department order in both
//     chapters: Administration > F&B > Grounds > Golf Shop > Clubhouse.
//   • Rankings dynamically change when payroll ranks change.
//   • Rows retain their actual/budget/priorYear association after sort.
//   • Geometry constants + visibility keys unchanged.

import { describe, expect, it } from "vitest";
import {
  PAYROLL_DEPT_SERIES_HEX,
  payrollDeptSeriesLabels,
  comparePayrollDeptForChart,
} from "@/lib/reporting/payroll-dept-chart-config";
import {
  buildPayrollDepartmentData,
  type PayrollDeptRowInput,
} from "@/lib/reporting/payroll-analysis";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO = path.resolve(__dirname, "..");

describe("MBR-PY-4 §K — shared config exports the authoritative palette + comparator", () => {
  it("hex palette matches Chapter II's seriesColors byte-for-byte", () => {
    expect(PAYROLL_DEPT_SERIES_HEX.actual).toBe("#3f7042");
    expect(PAYROLL_DEPT_SERIES_HEX.budget).toBe("#b08a4a");
    expect(PAYROLL_DEPT_SERIES_HEX.priorYear).toBe("#7a9466");
  });

  it("MBR-PY-4A — Tailwind palette form retired; only hex form remains", () => {
    // The pre-MBR-PY-4A `PAYROLL_DEPT_SERIES_TW` export must be gone.
    // `fill-[#7a9466]` is an arbitrary-value utility that Tailwind's
    // JIT scanner cannot generate when the string reaches the JSX
    // only through a module import — the deployed bars rendered
    // BLACK on staging because the class never existed in the
    // compiled CSS.  Hex is the single source of truth now.
    const configSrc = fs.readFileSync(
      path.join(REPO, "src/lib/reporting/payroll-dept-chart-config.ts"),
      "utf-8",
    );
    expect(configSrc).not.toMatch(/export const PAYROLL_DEPT_SERIES_TW/);
    // Also pin the three hex values are the SAME ones the chart
    // primitive receives — the SVG `fill` attribute is applied
    // directly (EditorialGroupedBarChart's `color.startsWith("#")`
    // branch).
    expect(PAYROLL_DEPT_SERIES_HEX.actual.startsWith("#")).toBe(true);
    expect(PAYROLL_DEPT_SERIES_HEX.budget.startsWith("#")).toBe(true);
    expect(PAYROLL_DEPT_SERIES_HEX.priorYear.startsWith("#")).toBe(true);
  });

  it("legend labels: current-year is dynamic; Prior Year is STATIC (MBR-PY-4A)", () => {
    const labels2026 = payrollDeptSeriesLabels(2026);
    expect(labels2026.actual).toBe("2026 Actual");
    expect(labels2026.budget).toBe("Budget");
    // MBR-PY-4A — never prepend the historical year.
    expect(labels2026.priorYear).toBe("Prior Year");
    const labels2027 = payrollDeptSeriesLabels(2027);
    expect(labels2027.actual).toBe("2027 Actual");
    expect(labels2027.priorYear).toBe("Prior Year");
  });
});

describe("MBR-PY-4 §L — comparator sorts by ytdActual DESC with alpha tie-break", () => {
  it("primary sort is current-year YTD actual DESCENDING", () => {
    const rows = [
      { ytdActual: 100_000, name: "A" },
      { ytdActual: 300_000, name: "B" },
      { ytdActual: 200_000, name: "C" },
    ];
    rows.sort(comparePayrollDeptForChart);
    expect(rows.map((r) => r.ytdActual)).toEqual([300_000, 200_000, 100_000]);
  });

  it("secondary (tie-break) is display name ALPHABETICAL", () => {
    const rows = [
      { ytdActual: 50_000, name: "Zebra" },
      { ytdActual: 50_000, name: "Alpha" },
      { ytdActual: 50_000, name: "Mango" },
    ];
    rows.sort(comparePayrollDeptForChart);
    expect(rows.map((r) => r.name)).toEqual(["Alpha", "Mango", "Zebra"]);
  });

  it("works with `fullLabel` shape (Chapter XII adapter projection)", () => {
    const rows = [
      { ytdActual: 100, fullLabel: "Zed" },
      { ytdActual: 100, fullLabel: "Alpha" },
    ];
    rows.sort(comparePayrollDeptForChart);
    expect(rows[0].fullLabel).toBe("Alpha");
  });

  it("Mar 2026 Coulee: Admin > F&B > Grounds > Golf Shop > Clubhouse", () => {
    // The service passes the resolver's row name (e.g.
    // "Administration", "Food & Beverage") straight into the
    // comparator.  With current-year dollars approximating
    // ADMIN 152.8K > F&B 139.8K > GROUNDS 127.2K > GOLF_SHOP 92K >
    // CLUBHOUSE 26.6K, the sort stabilises on this order every
    // period.
    const rows = [
      { ytdActual:  26_645.40, name: "Clubhouse" },
      { ytdActual: 127_203.24, name: "Course & Grounds" },
      { ytdActual:  92_034.26, name: "Golf Shop" },
      { ytdActual: 139_755.61, name: "Food & Beverage" },
      { ytdActual: 152_789.41, name: "Administration" },
    ];
    rows.sort(comparePayrollDeptForChart);
    expect(rows.map((r) => r.name)).toEqual([
      "Administration",
      "Food & Beverage",
      "Course & Grounds",
      "Golf Shop",
      "Clubhouse",
    ]);
  });

  it("sort is DYNAMIC — a change in current-year rankings re-orders the chart", () => {
    const original = [
      { ytdActual: 152_789, name: "Administration" },
      { ytdActual: 139_755, name: "Food & Beverage" },
    ];
    original.sort(comparePayrollDeptForChart);
    expect(original[0].name).toBe("Administration");
    // Flip the ranking.
    const flipped = [
      { ytdActual: 139_755, name: "Administration" },
      { ytdActual: 152_789, name: "Food & Beverage" },
    ];
    flipped.sort(comparePayrollDeptForChart);
    expect(flipped[0].name).toBe("Food & Beverage");
  });
});

describe("MBR-PY-4 §M — buildPayrollDepartmentData row association after sort", () => {
  it("each row retains its correct actual/budget/priorYear values after sorting", () => {
    const departments: PayrollDeptRowInput[] = [
      // Intentionally out-of-order on entry.
      { key: "clubhouse", name: "Clubhouse",        actual:  26_645, budget: 25_000,  priorYear: 17_765 },
      { key: "admin",     name: "Administration",   actual: 152_789, budget: 160_000, priorYear: 153_630 },
      { key: "grounds",   name: "Course & Grounds", actual: 127_203, budget: 130_000, priorYear: 110_214 },
      { key: "golf",      name: "Golf Shop",        actual:  92_034, budget: 90_000,  priorYear: 77_558 },
      { key: "fb",        name: "Food & Beverage",  actual: 139_755, budget: 150_000, priorYear: 152_273 },
    ];
    // buildPayrollDepartmentData itself doesn't sort — Chapter II
    // sorts in the live builder before passing in.  Simulate the
    // live builder's sort here.
    const sorted = departments
      .map((d) => ({ ...d, ytdActual: d.actual }))
      .sort(comparePayrollDeptForChart)
      .map(({ ytdActual: _u, ...rest }) => rest);
    const built = buildPayrollDepartmentData(
      {
        departments: sorted,
        revenueDollars: 3_000_000,
        duesDollars:    2_000_000,
        reportingYear:  2026,
      },
      { dataSource: "live" },
    );
    expect(built.rows[0].name).toBe("Administration");
    expect(built.rows[0].actualK).toBeCloseTo(152.789, 2);
    expect(built.rows[0].budgetK).toBeCloseTo(160, 2);
    expect(built.rows[0].priorYearK).toBeCloseTo(153.630, 2);
    expect(built.rows[1].name).toBe("Food & Beverage");
    expect(built.rows[2].name).toBe("Course & Grounds");
    expect(built.rows[3].name).toBe("Golf Shop");
    expect(built.rows[4].name).toBe("Clubhouse");
  });
});

describe("MBR-PY-4 §N — both chapters import the shared config", () => {
  it("Chapter II (payroll-analysis.ts) imports PAYROLL_DEPT_SERIES_HEX + comparator", () => {
    const src = fs.readFileSync(path.join(REPO, "src/lib/reporting/payroll-analysis.ts"), "utf-8");
    expect(src).toContain('"./payroll-dept-chart-config"');
    expect(src).toContain("PAYROLL_DEPT_SERIES_HEX");
    expect(src).toContain("comparePayrollDeptForChart");
    // seriesColors reads from the shared hex, not an inline literal.
    expect(src).toContain("PAYROLL_DEPT_SERIES_HEX.actual");
    expect(src).toContain("PAYROLL_DEPT_SERIES_HEX.budget");
    expect(src).toContain("PAYROLL_DEPT_SERIES_HEX.priorYear");
    // The sort step is wired BEFORE calling buildPayrollDepartmentData.
    expect(src).toMatch(/\.sort\(comparePayrollDeptForChart\)/);
  });

  it("Chapter XII (departmental-payroll-analysis.ts) imports the comparator", () => {
    const src = fs.readFileSync(path.join(REPO, "src/lib/reporting/departmental-payroll-analysis.ts"), "utf-8");
    expect(src).toContain('"@/lib/reporting/payroll-dept-chart-config"');
    expect(src).toContain("comparePayrollDeptForChart");
    expect(src).toMatch(/\.sort\(comparePayrollDeptForChart\)/);
    // Pre-MBR-PY-4 ascending-by-name sort retired; the enriched
    // array no longer uses the bare `(a, b) => b.ytdActual - a.ytdActual`.
    expect(src).not.toMatch(/enriched\.sort\(\(a, b\) => b\.ytdActual - a\.ytdActual\)/);
  });

  it("Chapter XII chart (PayrollChartCards.tsx) imports hex palette + static Prior-Year label", () => {
    const src = fs.readFileSync(
      path.join(REPO, "src/app/app/admin/reporting/monthly/PayrollChartCards.tsx"),
      "utf-8",
    );
    expect(src).toContain('"@/lib/reporting/payroll-dept-chart-config"');
    // MBR-PY-4A — hex form, not Tailwind.  Comments may still
    // reference the retired `PAYROLL_DEPT_SERIES_TW` name as the
    // audit trail; actual code references (import, member access)
    // must be gone.
    expect(src).toContain("PAYROLL_DEPT_SERIES_HEX");
    // No `PAYROLL_DEPT_SERIES_TW.actual` / `.budget` / `.priorYear`
    // member access anywhere.
    expect(src).not.toMatch(/PAYROLL_DEPT_SERIES_TW\.[a-zA-Z]/);
    // No `PAYROLL_DEPT_SERIES_TW,` / `PAYROLL_DEPT_SERIES_TW\s*}`
    // import-specifier either.
    expect(src).not.toMatch(/import\s*\{[^}]*PAYROLL_DEPT_SERIES_TW/);
    expect(src).toContain("payrollDeptSeriesLabels");
    // Pre-MBR-PY-4 slate-blue literal is gone.
    expect(src).not.toMatch(/color:\s*"fill-\[#7d96b0\]"/);
    // GroupedActualBudgetChart (the Chapter XII three-series chart)
    // reads ALL three fills from the shared config — never inline.
    const groupedStart = src.indexOf("function GroupedActualBudgetChart");
    const nextFnStart = src.indexOf("\nfunction ", groupedStart + 10);
    const scope = src.slice(groupedStart, nextFnStart > 0 ? nextFnStart : groupedStart + 5_000);
    expect(scope).toContain("PAYROLL_DEPT_SERIES_HEX.actual");
    expect(scope).toContain("PAYROLL_DEPT_SERIES_HEX.budget");
    expect(scope).toContain("PAYROLL_DEPT_SERIES_HEX.priorYear");
    // Unrelated charts (WagesVsTaxesChart, variance chart) remain
    // untouched per the directive scope guard — we deliberately do
    // NOT assert on them.
  });
});

describe("MBR-PY-4A §P — chart series render HEX colours (SVG fill), never Tailwind arbitrary-value utilities", () => {
  it("EditorialGroupedBarChart detects hex colors and applies them via SVG `fill` attribute", () => {
    // The chart primitive's dual API: if `color.startsWith(\"#\")`,
    // the color is applied as `<rect fill=\"#…\">` directly.  Any
    // other string is treated as a Tailwind class name.  We rely on
    // the hex branch so the shared `PAYROLL_DEPT_SERIES_HEX` values
    // reach the DOM regardless of Tailwind's content-scanner reach.
    const src = fs.readFileSync(
      path.join(REPO, "src/components/reporting/EditorialGroupedBarChart.tsx"),
      "utf-8",
    );
    expect(src).toMatch(/isHex\s*=\s*s\.color\.startsWith\("#"\)/);
    expect(src).toMatch(/isHex \? \{ fill: s\.color \} : \{\}/);
  });

  it("Chapter XII series config passes HEX, never a `fill-` Tailwind utility", () => {
    const src = fs.readFileSync(
      path.join(REPO, "src/app/app/admin/reporting/monthly/PayrollChartCards.tsx"),
      "utf-8",
    );
    const groupedStart = src.indexOf("function GroupedActualBudgetChart");
    const nextFnStart = src.indexOf("\nfunction ", groupedStart + 10);
    const scope = src.slice(groupedStart, nextFnStart > 0 ? nextFnStart : groupedStart + 5_000);
    // The three series entries inside this chart must pass hex
    // values from PAYROLL_DEPT_SERIES_HEX — not any `fill-club-*`
    // or `fill-[#…]` string that would route through Tailwind.
    expect(scope).not.toMatch(/color:\s*"fill-club-/);
    expect(scope).not.toMatch(/color:\s*"fill-\[/);
    expect(scope).toContain("PAYROLL_DEPT_SERIES_HEX.actual");
    expect(scope).toContain("PAYROLL_DEPT_SERIES_HEX.budget");
    expect(scope).toContain("PAYROLL_DEPT_SERIES_HEX.priorYear");
  });

  it("Prior-year hex is #7a9466 (muted sage) — the directive-named colour", () => {
    expect(PAYROLL_DEPT_SERIES_HEX.priorYear).toBe("#7a9466");
    // Not black, not slate-blue (#7d96b0 was the pre-MBR-PY-4
    // Chapter XII literal that caused the black-bar fallback).
    expect(PAYROLL_DEPT_SERIES_HEX.priorYear).not.toBe("#000000");
    expect(PAYROLL_DEPT_SERIES_HEX.priorYear).not.toBe("#7d96b0");
  });
});

describe("MBR-PY-4 §O — chart geometry constants + visibility keys unchanged", () => {
  it("Chapter XII chart card geometry preserved (height=245, padLeft=44, padRight=14)", () => {
    const src = fs.readFileSync(
      path.join(REPO, "src/app/app/admin/reporting/monthly/PayrollChartCards.tsx"),
      "utf-8",
    );
    expect(src).toContain("height={245}");
    expect(src).toContain("padLeft={44}");
    expect(src).toContain("padRight={14}");
    expect(src).toContain('"card:payroll-analysis:ytd-payroll-by-department"');
  });

  it("Chapter II chart card geometry preserved (height=240, padLeft=48, padRight=14)", () => {
    const src = fs.readFileSync(
      path.join(REPO, "src/app/app/admin/reporting/monthly/MonthlyReportingPackageBody.tsx"),
      "utf-8",
    );
    const slice = src.slice(src.indexOf("function PayrollDepartmentCard"));
    const scope = slice.slice(0, 5_000);
    expect(scope).toContain("height={240}");
    expect(scope).toContain("padLeft={48}");
    expect(scope).toContain("padRight={14}");
    expect(scope).toContain('"card:financial-performance:payroll-dept-breakdown"');
  });
});
