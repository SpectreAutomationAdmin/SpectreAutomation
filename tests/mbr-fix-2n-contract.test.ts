// MBR-FIX-2N (2026-10-11) — Capital KPI renames + F&B label integrity.
//
// Three permitted corrections per the directive:
//
//   §2  "Net Available Capital Ratio" → "Capital Funding Coverage
//        Ratio".  Formula = Available Capital Funding ÷ Approved
//        Capital Requirements × 100. Spectre has NEITHER authoritative
//        source today (no capital-planning module), so the KPI stays
//        unavailable with the precise directive-prescribed reason.
//
//   §3  "Net Capital > Depreciation?" → "Capital Reinvestment Ratio".
//        Formula = Capital Asset Additions ÷ Depreciation Expense
//        (trailing 12 months). Coulee has 3 committed months — 9
//        short of the 12-month window. KPI stays unavailable with
//        the directive-prescribed reason. No fabricated additions,
//        no inferred PP&E movement, no annualized incomplete history.
//
//   §4  "F&B Subsidy as % of Dues" → "F&B Operating Loss as % of
//        Dues".  Same calculation; the label "subsidy" implied a
//        formally approved dues-to-dept allocation that does not
//        exist on Coulee's accounting records. Rename is applied
//        consistently across Section II scorecard, Section III
//        Stewardship Dashboard, demo seed, and unavailable sentinel.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO    = path.resolve(__dirname, "..");
const BUILDER = path.join(REPO, "src/lib/reporting/scorecard-live-builder.ts");
const ADAPTER = path.join(REPO, "src/lib/reporting/stewardship-dashboard-adapter.ts");

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

describe("MBR-FIX-2N §2 — Capital Funding Coverage Ratio", () => {
  const src = readFileSync(BUILDER, "utf8");
  const code = stripComments(src);

  it("row key renamed from 'net-available-capital' to 'capital-funding-coverage'", () => {
    expect(code).not.toMatch(/key:\s*"net-available-capital"/);
    expect(code).toMatch(/key:\s*"capital-funding-coverage"/);
  });

  it("metric label renamed from 'Net Available Capital Ratio' to 'Capital Funding Coverage Ratio'", () => {
    expect(code).not.toMatch(/metric:\s*"Net Available Capital Ratio"/);
    expect(code).toMatch(/metric:\s*"Capital Funding Coverage Ratio"/);
  });

  it("description names the formula + the precise unavailable reason", () => {
    const idx = src.indexOf('"capital-funding-coverage"');
    expect(idx).toBeGreaterThan(0);
    const body = src.slice(idx, idx + 1500);
    expect(body).toMatch(/Available Capital Funding ÷ Approved Capital Requirements/);
    expect(body).toMatch(/Approved capital funding and expenditure plan not fully configured/);
  });

  it("row stays unavailable (actual/budget/benchmark null) + no favourable tone", () => {
    const idx = src.indexOf('"capital-funding-coverage"');
    const body = src.slice(idx, idx + 1500);
    expect(body).toMatch(/actual:\s*null/);
    expect(body).toMatch(/budget:\s*null/);
    expect(body).toMatch(/benchmark:\s*null/);
    expect(body).toMatch(/status:\s*null/);
  });
});

describe("MBR-FIX-2N §3 — Capital Reinvestment Ratio", () => {
  const src = readFileSync(BUILDER, "utf8");
  const code = stripComments(src);

  it("row key renamed from 'net-capital-vs-depreciation' to 'capital-reinvestment-ratio'", () => {
    expect(code).not.toMatch(/key:\s*"net-capital-vs-depreciation"/);
    expect(code).toMatch(/key:\s*"capital-reinvestment-ratio"/);
  });

  it("metric label renamed from 'Net Capital > Depreciation?' to 'Capital Reinvestment Ratio'", () => {
    expect(code).not.toMatch(/metric:\s*"Net Capital > Depreciation\?"/);
    expect(code).toMatch(/metric:\s*"Capital Reinvestment Ratio"/);
  });

  it("description names the formula + the precise unavailable reason", () => {
    const idx = src.indexOf('"capital-reinvestment-ratio"');
    expect(idx).toBeGreaterThan(0);
    const body = src.slice(idx, idx + 1500);
    expect(body).toMatch(/Capital Asset Additions ÷ Depreciation Expense/);
    expect(body).toMatch(/trailing 12 months/i);
    expect(body).toMatch(/12 months of capital additions and depreciation history required/);
  });

  it("row stays unavailable + no fabricated additions / inferred PP&E movement", () => {
    const idx = src.indexOf('"capital-reinvestment-ratio"');
    const body = src.slice(idx, idx + 1500);
    expect(body).toMatch(/actual:\s*null/);
    expect(body).toMatch(/budget:\s*null/);
    expect(body).toMatch(/benchmark:\s*null/);
    expect(body).toMatch(/status:\s*null/);
  });
});

