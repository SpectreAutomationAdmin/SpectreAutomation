// Sprint 3 Checkpoint 15B (2026-07-24) — Source-contract tests for
// the intelligence kernel + Mission Control wiring + APIs.
//
// Read the source files and assert:
//   - closed enumerations are honoured
//   - persistence + origins never accept untrusted client-side kind
//   - MC loader is read-only (no writes)
//   - fixture command has staging guards
//   - notice-send remains fail-closed

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const TYPES = readFileSync(path.resolve(__dirname, "../src/lib/intelligence/types.ts"), "utf8");
const ORIGINS = readFileSync(path.resolve(__dirname, "../src/lib/intelligence/origins.ts"), "utf8");
const PERSISTENCE = readFileSync(path.resolve(__dirname, "../src/lib/intelligence/persistence.ts"), "utf8");
const ANALYSER = readFileSync(path.resolve(__dirname, "../src/lib/intelligence/analysers/ar-aging.ts"), "utf8");
const MATERIALISER = readFileSync(path.resolve(__dirname, "../src/lib/intelligence/materialisers/ar-aging.ts"), "utf8");
const AR_INTAKE = readFileSync(path.resolve(__dirname, "../src/lib/mission-control/ar-intake.ts"), "utf8");
const AR_EVIDENCE_ROUTE = readFileSync(path.resolve(__dirname, "../src/app/api/mission-control/work-intake/[id]/ar-evidence/route.ts"), "utf8");
const FINDING_REJECT_ROUTE = readFileSync(path.resolve(__dirname, "../src/app/api/work-intake/[id]/findings/[findingId]/reject/route.ts"), "utf8");
const MC_INDEX = readFileSync(path.resolve(__dirname, "../src/lib/mission-control/index.ts"), "utf8");
const CLI = readFileSync(path.resolve(__dirname, "../bin/intelligence-ar-aging-materialise.ts"), "utf8");

// ---------------------------------------------------------------------------
// Closed enumerations
// ---------------------------------------------------------------------------

