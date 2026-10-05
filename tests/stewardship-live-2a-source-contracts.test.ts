// STEWARDSHIP-LIVE-2A (2026-10-05) — source-contract pins for the
// Section III availability closeout.
//
// Three invariants:
//   §1  AR Current % reads from the canonical ratio-registry
//       `arCurrentPct` ResolvedMetric. Section III parity with
//       Executive + Section VIII flows from that one source.
//   §2  Capital Income vs Plan renders SOURCE_NOT_CONNECTED when the
//       Budget source has no capital-fund lines — never a nonsensical
//       "+100% / Ahead of plan" calculated against a zero plan.
//   §3  Initiation Fee Operating Subsidy renders N/A when the COA
//       classifies Entrance Fees as CAPITAL — the ratio is
//       structurally not applicable, not source-not-connected.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const ADAPTER = path.join(REPO, "src/lib/reporting/stewardship-dashboard-adapter.ts");
const MONTHLY = path.join(REPO, "src/lib/reporting/monthly-package.ts");

describe("STEWARDSHIP-LIVE-2A §1 — AR Current % canonical source", () => {
  it("adapter imports ResolvedMetric type from ratio-registry (canonical AR source)", () => {
    const src = readFileSync(ADAPTER, "utf8");
    expect(src).toMatch(/import type \{ ResolvedMetric \} from "@\/lib\/reporting\/ratio-registry"/);
  });

  it("StewardshipAvailabilityInputs exports arCurrentPct: ResolvedMetric | null", () => {
    const src = readFileSync(ADAPTER, "utf8");
    const type = src.match(/export type StewardshipAvailabilityInputs = \{[\s\S]*?\};/)?.[0] ?? "";
    expect(type).toMatch(/arCurrentPct: ResolvedMetric \| null/);
    expect(type).toMatch(/capitalBudgetConnected: boolean/);
    expect(type).toMatch(/entranceFeesAreOperating: boolean/);
  });

  it("buildArCurrentCard reads the metric from availability.arCurrentPct (not from the UNAVAILABLE sentinel) when AVAILABLE", () => {
    const src = readFileSync(ADAPTER, "utf8");
    const body = src.match(/function buildArCurrentCard\([\s\S]*?^}/m)?.[0] ?? "";
    expect(body).toMatch(/availability\?\.arCurrentPct/);
    expect(body).toMatch(/ar\.metric\.provenance\.availability !== "AVAILABLE"/);
    expect(body).toMatch(/ar\.metric\.display/);
    // The target-based classification (≥ 80%) remains policy config.
    expect(body).toMatch(/const target = 0\.80/);
  });

  it("buildArCurrentCard falls back to UNAVAILABLE sentinel when no AR snapshot available", () => {
    const src = readFileSync(ADAPTER, "utf8");
    const body = src.match(/function buildArCurrentCard\([\s\S]*?^}/m)?.[0] ?? "";
    expect(body).toMatch(/return aux\.auxiliaryKpiCards\.operating\.arCurrent;/);
  });

  it("operating card roster uses buildArCurrentCard (not the UNAVAILABLE sentinel directly)", () => {
    const src = readFileSync(ADAPTER, "utf8");
    const body = src.match(/function buildOperatingKpiCards\([\s\S]*?^}/m)?.[0] ?? "";
    expect(body).toMatch(/buildArCurrentCard\(aux, availability\)/);
    expect(body).not.toMatch(/aux\.auxiliaryKpiCards\.operating\.arCurrent,/);
  });
});

