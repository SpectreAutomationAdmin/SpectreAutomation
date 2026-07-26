// syncCanonicalAccountingTaxonomy — migration helper tests.
//
// Founder rule 2026-07-19: the canonical migration walks an
// existing club's Categories + FS Groups + Accounts and brings
// them in line with the permanent Spectre taxonomy. The helper
// is idempotent + tenant-scoped + safe to re-run.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";

import { db, resetDb, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";

import { syncCanonicalAccountingTaxonomy } from "@/lib/accounting/coa";
import {
  DEFAULT_CATEGORIES,
  DEFAULT_FS_GROUPS,
} from "@/lib/accounting/coa-template";

beforeAll(async () => {
  await seedRbac();
});
beforeEach(async () => {
  await resetDb();
  await seedRbac();
});

describe("syncCanonicalAccountingTaxonomy — return shape + counts", () => {
  it("returns the expected shape with numeric counts", async () => {
    const club = await bootstrapAPClub("CANON-SYNC-SHAPE");
    const result = await syncCanonicalAccountingTaxonomy(club.id);
    expect(result).toEqual(
      expect.objectContaining({
        categoriesUpserted: expect.any(Number),
        fsGroupsUpserted: expect.any(Number),
        accountsRetargeted: expect.any(Number),
        legacyFsGroupsRemoved: expect.any(Number),
        legacyCategoriesRemoved: expect.any(Number),
      }),
    );
    // The helper upserts the full canonical set on every run, so
    // these counts equal the canonical seed sizes.
    expect(result.categoriesUpserted).toBe(DEFAULT_CATEGORIES.length);
    expect(result.fsGroupsUpserted).toBe(DEFAULT_FS_GROUPS.length);
  });
});

describe("syncCanonicalAccountingTaxonomy — idempotent", () => {
  it("second run is content-stable — every account's fsGroup + category remain on canonical keys", async () => {
    const club = await bootstrapAPClub("CANON-SYNC-IDEMPOTENT");
    // First sync: any legacy rows from the bootstrap seed get
    // moved across.
    await syncCanonicalAccountingTaxonomy(club.id);

    const snapshotAfterFirst = await db().account.findMany({
      where: { clubId: club.id },
      include: { fsGroup: true, category: true },
      orderBy: [{ accountNumber: "asc" }],
    });

    // Second sync: nothing left to GC + content remains identical.
    // (The helper may re-touch rows whose new canonical key
    // happens to equal a key in LEGACY_FS_GROUP_MIGRATION — e.g.
    // BS_OTHER_ASSETS — but the FK target is the same, so the
    // account row is unchanged.)
    const second = await syncCanonicalAccountingTaxonomy(club.id);
    expect(second.legacyFsGroupsRemoved).toBe(0);
    expect(second.legacyCategoriesRemoved).toBe(0);

    const snapshotAfterSecond = await db().account.findMany({
      where: { clubId: club.id },
      include: { fsGroup: true, category: true },
      orderBy: [{ accountNumber: "asc" }],
    });

    expect(snapshotAfterSecond).toHaveLength(snapshotAfterFirst.length);
    for (let i = 0; i < snapshotAfterFirst.length; i++) {
      const before = snapshotAfterFirst[i];
      const after = snapshotAfterSecond[i];
      expect(after.fsGroup?.key).toBe(before.fsGroup?.key);
      expect(after.category?.key).toBe(before.category?.key);
    }
  });
});

describe("syncCanonicalAccountingTaxonomy — canonical taxonomy is materialised", () => {
  it("after sync, the club has every canonical Category + FS Group present", async () => {
    const club = await bootstrapAPClub("CANON-SYNC-MATERIALISE");
    await syncCanonicalAccountingTaxonomy(club.id);

    const categories = await db().accountCategory.findMany({
      where: { clubId: club.id },
      select: { key: true },
    });
    const categoryKeys = new Set(categories.map((c) => c.key));
    for (const canonical of DEFAULT_CATEGORIES) {
      expect(categoryKeys.has(canonical.key)).toBe(true);
    }

    const fsGroups = await db().financialStatementGroup.findMany({
      where: { clubId: club.id },
      select: { key: true },
    });
    const fsGroupKeys = new Set(fsGroups.map((g) => g.key));
    for (const canonical of DEFAULT_FS_GROUPS) {
      expect(fsGroupKeys.has(canonical.key)).toBe(true);
    }
  });
});

describe("syncCanonicalAccountingTaxonomy — tenant safety", () => {
  it("does not modify any other club's Categories or FS Groups", async () => {
    const a = await bootstrapAPClub("CANON-SYNC-TENANT-A");
    const b = await bootstrapAPClub("CANON-SYNC-TENANT-B");

    // Snapshot Club B's FS Group + Category fingerprint before
    // touching Club A.
    const bBeforeFsGroups = await db().financialStatementGroup.findMany({
      where: { clubId: b.id },
      select: { key: true, name: true },
      orderBy: [{ key: "asc" }],
    });
    const bBeforeCategories = await db().accountCategory.findMany({
      where: { clubId: b.id },
      select: { key: true, name: true },
      orderBy: [{ key: "asc" }],
    });

    await syncCanonicalAccountingTaxonomy(a.id);

    const bAfterFsGroups = await db().financialStatementGroup.findMany({
      where: { clubId: b.id },
      select: { key: true, name: true },
      orderBy: [{ key: "asc" }],
    });
    const bAfterCategories = await db().accountCategory.findMany({
      where: { clubId: b.id },
      select: { key: true, name: true },
      orderBy: [{ key: "asc" }],
    });

    expect(bAfterFsGroups).toEqual(bBeforeFsGroups);
    expect(bAfterCategories).toEqual(bBeforeCategories);
  });
});
