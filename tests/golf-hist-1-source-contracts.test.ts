// GOLF-HIST-1 (2026-10-05) — source-contract pins.
//
// §A  Prisma schema carries GolfActivityImportBatch + Row + Day.
// §B  Canonical resolver reads only from GolfActivityDay (never
//     from preview rows, never from provider-specific tables).
// §C  Weather × Golf join resolver is period-aware + depends only on
//     canonical GolfActivityDay + WEATHER-HIST-1 observation.
// §D  Section XI live builder consumes the join; preview-only data
//     NEVER renders live.
// §E  Commit service blocks commit when reconciliationStatus !=
//     RECONCILED OR conflictCount > 0.
// §F  Admin API endpoint is staging-only + tenant-scoped.
// §G  monthly-package.ts wires live tenants to resolveWeatherGolfJoin
//     before building Section XI.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const SQLITE_SCHEMA = path.join(REPO, "prisma/schema.prisma");
const PG_SCHEMA     = path.join(REPO, "prisma-postgres/schema.prisma");
const RESOLVER      = path.join(REPO, "src/lib/reporting/golf-activity-resolver.ts");
const JOIN          = path.join(REPO, "src/lib/reporting/weather-golf-join.ts");
const SECTION_XI    = path.join(REPO, "src/lib/reporting/monthly-weather-summary.ts");
const MONTHLY       = path.join(REPO, "src/lib/reporting/monthly-package.ts");
const COMMIT        = path.join(REPO, "src/lib/imports/golf-activity/commit-service.ts");
const PARSER        = path.join(REPO, "src/lib/imports/golf-activity/gggolf-pdf-parser.ts");
const API           = path.join(REPO, "src/app/api/admin/golf-activity-import/route.ts");
const WEATHER_TYPES = path.join(REPO, "src/lib/reporting/weather/types.ts");

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/[ \t]+\/\/.*$/gm, "");
}

