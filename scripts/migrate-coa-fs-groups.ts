// One-shot migration: align an existing club's FS Group taxonomy to
// the founder's 2026-07-02 cleanup — remove department labels from
// the FS Group dropdown, replace with cross-department presentation
// buckets. Idempotent.
//
// What it does, per club:
//   1. Upserts every FS group defined in DEFAULT_FS_GROUPS (adds new
//      buckets like IS_OPEX_WAGES, renames IS_REVENUE_FB to "Food &
//      Beverage Revenue", etc.).
//   2. Remaps each Account.fsGroupId that points at a retired key
//      (IS_REVENUE_GOLF / IS_OPEX_COURSE / etc.) to the appropriate
//      new bucket, using a per-account-number mapping table below.
//   3. Deletes the retired FS groups — but only if NO accounts still
//      reference them after the remap (safety guard).
//
// Per CLAUDE.md operating rules: touches FinancialStatementGroup +
// Account.fsGroupId only. Never touches ledger postings, members,
// club settings, users, or roles.

import { PrismaClient } from "@prisma/client";
import {
  DEFAULT_FS_GROUPS,
  RETIRED_FS_GROUP_KEYS,
} from "../src/lib/accounting/coa-template";

// Map per-account remappings for accounts that were on a retired
// FS group. Keys are accountNumber strings; values are the new
// FS-group `key`. Accounts not in this map keep whatever FS group
// they already hold.
const ACCOUNT_REMAP: Record<string, string> = {
  // Revenue — IS_REVENUE_GOLF retired.
  "4100": "IS_REVENUE_GUEST_FEE",      // Greens & Guest Fees
  "4110": "IS_REVENUE_CART",            // Cart & Range Fees
  "4400": "IS_REVENUE_OTHER",           // Lesson Revenue

  // Expenses — IS_OPEX_COURSE / IS_OPEX_PROSHOP / IS_OPEX_FB /
  // IS_OPEX_CLUBHOUSE / IS_OPEX_ADMIN all retired.
  "6000": "IS_OPEX_WAGES",              // Course Salaries
  "6010": "IS_OPEX_COURSE_SUPPLIES",    // Course Supplies
  "6020": "IS_OPEX_EQUIPMENT_REPAIRS",  // Course Equipment R&M
  "6100": "IS_OPEX_WAGES",              // Pro Shop Salaries
  "6200": "IS_OPEX_WAGES",              // F&B Salaries
  "6210": "IS_OPEX_OTHER",              // F&B Supplies
  "6300": "IS_OPEX_WAGES",              // Clubhouse Salaries
  "6310": "IS_OPEX_UTILITIES",          // Clubhouse Utilities
  "6320": "IS_OPEX_RM",                 // Clubhouse R&M
  "6400": "IS_OPEX_WAGES",              // Admin Salaries
  "6410": "IS_OPEX_OFFICE",             // Office & Administration
  "6420": "IS_OPEX_PROFESSIONAL",       // Professional Fees
  "6430": "IS_OPEX_INSURANCE",          // Insurance
  "6440": "IS_OPEX_MARKETING",          // Marketing
  "6500": "IS_OPEX_BAD_DEBT",           // Bad Debt
  "6900": "IS_OPEX_DEPRECIATION",       // Depreciation
  "6910": "IS_OPEX_INTEREST",           // Interest Expense
};

