// TB-HIST-12A (2026-10-03) — source-contract regression guards for
// KPI-level partial availability.
//
// Pins:
//   §1  availability model classifies at KPI level, not chapter level
//   §3  Operations card renders Revenue/NOI/Dues-to-Revenue when
//       derivable; status verdict stays Unavailable without budget
//   §4  Financial Health card renders Working Capital/Current Ratio
//       when derivable; AR Current remains Unavailable
//   §8  factual narrative generator exists + stays non-evaluative
//   §15 January supportability matrix doc exists
//   §16 live Coulee doesn't short-circuit to chapter-wide Unavailable
//       when real KPI inputs exist

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const MONTHLY_PKG = readFileSync(path.join(REPO, "src/lib/reporting/monthly-package.ts"), "utf8");
const PARTIAL_MOD = readFileSync(path.join(REPO, "src/lib/reporting/january-partial-availability.ts"), "utf8");

// --------------------------------------------------------------
// §1 — KPI-level availability model
// --------------------------------------------------------------
describe("TB-HIST-12A §1 — availability classifies at KPI level, not chapter level", () => {
  it("exports the KpiAvailability enum with the four required states", () => {
    expect(PARTIAL_MOD).toMatch(/export type KpiAvailability\s*=\s*"REAL"\s*\|\s*"DERIVED"\s*\|\s*"MANUAL"\s*\|\s*"UNAVAILABLE"/);
  });

  it("exposes per-KPI DerivedKpi<T> with { value, provenance }", () => {
    expect(PARTIAL_MOD).toMatch(/export type DerivedKpi<T>\s*=\s*\{[\s\S]{0,200}value:\s*T\s*\|\s*null;[\s\S]{0,200}provenance:\s*KpiProvenance;/);
  });

  it("exposes OperationsPartialAvailability + FinancialHealthPartialAvailability shapes", () => {
    expect(PARTIAL_MOD).toMatch(/export type OperationsPartialAvailability\s*=\s*\{[\s\S]{0,500}revenue:\s*DerivedKpi<Prisma\.Decimal>/);
    expect(PARTIAL_MOD).toMatch(/export type FinancialHealthPartialAvailability\s*=\s*\{[\s\S]{0,500}workingCapital:\s*DerivedKpi<Prisma\.Decimal>/);
  });
});

// --------------------------------------------------------------
// §3 — Operations card renders available KPIs
// --------------------------------------------------------------
describe("TB-HIST-12A §3 — Operations card renders Revenue/NOI/Dues when derivable", () => {
  it("buildOperationsBriefing accepts a partial-availability input", () => {
    expect(MONTHLY_PKG).toMatch(/function buildOperationsBriefing\([\s\S]{0,500}partial\?:\s*import\("\.\/january-partial-availability"\)\.OperationsPartialAvailability/);
  });

  it("live-branch narrative is factual (no 'On Plan' verdict) when revenue is derivable", () => {
    // The live branch must set statusLabel to the neutral
    // "Financial operating position" string, NOT "On Plan".
    expect(MONTHLY_PKG).toMatch(/statusLabel:\s*anyDerived\s*\?\s*"Financial operating position"\s*:\s*"Unavailable"/);
    // narrative must contain the factual lead-in templates.
    expect(MONTHLY_PKG).toMatch(/Revenue over the period totals/);
    expect(MONTHLY_PKG).toMatch(/Budget comparison is unavailable/);
  });

  it("renders a dues-to-revenue tile with its own availability tag", () => {
    expect(MONTHLY_PKG).toMatch(/key:\s*"dues-rev",[\s\S]{0,120}value:\s*duesVal/);
  });
});

// --------------------------------------------------------------
// §4 — Financial Health card renders Working Capital / Current Ratio
// --------------------------------------------------------------
describe("TB-HIST-12A §4 — Financial Health card renders Working Capital / Current Ratio when derivable", () => {
  it("buildFinancialHealthBriefing accepts a partial-availability input", () => {
    expect(MONTHLY_PKG).toMatch(/function buildFinancialHealthBriefing\([\s\S]{0,500}partial\?:\s*import\("\.\/january-partial-availability"\)\.FinancialHealthPartialAvailability/);
  });

  it("live-branch narrative is factual (no 'Strong Position' verdict) when ratios are derivable", () => {
    expect(MONTHLY_PKG).toMatch(/statusLabel:\s*anyDerived\s*\?\s*"Financial position"\s*:\s*"Unavailable"/);
    expect(MONTHLY_PKG).toMatch(/Current assets exceed current liabilities by/);
    expect(MONTHLY_PKG).toMatch(/Reserve coverage ratio and AR Current %? remain unavailable/);
  });

  it("AR Current chip stays Unavailable even when Working Capital is derivable", () => {
    expect(MONTHLY_PKG).toMatch(/key:\s*"ar-current",[\s\S]{0,100}value:\s*"Unavailable"[\s\S]{0,80}subtitle:\s*"AR aging not imported"/);
  });
});

// --------------------------------------------------------------
// §8 — Factual narrative generator — exists + non-evaluative
// --------------------------------------------------------------
describe("TB-HIST-12A §8 — factual narrative generator", () => {
  it("buildFactualNarrative exists and takes typed numerics", () => {
    expect(PARTIAL_MOD).toMatch(/export function buildFactualNarrative\(parts:\s*\{/);
  });

  it("never emits evaluative verdict labels in its sentence templates", () => {
    const narrativeFn = PARTIAL_MOD.match(/export function buildFactualNarrative[\s\S]*?(?=\n\}\n|\n\nfunction )/)?.[0] ?? "";
    expect(narrativeFn).not.toMatch(/Strong Position/);
    expect(narrativeFn).not.toMatch(/On Plan/);
    expect(narrativeFn).not.toMatch(/Executing/);
    expect(narrativeFn).not.toMatch(/Healthy/);
  });
});

// --------------------------------------------------------------
// §15 — January supportability matrix doc exists
// --------------------------------------------------------------
describe("TB-HIST-12A §15 — January supportability matrix doc exists", () => {
  it("docs/tb-hist-12a-partial-availability-matrix.md exists", () => {
    const docPath = path.join(REPO, "docs/tb-hist-12a-partial-availability-matrix.md");
    expect(existsSync(docPath)).toBe(true);
    const doc = readFileSync(docPath, "utf8");
    // Includes KPI inventory + January supportability + Chapter list.
    expect(doc).toMatch(/May 2026 reference .* KPI inventory/i);
    expect(doc).toMatch(/January supportability matrix/i);
    expect(doc).toMatch(/Chapter X .* Departmental P&L/i);
  });
});

// --------------------------------------------------------------
// §16 — live Coulee does not short-circuit to chapter-wide Unavailable
// --------------------------------------------------------------
describe("TB-HIST-12A §16 — live Coulee renders per-KPI, not chapter-blanket", () => {
  it("getMonthlyReportingPackage resolves partial-availability inputs on live tenants only", () => {
    expect(MONTHLY_PKG).toMatch(/let\s+operationsPartial:[\s\S]{0,400}=\s*undefined/);
    expect(MONTHLY_PKG).toMatch(/let\s+financialHealthPartial:[\s\S]{0,400}=\s*undefined/);
    expect(MONTHLY_PKG).toMatch(/if\s*\(hasRealData\)\s*\{[\s\S]{0,800}computeOperationsPartialAvailability\(/);
    expect(MONTHLY_PKG).toMatch(/computeFinancialHealthPartialAvailability\(/);
  });

  it("the pkg literal threads both partial inputs into the briefing builders", () => {
    expect(MONTHLY_PKG).toMatch(/operations:\s*buildOperationsBriefing\(executiveSummary,\s*hasRealData,\s*operationsPartial\)/);
    expect(MONTHLY_PKG).toMatch(/financialHealth:\s*buildFinancialHealthBriefing\(hasRealData,\s*financialHealthPartial\)/);
  });
});
