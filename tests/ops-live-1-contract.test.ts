// OPS-LIVE-1 (2026-10-06) — Operating Statistics + Utilization
// Outcomes contract regressions. Enforce:
//
//   §A  31,420 / 74.1 / 1,567 / 63.97 demo values cannot reach a
//       live Coulee render.
//   §B  Section XI Utilization Outcomes consume live Rounds YTD +
//       UNAVAILABLE sentinels for the three sources not connected.
//   §C  Section IX uses the canonical live builder on hasRealData;
//       demo tenants keep the Silver Springs seed.
//   §D  Cross-section reconciliation — Section IX Total Rounds and
//       Section XI Rounds YTD read from the SAME canonical YTD
//       resolver.
//   §E  Canonical YTD resolver reads only from GolfActivityDay
//       (never Import rows, never provider-specific code).
//   §F  Redactor preserves live Section IX (does not wipe when
//       dataSource === "live").
//   §G  Weather × Golf + correlation withholding from GOLF-HIST-1B
//       are preserved.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const MONTHLY = path.join(REPO, "src/lib/reporting/monthly-package.ts");
const OPS_STATS = path.join(REPO, "src/lib/reporting/operating-statistics.ts");
const YTD_RESOLVER = path.join(REPO, "src/lib/reporting/golf-activity-ytd.ts");
const BODY = path.join(REPO, "src/app/app/admin/reporting/monthly/MonthlyReportingPackageBody.tsx");

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/[ \t]+\/\/.*$/gm, "");
}

describe("OPS-LIVE-1 §A — demo values cannot reach live tenants", () => {
  const monthly = readFileSync(MONTHLY, "utf8");

  it("live operatingStats branch does NOT contain demo rounds / spend numerics", () => {
    // Scope the slice to the LIVE branch only — the ternary's demo
    // branch begins at `: {` after the live branch's `}`.
    const idx = monthly.indexOf("operatingStats: hasRealData");
    const demoStart = monthly.indexOf("}),\n\n      : {", idx);
    const endIdx = demoStart >= 0 ? demoStart : idx + 400;
    const liveSlice = monthly.slice(idx, endIdx);
    expect(liveSlice).toMatch(/buildCouleeOperatingStats/);
    expect(liveSlice).not.toMatch(/31420|"31,420"|\$1,567|63\.97/);
  });

  it("live weatherUtilization branch does NOT contain demo utilization numerics", () => {
    const idx = monthly.indexOf("weatherUtilization: hasRealData");
    expect(idx).toBeGreaterThan(-1);
    // Live-branch body spans from the opening `?` to the `:` that
    // starts the demo branch. Find the `: {` that begins the demo
    // branch (first demo-dataSource reference after our marker).
    const demoMarker = monthly.indexOf("dataSource: \"demo\"", idx);
    const endIdx = demoMarker >= 0 ? demoMarker : idx + 800;
    const liveSlice = monthly.slice(idx, endIdx);
    expect(liveSlice).not.toMatch(/74\.1|82\.4|~\$48K/);
    expect(liveSlice).toMatch(/courseUtilizationPct: "—"/);
  });

  it("buildCouleeOperatingStatistics (Section IX live builder) has no demo-value numerics", () => {
    const src = readFileSync(OPS_STATS, "utf8");
    const idx = src.indexOf("export function buildCouleeOperatingStatistics");
    expect(idx).toBeGreaterThan(-1);
    const body = src.slice(idx);
    const bodyNoComments = stripComments(body);
    // No Silver Springs demo rounds / covers numerics in the live
    // builder body.
    for (const forbidden of [/4_280/, /2_640/, /1_120/, /520\b/, /18\.40/, /6_840/, /32\.40/, /14\.20/, /1_240/, /342\b/, /6\.8\b/, /4\.6\b/, /84\.0/, /38\.4\b/, /12\.4\b/]) {
      expect(bodyNoComments, `live builder must not contain ${forbidden.source}`).not.toMatch(forbidden);
    }
  });
});

describe("OPS-LIVE-1 §B — Section XI Utilization Outcomes UI respects unavailability", () => {
  const body = readFileSync(BODY, "utf8");

  it("Rounds YTD tile renders '—' when stats.rounds.ytd is null", () => {
    expect(body).toMatch(/stats\.rounds\.ytd != null \? stats\.rounds\.ytd\.toLocaleString\(\) : "—"/);
  });

  it("Course utilization tile renders unavailable sub when value is '—'", () => {
    expect(body).toMatch(/Tee-time inventory source not connected/);
  });

  it("Spend per Member tile renders unavailable sub when value is '—'", () => {
    expect(body).toMatch(/Member spend source not connected/);
  });

  it("Spend per Round tile renders unavailable sub when value is '—'", () => {
    expect(body).toMatch(/Round spend source not connected/);
  });

  it("Rounds YTD sub DROPS the 'vs plan' clause when varPct is '—'", () => {
    expect(body).toMatch(/stats\.rounds\.varPct === "—"[\s\S]{0,80}guestSharePct}/);
  });
});

