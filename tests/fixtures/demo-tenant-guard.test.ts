// Staging T&A guard tests (2026-09-05) — verifies the
// SYNTHETIC_TIME_ATTENDANCE class of demo-tenant-guard.ts enforces
// every safety rail before allowing a fixture write against the
// Coulee Ridge founder-review staging tenant.
//
// Guards NOT covered here that live in the top-level guardDemoTenant
// (production URL / NODE_ENV / DATABASE_URL) are indirectly exercised
// through the wrong-env tests.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { db, resetDb, seedRbac } from "../util/db";
import {
  guardDemoTenant,
  assertStagingTaTargetAllowed,
  COULEE_RIDGE_STAGING_CLUB_ID,
  COULEE_RIDGE_STAGING_CLUB_NAME,
  STAGING_SYNTHETIC_EMAIL_DOMAIN,
} from "@/lib/fixtures/demo-tenant-guard";

// The guard exits the process on failure. Vitest treats process.exit
// as a fatal condition — we wrap in try/catch on Error inside our
// helper. Bail path uses console.error + process.exit; both are
// captured by a spy on process.exit that throws instead of exiting.

let originalExit: typeof process.exit;
let originalConsoleError: typeof console.error;
let bailMessages: string[] = [];
let bailCode: number | null = null;

beforeEach(async () => {
  await resetDb();
  await seedRbac();
  originalExit = process.exit;
  originalConsoleError = console.error;
  bailMessages = [];
  bailCode = null;
  // Replace process.exit with a throw so we can assert on it.
  (process.exit as unknown) = (code: number) => {
    bailCode = code;
    throw new Error(`process.exit(${code})`);
  };
  console.error = (msg: string) => { bailMessages.push(String(msg)); };
});

afterEach(() => {
  process.exit = originalExit;
  console.error = originalConsoleError;
});

async function seedStagingCoulee(opts?: { stagingDataMode?: string }) {
  return db().club.create({
    data: {
      id: COULEE_RIDGE_STAGING_CLUB_ID,
      name: COULEE_RIDGE_STAGING_CLUB_NAME,
      slug: "spectre-staging-platform",
      region: "AB",
      salesTaxRegion: "GST",
      foundedYear: 2000,
      stagingDataMode: opts?.stagingDataMode ?? "FOUNDER_REVIEW",
    },
  });
}

