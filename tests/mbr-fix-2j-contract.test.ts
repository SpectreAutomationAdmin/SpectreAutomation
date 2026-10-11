// MBR-FIX-2J (2026-10-11) — Stewardship Dashboard KPI data integration.
//
// Three permitted corrections (committed data already available):
//
//   §A  Working Capital — consume ratio-registry's `workingCapital`
//       metric (same source Executive Opening + Statement of Financial
//       Position use) rather than the frozen `bs.lines[*].category`
//       scan.  Fixes the ~$34.4M vs ~$3.94M divergence.
//   §B  Long-Term Debt-to-Equity — consume ratio-registry's
//       `longTermDebtToEquity` metric.  Fixes the 0.00 defect caused
//       by `bs.lines[category === "long-term-liability"]` not
//       reaching Coulee's LT Debt accounts.  Display with "x" suffix
//       (e.g. "0.14x") per directive §3B.
//   §C  F&B Subsidy — compute from Section X Departmental P&L
//       (committed TB).  Loss = |Revenue − COGS − Payroll − OtherOpEx|.
//       Subsidy % = loss / Operating Dues YTD × 100.
//   §D  Policy status guard — no favourable tone (green) when the
//       policy threshold is 0 / unconfigured.  Live tenants without
//       a configured ceiling / floor render neutral tone + "No
//       policy ... configured" copy.
//
// Dependency contract: the registry metrics + the F&B dept resolver
// already exist and feed Executive Opening + Section X; this slice
// is pure wiring — no new financial calculation.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO    = path.resolve(__dirname, "..");
const ADAPTER = path.join(REPO, "src/lib/reporting/stewardship-dashboard-adapter.ts");
const PACKAGE = path.join(REPO, "src/lib/reporting/monthly-package.ts");

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

describe("MBR-FIX-2J §A — Working Capital reads ratio-registry metric", () => {
  const src = readFileSync(ADAPTER, "utf8");
  const code = stripComments(src);

  it("StewardshipAvailabilityInputs declares workingCapital: ResolvedMetric | null", () => {
    expect(src).toMatch(/workingCapital:\s*ResolvedMetric\s*\|\s*null/);
  });

  it("buildWorkingCapitalCard accepts availability + prefers registry metric", () => {
    const idx = src.indexOf("function buildWorkingCapitalCard");
    expect(idx).toBeGreaterThan(0);
    const body = src.slice(idx, idx + 2500);
    expect(body).toMatch(/availability:\s*StewardshipAvailabilityInputs\s*\|\s*null/);
    expect(body).toMatch(/registryMetric\s*=\s*availability\?\.workingCapital/);
    expect(body).toMatch(/registryMetric\.metric\.provenance\.availability\s*===\s*"AVAILABLE"/);
  });

  it("buildWorkingCapitalCard emits neutral tone when policy floor is zero", () => {
    const idx = code.indexOf("function buildWorkingCapitalCard");
    const body = code.slice(idx, idx + 2500);
    expect(body).toMatch(/policyConfigured\s*=\s*floor\s*>\s*0/);
    expect(body).toMatch(/No policy floor configured/);
  });
});

describe("MBR-FIX-2J §B — Long-Term Debt-to-Equity reads ratio-registry metric", () => {
  const src = readFileSync(ADAPTER, "utf8");
  const code = stripComments(src);

  it("StewardshipAvailabilityInputs declares longTermDebtToEquity", () => {
    expect(src).toMatch(/longTermDebtToEquity:\s*ResolvedMetric\s*\|\s*null/);
  });

  it("buildDebtEquityCard reads availability.longTermDebtToEquity", () => {
    const idx = src.indexOf("function buildDebtEquityCard");
    expect(idx).toBeGreaterThan(0);
    const body = src.slice(idx, idx + 2500);
    expect(body).toMatch(/registryMetric\s*=\s*availability\?\.longTermDebtToEquity/);
    expect(body).toMatch(/provenance\.availability\s*===\s*"AVAILABLE"/);
  });

  it("buildDebtEquityCard displays ratio with 'x' suffix", () => {
    const idx = src.indexOf("function buildDebtEquityCard");
    const body = src.slice(idx, idx + 2500);
    expect(body).toMatch(/\$\{formatRatio\(ratio\)\}x/);
  });

  it("buildDebtEquityCard emits neutral tone when ceiling is zero", () => {
    const idx = code.indexOf("function buildDebtEquityCard");
    const body = code.slice(idx, idx + 2500);
    expect(body).toMatch(/policyConfigured\s*=\s*ceiling\s*>\s*0/);
    expect(body).toMatch(/No policy ceiling configured/);
  });
});

