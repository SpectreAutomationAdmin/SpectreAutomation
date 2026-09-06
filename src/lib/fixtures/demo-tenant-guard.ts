// Sprint 3 · Checkpoint 16F revised (2026-08-04) — data-mode guard
// for fixture writers.
//
// Coulee Ridge (staging demo AND founder-review tenant) is the sole
// staging tenant. Regression data is separated from operational data
// by data-mode *within the same tenant*, not by a second club.
//
// Fixture writers must declare the class of write they need:
//   - "SYNTHETIC_OPERATIONAL": creates fake Members / Vendors / AR
//     balances / Work Intake cards / statements / operational
//     dashboard artifacts. FORBIDDEN on any club whose
//     stagingDataMode is FOUNDER_REVIEW. Allowed only when
//     stagingDataMode = SYNTHETIC_DEMO (dev / disposable test DBs).
//   - "REGRESSION_DOCUMENT": stores an IngestedDocument + a
//     RegressionExpectation on the founder-review tenant so the
//     benchmark runner can evaluate the AP intelligence pipeline
//     against known-answer inputs — WITHOUT creating any Work
//     Intake, Member, Vendor, AR, or dashboard record. Allowed on
//     any club whose stagingDataMode is FOUNDER_REVIEW or
//     REGRESSION.
//
// Every write must ALSO pass environment guards:
//   * --apply flag explicitly present
//   * APP_URL is NOT production
//   * NODE_ENV is NOT production
//   * DATABASE_URL host does NOT contain "prod"

import { PrismaClient } from "@prisma/client";

// Staging T&A acceptance (2026-09-05) — the SYNTHETIC_TIME_ATTENDANCE
// write class exists SOLELY so the founder-review Coulee Ridge staging
// tenant can host a narrowly-scoped Time & Attendance acceptance fixture
// (Taylor Fixture + Grounds/Banquets manager fixtures + their clock
// events, timesheets, corrections, department approvals, approved-time
// freezes) without weakening the general SYNTHETIC_OPERATIONAL block.
//
// The staging Coulee Ridge Club ID and Club.name are BAKED IN and must
// match exactly. Every target employee/user must live under the
// approved synthetic email domain — production people (Lise Montsion,
// Chris Turcato, or any other real name that survived a prior demo
// tenant) are refused by name as an additional safety layer.
export type FixtureWriteClass =
  | "SYNTHETIC_OPERATIONAL"
  | "REGRESSION_DOCUMENT"
  | "SYNTHETIC_TIME_ATTENDANCE";
export type StagingDataMode = "FOUNDER_REVIEW" | "REGRESSION" | "SYNTHETIC_DEMO";

// Coulee Ridge staging tenant — see reference_staging_infra.md.
export const COULEE_RIDGE_STAGING_CLUB_ID = "cmrvdeny7000144372ktmmg9c";
export const COULEE_RIDGE_STAGING_CLUB_NAME = "Coulee Ridge Golf & Country Club";
// Only staging fixture identities whose email ends with this suffix
// (case-insensitive) may be created/updated by SYNTHETIC_TIME_ATTENDANCE.
export const STAGING_SYNTHETIC_EMAIL_DOMAIN = "fixture.spectre.test";
// Hard PRESERVE list — names that must NEVER be modified by
// SYNTHETIC_TIME_ATTENDANCE even if they somehow acquire a fixture
// email. Match is case-insensitive on "<firstName> <lastName>".
export const STAGING_PRESERVE_NAMES: ReadonlyArray<string> = [
  "chris turcato",
  "lise montsion",
];

export interface DemoTenantGuardArgs {
  prisma: PrismaClient;
  clubId: string;
  apply: boolean;
  callerName: string;
  /**
   * Class of write the caller intends. Governs which
   * stagingDataMode values are acceptable.
   */
  writeClass: FixtureWriteClass;
}

export interface DemoTenantGuardResult {
  clubSlug: string;
  clubName: string;
  isDemoTenant: boolean;
  stagingDataMode: StagingDataMode;
  databaseIdentity: string;
  environment: string;
}

const ALLOWED_MODES: Record<FixtureWriteClass, StagingDataMode[]> = {
  SYNTHETIC_OPERATIONAL: ["SYNTHETIC_DEMO"],
  REGRESSION_DOCUMENT: ["FOUNDER_REVIEW", "REGRESSION"],
  SYNTHETIC_TIME_ATTENDANCE: ["FOUNDER_REVIEW"],
};

/**
 * Refuses execution unless every §16F condition is met. Returns
 * on success; throws + process.exit(non-zero) on any failure.
 */
