// MBR-FP-5 — Chapter II presentation corrections:
//   1. Operating + Capital Stewardship Scorecard column header rows
//      share a minimum height so the two cards align horizontally.
//   2. Equity Value Over Time series is restricted to committed
//      fiscal year-end observations only; CAGR is null when the
//      series has fewer than two annual points; Current Equity is
//      decoupled from the series' last value and reflects the live
//      balance sheet at asOf.
//
// Pure data-layer + source-contract tests.  Live-wiring is validated
// separately on staging.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO = path.resolve(__dirname, "..");

describe("MBR-FP-5 §1 — Scorecard column-header min-height is a shared constant", () => {
  const bodySrc = fs.readFileSync(
    path.join(REPO, "src/app/app/admin/reporting/monthly/MonthlyReportingPackageBody.tsx"),
    "utf-8",
  );

  it("defines SCORECARD_COLUMN_HEADER_MIN_HEIGHT as a module-level constant", () => {
    expect(bodySrc).toMatch(/const SCORECARD_COLUMN_HEADER_MIN_HEIGHT\s*=\s*44\s*;/);
  });

  it("applies the shared min-height to the Band-3 column-header row", () => {
    const slice = bodySrc.slice(bodySrc.indexOf("function StewardshipScorecardCard"));
    const scope = slice.slice(0, 10_000);
    expect(scope).toContain("minHeight: `${SCORECARD_COLUMN_HEADER_MIN_HEIGHT}px`");
    // Pin the testid so the Playwright acceptance can locate the
    // row on both Operating + Capital cards.
    expect(scope).toContain("data-testid={`${testid}-column-headers`}");
  });

  it("Operating vs. Capital scorecard column-header text differs by design (Operating wraps, Capital does not)", () => {
    const scorecardLive = fs.readFileSync(
      path.join(REPO, "src/lib/reporting/scorecard-live-builder.ts"),
      "utf-8",
    );
    // Both column-header labels must still be present — this test
    // documents that the heights differ because of text wrap, which
    // the min-height fix equalises.
    expect(scorecardLive).toMatch(/benchmark:\s*"Variance \/ Target"/);
    expect(scorecardLive).toMatch(/benchmark:\s*"Target"/);
  });
});