async function seedOtherFounderReviewClub() {
  return db().club.create({
    data: {
      name: "Some Other Founder Review Club",
      slug: "some-other-fr",
      region: "AB",
      salesTaxRegion: "GST",
      foundedYear: 2000,
      stagingDataMode: "FOUNDER_REVIEW",
    },
  });
}

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const originals: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    originals[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try { return await fn(); } finally {
    for (const k of Object.keys(originals)) {
      const v = originals[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const STAGING_ENV = {
  APP_URL: "https://staging.spectreautomation.com",
  NODE_ENV: "test", // guard requires NOT "production"
  DATABASE_URL: "postgresql://user:pass@ep-fake.neon.tech/db",
  ALLOW_STAGING_TA_FIXTURE: "YES",
};

// ==================================================================
// A · Guard admission (§38 test 1)
// ==================================================================
describe("SYNTHETIC_TIME_ATTENDANCE guard — admission", () => {
  it("allows the write class for Coulee Ridge FOUNDER_REVIEW with every gate satisfied", async () => {
    await seedStagingCoulee();
    await withEnv(STAGING_ENV, async () => {
      const r = await guardDemoTenant({
        prisma: db(),
        clubId: COULEE_RIDGE_STAGING_CLUB_ID,
        apply: true,
        callerName: "test-happy-path",
        writeClass: "SYNTHETIC_TIME_ATTENDANCE",
      });
      expect(r.clubName).toBe(COULEE_RIDGE_STAGING_CLUB_NAME);
      expect(r.stagingDataMode).toBe("FOUNDER_REVIEW");
    });
  });
});

// ==================================================================
// B · Env-flag refusals (§38 tests 7-8)
// ==================================================================
describe("SYNTHETIC_TIME_ATTENDANCE guard — env-flag refusals", () => {
  it("§38.7 refuses when NODE_ENV=production (production refusal)", async () => {
    await seedStagingCoulee();
    await withEnv({ ...STAGING_ENV, NODE_ENV: "production" }, async () => {
      await expect(guardDemoTenant({
        prisma: db(), clubId: COULEE_RIDGE_STAGING_CLUB_ID,
        apply: true, callerName: "test-prod", writeClass: "SYNTHETIC_TIME_ATTENDANCE",
      })).rejects.toThrow(/process\.exit\(3\)/);
      expect(bailCode).toBe(3);
    });
  });

  it("§38.8 refuses when ALLOW_STAGING_TA_FIXTURE is absent", async () => {
    await seedStagingCoulee();
    await withEnv({ ...STAGING_ENV, ALLOW_STAGING_TA_FIXTURE: undefined }, async () => {
      await expect(guardDemoTenant({
        prisma: db(), clubId: COULEE_RIDGE_STAGING_CLUB_ID,
        apply: true, callerName: "test-flag", writeClass: "SYNTHETIC_TIME_ATTENDANCE",
      })).rejects.toThrow(/process\.exit\(8\)/);
      expect(bailCode).toBe(8);
    });
  });

  it("§38.8b refuses when APP_URL does not include 'staging'", async () => {
    await seedStagingCoulee();
    await withEnv({ ...STAGING_ENV, APP_URL: "http://localhost:3000" }, async () => {
      await expect(guardDemoTenant({
        prisma: db(), clubId: COULEE_RIDGE_STAGING_CLUB_ID,
        apply: true, callerName: "test-nonstaging", writeClass: "SYNTHETIC_TIME_ATTENDANCE",
      })).rejects.toThrow(/process\.exit\(9\)/);
      expect(bailCode).toBe(9);
    });
  });
});

// ==================================================================
// C · Tenant refusals (§38 tests 5-6)
// ==================================================================
describe("SYNTHETIC_TIME_ATTENDANCE guard — tenant refusals", () => {
  it("§38.5 refuses a wrong Club ID even if that club is Coulee Ridge by name", async () => {
    await db().club.create({
      data: {
        name: COULEE_RIDGE_STAGING_CLUB_NAME, // same name, wrong ID
        slug: "someone-else-tried-this", region: "AB", salesTaxRegion: "GST", foundedYear: 2000,
        stagingDataMode: "FOUNDER_REVIEW",
      },
    });
    const otherClub = await db().club.findFirstOrThrow({ where: { slug: "someone-else-tried-this" } });
    await withEnv(STAGING_ENV, async () => {
      await expect(guardDemoTenant({
        prisma: db(), clubId: otherClub.id,
        apply: true, callerName: "test-wrongid", writeClass: "SYNTHETIC_TIME_ATTENDANCE",
      })).rejects.toThrow(/process\.exit\(7\)/);
      expect(bailCode).toBe(7);
    });
  });

  it("§38.6 refuses another FOUNDER_REVIEW staging club (not Coulee Ridge)", async () => {
    const other = await seedOtherFounderReviewClub();
    await withEnv(STAGING_ENV, async () => {
      await expect(guardDemoTenant({
        prisma: db(), clubId: other.id,
        apply: true, callerName: "test-other", writeClass: "SYNTHETIC_TIME_ATTENDANCE",
      })).rejects.toThrow(/process\.exit\(7\)/);
      expect(bailCode).toBe(7);
    });
  });
});

// ==================================================================
// D · Existing-protection unchanged (§38 test 10)
// ==================================================================
describe("SYNTHETIC_TIME_ATTENDANCE guard — existing SYNTHETIC_OPERATIONAL block remains", () => {
  it("§38.10 SYNTHETIC_OPERATIONAL still forbidden on FOUNDER_REVIEW after extension", async () => {
    await seedStagingCoulee();
    await withEnv(STAGING_ENV, async () => {
      await expect(guardDemoTenant({
        prisma: db(), clubId: COULEE_RIDGE_STAGING_CLUB_ID,
        apply: true, callerName: "test-op-block", writeClass: "SYNTHETIC_OPERATIONAL",
      })).rejects.toThrow(/process\.exit\(6\)/);
      expect(bailCode).toBe(6);
    });
  });

  it("REGRESSION_DOCUMENT still allowed on FOUNDER_REVIEW", async () => {
    await seedStagingCoulee();
    await withEnv(STAGING_ENV, async () => {
      const r = await guardDemoTenant({
        prisma: db(), clubId: COULEE_RIDGE_STAGING_CLUB_ID,
        apply: true, callerName: "test-regr", writeClass: "REGRESSION_DOCUMENT",
      });
      expect(r.stagingDataMode).toBe("FOUNDER_REVIEW");
    });
  });
});

// ==================================================================
// E · Per-target helper (§38 tests 2-4, 9)
// ==================================================================
describe("assertStagingTaTargetAllowed — per-target refusals", () => {
  it("§38.2 refuses Chris Turcato by name (case-insensitive)", () => {
    expect(() => assertStagingTaTargetAllowed({
      callerName: "test", identity: { firstName: "Chris", lastName: "Turcato", email: `chris@${STAGING_SYNTHETIC_EMAIL_DOMAIN}` },
    })).toThrow(/PRESERVE list/i);

    expect(() => assertStagingTaTargetAllowed({
      callerName: "test", identity: { firstName: "chris", lastName: "TURCATO", email: `chris@${STAGING_SYNTHETIC_EMAIL_DOMAIN}` },
    })).toThrow(/PRESERVE list/i);
  });

  it("§38.3 refuses Lise Montsion by name (case-insensitive)", () => {
    expect(() => assertStagingTaTargetAllowed({
      callerName: "test", identity: { firstName: "Lise", lastName: "Montsion", email: `lise@${STAGING_SYNTHETIC_EMAIL_DOMAIN}` },
    })).toThrow(/PRESERVE list/i);
  });

  it("§38.4 refuses non-fixture email domain", () => {
    expect(() => assertStagingTaTargetAllowed({
      callerName: "test", identity: { firstName: "Taylor", lastName: "Fixture", email: "taylor@spectreautomation.com" },
    })).toThrow(/@fixture\.spectre\.test/i);

    expect(() => assertStagingTaTargetAllowed({
      callerName: "test", identity: { firstName: "Taylor", lastName: "Fixture", email: "taylor@silversprings.club" },
    })).toThrow(/@fixture\.spectre\.test/i);
  });

  it("allows a synthetic Taylor Fixture at the Coulee Ridge staging club", () => {
    expect(() => assertStagingTaTargetAllowed({
      callerName: "test", identity: {
        firstName: "Taylor", lastName: "Fixture",
        email: `taylor@${STAGING_SYNTHETIC_EMAIL_DOMAIN}`,
        clubId: COULEE_RIDGE_STAGING_CLUB_ID,
      },
    })).not.toThrow();
  });

  it("allows a synthetic identity with no email set (e.g. Employee row without login)", () => {
    expect(() => assertStagingTaTargetAllowed({
      callerName: "test", identity: {
        firstName: "Grounds", lastName: "Manager Fixture", email: null,
        clubId: COULEE_RIDGE_STAGING_CLUB_ID,
      },
    })).not.toThrow();
  });

  it("§38.9 (reset scope) — refuses any clubId that is not Coulee Ridge staging", () => {
    expect(() => assertStagingTaTargetAllowed({
      callerName: "test-reset", identity: {
        firstName: "Anything", lastName: "Synthetic",
        email: `x@${STAGING_SYNTHETIC_EMAIL_DOMAIN}`,
        clubId: "cmt12qc120000308c9j2rkcs4", // Riverside HR-2B.5 fixture club — real other tenant
      },
    })).toThrow(/is not the Coulee Ridge staging tenant/i);
  });
});
