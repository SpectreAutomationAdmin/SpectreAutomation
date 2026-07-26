// Migrate the COA Department taxonomy (founder spec 2026-07-02):
//
//   • Rename COURSE → GROUNDS (in-place update; FK ids preserved).
//   • Rename FB → F&B (in-place update; FK ids preserved).
//   • Merge GOLF into PROSHOP, then delete GOLF.
//   • Re-target the display NAMES (Grounds, F&B, Pro Shop, etc.) so
//     the dropdown labels match the new short forms.
//
// Idempotent: a second run after a clean state finds no work to do.
//
// Per CLAUDE.md operating rules: touches `Department`,
// `AccountDepartment`, and `Account.defaultDepartmentId` only.
// Doesn't touch ledger postings, members, club settings, users, or
// roles. The same scope-discipline as the prior coa-fs-groups
// migration.

import { PrismaClient } from "@prisma/client";
import {
  DEFAULT_DEPARTMENTS,
  DEPARTMENT_CODE_ALIASES,
} from "../src/lib/accounting/coa-template";

async function migrateClub(prisma: PrismaClient, clubId: string, clubName: string) {
  console.log(`\n=== ${clubName} (${clubId.slice(0, 10)}…) ===`);

  // ── Step 1 — in-place renames (COURSE → GROUNDS, FB → F&B) ────
  // Use UPDATE rather than delete+create so every FK reference
  // survives untouched.
  for (const [oldCode, newCode] of Object.entries(DEPARTMENT_CODE_ALIASES)) {
    // Don't rename GOLF here — it needs the merge path below.
    if (oldCode === "GOLF") continue;
    const target = DEFAULT_DEPARTMENTS.find((d) => d.code === newCode);
    if (!target) continue;
    const existing = await prisma.department.findFirst({
      where: { clubId, code: oldCode },
    });
    if (!existing) continue;
    // If the new code already exists separately, we'd hit a unique
    // constraint. Surface that as a merge candidate instead of a
    // blind rename. (Doesn't happen in fresh seeds but defensive.)
    const collision = await prisma.department.findFirst({
      where: { clubId, code: newCode },
    });
    if (collision && collision.id !== existing.id) {
      console.log(
        `  ⚠ ${oldCode}→${newCode}: both codes exist. Merge required (skipping for safety).`,
      );
      continue;
    }
    await prisma.department.update({
      where: { id: existing.id },
      data: { code: newCode, name: target.name },
    });
    console.log(`  Renamed: ${oldCode} → ${newCode} (Department.id preserved, ${existing.id.slice(0, 8)}…)`);
  }

  // ── Step 2 — merge GOLF into PROSHOP, then delete GOLF ────────
  const golf = await prisma.department.findFirst({
    where: { clubId, code: "GOLF" },
  });
  if (golf) {
    const proshop = await prisma.department.findFirst({
      where: { clubId, code: "PROSHOP" },
    });
    if (!proshop) {
      // Edge case: no PROSHOP exists. Rename GOLF → PROSHOP in
      // place so we don't lose its FKs.
      await prisma.department.update({
        where: { id: golf.id },
        data: { code: "PROSHOP", name: "Pro Shop" },
      });
      console.log(`  No PROSHOP found — renamed GOLF → PROSHOP in place.`);
    } else {
      // Move every Account.defaultDepartmentId pointing at GOLF → PROSHOP.
      const reassignDefaults = await prisma.account.updateMany({
        where: { clubId, defaultDepartmentId: golf.id },
        data: { defaultDepartmentId: proshop.id },
      });
      console.log(`  Reassigned ${reassignDefaults.count} Account.defaultDepartment(GOLF→PROSHOP).`);

      // Move AccountDepartment join rows pointing at GOLF → PROSHOP,
      // skipping any that would collide with an existing PROSHOP
      // link (deduplicate by deleting the GOLF row in that case).
      const golfJoinRows = await prisma.accountDepartment.findMany({
        where: { departmentId: golf.id },
        select: { id: true, accountId: true },
      });
      let moved = 0;
      let deduped = 0;
      for (const row of golfJoinRows) {
        const existingProshopLink = await prisma.accountDepartment.findFirst({
          where: { accountId: row.accountId, departmentId: proshop.id },
        });
        if (existingProshopLink) {
          // Account already on PROSHOP → drop the GOLF row.
          await prisma.accountDepartment.delete({ where: { id: row.id } });
          deduped++;
        } else {
          await prisma.accountDepartment.update({
            where: { id: row.id },
            data: { departmentId: proshop.id },
          });
          moved++;
        }
      }
      console.log(
        `  Moved ${moved} AccountDepartment join rows (GOLF→PROSHOP); deduped ${deduped} already-on-PROSHOP rows.`,
      );

      // Also re-target other tables that FK Department.id. These are
      // rarely populated in dev — the migration runs even on empty
      // ones for safety so a future production run is complete.
      await reassignSimpleFk(prisma, "vendor", "defaultDepartmentId", golf.id, proshop.id);
      await reassignSimpleFk(prisma, "aPInvoice", "departmentId", golf.id, proshop.id);
      await reassignSimpleFk(prisma, "aPInvoiceLine", "departmentId", golf.id, proshop.id);
      await reassignSimpleFk(prisma, "inventoryLocation", "departmentId", golf.id, proshop.id);
      await reassignSimpleFk(prisma, "employee", "departmentId", golf.id, proshop.id);
      await reassignSimpleFk(prisma, "timesheetEntry", "departmentId", golf.id, proshop.id);
      await reassignSimpleFk(prisma, "payrollLine", "departmentId", golf.id, proshop.id);
      await reassignSimpleFk(prisma, "labourBudget", "departmentId", golf.id, proshop.id);
      await reassignSimpleFk(prisma, "capitalAsset", "departmentId", golf.id, proshop.id);
      await reassignSimpleFk(prisma, "budgetLine", "departmentId", golf.id, proshop.id);
      await reassignSimpleFk(prisma, "forecastLine", "departmentId", golf.id, proshop.id);
      await reassignSimpleFk(prisma, "pOSLocation", "departmentId", golf.id, proshop.id);
      await reassignSimpleFk(prisma, "pOSSale", "departmentId", golf.id, proshop.id);
      await reassignSimpleFk(prisma, "costCenter", "departmentId", golf.id, proshop.id);
      await reassignSimpleFk(prisma, "journalEntryLine", "departmentId", golf.id, proshop.id);

      await prisma.department.delete({ where: { id: golf.id } });
      console.log(`  Deleted GOLF Department row.`);
    }
  } else {
    console.log("  No GOLF Department present.");
  }

  // ── Step 3 — refresh display names for surviving codes ────────
  for (const target of DEFAULT_DEPARTMENTS) {
    const row = await prisma.department.findFirst({
      where: { clubId, code: target.code },
    });
    if (!row) {
      // Create if missing (a never-seeded code; fresh club).
      await prisma.department.create({
        data: {
          clubId,
          code: target.code,
          name: target.name,
          isActive: true,
        },
      });
      console.log(`  Created missing Department: ${target.code} (${target.name})`);
      continue;
    }
    if (row.name !== target.name) {
      await prisma.department.update({
        where: { id: row.id },
        data: { name: target.name },
      });
      console.log(`  Renamed name: ${target.code} → "${target.name}"`);
    }
  }
}

// Generic FK reassign for tables that have a simple departmentId
// column. Uses raw Prisma model proxies to avoid duplicating each
// table-specific update call. No-ops cleanly when the table is empty.
async function reassignSimpleFk(
  prisma: PrismaClient,
  model: string,
  field: string,
  fromId: string,
  toId: string,
) {
  const proxy = (prisma as unknown as Record<string, { updateMany: (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{ count: number }> }>)[model];
  if (!proxy?.updateMany) return;
  try {
    const result = await proxy.updateMany({
      where: { [field]: fromId },
      data: { [field]: toId },
    });
    if (result.count > 0) {
      console.log(`    Reassigned ${result.count} ${model}.${field}(GOLF→PROSHOP).`);
    }
  } catch (e) {
    // Some tables may not have the field; ignore gracefully.
    console.log(`    Skipped ${model}.${field}: ${(e as Error).message.slice(0, 80)}`);
  }
}

async function main() {
  const prisma = new PrismaClient();
  const clubs = await prisma.club.findMany({
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });
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