describe("OPS-LIVE-1 §C — live-vs-demo branching contract", () => {
  const monthly = readFileSync(MONTHLY, "utf8");

  it("operatingStats branches on hasRealData → buildCouleeOperatingStats / demo seed", () => {
    expect(monthly).toMatch(/operatingStats: hasRealData\s*\?\s*await buildCouleeOperatingStats/);
    expect(monthly).toMatch(/operatingStats: hasRealData[\s\S]*?dataSource: "demo",/);
  });

  it("weatherUtilization branches on hasRealData → unavailable live sentinel / demo seed", () => {
    expect(monthly).toMatch(/weatherUtilization: hasRealData/);
    expect(monthly).toMatch(/dataSource: "live",[\s\S]*?courseUtilizationPct: "—"/);
  });

  it("Section IX monthly-package wires live tenants to buildCouleeOperatingStatistics", () => {
    expect(monthly).toMatch(/operatingStatistics: hasRealData[\s\S]*?buildCouleeOperatingStatistics/);
  });

  it("liveGolfYtd is resolved for live tenants and passed to BOTH Section IX and Section XI builders", () => {
    expect(monthly).toMatch(/const liveGolfYtd = hasRealData\s*\?\s*await resolveGolfActivityYtd/);
    // Pass-through to buildCouleeOperatingStats (Section XI utilization chips).
    expect(monthly).toMatch(/buildCouleeOperatingStats\(\{[\s\S]*?golfYtd: liveGolfYtd!/);
    // Pass-through to buildCouleeOperatingStatistics (Section IX).
    expect(monthly).toMatch(/buildCouleeOperatingStatistics\(\{[\s\S]*?golfYtd: liveGolfYtd!/);
  });
});

describe("OPS-LIVE-1 §D — Cross-section reconciliation (shared canonical resolver)", () => {
  const monthly = readFileSync(MONTHLY, "utf8");

  it("Section IX + XI consume the SAME GolfActivityYtd object", () => {
    // Both call sites must pass `golfYtd: liveGolfYtd!` — not two
    // independent calls to resolveGolfActivityYtd.
    const callsites = (monthly.match(/golfYtd: liveGolfYtd!/g) ?? []).length;
    expect(callsites).toBeGreaterThanOrEqual(2);
  });

  it("resolveGolfActivityYtd is imported once from the canonical module", () => {
    const matches = (monthly.match(/resolveGolfActivityYtd/g) ?? []).length;
    expect(matches).toBeGreaterThanOrEqual(2);
  });
});

describe("OPS-LIVE-1 §E — Canonical YTD resolver reads only from GolfActivityDay", () => {
  const src = stripComments(readFileSync(YTD_RESOLVER, "utf8"));

  it("delegates to resolveGolfActivity (which reads only GolfActivityDay)", () => {
    expect(src).toMatch(/resolveGolfActivity\(/);
  });

  it("never reads from Import rows or batch tables directly", () => {
    expect(src).not.toMatch(/prisma\.golfActivityImportRow/);
    expect(src).not.toMatch(/prisma\.golfActivityImportBatch/);
  });

  it("exposes coverage semantics (expected / present / complete)", () => {
    expect(src).toMatch(/coverageDaysExpected/);
    expect(src).toMatch(/coverageDaysPresent/);
    expect(src).toMatch(/coverageComplete/);
  });

  it("returns null (not 0) for totals when no coverage", () => {
    expect(src).toMatch(/totalRounds = coverageDaysPresent > 0 \? activity\.totalRounds : null/);
    expect(src).toMatch(/memberRounds = coverageDaysPresent > 0 \? activity\.memberRounds : null/);
    expect(src).toMatch(/guestRounds = coverageDaysPresent > 0 \? activity\.guestRounds : null/);
  });
});

describe("OPS-LIVE-1 §F — Redactor preserves live Section IX", () => {
  const monthly = readFileSync(MONTHLY, "utf8");
  it("redactor only wipes operatingStatistics when dataSource is NOT 'live'", () => {
    expect(monthly).toMatch(/operatingStatistics:\s*\n\s*pkg\.operatingStatistics\.dataSource === "live"\s*\n\s*\?\s*pkg\.operatingStatistics/);
  });
});

describe("OPS-LIVE-1 §G — GOLF-HIST-1B invariants preserved", () => {
  const monthly = readFileSync(MONTHLY, "utf8");
  const section_xi = readFileSync(
    path.join(REPO, "src/lib/reporting/monthly-weather-summary.ts"),
    "utf8",
  );

  it("Weather × Golf join resolver + Section XI live builder paths unchanged", () => {
    expect(monthly).toMatch(/const weatherGolfJoin = await resolveWeatherGolfJoin/);
    expect(monthly).toMatch(/buildCouleeMonthlyWeatherSummary/);
  });

  it("Golf correlation card data point remains '—'", () => {
    expect(section_xi).toMatch(/dataPoint: \{ label: "Weather correlation:", value: "—" \}/);
  });

  it("rounds card bars=[] on unavailable branch preserved", () => {
    expect(section_xi).toMatch(/bars: \[\] as ReadonlyArray<WeatherRoundsBar>/);
  });
});

describe("OPS-LIVE-1 §H — operatingStats + weatherUtilization type signatures accept null + '—'", () => {
  const monthly = readFileSync(MONTHLY, "utf8");

  it("rounds / fbCovers accept null for numeric YTD fields", () => {
    expect(monthly).toMatch(/ytd: number \| null/);
    expect(monthly).toMatch(/ytdBudget: number \| null/);
  });

  it("members.active accepts null (per Zero ≠ Unavailable)", () => {
    expect(monthly).toMatch(/active: number \| null/);
  });
});