export async function guardDemoTenant(args: DemoTenantGuardArgs): Promise<DemoTenantGuardResult> {
  function bail(code: number, msg: string): never {
    // eslint-disable-next-line no-console
    console.error(`REFUSED [${args.callerName}]: ${msg}`);
    process.exit(code);
    throw new Error(msg);
  }

  if (!args.apply) {
    bail(2, `--apply flag is required for real writes. Use --dry-run to inspect without writing.`);
  }

  const appUrl = (process.env.APP_URL ?? "").toLowerCase();
  const isProdUrl = appUrl.includes("production") ||
    (appUrl.includes("spectreautomation.com") && !appUrl.includes("staging"));
  if (isProdUrl) {
    bail(3, `APP_URL indicates production (${appUrl}). Fixture writers MUST NOT write to production.`);
  }
  if (process.env.NODE_ENV === "production") {
    bail(3, `NODE_ENV=production. Fixture writers MUST NOT write to production.`);
  }

  const dbUrl = process.env.DATABASE_URL ?? "";
  const dbHost = (() => {
    try { return new URL(dbUrl).hostname; } catch { return ""; }
  })();
  if (/\bprod(uction)?\b/i.test(dbHost)) {
    bail(4, `DATABASE_URL host looks like production (${dbHost}). Refusing.`);
  }

  const club = await args.prisma.club.findUnique({
    where: { id: args.clubId },
    select: { id: true, slug: true, name: true, isDemoTenant: true, stagingDataMode: true },
  });
  if (!club) bail(5, `Club ${args.clubId} not found.`);

  const mode = (club.stagingDataMode ?? "FOUNDER_REVIEW") as StagingDataMode;
  const allowed = ALLOWED_MODES[args.writeClass];
  if (!allowed.includes(mode)) {
    bail(
      6,
      `Club ${club.slug} (${club.name}) has stagingDataMode=${mode}. ` +
      `Write class "${args.writeClass}" requires stagingDataMode in [${allowed.join(", ")}]. ` +
      (args.writeClass === "SYNTHETIC_OPERATIONAL"
        ? `Synthetic operational fixtures are FORBIDDEN on the founder-review tenant. ` +
          `Use a disposable dev/test DB with stagingDataMode=SYNTHETIC_DEMO.`
        : `Regression documents may be stored only on FOUNDER_REVIEW or REGRESSION tenants.`),
    );
  }

  // SYNTHETIC_TIME_ATTENDANCE — one additional layer.
  if (args.writeClass === "SYNTHETIC_TIME_ATTENDANCE") {
    if (club.id !== COULEE_RIDGE_STAGING_CLUB_ID) {
      bail(7, `SYNTHETIC_TIME_ATTENDANCE requires Club.id=${COULEE_RIDGE_STAGING_CLUB_ID}; got ${club.id}.`);
    }
    if (club.name !== COULEE_RIDGE_STAGING_CLUB_NAME) {
      bail(7, `SYNTHETIC_TIME_ATTENDANCE requires Club.name="${COULEE_RIDGE_STAGING_CLUB_NAME}"; got "${club.name}".`);
    }
    if (process.env.ALLOW_STAGING_TA_FIXTURE !== "YES") {
      bail(8, `SYNTHETIC_TIME_ATTENDANCE requires ALLOW_STAGING_TA_FIXTURE=YES.`);
    }
    // APP_URL must indicate staging (already verified not-production above).
    if (!appUrl.includes("staging")) {
      bail(9, `SYNTHETIC_TIME_ATTENDANCE requires APP_URL to include "staging"; got "${appUrl}".`);
    }
  }

  return {
    clubSlug: club.slug,
    clubName: club.name,
    isDemoTenant: club.isDemoTenant,
    stagingDataMode: mode,
    databaseIdentity: dbHost || dbUrl.slice(0, 40),
    environment: process.env.NODE_ENV ?? "development",
  };
}

// -------------------------------------------------------------------
// Per-target safety helper for SYNTHETIC_TIME_ATTENDANCE writers.
//
// Every write that touches a specific Employee/User (create, update,
// or delete) must first call this. The helper enforces:
//   • target email (if present) ends in @fixture.spectre.test (case-insensitive);
//   • target's "<firstName> <lastName>" is NOT in the PRESERVE list;
//   • target's clubId (if given) is the Coulee Ridge staging club;
//   • employeeId (if given) has already been read to verify identity
//     — the caller is expected to have loaded the row first and pass
//     its identity fields explicitly.
//
// Throws with a clear reason on refusal; returns silently on allow.
// -------------------------------------------------------------------
export interface AssertStagingTaTargetArgs {
  callerName: string;
  identity: {
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
    clubId?: string | null;
  };
}

export function assertStagingTaTargetAllowed(args: AssertStagingTaTargetArgs): void {
  const label = args.callerName;
  const { firstName, lastName, email, clubId } = args.identity;
  if (clubId && clubId !== COULEE_RIDGE_STAGING_CLUB_ID) {
    throw new Error(`REFUSED [${label}]: target clubId=${clubId} is not the Coulee Ridge staging tenant (${COULEE_RIDGE_STAGING_CLUB_ID}).`);
  }
  const fullName = `${(firstName ?? "").trim()} ${(lastName ?? "").trim()}`.trim().toLowerCase();
  if (fullName && STAGING_PRESERVE_NAMES.includes(fullName)) {
    throw new Error(`REFUSED [${label}]: target "${fullName}" is on the PRESERVE list and must NEVER be modified by SYNTHETIC_TIME_ATTENDANCE.`);
  }
  if (email && email.length > 0) {
    const lowered = email.toLowerCase();
    if (!lowered.endsWith(`@${STAGING_SYNTHETIC_EMAIL_DOMAIN}`)) {
      throw new Error(`REFUSED [${label}]: target email "${email}" must end in @${STAGING_SYNTHETIC_EMAIL_DOMAIN} to qualify as a synthetic staging fixture identity.`);
    }
  }
}