describe("MBR-FIX-2J §C — F&B Subsidy computes from Section X inputs", () => {
  const src = readFileSync(ADAPTER, "utf8");

  it("StewardshipAvailabilityInputs declares fbNetOperatingLoss + operatingDuesYtd", () => {
    expect(src).toMatch(/fbNetOperatingLoss:\s*number\s*\|\s*null/);
    expect(src).toMatch(/operatingDuesYtd:\s*number\s*\|\s*null/);
  });

  it("buildFbSubsidyCard formula = loss / dues × 100", () => {
    const idx = src.indexOf("function buildFbSubsidyCard");
    expect(idx).toBeGreaterThan(0);
    const body = src.slice(idx, idx + 2500);
    expect(body).toMatch(/const\s+subsidyPct\s*=\s*\(loss\s*\/\s*dues\)\s*\*\s*100/);
  });

  it("buildFbSubsidyCard falls back to sentinel when inputs missing", () => {
    const idx = src.indexOf("function buildFbSubsidyCard");
    const body = src.slice(idx, idx + 2500);
    expect(body).toMatch(/if\s*\(loss\s*==\s*null\s*\|\|\s*dues\s*==\s*null\s*\|\|\s*dues\s*<=\s*0\)/);
    expect(body).toMatch(/aux\.auxiliaryKpiCards\.operating\.fbSubsidy/);
  });

  it("F&B Subsidy card is wired into the operating KPI list (replaces aux sentinel)", () => {
    const src2 = readFileSync(ADAPTER, "utf8");
    const idx = src2.indexOf("function buildOperatingKpiCards");
    const body = src2.slice(idx, idx + 2000);
    expect(body).toMatch(/buildFbSubsidyCard\(aux,\s*availability\)/);
  });
});

describe("MBR-FIX-2J §D — monthly-package threads the authoritative inputs", () => {
  const src = readFileSync(PACKAGE, "utf8");

  it("availability object includes workingCapital from januaryMetricSet", () => {
    expect(src).toMatch(/workingCapital:\s*januaryMetricSet\?\.workingCapital\s*\?\?\s*null/);
  });

  it("availability object includes longTermDebtToEquity from januaryMetricSet", () => {
    expect(src).toMatch(/longTermDebtToEquity:\s*januaryMetricSet\?\.longTermDebtToEquity\s*\?\?\s*null/);
  });

  it("availability object computes F&B net operating loss from committed dept P&L", () => {
    expect(src).toMatch(/departmentCode\s*===\s*"FOOD_AND_BEVERAGE"/);
    expect(src).toMatch(/const\s+revenue\s*=\s*-Number\(fbRow\.revenue\.toString\(\)\)/);
    expect(src).toMatch(/fbNetOperatingLoss\s*=\s*netResult\s*<\s*0\s*\?\s*Math\.abs\(netResult\)\s*:\s*0/);
  });

  it("availability object sources Operating Dues YTD from the FS-Group projection", () => {
    // Anchor on the Section III-scoped stewardship bundle call site
    // (where availability is prepared) so this doesn't false-match
    // the MBR-FIX-2H Operating Cost Coverage builder's identical
    // dues lookup elsewhere in the file.
    const idx = src.indexOf("let fbNetOperatingLoss: number | null = null;");
    expect(idx).toBeGreaterThan(-1);
    const nearby = src.slice(idx, idx + 2500);
    expect(nearby).toMatch(/fsGroupProjection\.operatingRevenue\.find\(/);
    expect(nearby).toMatch(/fsGroupKey\s*===\s*"IS_MEMBERSHIP_DUES"/);
    expect(nearby).toMatch(/operatingDuesYtd\s*=\s*Math\.abs\(duesRow\.ytdActual\)/);
  });
});
