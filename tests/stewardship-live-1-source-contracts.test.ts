// STEWARDSHIP-LIVE-1 (2026-10-04) — source-contract pins:
//   • UNAVAILABLE_AUXILIARY_KPI_CARDS exports precise unavailable
//     sentinels (not Silver Springs demo numerics).
//   • UNAVAILABLE_STEWARDSHIP_AUX.auxiliaryKpiCards references the
//     unavailable constant, not SILVER_SPRINGS_STEWARDSHIP_AUX.
//   • buildSummaryCards emits precise unavailable Reserve Coverage
//     text when the aux signals unavailable.
//   • Redactor preserves live stewardshipKpiDashboard + operatingKPIs
//     + capitalKPIs instead of blanket-wiping.
//
// Mirrors the directive §28 Test Matrix: ROOT CAUSE / SECTION
// AVAILABILITY / HEADLINE / RENDERING pins.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const ADAPTER = path.join(REPO, "src/lib/reporting/stewardship-dashboard-adapter.ts");
const MONTHLY = path.join(REPO, "src/lib/reporting/monthly-package.ts");

describe("STEWARDSHIP-LIVE-1 §12-16 — UNAVAILABLE_AUXILIARY_KPI_CARDS", () => {
  it("exports a precise per-card unavailable constant", () => {
    const src = readFileSync(ADAPTER, "utf8");
    expect(src).toMatch(/export const UNAVAILABLE_AUXILIARY_KPI_CARDS/);
  });

  it("every auxiliary card uses 'Source not connected' assessment (no Silver Springs demo numerics)", () => {
    const src = readFileSync(ADAPTER, "utf8");
    // The 9 auxiliary cards (5 operating + 4 capital) all live in the
    // UNAVAILABLE_AUXILIARY_KPI_CARDS block. Each must carry a
    // "Source not connected" assessment prefix.
    const block = src.match(/export const UNAVAILABLE_AUXILIARY_KPI_CARDS[\s\S]*?^};/m)?.[0] ?? "";
    expect(block.length).toBeGreaterThan(500);
    const assessments = block.match(/assessment:\s*"Source not connected/g) ?? [];
    expect(assessments.length).toBe(9); // 5 operating + 4 capital
    // Every card renders as "—" (em-dash) not a numeric literal.
    const emDashes = block.match(/actual:\s*"—"/g) ?? [];
    expect(emDashes.length).toBe(9);
    // Every card is tone: "neutral" (never green/amber/red leak).
    const neutrals = block.match(/tone:\s*"neutral"/g) ?? [];
    expect(neutrals.length).toBe(9);
  });

  it("UNAVAILABLE_STEWARDSHIP_AUX.auxiliaryKpiCards references the unavailable constant (not SILVER_SPRINGS)", () => {
    const src = readFileSync(ADAPTER, "utf8");
    const block = src.match(/export const UNAVAILABLE_STEWARDSHIP_AUX[\s\S]*?^};/m)?.[0] ?? "";
    expect(block).toMatch(/auxiliaryKpiCards:\s*UNAVAILABLE_AUXILIARY_KPI_CARDS/);
    expect(block).not.toMatch(/auxiliaryKpiCards:\s*SILVER_SPRINGS_STEWARDSHIP_AUX\.auxiliaryKpiCards/);
  });

  it("no Silver Springs demo values leak into UNAVAILABLE_AUXILIARY_KPI_CARDS", () => {
    const src = readFileSync(ADAPTER, "utf8");
    const block = src.match(/export const UNAVAILABLE_AUXILIARY_KPI_CARDS[\s\S]*?^};/m)?.[0] ?? "";
    // Silver Springs demo numerics that previously leaked via the
    // reused auxiliaryKpiCards reference.
    for (const demoNeedle of ["5.1%", "+6.0%", "-1.4%", "78.4%", "6.4%", "1.42x", "-16.5%", "2.49x", "6 of 7"]) {
      expect(block).not.toContain(demoNeedle);
    }
  });
});

describe("STEWARDSHIP-LIVE-1 §11 — buildSummaryCards precise unavailable Reserve Coverage", () => {
  it("buildSummaryCards detects the unavailable Reserve Coverage sentinel and emits precise text", () => {
    const src = readFileSync(ADAPTER, "utf8");
    // The precise unavailable branch triggers when balanceLabel ===
    // "Unavailable" AND facBenchmarkPct === 0 (both set by
    // UNAVAILABLE_STEWARDSHIP_AUX).
    expect(src).toMatch(/aux\.reserveCoverage\.balanceLabel === "Unavailable"/);
    expect(src).toMatch(/aux\.reserveCoverage\.facBenchmarkPct === 0/);
    expect(src).toMatch(/"Reserve Study not connected"/);
    expect(src).toMatch(/"Source unavailable"/);
    // Never a nonsensical "0%" / "FAC benchmark ≥0%" rendering.
  });
});

describe("STEWARDSHIP-LIVE-1 §7-18 — redactor preserves live Section III", () => {
  it("stewardshipKpiDashboard preserved when dataSource is 'live' (not blanket makeUnavailable)", () => {
    const src = readFileSync(MONTHLY, "utf8");
    const redactor = src.match(/function redactMonthlyPackageForLiveTenant[\s\S]*?^}/m)?.[0] ?? "";
    expect(redactor).toMatch(/stewardshipKpiDashboard:\s*\n?\s*pkg\.stewardshipKpiDashboard\.dataSource === "live"\s*\n?\s*\?\s*pkg\.stewardshipKpiDashboard\s*\n?\s*:\s*makeUnavailable\(pkg\.stewardshipKpiDashboard, u\)/);
  });

  it("operatingKPIs preserved when dataSource is 'live' (not blanket empty)", () => {
    const src = readFileSync(MONTHLY, "utf8");
    const redactor = src.match(/function redactMonthlyPackageForLiveTenant[\s\S]*?^}/m)?.[0] ?? "";
    expect(redactor).toMatch(/operatingKPIs:\s*\n?\s*pkg\.operatingKPIs\.dataSource === "live"\s*\n?\s*\?\s*pkg\.operatingKPIs\s*\n?\s*:\s*\{\s*dataSource: "demo", cards: \[\]\s*\}/);
  });

  it("capitalKPIs preserved when dataSource is 'live' (not blanket empty)", () => {
    const src = readFileSync(MONTHLY, "utf8");
    const redactor = src.match(/function redactMonthlyPackageForLiveTenant[\s\S]*?^}/m)?.[0] ?? "";
    expect(redactor).toMatch(/capitalKPIs:\s*\n?\s*pkg\.capitalKPIs\.dataSource === "live"\s*\n?\s*\?\s*pkg\.capitalKPIs\s*\n?\s*:\s*\{\s*dataSource: "demo", cards: \[\]\s*\}/);
  });
});

describe("STEWARDSHIP-LIVE-1 §25 — no accounting / stewardship mutation", () => {
  it("stewardship-dashboard-adapter never mutates prisma", () => {
    const src = readFileSync(ADAPTER, "utf8");
    expect(src).not.toMatch(/prisma\.\w+\.(create|update|upsert|delete|createMany|updateMany|deleteMany)/);
  });

  it("monthly-package Section III redactor branch never mutates prisma", () => {
    const src = readFileSync(MONTHLY, "utf8");
    const redactor = src.match(/function redactMonthlyPackageForLiveTenant[\s\S]*?^}/m)?.[0] ?? "";
    expect(redactor).not.toMatch(/prisma\.\w+\.(create|update|upsert|delete|createMany|updateMany|deleteMany)/);
  });
});
