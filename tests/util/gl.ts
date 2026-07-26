// Test helper: bootstrap a club with the default COA + a fiscal year so the
// accounting engine has something to operate on.

import { db, makeClub, seedRbac } from "./db";
import { upsertCategory, upsertFsGroup, upsertAccountInternal } from "@/lib/accounting/coa";
import { DEFAULT_CATEGORIES, DEFAULT_FS_GROUPS, DEFAULT_ACCOUNTS, DEFAULT_DEPARTMENTS } from "@/lib/accounting/coa-template";
import { ensureFiscalYear } from "@/lib/accounting/periods";

export async function bootstrapAccountingClub(name = "GL Test Club") {
  await seedRbac();
  const club = await makeClub(name);
  // Departments
  for (let i = 0; i < DEFAULT_DEPARTMENTS.length; i++) {
    const d = DEFAULT_DEPARTMENTS[i];
    await db().department.create({ data: { clubId: club.id, code: d.code, name: d.name, sortOrder: i, isActive: true } });
  }
  for (const g of DEFAULT_FS_GROUPS) await upsertFsGroup(club.id, g);
  for (const c of DEFAULT_CATEGORIES) await upsertCategory(club.id, c);
  for (const a of DEFAULT_ACCOUNTS) await upsertAccountInternal(club.id, a, null);
  // Two-year window so dated tests don't break across calendar boundaries.
  const y = new Date().getFullYear();
  await ensureFiscalYear(club.id, { startYear: y - 1, startMonth: 1 });
  await ensureFiscalYear(club.id, { startYear: y, startMonth: 1 });
  return club;
}
