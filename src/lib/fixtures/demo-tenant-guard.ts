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

export type FixtureWriteClass = "SYNTHETIC_OPERATIONAL" | "REGRESSION_DOCUMENT";
export type StagingDataMode = "FOUNDER_REVIEW" | "REGRESSION" | "SYNTHETIC_DEMO";

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

  return {
    clubSlug: club.slug,
    clubName: club.name,
    isDemoTenant: club.isDemoTenant,
    stagingDataMode: mode,
    databaseIdentity: dbHost || dbUrl.slice(0, 40),
    environment: process.env.NODE_ENV ?? "development",
  };
}