describe("STEWARDSHIP-LIVE-2A §2 — Capital Income vs Plan: null Budget != zero", () => {
  it("buildCapitalIncomeVsPlanCard renders SOURCE_NOT_CONNECTED when capitalBudgetConnected is false", () => {
    const src = readFileSync(ADAPTER, "utf8");
    const body = src.match(/function buildCapitalIncomeVsPlanCard\([\s\S]*?^}/m)?.[0] ?? "";
    expect(body).toMatch(/availability\.capitalBudgetConnected === false/);
    expect(body).toMatch(/"Capital budget not connected — vs-plan unavailable."/);
    expect(body).toMatch(/budget: "Plan not connected"/);
    // Live Actual still rendered via formatMoneyShort(actual).
    expect(body).toMatch(/actual: formatMoneyShort\(actual\),/);
    // Tone is neutral — never red/amber from a bogus comparison.
    expect(body).toMatch(/tone: "neutral"/);
  });

  it("buildCapitalIncomeVsPlanCard retains the normal pct-vs-plan branch for tenants with capital budget", () => {
    const src = readFileSync(ADAPTER, "utf8");
    const body = src.match(/function buildCapitalIncomeVsPlanCard\([\s\S]*?^}/m)?.[0] ?? "";
    // When capitalBudgetConnected is true, the normal pct branch fires.
    expect(body).toMatch(/const pct = budget > 0 \? \(actual - budget\) \/ budget : 0;/);
  });
});

describe("STEWARDSHIP-LIVE-2A §3 — Initiation Fee Operating Subsidy N/A when entrance fees are CAPITAL", () => {
  it("buildInitFeeSubsidyCard renders N/A — Entrance fees classified to Capital Fund when entranceFeesAreOperating is false", () => {
    const src = readFileSync(ADAPTER, "utf8");
    const body = src.match(/function buildInitFeeSubsidyCard\([\s\S]*?^}/m)?.[0] ?? "";
    expect(body).toMatch(/availability\.entranceFeesAreOperating === false/);
    expect(body).toMatch(/N\/A — Entrance fees classified to Capital Fund\./);
    expect(body).toMatch(/actual: "N\/A"/);
    expect(body).toMatch(/tone: "neutral"/);
  });

  it("operating card roster uses buildInitFeeSubsidyCard (not the UNAVAILABLE sentinel directly)", () => {
    const src = readFileSync(ADAPTER, "utf8");
    const body = src.match(/function buildOperatingKpiCards\([\s\S]*?^}/m)?.[0] ?? "";
    expect(body).toMatch(/buildInitFeeSubsidyCard\(aux, availability\)/);
    expect(body).not.toMatch(/aux\.auxiliaryKpiCards\.operating\.initFeeSubsidy,/);
  });
});

describe("STEWARDSHIP-LIVE-2A — monthly-package wires availability for live tenants", () => {
  it("getStewardshipForClub call carries availability block for live tenants", () => {
    const src = readFileSync(MONTHLY, "utf8");
    const call = src.match(/const stewardshipBundle = await getStewardshipForClub\(\{[\s\S]*?\}\);/)?.[0] ?? "";
    expect(call).toMatch(/availability: hasRealData/);
    expect(call).toMatch(/arCurrentPct: januaryMetricSet\?\.arCurrentPct \?\? null/);
    expect(call).toMatch(/capitalBudgetConnected: false/);
    expect(call).toMatch(/entranceFeesAreOperating: false/);
  });
});

describe("STEWARDSHIP-LIVE-2A §4 — availability audit: no zero-for-missing patterns", () => {
  it("no NEW zero-for-missing budget in the adapter (every budget read is explicit)", () => {
    const src = readFileSync(ADAPTER, "utf8");
    // The capital-income builder's live branch uses budget directly;
    // the SOURCE_NOT_CONNECTED branch sets actual via formatMoneyShort
    // (which only accepts the live Actual, never a hidden zero).
    const capBody = src.match(/function buildCapitalIncomeVsPlanCard\([\s\S]*?^}/m)?.[0] ?? "";
    // Pattern "budget: 0" (coercing missing budget to zero) must not appear.
    expect(capBody).not.toMatch(/budget: 0\b/);
    // The SOURCE_NOT_CONNECTED branch is BEFORE the pct calculation,
    // so the "budget > 0 ? ... : 0" fallback can't fire for live tenants
    // whose capital budget is actually zero AND the signal says so.
  });

  it("no accounting-data mutation introduced in this slice", () => {
    const src = readFileSync(ADAPTER, "utf8");
    expect(src).not.toMatch(/prisma\.\w+\.(create|update|upsert|delete|createMany|updateMany|deleteMany)/);
  });
});