async function migrateClub(prisma: PrismaClient, clubId: string, clubName: string) {
  console.log(`\n=== ${clubName} (${clubId.slice(0, 10)}…) ===`);

  // Step 1 — upsert all canonical FS groups. Idempotent: existing
  // keys keep their id, just update name + statement + sortOrder.
  // First pass: groups without parentKey (so children can FK them).
  const allDefs = [...DEFAULT_FS_GROUPS];
  const ordered = [
    ...allDefs.filter((g) => !g.parentKey),
    ...allDefs.filter((g) => g.parentKey),
  ];
  let upserted = 0;
  for (const g of ordered) {
    let parentGroupId: string | null = null;
    if (g.parentKey) {
      const p = await prisma.financialStatementGroup.findFirst({
        where: { clubId, key: g.parentKey },
      });
      if (p) parentGroupId = p.id;
    }
    await prisma.financialStatementGroup.upsert({
      where: { clubId_key: { clubId, key: g.key } },
      update: {
        name: g.name,
        statement: g.statement,
        cashFlowSection: g.cashFlowSection ?? null,
        parentGroupId,
        sortOrder: g.sortOrder ?? 0,
      },
      create: {
        clubId,
        key: g.key,
        name: g.name,
        statement: g.statement,
        cashFlowSection: g.cashFlowSection ?? null,
        parentGroupId,
        sortOrder: g.sortOrder ?? 0,
      },
    });
    upserted++;
  }
  console.log(`  Upserted ${upserted} canonical FS groups.`);

  // Step 2 — remap accounts that point at a retired FS group key.
  const retiredGroups = await prisma.financialStatementGroup.findMany({
    where: { clubId, key: { in: [...RETIRED_FS_GROUP_KEYS] } },
    select: { id: true, key: true },
  });
  const retiredIdSet = new Set(retiredGroups.map((g) => g.id));
  if (retiredIdSet.size === 0) {
    console.log("  No retired FS groups present — nothing to remap.");
  } else {
    const affectedAccounts = await prisma.account.findMany({
      where: { clubId, fsGroupId: { in: [...retiredIdSet] } },
      select: { id: true, accountNumber: true, fsGroupId: true, name: true },
    });
    console.log(`  Found ${affectedAccounts.length} accounts on retired FS groups.`);

    // Cache new FS group ids by key.
    const newGroups = await prisma.financialStatementGroup.findMany({
      where: { clubId },
      select: { id: true, key: true },
    });
    const byKey = new Map(newGroups.map((g) => [g.key, g.id] as const));

    let remapped = 0;
    let unmapped = 0;
    for (const acct of affectedAccounts) {
      const targetKey = ACCOUNT_REMAP[acct.accountNumber];
      if (!targetKey) {
        // No explicit mapping → fall back to a sensible default
        // based on the retired key.
        const retiredKey = retiredGroups.find((g) => g.id === acct.fsGroupId)?.key;
        const fallback =
          retiredKey === "IS_REVENUE" || retiredKey === "IS_REVENUE_GOLF"
            ? "IS_REVENUE_OTHER"
            : "IS_OPEX_OTHER";
        const targetId = byKey.get(fallback);
        if (!targetId) {
          console.log(`    ⚠ ${acct.accountNumber} ${acct.name}: no target FS group ${fallback}`);
          unmapped++;
          continue;
        }
        await prisma.account.update({
          where: { id: acct.id },
          data: { fsGroupId: targetId },
        });
        console.log(`    ${acct.accountNumber} ${acct.name} → ${fallback} (fallback from ${retiredKey})`);
        remapped++;
        continue;
      }
      const targetId = byKey.get(targetKey);
      if (!targetId) {
        console.log(`    ⚠ ${acct.accountNumber}: target ${targetKey} not found`);
        unmapped++;
        continue;
      }
      await prisma.account.update({
        where: { id: acct.id },
        data: { fsGroupId: targetId },
      });
      console.log(`    ${acct.accountNumber} ${acct.name} → ${targetKey}`);
      remapped++;
    }
    console.log(`  Remapped ${remapped} accounts (${unmapped} unmapped).`);

    // Step 3 — delete retired FS groups, but only those with zero
    // remaining account references.
    let deleted = 0;
    for (const g of retiredGroups) {
      const refCount = await prisma.account.count({ where: { fsGroupId: g.id } });
      if (refCount > 0) {
        console.log(`    Skipping delete of ${g.key} — still has ${refCount} account(s).`);
        continue;
      }
      // Also clear parentGroupId references pointing at this group
      // (e.g. if IS_REVENUE was a parent of IS_REVENUE_MEMBERSHIP,
      // we need to null those out before delete).
      await prisma.financialStatementGroup.updateMany({
        where: { clubId, parentGroupId: g.id },
        data: { parentGroupId: null },
      });
      await prisma.financialStatementGroup.delete({ where: { id: g.id } });
      console.log(`    Deleted retired FS group: ${g.key}`);
      deleted++;
    }
    console.log(`  Deleted ${deleted} retired FS groups.`);
  }
}

async function main() {
  const prisma = new PrismaClient();
  const clubs = await prisma.club.findMany({
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });
  if (clubs.length === 0) {
    console.log("No clubs.");
    await prisma.$disconnect();
    return;
  }
  for (const c of clubs) {
    await migrateClub(prisma, c.id, c.name);
  }
  console.log("\nDone.");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