describe("MBR-FP-5 §2–3 — Equity series admits ONLY fiscal year-end snapshots", () => {
  const equitySrc = fs.readFileSync(
    path.join(REPO, "src/lib/reporting/equity-history.ts"),
    "utf-8",
  );

  it("resolver reads fiscalYearEndMonth/Day from ClubProfile (defaults Dec 31)", () => {
    expect(equitySrc).toMatch(/prisma\.clubProfile\.findUnique/);
    expect(equitySrc).toMatch(/fiscalYearEndMonth:\s*true/);
    expect(equitySrc).toMatch(/fiscalYearEndDay:\s*true/);
    expect(equitySrc).toMatch(/fyEndMonth\s*=\s*fyProfile\?\.fiscalYearEndMonth\s*\?\?\s*12/);
    expect(equitySrc).toMatch(/fyEndDay\s*=\s*fyProfile\?\.fiscalYearEndDay\s*\?\?\s*31/);
  });

  it("snapshot filter: month+day must match tenant's fiscal year-end", () => {
    const fn = equitySrc.slice(equitySrc.indexOf("function getEquityPointsFromCommittedSnapshots"));
    const scope = fn.slice(0, 5_000);
    expect(scope).toMatch(/if \(month !== cfg\.fyEndMonth \|\| day !== cfg\.fyEndDay\) continue/);
    // The month+day are read off `s.asOf` with 1-based month.
    expect(scope).toMatch(/const month = s\.asOf\.getUTCMonth\(\) \+ 1/);
    expect(scope).toMatch(/const day = s\.asOf\.getUTCDate\(\)/);
  });

  it("reporting cutoff: snapshots with asOf > asOfEod are excluded", () => {
    const fn = equitySrc.slice(equitySrc.indexOf("function getEquityPointsFromCommittedSnapshots"));
    const scope = fn.slice(0, 5_000);
    expect(scope).toMatch(/asOf:\s*\{\s*lte:\s*asOfEod\s*\}/);
  });

  it("label format: '<YYYY>' (not '<Mon YYYY>')", () => {
    const fn = equitySrc.slice(equitySrc.indexOf("function getEquityPointsFromCommittedSnapshots"));
    const scope = fn.slice(0, 5_000);
    expect(scope).toMatch(/const label = String\(s\.asOf\.getUTCFullYear\(\)\)/);
    // The pre-MBR-FP-5 "<Mon YYYY>" helper is gone.
    expect(equitySrc).not.toMatch(/function labelFromDate\(/);
  });

  it("dedupe by fiscal year — same-FY twice does NOT produce two points", () => {
    const fn = equitySrc.slice(equitySrc.indexOf("function getEquityPointsFromCommittedSnapshots"));
    const scope = fn.slice(0, 5_000);
    expect(scope).toMatch(/Map<string,/);
    expect(scope).toMatch(/byYear\.set\(label,/);
  });
});

describe("MBR-FP-5 §4 — CAGR + Current Equity semantics", () => {
  const equitySrc = fs.readFileSync(
    path.join(REPO, "src/lib/reporting/equity-history.ts"),
    "utf-8",
  );
  const pkgSrc = fs.readFileSync(
    path.join(REPO, "src/lib/reporting/monthly-package.ts"),
    "utf-8",
  );

  it("EquityHistory.actualCagrBps is number | null (was number)", () => {
    expect(equitySrc).toMatch(/actualCagrBps:\s*number \| null/);
  });

  it("actualCagrBps resolves to null when the series has fewer than two annual observations", () => {
    // Both the FY-path return and the snapshot-path return must set
    // actualCagrBps: null when the point count is below 2.
    expect(equitySrc).toMatch(/actualCagrBps:\s*sp\.length < 2 \? null :/);
    expect(equitySrc).toMatch(/actualCagrBps:\s*actualCents\.length < 2 \? null :/);
  });

  it("Current Equity KPI (snapshot-path tenants) is sourced from a live balance sheet at asOf, not the series' last year-end", () => {
    // The directive-named behaviour applies specifically to the
    // Jonas-only / snapshot-path case where the chart plots ONLY
    // completed fiscal year-ends but the KPI must reflect the
    // current reporting period (e.g. Jan 31 2026).  The FY-driven
    // path keeps the pre-MBR-FP-5 semantic (series' last point IS
    // the current-period equity) because the current open FY
    // already appears in the series as its final observation.
    expect(equitySrc).toMatch(/async function resolveLiveEquity\(clubId: string, asOf: Date\)/);
    expect(equitySrc).toMatch(/const liveCurrent = await resolveLiveEquity\(clubId, asOf\)/);
    // Snapshot-path uses the live BS; graceful fallback is the
    // series' last year-end.
    expect(equitySrc).toMatch(/currentEquityCents:\s*liveCurrent \?\? current/);
  });

  it("Formatter emits '—' for CAGR when actualCagrBps is null (never a fabricated 0.0%)", () => {
    const fn = pkgSrc.slice(pkgSrc.indexOf("function formatEquityDashboard"));
    const scope = fn.slice(0, 5_000);
    expect(scope).toMatch(/actualCagrLabel = h\.actualCagrBps == null \? "—" : pct\(h\.actualCagrBps\)/);
  });

  it("Commentary generator receives 0 (not null) for CAGR when the series has one point", () => {
    const fn = pkgSrc.slice(pkgSrc.indexOf("function formatEquityDashboard"));
    const scope = fn.slice(0, 5_000);
    // The buildEquityCommentary signature requires a number — the
    // formatter coalesces to 0 so the KPI tile can still render "—"
    // while the commentary branch interprets a flat trajectory.
    expect(scope).toMatch(/actualCagrBps:\s*h\.actualCagrBps\s*\?\?\s*0/);
  });
});

describe("MBR-FP-5 §5 — Financial data integrity preserved", () => {
  const equitySrc = fs.readFileSync(
    path.join(REPO, "src/lib/reporting/equity-history.ts"),
    "utf-8",
  );

  it("tenant isolation preserved — every Prisma read filters by clubId", () => {
    // Spot-check: the snapshot query carries clubId; the ClubProfile
    // lookup carries clubId; nothing goes global.
    expect(equitySrc).toMatch(/prisma\.reportingLedgerSnapshot\.findMany/);
    // The findMany's where carries both clubId and entityKind.
    const snapshotCall = equitySrc.slice(equitySrc.indexOf("reportingLedgerSnapshot.findMany"));
    const scope = snapshotCall.slice(0, 1_500);
    expect(scope).toMatch(/clubId,/);
    expect(scope).toMatch(/entityKind: "trial-balance"/);
    // ClubProfile lookup is also tenant-scoped.
    expect(equitySrc).toMatch(/prisma\.clubProfile\.findUnique\(\{\s*where:\s*\{\s*clubId\s*\}/);
  });

  it("historical equity is derived from `balanceSheet(clubId, s.asOf)` — never from monthly interpolation", () => {
    const fn = equitySrc.slice(equitySrc.indexOf("function getEquityPointsFromCommittedSnapshots"));
    const scope = fn.slice(0, 5_000);
    expect(scope).toMatch(/const bs = await balanceSheet\(clubId, s\.asOf\)/);
  });
});
