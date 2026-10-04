// REPORT-CHART-1A (2026-10-03) — source-contract pins:
//   • December BS-only snapshot => null, not $0
//   • 12-slot x-axis skeleton anchored on resolver's last month
//   • Nice-tick algorithm produces 4–6 major ticks
//   • Compact finance notation ($K / $M, no $1000K)
//   • Null bars never fabricated as zero
//   • Chart primitive accepts (number | null) values and skips nulls

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { chooseNiceDollarTicks } from "@/lib/reporting/monthly-package";

const REPO = path.resolve(__dirname, "..");
const OPRES   = path.join(REPO, "src/lib/reporting/operating-results.ts");
const PACKAGE = path.join(REPO, "src/lib/reporting/monthly-package.ts");
const BAR     = path.join(REPO, "src/components/reporting/EditorialBarChart.tsx");

describe("REPORT-CHART-1A §1 — BS-only snapshots omit the month (null, not $0)", () => {
  it("snapshot resolver tracks hasRevenueAccount + hasExpenseAccount and continues when both are false", () => {
    const src = readFileSync(OPRES, "utf8");
    expect(src).toMatch(/hasRevenueAccount/);
    expect(src).toMatch(/hasExpenseAccount/);
    expect(src).toMatch(/if \(!hasRevenueAccount && !hasExpenseAccount\) continue/);
  });

  it("resolver never pushes a zero-NOI point for a BS-only snapshot", () => {
    const src = readFileSync(OPRES, "utf8");
    const resolver = src.match(/async function getOperatingMonthsFromCommittedSnapshots[\s\S]*?\n\}/)?.[0] ?? "";
    // §1 guard — the push only happens AFTER the BS-only check
    // continues. Ensure the push is strictly later than the guard.
    const guardIdx = resolver.indexOf("if (!hasRevenueAccount && !hasExpenseAccount) continue");
    const pushIdx  = resolver.indexOf("points.push");
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(pushIdx).toBeGreaterThan(guardIdx);
  });
});

describe("REPORT-CHART-1A §6 — 12-slot x-axis skeleton + null-aware series", () => {
  it("formatter builds a 12-slot skeleton anchored on the last plotted month", () => {
    const src = readFileSync(PACKAGE, "utf8");
    const fn = src.match(/export function formatOperatingDashboard[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn).toMatch(/anchorMonth/);
    expect(fn).toMatch(/for \(let i = 11; i >= 0; i--\)/);
  });

  it("formatter output type OperatingSeriesPoint carries value: number | null", () => {
    const src = readFileSync(PACKAGE, "utf8");
    expect(src).toMatch(/export type OperatingSeriesPoint\b/);
    expect(src).toMatch(/value:\s*number\s*\|\s*null/);
  });

  it("formatter emits null (never 0) for a slot without a resolver match", () => {
    const src = readFileSync(PACKAGE, "utf8");
    const fn = src.match(/export function formatOperatingDashboard[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn).toMatch(/value: m\?\.noi \?\? null/);
    expect(fn).toMatch(/value: m\?\.budgetNoi \?\? null/);
  });
});

describe("REPORT-CHART-1A §4 + §9 — nice-tick algorithm (4–6 major ticks)", () => {
  it("produces 5 major ticks for the $0 → $3.76M January operating range", () => {
    const { domainMin, domainMax, step, tickCount } = chooseNiceDollarTicks(0, 3_762_688.26);
    expect(domainMin).toBe(0);
    expect(domainMax).toBe(4_000_000);
    expect(step).toBe(1_000_000);
    expect(tickCount).toBe(4);                 // 4 intervals → 5 label positions (0, 1M, 2M, 3M, 4M)
    expect(tickCount + 1).toBeGreaterThanOrEqual(4);
    expect(tickCount + 1).toBeLessThanOrEqual(7);
  });

  it("picks nice step sizes across common ranges", () => {
    // Small positive: $0 → $45K → step $10K → 4 intervals
    const a = chooseNiceDollarTicks(0, 45_000);
    expect(a.step).toBe(10_000);
    expect(a.tickCount + 1).toBeLessThanOrEqual(7);
    // Mixed sign (demo seed): −$193K → $45K → step $100K
    const b = chooseNiceDollarTicks(-193_000, 45_000);
    expect(b.tickCount + 1).toBeLessThanOrEqual(7);
    // $8M equity-scale range — step picks $5M (not $1M which would
    // make 10 ticks)
    const c = chooseNiceDollarTicks(0, 11_315_408);
    expect(c.tickCount + 1).toBeLessThanOrEqual(7);
  });
});

describe("REPORT-CHART-1A §4 — formatter uses dollars-compact + raw dollars", () => {
  it("dashboard type declares yDomain + yTicks + availableObservations", () => {
    const src = readFileSync(PACKAGE, "utf8");
    expect(src).toMatch(/yDomain:\s*\[number,\s*number\]/);
    expect(src).toMatch(/yTicks:\s*number/);
    expect(src).toMatch(/availableObservations:\s*number/);
  });

  it("OperatingResultsCard uses formatY=dollars-compact (never dollars-thousands)", () => {
    const body = readFileSync(
      path.join(REPO, "src/app/app/admin/reporting/monthly/MonthlyReportingPackageBody.tsx"),
      "utf8",
    );
    const card = body.match(/function OperatingResultsCard[\s\S]*?return \(\s*<StewardshipCard/)?.[0] ?? "";
    expect(card).toMatch(/formatY="dollars-compact"/);
    expect(card).not.toMatch(/formatY="dollars-thousands"/);
  });
});

describe("REPORT-CHART-1A §6 — EditorialBarChart accepts null values + skips them", () => {
  it("primary/secondary/overlay values accept Array<number | null>", () => {
    const src = readFileSync(BAR, "utf8");
    expect(src).toMatch(/primary:\s*\{\s*values:\s*Array<number \| null>/);
    expect(src).toMatch(/secondary\?:\s*\{\s*values:\s*Array<number \| null>/);
    expect(src).toMatch(/overlay\?:\s*\{\s*values:\s*Array<number \| null>/);
  });

  it("render loop returns null for null primary values (no $0 bar)", () => {
    const src = readFileSync(BAR, "utf8");
    expect(src).toMatch(/\/\* Primary bars[\s\S]{0,300}if \(v == null\) return null/);
  });

  it("overlay path breaks at null values (no bridging segment)", () => {
    const src = readFileSync(BAR, "utf8");
    expect(src).toMatch(/needMove = true/);
  });
});

describe("REPORT-CHART-1A §22 — read-only (no prisma writes)", () => {
  it("snapshot resolver guard adds no write path", () => {
    const src = readFileSync(OPRES, "utf8");
    const resolver = src.match(/async function getOperatingMonthsFromCommittedSnapshots[\s\S]*?\n\}/)?.[0] ?? "";
    expect(resolver).not.toMatch(/prisma\.\w+\.(create|update|upsert|delete)/);
  });
});