describe("GOLF-HIST-1 §A — Prisma schema", () => {
  it("SQLite schema defines GolfActivityImportBatch with idempotency key", () => {
    const src = readFileSync(SQLITE_SCHEMA, "utf8");
    expect(src).toMatch(/model GolfActivityImportBatch \{/);
    expect(src).toMatch(/@@unique\(\[clubId, sourceSystem, sourceFileHash, reportingPeriodStart\]\)/);
    expect(src).toMatch(/reconciliationStatus String\s+@default\("UNKNOWN"\)/);
  });

  it("SQLite schema defines GolfActivityImportRow", () => {
    const src = readFileSync(SQLITE_SCHEMA, "utf8");
    expect(src).toMatch(/model GolfActivityImportRow \{/);
    expect(src).toMatch(/activityDate\s+DateTime/);
    expect(src).toMatch(/rawDateLabel\s+String/);
    expect(src).toMatch(/rawWeatherCode\s+String\?/);
  });

  it("SQLite schema defines GolfActivityDay with (clubId, activityDate) unique", () => {
    const src = readFileSync(SQLITE_SCHEMA, "utf8");
    expect(src).toMatch(/model GolfActivityDay \{/);
    expect(src).toMatch(/@@unique\(\[clubId, activityDate\]\)/);
  });

  it("Postgres schema mirrors the three models with the same uniques", () => {
    const src = readFileSync(PG_SCHEMA, "utf8");
    expect(src).toMatch(/model GolfActivityImportBatch \{/);
    expect(src).toMatch(/model GolfActivityImportRow \{/);
    expect(src).toMatch(/model GolfActivityDay \{/);
    expect(src).toMatch(/@@unique\(\[clubId, sourceSystem, sourceFileHash, reportingPeriodStart\]\)/);
    expect(src).toMatch(/@@unique\(\[clubId, activityDate\]\)/);
  });

  it("Weather types extended with optional dailyClassifications", () => {
    const src = readFileSync(WEATHER_TYPES, "utf8");
    expect(src).toMatch(/dailyClassifications\?: ReadonlyArray<DailyWeatherClassification>/);
    expect(src).toMatch(/export type DailyWeatherClassification = \{/);
  });
});

describe("GOLF-HIST-1 §B — Canonical resolver reads only from GolfActivityDay", () => {
  const src = stripComments(readFileSync(RESOLVER, "utf8"));

  it("resolveGolfActivity queries prisma.golfActivityDay (not Import rows)", () => {
    expect(src).toMatch(/prisma\.golfActivityDay\.findMany/);
    expect(src).not.toMatch(/prisma\.golfActivityImportRow/);
    expect(src).not.toMatch(/prisma\.golfActivityImportBatch/);
  });

  it("resolver returns periodAverageRoundsPerDay only when authoritative coverage > 0", () => {
    expect(src).toMatch(/authoritativeDays > 0/);
    expect(src).toMatch(/periodAverageRoundsPerDay = authoritativeDays > 0/);
  });

  it("resolver computes missingDates separately from realZeroDays", () => {
    expect(src).toMatch(/missingDates: Date\[\]/);
    expect(src).toMatch(/realZeroDays\+\+/);
  });

  it("resolver is provider-neutral (never branches on sourceSystem)", () => {
    expect(src).not.toMatch(/sourceSystem\s*===\s*["']GGGOLF/i);
    expect(src).not.toMatch(/if\s*\(.*sourceSystem.*===/);
  });
});

describe("GOLF-HIST-1 §C — Weather × Golf join resolver", () => {
  const src = stripComments(readFileSync(JOIN, "utf8"));

  it("join resolver calls resolveGolfActivity and fetchObservation", () => {
    expect(src).toMatch(/resolveGolfActivity\(/);
    expect(src).toMatch(/fetchObservation\(/);
  });

  it("join falls back when golf data OR daily classifications unavailable", () => {
    expect(src).toMatch(/golfDataAvailable: false/);
    expect(src).toMatch(/dailyClassificationsAvailable: false/);
    expect(src).toMatch(/dailyClassifications\?\.length === 0|classifications\.length === 0/);
  });

  it("join aggregates by canonical weather conditions (reuses WEATHER-HIST-1 classifier)", () => {
    expect(src).toMatch(/"sunny"/);
    expect(src).toMatch(/"partly-cloudy"/);
    expect(src).toMatch(/"rain"/);
    expect(src).toMatch(/"high-wind"/);
    // No new golf-specific classifier.
    expect(src).not.toMatch(/function classify/);
  });

  it("join reuses the approved Pearson-style rain-rounds correlation shape", () => {
    expect(src).toMatch(/computeRainRoundsCorrelation|rainRoundsCorrelation/);
  });
});

describe("GOLF-HIST-1 §D — Section XI live builder consumes the join", () => {
  const src = readFileSync(SECTION_XI, "utf8");

  it("buildCouleeMonthlyWeatherSummary accepts optional weatherGolfJoin input", () => {
    expect(src).toMatch(/weatherGolfJoin\?:/);
    expect(src).toMatch(/golfDataAvailable: boolean;/);
    expect(src).toMatch(/dailyClassificationsAvailable: boolean;/);
  });

  it("live-join bars render averageRounds from byCondition averages (NOT zero)", () => {
    const idx = src.indexOf("const roundsCard = joinLive && opts.weatherGolfJoin");
    expect(idx).toBeGreaterThan(-1);
    const slice = src.slice(idx, idx + 2000);
    expect(slice).toMatch(/byCondition\["sunny"\]\.averageRoundsPerDay/);
    expect(slice).toMatch(/byCondition\["partly-cloudy"\]\.averageRoundsPerDay/);
    expect(slice).toMatch(/byCondition\["rain"\]\.averageRoundsPerDay/);
    expect(slice).toMatch(/byCondition\["high-wind"\]\.averageRoundsPerDay/);
  });

  it("falls back to the UNAVAILABLE sentinel when join is absent or partial", () => {
    expect(src).toMatch(/buildRoundsUnavailableInsight/);
    expect(src).toMatch(/Rounds-by-weather analysis unavailable/);
  });

  it("Golf correlation card activates with live join; Racquet + Dining remain UNAVAILABLE", () => {
    expect(src).toMatch(/buildLiveGolfCorrelationCard/);
    expect(src).toMatch(/Racquet booking source[\s\S]*?not yet connected/i);
    expect(src).toMatch(/POS source not yet connected/);
  });
});

describe("GOLF-HIST-1 §E — Commit service gates", () => {
  const src = stripComments(readFileSync(COMMIT, "utf8"));

  it("commit refuses when reconciliationStatus !== 'RECONCILED'", () => {
    expect(src).toMatch(/batch\.reconciliationStatus !== "RECONCILED"/);
    expect(src).toMatch(/RECONCILIATION_REQUIRED/);
  });

  it("commit refuses when conflictCount > 0", () => {
    expect(src).toMatch(/batch\.conflictCount > 0/);
    expect(src).toMatch(/COMMIT_BLOCKED_BY_CONFLICT/);
  });

  it("commit never writes to accounting tables", () => {
    expect(src).not.toMatch(/prisma\.account\.create|prisma\.account\.update/);
    expect(src).not.toMatch(/prisma\.journalEntry/);
    expect(src).not.toMatch(/prisma\.reportingLedgerBatch/);
    expect(src).not.toMatch(/prisma\.reportingLedgerSnapshot/);
    expect(src).not.toMatch(/prisma\.budget\./);
  });

  it("commit upserts GolfActivityDay by (clubId, activityDate)", () => {
    expect(src).toMatch(/clubId_activityDate: \{ clubId: batch\.clubId, activityDate: r\.activityDate \}/);
  });

  it("preview populates idempotency key via upsert on (clubId, sourceSystem, sourceFileHash, reportingPeriodStart)", () => {
    expect(src).toMatch(/clubId_sourceSystem_sourceFileHash_reportingPeriodStart/);
  });
});

describe("GOLF-HIST-1 §F — Admin API endpoint", () => {
  const src = stripComments(readFileSync(API, "utf8"));

  it("endpoint is staging-only", () => {
    expect(src).toMatch(/if \(!isStaging\(\)\) return NextResponse\.json\(\{ error: "Not available in production\." \}, \{ status: 404 \}\)/);
  });

  it("endpoint tenant-scopes with hasClubAccess for every action", () => {
    expect(src).toMatch(/hasClubAccess\(principal, clubId\)/);
  });

  it("commit refuses cross-tenant batch IDs", () => {
    expect(src).toMatch(/batch\.clubId !== clubId/);
  });
});

describe("GOLF-HIST-1 §G — monthly-package wiring", () => {
  const src = readFileSync(MONTHLY, "utf8");

  it("monthly-package imports resolveWeatherGolfJoin", () => {
    expect(src).toMatch(/import \{ resolveWeatherGolfJoin \} from "@\/lib\/reporting\/weather-golf-join"/);
  });

  it("Section XI live tenant path resolves the join before building the chapter", () => {
    expect(src).toMatch(/const weatherGolfJoin = await resolveWeatherGolfJoin/);
    expect(src).toMatch(/return buildCouleeMonthlyWeatherSummary\(\{[\s\S]*?weatherGolfJoin,/);
  });

  it("join failure never breaks the report (catch -> null)", () => {
    expect(src).toMatch(/resolveWeatherGolfJoin\([\s\S]*?\}\)\.catch\(\(\) => null\)/);
  });
});

describe("GOLF-HIST-1 §H — Parser is provider-aware but canonical model is provider-neutral", () => {
  it("parser is explicitly GGGolf-specific", () => {
    const src = readFileSync(PARSER, "utf8");
    expect(src).toMatch(/GGGolf/i);
    expect(src).toMatch(/sourceFileHash/);
  });

  it("GOLF-HIST-1A — parser uses positional (pdfjs) extraction, NOT text flattening", () => {
    const src = readFileSync(PARSER, "utf8");
    // The real parser must read positional glyphs with pagerender +
    // getTextContent; the previous text-only path is deleted.
    expect(src).toMatch(/pagerender:/);
    expect(src).toMatch(/getTextContent/);
    expect(src).toMatch(/export async function extractGgGolfLayout/);
    expect(src).toMatch(/export function parseGgGolfLayout/);
    // No regex that splits on whitespace between numeric columns —
    // the real pdf-parse output has no inter-column whitespace.
    expect(src).not.toMatch(/parseGgGolfText/);
  });

  it("GOLF-HIST-1A — PARSE_FAILED enum value exists on the result type + is used for the fail-closed path", () => {
    const src = readFileSync(PARSER, "utf8");
    expect(src).toMatch(/"PARSE_FAILED"/);
    expect(src).toMatch(/reconciliationStatus: "PARSE_FAILED"/);
    // Period must NOT be fabricated when parsing fails.
    expect(src).toMatch(/reportingPeriodStart: Date \| null/);
    expect(src).toMatch(/reportingPeriodEnd: Date \| null/);
  });

  it("GOLF-HIST-1A — commit service refuses to persist a PARSE_FAILED batch", () => {
    const src = readFileSync(COMMIT, "utf8");
    expect(src).toMatch(/GolfParseFailedError/);
    expect(src).toMatch(/parse\.reconciliationStatus === "PARSE_FAILED"/);
    expect(src).toMatch(/PARSE FAILED/);
  });

  it("GOLF-HIST-1A — API endpoint returns HTTP 422 on GolfParseFailedError", () => {
    const src = readFileSync(API, "utf8");
    expect(src).toMatch(/GolfParseFailedError/);
    expect(src).toMatch(/status: 422/);
    expect(src).toMatch(/code: "PARSE_FAILED"/);
  });

  it("resolver + join + Section XI builder never mention GGGolf", () => {
    for (const f of [RESOLVER, JOIN, SECTION_XI]) {
      const src = stripComments(readFileSync(f, "utf8"));
      expect(src, `${path.basename(f)} must not know about GGGolf`).not.toMatch(/GGGolf/i);
      expect(src, `${path.basename(f)} must not know about GGGolf`).not.toMatch(/gg[-_]?golf/i);
    }
  });

  it("commit service accepts sourceSystem but defaults to GGGOLF_EXPORT (provider identifier only, no logic)", () => {
    const src = readFileSync(COMMIT, "utf8");
    expect(src).toMatch(/DEFAULT_SOURCE_SYSTEM = "GGGOLF_EXPORT"/);
    // No branches on sourceSystem value.
    expect(stripComments(src)).not.toMatch(/if\s*\([^)]*sourceSystem\s*===/);
  });
});