describe("Closed enumerations", () => {
  it("ORIGIN_KINDS is closed — 15B AR kinds + 15E document/AP kinds", () => {
    const block = TYPES.slice(TYPES.indexOf("export const ORIGIN_KINDS = ["), TYPES.indexOf("] as const;", TYPES.indexOf("ORIGIN_KINDS")) + "] as const;".length);
    // 15B (AR)
    expect(block).toContain('"MEMBER_ACCOUNT"');
    expect(block).toContain('"MEMBER"');
    expect(block).toContain('"COLLECTION_NOTICE"');
    expect(block).toContain('"MEMBER_TRANSACTION"');
    // 15E (Documents + AP)
    expect(block).toContain('"INGESTED_DOCUMENT"');
    expect(block).toContain('"AP_INVOICE"');
    // Explicit exclusions — not yet approved in any checkpoint.
    expect(block).not.toContain('"EMAIL_MESSAGE"');
    expect(block).not.toContain('"APPROVAL_REQUEST"');
  });

  it("FINDING_STATES enumerate exactly the five approved values", () => {
    expect(TYPES).toMatch(/FINDING_STATES = \[\s*"CONFIRMED",\s*"OBSERVED",\s*"SUPERSEDED",\s*"USER_REJECTED",\s*"ERROR",?\s*\] as const/);
  });

  it("FINDING_SEVERITIES enumerate exactly the five approved values", () => {
    expect(TYPES).toMatch(/FINDING_SEVERITIES = \[\s*"INFO",\s*"LOW",\s*"MEDIUM",\s*"HIGH",\s*"CRITICAL",?\s*\] as const/);
  });

  it("PERSISTENCE_ERROR_CATEGORIES enumerate exactly the six approved values", () => {
    for (const v of ["DATA_MISSING", "TENANT_MISMATCH", "POLICY_UNDEFINED", "PERSISTENCE_CONFLICT", "UNAUTHORIZED", "UNEXPECTED"]) {
      expect(TYPES).toContain(`"${v}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// Origin resolver — server-only, tenant-guarded
// ---------------------------------------------------------------------------

describe("Origins resolver — tenant + kind guards", () => {
  it("resolveEvidenceReferences validates the kind against ORIGIN_KINDS", () => {
    expect(ORIGINS).toMatch(/if \(!\(ORIGIN_KINDS as readonly string\[\]\)\.includes\(ref\.kind\)\)/);
  });

  it("every exists-check filters by clubId (no cross-tenant leakage)", () => {
    // Each branch of the switch includes `clubId` in the where clause
    const switchBlock = ORIGINS.slice(ORIGINS.indexOf("switch (kind)"), ORIGINS.indexOf("default:"));
    // Every case: passes { id: referenceId, clubId } to .count/.findFirst
    const clubFilters = (switchBlock.match(/clubId/g) || []).length;
    expect(clubFilters).toBeGreaterThanOrEqual(4); // one per kind
  });

  it("throws IntelligenceError(DATA_MISSING) on missing / cross-club reference", () => {
    expect(ORIGINS).toMatch(/DATA_MISSING[\s\S]*?Reference not found or cross-club/);
  });
});

// ---------------------------------------------------------------------------
// Persistence — identity semantics + rejection preservation
// ---------------------------------------------------------------------------

describe("Persistence — semantic identity + rejection preservation", () => {
  it("uses findingIdentityKey (semantic, not row id / timestamp)", () => {
    expect(PERSISTENCE).toMatch(/findingIdentityKey\(d\)/);
  });

  it("preserves USER_REJECTED — the analyser cannot silently re-activate the same shape", () => {
    expect(PERSISTENCE).toMatch(/rejectedSameShape[\s\S]*?The rejection stands\. Do nothing\./);
  });

  it("never physically deletes findings — supersession is an update to state SUPERSEDED", () => {
    expect(PERSISTENCE).not.toMatch(/prisma\.workIntakeFinding\.delete/);
    expect(PERSISTENCE).toMatch(/state:\s*"SUPERSEDED"/);
  });

  it("advances WorkIntakeItem.lastAnalysedAt only when the run makes a material change", () => {
    expect(PERSISTENCE).toMatch(/const materialChange = created > 0 \|\| superseded > 0/);
    expect(PERSISTENCE).toMatch(/if \(materialChange\)/);
    expect(PERSISTENCE).toMatch(/prisma\.workIntakeItem\.update\([\s\S]*?lastAnalysedAt: new Date\(\)/);
  });

  it("emits ANALYSIS_REFRESHED activity only when the analysis materially changes", () => {
    const block = PERSISTENCE.slice(PERSISTENCE.indexOf("if (materialChange)"));
    expect(block).toMatch(/action: "ANALYSIS_REFRESHED"/);
  });

  it("bounded findings per run (32 cap enforced)", () => {
    expect(PERSISTENCE).toMatch(/args\.desired\.length > 32/);
    expect(PERSISTENCE).toMatch(/PERSISTENCE_CONFLICT/);
  });

  it("assertIntakeInClub is called before any write", () => {
    // Both upsertAnalysisFindings and rejectFinding must call it
    const upsert = PERSISTENCE.slice(PERSISTENCE.indexOf("export async function upsertAnalysisFindings"), PERSISTENCE.indexOf("export async function readActiveFindings"));
    expect(upsert).toMatch(/await assertIntakeInClub\(workIntakeItemId, clubId\)/);
    const reject = PERSISTENCE.slice(PERSISTENCE.indexOf("export async function rejectFinding"));
    expect(reject).toMatch(/await assertIntakeInClub\(args\.workIntakeItemId, args\.clubId\)/);
  });
});

// ---------------------------------------------------------------------------
// AR-aging analyser + materialiser
// ---------------------------------------------------------------------------

describe("AR-aging rule module", () => {
  it("declares AR_AGING_RULE_VERSION as a numeric constant (versioning is per-rule)", () => {
    expect(ANALYSER).toMatch(/export const AR_AGING_RULE_VERSION = 1/);
  });

  it("dominant-bucket selection prefers 120 > 90 > 60 (never all three findings)", () => {
    expect(ANALYSER).toMatch(/export function dominantBucket/);
    // 120 branch appears before 90 branch in the composer
    const idx120 = ANALYSER.indexOf("ar.policy.120_day_breach");
    const idx90 = ANALYSER.indexOf("ar.policy.90_day_breach");
    const idx60 = ANALYSER.indexOf("ar.policy.60_day_breach");
    expect(idx120).toBeLessThan(idx90);
    expect(idx90).toBeLessThan(idx60);
  });

  it("credit offset finding statement explicitly says 'does not automatically net'", () => {
    expect(ANALYSER).toMatch(/does not automatically net/);
  });

  it("insufficient-evidence finding uses state ERROR, never a fabricated conclusion", () => {
    const block = ANALYSER.slice(ANALYSER.indexOf("ar.analysis.insufficient_evidence"));
    expect(block).toMatch(/state: "ERROR"/);
  });

  it("recommendation composer never promises suspension / legal / write-off", () => {
    const composer = ANALYSER.slice(ANALYSER.indexOf("export function composeArAgingRecommendation"));
    // The 120-day statement explicitly disclaims these actions
    expect(composer).toMatch(/Spectre does not initiate suspension, share sale, legal collection, or write-off automatically/);
  });

  it("materialiser never runs from a page-load path — no MC loader imports it", () => {
    // The MC loader imports only ar-intake (read-only) not the materialiser
    expect(MC_INDEX).not.toMatch(/materialisers\/ar-aging/);
    expect(AR_INTAKE).not.toMatch(/materialisers\/ar-aging/);
  });

  it("materialiser is bounded (MAX_ACCOUNTS_PER_RUN <= 500)", () => {
    expect(MATERIALISER).toMatch(/MAX_ACCOUNTS_PER_RUN = 500/);
  });

  it("materialiser writes only through the intelligence kernel + Prisma helpers", () => {
    // No direct route/API calls, no cron / scheduler
    expect(MATERIALISER).not.toMatch(/setInterval|setTimeout|cron/i);
    expect(MATERIALISER).not.toMatch(/\benqueue\(/);
  });
});

// ---------------------------------------------------------------------------
// MC loader — read-only invariant
// ---------------------------------------------------------------------------

describe("MC AR loader — READ-ONLY", () => {
  it("ar-intake loader has zero .create/.update/.delete calls", () => {
    expect(AR_INTAKE).not.toMatch(/prisma\.[a-z][A-Za-z]*\.(create|update|delete|upsert)/);
  });

  it("ar-intake loader does not import the materialiser or persistence writers", () => {
    expect(AR_INTAKE).not.toMatch(/materialisers\/ar-aging/);
    expect(AR_INTAKE).not.toMatch(/upsertAnalysisFindings|upsertOrigins|rejectFinding/);
  });

  it("MC snapshot loader replaces the ad-hoc AR path with the persisted path", () => {
    // Legacy loader is not called from the snapshot
    expect(MC_INDEX).toMatch(/loadArIntakeItems\(\{ clubId, now \}\)/);
    // The legacy `loadOverdueMemberARItems` is still defined for reference
    // but no longer invoked by loadMissionControlSnapshot
    const snapshotFn = MC_INDEX.slice(MC_INDEX.indexOf("export async function loadMissionControlSnapshot"));
    expect(snapshotFn).not.toMatch(/loadOverdueMemberARItems\(principal, clubId, now\)/);
  });

  it("ar-intake exposes only the ar.review_collection_notice action as primary (no send)", () => {
    const actionsBlock = AR_INTAKE.slice(AR_INTAKE.indexOf("actions: ["), AR_INTAKE.indexOf("],", AR_INTAKE.indexOf("actions: [")));
    expect(actionsBlock).toMatch(/ar\.review_collection_notice/);
    expect(actionsBlock).not.toMatch(/send_notice|transmit|deliver_notice/);
  });
});

// ---------------------------------------------------------------------------
// APIs — tenant + fail-closed send
// ---------------------------------------------------------------------------

describe("AR evidence endpoint", () => {
  it("is a GET (read-only)", () => {
    expect(AR_EVIDENCE_ROUTE).toMatch(/^export async function GET\(/m);
    expect(AR_EVIDENCE_ROUTE).not.toMatch(/^export async function (POST|PATCH|DELETE|PUT)\(/m);
  });

  it("enforces active club scope on the intake lookup", () => {
    expect(AR_EVIDENCE_ROUTE).toMatch(/where:\s*\{\s*id:\s*workIntakeItemId,\s*clubId\s*\}/);
  });

  it("never leaks existence — 404 on missing / cross-club / no MEMBER_ACCOUNT origin", () => {
    const notFoundCount = (AR_EVIDENCE_ROUTE.match(/status: 404/g) || []).length;
    expect(notFoundCount).toBeGreaterThanOrEqual(3);
  });

  it("proposed notice is READ-ONLY — sendActionAvailable is always false in this checkpoint", () => {
    expect(AR_EVIDENCE_ROUTE).toMatch(/sendActionAvailable: false/);
    expect(AR_EVIDENCE_ROUTE).toMatch(/Direct notice sending requires a separate controlled authorization checkpoint/);
    // No .create on collectionNotice from this route
    expect(AR_EVIDENCE_ROUTE).not.toMatch(/prisma\.collectionNotice\.create/);
    expect(AR_EVIDENCE_ROUTE).not.toMatch(/prisma\.collectionNotice\.update/);
  });

  it("never sends email / transmits / calls Graph", () => {
    expect(AR_EVIDENCE_ROUTE).not.toMatch(/sendMail/i);
    expect(AR_EVIDENCE_ROUTE).not.toMatch(/graph\.microsoft\.com/);
    expect(AR_EVIDENCE_ROUTE).not.toMatch(/POST.*sendMail/);
  });
});

describe("Finding-reject endpoint", () => {
  it("is a POST that only mutates the finding row (no notice / no send)", () => {
    expect(FINDING_REJECT_ROUTE).toMatch(/^export async function POST\(/m);
    expect(FINDING_REJECT_ROUTE).not.toMatch(/sendMail|graph\.microsoft\.com/);
  });

  it("enforces active club scope + delegates to rejectFinding (which asserts intake-in-club)", () => {
    expect(FINDING_REJECT_ROUTE).toMatch(/const clubId = await getActiveClubId/);
    expect(FINDING_REJECT_ROUTE).toMatch(/rejectFinding\(\{[\s\S]*?clubId,[\s\S]*?workIntakeItemId,[\s\S]*?findingId,/);
  });

  it("requires a non-empty reason (400 otherwise)", () => {
    expect(FINDING_REJECT_ROUTE).toMatch(/reason_required/);
    expect(FINDING_REJECT_ROUTE).toMatch(/reason\.length === 0/);
  });

  it("returns 404 (never 403) on tenant mismatch to avoid existence leaks", () => {
    expect(FINDING_REJECT_ROUTE).toMatch(/TENANT_MISMATCH[\s\S]*?404/);
  });
});

// ---------------------------------------------------------------------------
// CLI — staging guard
// ---------------------------------------------------------------------------

describe("intelligence-ar-aging-materialise CLI", () => {
  it("refuses to run outside staging / localhost", () => {
    expect(CLI).toMatch(/if \(!appUrl\.includes\("staging"\) && !appUrl\.includes\("localhost"\)\)/);
    expect(CLI).toMatch(/REFUSED: APP_URL does not indicate staging/);
  });

  it("refuses to run against Silver Springs by slug or name", () => {
    expect(CLI).toMatch(/silver-springs|Silver Springs/);
    expect(CLI).toMatch(/REFUSED: Silver Springs data is out of scope/);
  });

  it("dry-run is the default; --apply required for writes", () => {
    expect(CLI).toMatch(/let apply = false/);
    expect(CLI).toMatch(/"--apply"/);
  });

  it("outputs redacted structured summary (no member names / emails / balances)", () => {
    // Ensure JSON.stringify body lists only aggregate + redacted-tail fields
    const outputBlock = CLI.slice(CLI.indexOf("MATERIALISATION RESULT"));
    expect(outputBlock).not.toMatch(/firstName|lastName|memberEmail|memberNumber/);
    expect(outputBlock).toMatch(/referenceIdTail/);
  });
});
