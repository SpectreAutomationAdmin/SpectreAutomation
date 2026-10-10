// MBR-FIX-2D (2026-10-10) — ONE authoritative NOI across every
// section of the Monthly Board Reporting Package.
//
// The founder's acceptance requirement: NOI Before Depreciation
// must be identical in Executive Opening At-A-Glance, Executive
// Operations, Operating Results chart, Stewardship Dashboard,
// Statement of Activities.
//
// 2C left a $48,153.34 residual between At-A-Glance and Operations
// because the IncomeStatementProjection's bucket roll-up (reading
// TB payload directly) differed from the ratio-registry /
// `computeOperationsPartialAvailability` path (reading via
// `reportingAccountBalances` + `consolidateAccountBalances` which
// normalises through Spectre's authoritative Account.type +
// dimensional joins).
//
// 2D closes the residual by making the IS Projection delegate its
// NOI/Revenue/Expense roll-up to a single `resolveAuthoritativeOperatingIs`
// helper that uses the same path every other consumer uses.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO       = path.resolve(__dirname, "..");
const PROJECTION = path.join(REPO, "src/lib/reporting/ledger/projections/income-statement-projection.ts");

describe("MBR-FIX-2D §A — authoritative helper exists", () => {
  const src = readFileSync(PROJECTION, "utf8");

  it("exports resolveAuthoritativeOperatingIs", () => {
    expect(src).toMatch(/export async function resolveAuthoritativeOperatingIs\(/);
    expect(src).toMatch(/export type AuthoritativeOperatingIs = \{/);
  });

  it("helper reads via reportingAccountBalances + consolidateAccountBalances", () => {
    expect(src).toMatch(/await import\("@\/lib\/accounting\/reporting-balances"\)/);
    expect(src).toMatch(/await import\("@\/lib\/accounting\/balance"\)/);
    expect(src).toMatch(/reportingAccountBalances\(\s*clubId,\s*\{ from: fiscalYearStart, to: periodEnd \},\s*\)/);
  });

  it("helper applies the operating-fund gate", () => {
    expect(src).toMatch(/const isOperating = \(fund: string \| null\): boolean => \{/);
    expect(src).toMatch(/\.includes\("OPERATING"\)/);
  });

  it("helper classifies via fsGroupKey (IS_DEPRECIATION / IS_INTEREST_EXPENSE / IS_COGS*)", () => {
    expect(src).toMatch(/if \(key === "IS_DEPRECIATION"\) depreciation \+= v;/);
    expect(src).toMatch(/else if \(key === "IS_INTEREST_EXPENSE"\) financing \+= v;/);
    expect(src).toMatch(/else if \(key\.startsWith\("IS_COGS"\)\) cogs \+= v;/);
    expect(src).toMatch(/else opex \+= v;/);
  });

  it("NOI = revenue − cogs − opex (depreciation + financing excluded)", () => {
    expect(src).toMatch(/const noi = revenue - cogs - opex;/);
  });
});

describe("MBR-FIX-2D §B — IncomeStatementProjection delegates NOI to the authoritative helper", () => {
  const src = readFileSync(PROJECTION, "utf8");

  it("projection calls resolveAuthoritativeOperatingIs after bucket roll-up", () => {
    expect(src).toMatch(/const auth = await resolveAuthoritativeOperatingIs\(\s*input\.clubId,\s*input\.periodStart,\s*input\.periodEnd,\s*\);/);
  });

  it("override rewrites totalOperatingRevenue + noiBeforeDepreciation + totalOperatingExpense", () => {
    expect(src).toMatch(/buckets\.totalOperatingRevenue = auth\.revenue;/);
    expect(src).toMatch(/buckets\.noiBeforeDepreciation = auth\.noi;/);
    expect(src).toMatch(/buckets\.totalOperatingExpense =\s*auth\.cogs \+ auth\.opex \+ auth\.depreciation;/);
    expect(src).toMatch(/buckets\.depreciation = auth\.depreciation;/);
    expect(src).toMatch(/buckets\.financing = auth\.financing;/);
    expect(src).toMatch(/buckets\.noi = buckets\.noiBeforeDepreciation - buckets\.depreciation;/);
  });

  it("override is wrapped in try/catch so the in-memory ledger path still works", () => {
    const idx = src.indexOf("const auth = await resolveAuthoritativeOperatingIs(");
    expect(idx).toBeGreaterThan(0);
    // Scan up to 1200 chars after the call to find a catch.
    const after = src.slice(idx, idx + 1200);
    expect(after).toMatch(/\} catch \{/);
    expect(after).toMatch(/Authoritative path unavailable/);
  });
});
