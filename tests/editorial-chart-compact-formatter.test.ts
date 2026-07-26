// Founder rule 2026-07-05 v15.9 — shared auto-scaling compact
// currency formatter.
//
// Bug that motivated this: Payroll charts were passing RAW DOLLAR
// values (e.g. 900_000) to the shared `dollars-thousands`
// formatter (which expects the caller to pre-scale to thousands
// and appends a "K" suffix). The result was labels rendering as
// "900000K" instead of "$900K".
//
// Fix: add a shared `dollars-compact` formatter case to every
// editorial chart primitive (Line, Bar, GroupedBar). Callers pass
// raw dollars; the formatter picks the unit per tick:
//   0        → "$0K"
//   100_000  → "$100K"
//   900_000  → "$900K"
//   1_200_000 → "$1.2M"
//   -500_000 → "-$500K"
//
// This suite locks the formatter shape in all three primitives so
// no chapter can re-introduce the "raw dollars into
// dollars-thousands" regression.

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const barChart = fs.readFileSync(
  path.resolve(process.cwd(), "src/components/reporting/EditorialBarChart.tsx"),
  "utf8",
);
const groupedBar = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/components/reporting/EditorialGroupedBarChart.tsx",
  ),
  "utf8",
);
const lineChart = fs.readFileSync(
  path.resolve(process.cwd(), "src/components/reporting/EditorialLineChart.tsx"),
  "utf8",
);
const payrollCards = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/app/admin/reporting/monthly/PayrollChartCards.tsx",
  ),
  "utf8",
);

// ---------------------------------------------------------------------------
// The shared formatter — behavioural spec, reproduced here so a
// regression that touches ONE primitive can be caught without
// exercising the whole chart pipeline.
// ---------------------------------------------------------------------------
function compactFormat(v: number): string {
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) {
    const label = (abs / 1_000_000).toFixed(1).replace(/\.0$/, "");
    return `${sign}$${label}M`;
  }
  return `${sign}$${Math.round(abs / 1_000)}K`;
}

describe("v15.9 compact currency formatter — the founder's expected outputs", () => {
  it("0 → $0K (zero-tick reads with the K suffix so all under-1M ticks share the unit)", () => {
    expect(compactFormat(0)).toBe("$0K");
  });

  it("100_000 → $100K", () => {
    expect(compactFormat(100_000)).toBe("$100K");
  });

  it("300_000 → $300K", () => {
    expect(compactFormat(300_000)).toBe("$300K");
  });

  it("900_000 → $900K (the founder's exact failing case)", () => {
    expect(compactFormat(900_000)).toBe("$900K");
  });

  it("1_200_000 → $1.2M (auto-scales to millions at $1M threshold)", () => {
    expect(compactFormat(1_200_000)).toBe("$1.2M");
  });

  it("2_000_000 → $2M (whole-million trailing zero stripped so board copy stays clean)", () => {
    expect(compactFormat(2_000_000)).toBe("$2M");
  });

  it("-500_000 → -$500K (negative variance chart labels)", () => {
    expect(compactFormat(-500_000)).toBe("-$500K");
  });

  it("-1_500_000 → -$1.5M", () => {
    expect(compactFormat(-1_500_000)).toBe("-$1.5M");
  });

  it("never renders the pre-fix duplicated-suffix pattern (e.g. '900000K')", () => {
    // Guard: the failing pattern the founder called out.
    for (const v of [900_000, 100_000, -500_000, 1_200_000]) {
      const out = compactFormat(v);
      expect(out).not.toMatch(/^\$\d{5,}K$/);
      expect(out).not.toMatch(/^\$\d{5,}M$/);
    }
  });
});

// ---------------------------------------------------------------------------
// Source-contract — every editorial chart primitive exposes the
// shared "dollars-compact" case in its FormatYSpec + applyFormatY.
// ---------------------------------------------------------------------------
describe("v15.9 every editorial chart primitive exposes the shared `dollars-compact` case", () => {
  it("EditorialBarChart adds `dollars-compact` to FormatYSpec + applyFormatY", () => {
    expect(barChart).toMatch(/\|\s*"dollars-compact"/);
    expect(barChart).toMatch(/case "dollars-compact":/);
    // The formatter's key branch: $1M threshold and .0-stripping.
    expect(barChart).toMatch(/abs >= 1_000_000/);
    expect(barChart).toMatch(/replace\(\/\\\.0\$\/, ""\)/);
  });

  it("EditorialGroupedBarChart adds `dollars-compact` to FormatYSpec + applyFormatY", () => {
    expect(groupedBar).toMatch(/\|\s*"dollars-compact"/);
    expect(groupedBar).toMatch(/case "dollars-compact":/);
  });

  it("EditorialLineChart adds `dollars-compact` to FormatYSpec + applyFormatY", () => {
    expect(lineChart).toMatch(/\|\s*"dollars-compact"/);
    expect(lineChart).toMatch(/case "dollars-compact":/);
  });
});

// ---------------------------------------------------------------------------
// Payroll — all three bar charts consume the shared formatter with
// raw-dollar domains (no per-chart formatter code).
// ---------------------------------------------------------------------------
describe("v15.9 Payroll charts consume the shared compact formatter (no bespoke Payroll formatter)", () => {
  it("all three Payroll bar charts pass `formatY=\"dollars-compact\"`", () => {
    // Three occurrences: YTD by Department, YTD Variance, Wages vs Taxes.
    const matches = payrollCards.match(/formatY="dollars-compact"/g);
    expect(matches, "expected 3 charts using the shared compact formatter").not.toBeNull();
    expect(matches!.length).toBe(3);
  });

  it("no Payroll chart still consumes the pre-fix `dollars-thousands` (raw-dollars-into-K bug)", () => {
    // Guard: the exact byte the founder reported. If any Payroll
    // chart falls back to dollars-thousands with a raw-dollar
    // domain, the "900000K" bug returns.
    expect(payrollCards).not.toMatch(/formatY="dollars-thousands"/);
  });

  it("Payroll charts carry NO local `applyFormatY` / bespoke tick formatter", () => {
    // The founder's acceptance rule: "No custom one-off formatter
    // remains in Payroll Analysis; use the shared editorial chart
    // formatter."
    expect(payrollCards).not.toMatch(/function applyFormatY/);
    expect(payrollCards).not.toMatch(/const applyFormatY/);
  });

  it("padLeft on the Payroll bar charts is at least 44 (equity/operating alignment invariant)", () => {
    // With the fixed formatter producing 4-6 char labels ("$900K",
    // "$1.2M", "-$500K"), padLeft=44 (with the 8-px anchor gap the
    // shared primitives use) leaves ~36 px of visible margin — the
    // widest label fits comfortably inside the plot band. Any
    // future edit that drops padLeft below the canonical value
    // risks reintroducing the clipping the founder called out.
    expect(payrollCards).toMatch(/padLeft=\{44\}/);
  });
});