describe("MBR-FIX-2N §4 — F&B Operating Loss as % of Dues (consistent rename)", () => {
  const builderSrc = readFileSync(BUILDER, "utf8");
  const adapterSrc = readFileSync(ADAPTER, "utf8");

  it("Section II scorecard row renamed", () => {
    expect(builderSrc).toMatch(/metric:\s*"F&B Operating Loss as % of Dues"/);
    expect(builderSrc).toMatch(/key:\s*"fb-operating-loss-pct-dues"/);
    // Pre-fix label absent.
    expect(builderSrc).not.toMatch(/metric:\s*"F&B Subsidy as % of Dues"/);
  });

  it("Section II numerator uses Math.max(0, loss) so a surplus does not render negative", () => {
    const idx = builderSrc.indexOf("function buildFbSubsidyRow");
    expect(idx).toBeGreaterThan(0);
    const body = builderSrc.slice(idx, idx + 2000);
    expect(body).toMatch(/const\s+lossPct\s*=\s*\(Math\.max\(0,\s*loss\)\s*\/\s*dues\)\s*\*\s*100/);
    expect(body).toMatch(/isSurplus\s*=\s*loss\s*<=\s*0/);
  });

  it("Section II description names Section X + explicitly disclaims formal allocation", () => {
    const idx = builderSrc.indexOf("function buildFbSubsidyRow");
    const body = builderSrc.slice(idx, idx + 2500);
    expect(body).toMatch(/not a formal allocation of dues/i);
  });

  it("Section III Stewardship Dashboard card renamed consistently", () => {
    expect(adapterSrc).toMatch(/name:\s*"F&B Operating Loss as % of Dues"/);
    expect(adapterSrc).toMatch(/key:\s*"fb-operating-loss-pct-dues"/);
  });

  it("Section III live card uses Math.max(0, loss) + surplus-aware assessment", () => {
    const idx = adapterSrc.indexOf("function buildFbSubsidyCard");
    expect(idx).toBeGreaterThan(0);
    const body = adapterSrc.slice(idx, idx + 3000);
    expect(body).toMatch(/const\s+lossPct\s*=\s*\(Math\.max\(0,\s*loss\)\s*\/\s*dues\)\s*\*\s*100/);
    expect(body).toMatch(/isSurplus\s*=\s*loss\s*<=\s*0/);
    expect(body).toMatch(/surplus/);
  });

  it("unavailable sentinel + demo seed both carry the renamed label", () => {
    // Two occurrences of the renamed key, zero of the old key.
    const renamed = (adapterSrc.match(/key:\s*"fb-operating-loss-pct-dues"/g) || []).length;
    expect(renamed).toBeGreaterThanOrEqual(2);
    expect(adapterSrc).not.toMatch(/key:\s*"fb-subsidy"/);
  });
});

describe("MBR-FIX-2N §13 — no favourable tone / status without approved threshold", () => {
  const src = readFileSync(BUILDER, "utf8");

  it("Capital Funding Coverage row keeps status: null", () => {
    const idx = src.indexOf('"capital-funding-coverage"');
    const body = src.slice(idx, idx + 1500);
    expect(body).toMatch(/status:\s*null/);
    expect(body).not.toMatch(/status:\s*"green"/);
  });

  it("Capital Reinvestment Ratio row keeps status: null", () => {
    const idx = src.indexOf('"capital-reinvestment-ratio"');
    const body = src.slice(idx, idx + 1500);
    expect(body).toMatch(/status:\s*null/);
    expect(body).not.toMatch(/status:\s*"green"/);
  });
});
