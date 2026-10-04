// REPORT-CHART-1 (2026-10-03) — source-contract pins.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const EQUITY = path.join(REPO, "src/lib/reporting/equity-history.ts");
const OPRES = path.join(REPO, "src/lib/reporting/operating-results.ts");

// --------------------------------------------------------------
// §3-4 — Equity committed-snapshot fallback
// --------------------------------------------------------------
describe("REPORT-CHART-1 §3-4 — Equity history falls through to committed TB snapshots", () => {
  it("getEquityHistory prefers the committed-snapshot path when it has more plottable points than the FY series", () => {
    const src = readFileSync(EQUITY, "utf8");
    expect(src).toMatch(/snapshotPoints\.length > series\.length/);
    expect(src).toMatch(/getEquityPointsFromCommittedSnapshots/);
  });

  it("snapshot resolver reads ReportingLedgerSnapshot with entityKind='trial-balance' + batchState='committed'", () => {
    const src = readFileSync(EQUITY, "utf8");
    expect(src).toMatch(/entityKind:\s*"trial-balance"/);
    expect(src).toMatch(/batchState:\s*"committed"/);
  });

  it("snapshot resolver orders by asOf ascending (Dec before Jan)", () => {
    const src = readFileSync(EQUITY, "utf8");
    expect(src).toMatch(/orderBy:\s*\{\s*asOf:\s*"asc"\s*\}/);
  });

  it("§5 benchmark projections (best-in-class / minimum-required) are suppressed on the snapshot path", () => {
    const src = readFileSync(EQUITY, "utf8");
    const block = src.match(/snapshotPoints\.length > series\.length[\s\S]*?\n\s{2}\}/)?.[0] ?? "";
    expect(block).toMatch(/bestInClassCagrBps:\s*0/);
    expect(block).toMatch(/minimumRequiredCagrBps:\s*0/);
    expect(block).toMatch(/bestInClassBenchmarkCents:\s*0n/);
    expect(block).toMatch(/minimumRequiredBenchmarkCents:\s*0n/);
  });

  it("snapshot path never fabricates a future equity point beyond asOf", () => {
    const src = readFileSync(EQUITY, "utf8");
    const resolver = src.match(/async function getEquityPointsFromCommittedSnapshots[\s\S]*?\n\}/)?.[0] ?? "";
    // End-of-day asOf used in the lte filter (same TB-HIST-12 pattern).
    expect(resolver).toMatch(/asOf:\s*\{\s*lte:\s*asOfEod\s*\}/);
    expect(resolver).not.toMatch(/fakeTrend|interpolate|forwardFill/i);
  });
});

// --------------------------------------------------------------
// §7-9 — Operating results committed-snapshot fallback
// --------------------------------------------------------------
describe("REPORT-CHART-1 §7-9 — Operating Results falls through to committed TB snapshots", () => {
  it("getOperatingResults falls through to committed snapshots when FP has no plottable data", () => {
    const src = readFileSync(OPRES, "utf8");
    expect(src).toMatch(/hasPlottableFpData/);
    expect(src).toMatch(/if \(!hasPlottableFpData\)/);
    expect(src).toMatch(/getOperatingMonthsFromCommittedSnapshots/);
  });

  it("§8 NOI metric = Revenue − COGS − OpEx (NOI before depreciation; same as JanuaryMetricSet.noi)", () => {
    const src = readFileSync(OPRES, "utf8");
    expect(src).toMatch(/const noi = revenue - cogs - opex/);
  });

  it("§8 COGS classified via fsGroupKey.startsWith('IS_COGS') — same TB-HIST-10/12B semantics", () => {
    const src = readFileSync(OPRES, "utf8");
    expect(src).toMatch(/fsGroupKey\?.startsWith\("IS_COGS"\)/);
  });

  it("§10 Budget series produces zero plotted points on the snapshot path (budgetNoi: null)", () => {
    const src = readFileSync(OPRES, "utf8");
    expect(src).toMatch(/budgetNoi:\s*null/);
  });

  it("§11 Prior-Year series is empty-array on the snapshot path (not zero-filled)", () => {
    const src = readFileSync(OPRES, "utf8");
    const block = src.match(/if \(!hasPlottableFpData\)[\s\S]*?\n\s{2}\}/)?.[0] ?? "";
    expect(block).toMatch(/priorYearMonths:\s*\[\]/);
  });

  it("§14 snapshot resolver never fabricates a future month beyond asOf", () => {
    const src = readFileSync(OPRES, "utf8");
    const resolver = src.match(/async function getOperatingMonthsFromCommittedSnapshots[\s\S]*?\n\}/)?.[0] ?? "";
    expect(resolver).toMatch(/asOf:\s*\{\s*lte:\s*asOfEod\s*\}/);
    expect(resolver).not.toMatch(/fakeTrend|interpolate|forwardFill/i);
  });
});

// --------------------------------------------------------------
// §22 — ZERO data mutations
// --------------------------------------------------------------
describe("REPORT-CHART-1 §22 — read-only (no prisma writes)", () => {
  it("equity-history snapshot resolver never writes", () => {
    const src = readFileSync(EQUITY, "utf8");
    const resolver = src.match(/async function getEquityPointsFromCommittedSnapshots[\s\S]*?\n\}/)?.[0] ?? "";
    expect(resolver).not.toMatch(/prisma\.\w+\.(create|update|upsert|delete)/);
  });

  it("operating-results snapshot resolver never writes", () => {
    const src = readFileSync(OPRES, "utf8");
    const resolver = src.match(/async function getOperatingMonthsFromCommittedSnapshots[\s\S]*?\n\}/)?.[0] ?? "";
    expect(resolver).not.toMatch(/prisma\.\w+\.(create|update|upsert|delete)/);
  });
});
