// Sprint 3 · Checkpoint 16F (2026-08-04) — hard guard for fixture
// generators.
//
// Founder rule §8: fixture generators may run only when ALL are true:
//   * target club has `isDemoTenant = true`
//   * explicit CLI --apply confirmation
//   * database URL is NOT a production database
//   * environment is not production
//
// This module is the single choke-point every fixture script must
// call. Refuses (with process.exit(non-zero)) otherwise.

import { PrismaClient } from "@prisma/client";

export interface DemoTenantGuardArgs {
  prisma: PrismaClient;
  clubId: string;
  apply: boolean;
  callerName: string;   // e.g. "c15h-founder-fixture"
}

export interface DemoTenantGuardResult {
  clubSlug: string;
  clubName: string;
  isDemoTenant: boolean;
  databaseIdentity: string;
  environment: string;
}

/**
 * Refuses execution unless every §8 condition is met. Returns
 * on success; throws + exits on any failure.
 */
export async function guardDemoTenant(args: DemoTenantGuardArgs): Promise<DemoTenantGuardResult> {
  function bail(code: number, msg: string): never {
    // eslint-disable-next-line no-console
    console.error(`REFUSED [${args.callerName}]: ${msg}`);
    process.exit(code);
    throw new Error(msg); // unreachable — process.exit is `never`
  }

  // 1. Explicit --apply confirmation (caller passes this in).
  if (!args.apply) {
    bail(2, `--apply flag is required for real writes. Use --dry-run to inspect without writing.`);
  }

  // 2. Environment must NOT be production. Rely on multiple signals,
  // not only NODE_ENV.
  const appUrl = (process.env.APP_URL ?? "").toLowerCase();
  const isProdUrl = appUrl.includes("production") ||
    (appUrl.includes("spectreautomation.com") && !appUrl.includes("staging"));
  if (isProdUrl) {
    bail(3, `APP_URL indicates production (${appUrl}). Fixture generators MUST NOT write to production.`);
  }
  if (process.env.NODE_ENV === "production") {
    bail(3, `NODE_ENV=production. Fixture generators MUST NOT write to production.`);
  }

  // 3. Database URL sanity check — must NOT contain "prod" or a
  // known production identifier. Accepts staging/dev/test hosts.
  const dbUrl = process.env.DATABASE_URL ?? "";
  const dbHost = (() => {
    try { return new URL(dbUrl).hostname; } catch { return ""; }
  })();
  if (/\bprod(uction)?\b/i.test(dbHost)) {
    bail(4, `DATABASE_URL host looks like production (${dbHost}). Refusing.`);
  }

  // 4. Club must exist AND have isDemoTenant = true.
  const club = await args.prisma.club.findUnique({
    where: { id: args.clubId },
    select: { id: true, slug: true, name: true, isDemoTenant: true },
  });
  if (!club) bail(5, `Club ${args.clubId} not found.`);
  if (!club.isDemoTenant) {
    bail(6,
      `Club ${club.slug} (${club.name}) has isDemoTenant=false. ` +
      `Fixture generators must target a demo tenant. Create a dedicated demo club with isDemoTenant=true.`,
    );
  }

  return {
    clubSlug: club.slug,
    clubName: club.name,
    isDemoTenant: club.isDemoTenant,
    databaseIdentity: dbHost || dbUrl.slice(0, 40),
    environment: process.env.NODE_ENV ?? "development",
  };
}
