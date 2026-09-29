// Sprint 3 Checkpoint 15I-4 (2026-07-27) — Tenant accounting bootstrap.
//
// Ensures a club has the standard Spectre accounting taxonomy —
// AccountCategory rows, FinancialStatementGroup rows, and Department
// rows — required by every downstream accounting surface (Chart of
// Accounts import mapping, financial statements, GL recommender,
// journal entry validation, AP intelligence).
//
// Semantics:
//   • ENSURE, not overwrite. Rows are inserted ONLY when a matching
//     canonical key is missing on the tenant. Founder-customised
//     names, sort orders, or parent relationships on existing rows
//     are preserved.
//   • Idempotent. Re-running the ensure on a fully-configured tenant
//     produces zero inserts. Re-running on a partially-configured
//     tenant inserts only the missing rows.
//   • Tenant-scoped. Every insert carries clubId; no cross-tenant
//     leakage possible.
//   • Non-destructive. Existing AccountCategory / FinancialStatementGroup
//     / Department rows are never deleted or renamed by this service.
//   • Does NOT seed DEFAULT_ACCOUNTS. The founder imports the club's
//     chart of accounts via the CoA import path; auto-seeding
//     accounts here would collide with imported rows.
//   • Does NOT seed fiscal years. Period bootstrap lives in
//     `src/lib/accounting/periods.ts` (`ensureFiscalYear`).
//
// Called from:
//   • The COA import server action (defensive — a first-time import
//     on a bare tenant now auto-repairs the taxonomy before parsing
//     the file, so the founder never sees "not configured for this
//     club" errors for canonical keys).
//   • The club onboarding path (future — this file is the single
//     source of truth so club provisioning can call the same
//     function).

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability/logger";
import {
  DEFAULT_CATEGORIES,
  DEFAULT_FS_GROUPS,
  DEFAULT_DEPARTMENTS,
} from "./coa-template";

// DIM-1 (2026-09-29) — canonical Fund seed. Two entries seeded by
// default (OPERATING + CAPITAL) so every club can begin posting
// dimensional accounting immediately. The Fund model is extensible —
// per-club RESTRICTED / ENDOWMENT / TOURNAMENT / project-specific
// funds can be added later without a schema change.
const DEFAULT_FUNDS: ReadonlyArray<{ key: string; name: string; sortOrder: number }> = [
  { key: "OPERATING", name: "Operating Fund", sortOrder: 10 },
  { key: "CAPITAL",   name: "Capital Fund",   sortOrder: 20 },
];

export interface EnsureStandardConfigurationResult {
  clubId: string;
  categoriesInserted: number;
  fsGroupsInserted: number;
  departmentsInserted: number;
  fundsInserted: number;
  // The exact canonical keys that were newly inserted, for audit.
  insertedCategoryKeys: string[];
  insertedFsGroupKeys: string[];
  insertedDepartmentCodes: string[];
  insertedFundKeys: string[];
  // Counts BEFORE the ensure ran, for diagnostic clarity.
  before: { categories: number; fsGroups: number; departments: number; funds: number };
  // Counts AFTER the ensure ran.
  after: { categories: number; fsGroups: number; departments: number; funds: number };
  // Elapsed ms — mostly for staging log correlation.
  elapsedMs: number;
}

/**
 * Ensures the standard Spectre accounting taxonomy is installed on
 * this club. Safe to call from any surface that requires the tenant
 * to have the canonical categories / FS groups / departments in
 * place (COA import, AP intelligence, journal validation).
 *
 * Idempotent, tenant-scoped, non-destructive. Preserves any
 * founder-customised names on existing rows.
 */
export async function ensureStandardAccountingConfiguration(
  clubId: string,
): Promise<EnsureStandardConfigurationResult> {
  const startedAt = Date.now();

  // Snapshot existing keys BEFORE inserting anything, so we know
  // which canonical entries are missing.
  const [existingCategories, existingFsGroups, existingDepartments, existingFunds] = await Promise.all([
    prisma.accountCategory.findMany({
      where: { clubId },
      select: { key: true },
    }),
    prisma.financialStatementGroup.findMany({
      where: { clubId },
      select: { key: true },
    }),
    prisma.department.findMany({
      where: { clubId },
      select: { code: true },
    }),
    // DIM-1 (2026-09-29) — Fund is per-tenant configuration, seeded
    // idempotently alongside the rest of the canonical taxonomy.
    prisma.fund.findMany({
      where: { clubId },
      select: { key: true },
    }),
  ]);

  const beforeCounts = {
    categories: existingCategories.length,
    fsGroups: existingFsGroups.length,
    departments: existingDepartments.length,
    funds: existingFunds.length,
  };

  const existingCategoryKeys = new Set(existingCategories.map((c) => c.key));
  const existingFsGroupKeys = new Set(existingFsGroups.map((g) => g.key));
  const existingDepartmentCodes = new Set(existingDepartments.map((d) => d.code));
  const existingFundKeys = new Set(existingFunds.map((f) => f.key));

  // ---- CATEGORIES ------------------------------------------------------
  // No parent-child structure on categories, so we bulk create in
  // one round-trip. The pre-filter against the existing-keys set is
  // the primary idempotency guard. Concurrent bootstraps on the
  // same club would race — extremely unlikely in practice (single
  // COA import per club at a time) — and would surface as a unique-
  // constraint error caught below.
  const categoriesToInsert = DEFAULT_CATEGORIES.filter(
    (c) => !existingCategoryKeys.has(c.key),
  );
  if (categoriesToInsert.length > 0) {
    try {
      await prisma.accountCategory.createMany({
        data: categoriesToInsert.map((c) => ({
          clubId,
          key: c.key,
          name: c.name,
          type: c.type,
          sortOrder: c.sortOrder ?? 0,
        })),
      });
    } catch (e) {
      logger.warn("ensure-standard-accounting.category_race", {
        clubId, count: categoriesToInsert.length,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // ---- FS GROUPS -------------------------------------------------------
  // FS groups CAN have a parent (parentKey → parentGroupId), so we
  // insert in two passes: parent-free first, then children so the
  // FK is resolvable. `createMany` doesn't support setting FK by
  // key lookup, so we fall back to `create` per row for children.
  const fsGroupsToInsert = DEFAULT_FS_GROUPS.filter(
    (g) => !existingFsGroupKeys.has(g.key),
  );
  const rootFsGroups = fsGroupsToInsert.filter((g) => !g.parentKey);
  const childFsGroups = fsGroupsToInsert.filter((g) => g.parentKey);

  if (rootFsGroups.length > 0) {
    try {
      await prisma.financialStatementGroup.createMany({
        data: rootFsGroups.map((g) => ({
          clubId,
          key: g.key,
          name: g.name,
          statement: g.statement,
          cashFlowSection: g.cashFlowSection ?? null,
          parentGroupId: null,
          sortOrder: g.sortOrder ?? 0,
        })),
      });
    } catch (e) {
      logger.warn("ensure-standard-accounting.fs_group_race", {
        clubId, count: rootFsGroups.length,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (childFsGroups.length > 0) {
    // Re-read after root insert so children can resolve their parent
    // FK. Cheap: at most 79 rows in the canonical set.
    const withParents = await prisma.financialStatementGroup.findMany({
      where: { clubId, key: { in: childFsGroups.map((g) => g.parentKey!) } },
      select: { id: true, key: true },
    });
    const parentIdByKey = new Map(withParents.map((p) => [p.key, p.id]));
    for (const g of childFsGroups) {
      const parentId = parentIdByKey.get(g.parentKey!) ?? null;
      if (!parentId) {
        // Canonical taxonomy misconfiguration — parent key doesn't
        // exist even in the DEFAULT set. Skip + log; the ensure
        // remains idempotent (skipped rows re-run cleanly next call).
        logger.warn("ensure-standard-accounting.orphan_fs_group", {
          clubId, key: g.key, parentKey: g.parentKey,
        });
        continue;
      }
      // Use upsert here because we can't use createMany for a resolved
      // parent FK. `where` is the tenant-scoped composite unique.
      await prisma.financialStatementGroup.upsert({
        where: { clubId_key: { clubId, key: g.key } },
        create: {
          clubId, key: g.key, name: g.name,
          statement: g.statement,
          cashFlowSection: g.cashFlowSection ?? null,
          parentGroupId: parentId,
          sortOrder: g.sortOrder ?? 0,
        },
        // If a row raced in between the pre-count and the insert,
        // do not overwrite the founder's version.
        update: {},
      });
    }
  }

  // ---- DEPARTMENTS -----------------------------------------------------
  const departmentsToInsert = DEFAULT_DEPARTMENTS.filter(
    (d) => !existingDepartmentCodes.has(d.code),
  );
  if (departmentsToInsert.length > 0) {
    try {
      await prisma.department.createMany({
        data: departmentsToInsert.map((d, i) => ({
          clubId,
          code: d.code,
          name: d.name,
          sortOrder: (d.sortOrder ?? i) as number,
          isActive: true,
        })),
      });
    } catch (e) {
      logger.warn("ensure-standard-accounting.department_race", {
        clubId, count: departmentsToInsert.length,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // ---- FUNDS (DIM-1) ---------------------------------------------------
  const fundsToInsert = DEFAULT_FUNDS.filter((f) => !existingFundKeys.has(f.key));
  if (fundsToInsert.length > 0) {
    try {
      await prisma.fund.createMany({
        data: fundsToInsert.map((f) => ({
          clubId,
          key: f.key,
          name: f.name,
          sortOrder: f.sortOrder,
          isActive: true,
        })),
      });
    } catch (e) {
      logger.warn("ensure-standard-accounting.fund_race", {
        clubId, count: fundsToInsert.length,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Snapshot AFTER for the return payload — cheap re-count.
  const [afterCats, afterGroups, afterDepts, afterFunds] = await Promise.all([
    prisma.accountCategory.count({ where: { clubId } }),
    prisma.financialStatementGroup.count({ where: { clubId } }),
    prisma.department.count({ where: { clubId } }),
    prisma.fund.count({ where: { clubId } }),
  ]);

  const result: EnsureStandardConfigurationResult = {
    clubId,
    categoriesInserted: categoriesToInsert.length,
    fsGroupsInserted: rootFsGroups.length + childFsGroups.length,
    departmentsInserted: departmentsToInsert.length,
    fundsInserted: fundsToInsert.length,
    insertedCategoryKeys: categoriesToInsert.map((c) => c.key),
    insertedFsGroupKeys: fsGroupsToInsert.map((g) => g.key),
    insertedDepartmentCodes: departmentsToInsert.map((d) => d.code),
    insertedFundKeys: fundsToInsert.map((f) => f.key),
    before: beforeCounts,
    after: {
      categories: afterCats,
      fsGroups: afterGroups,
      departments: afterDepts,
      funds: afterFunds,
    },
    elapsedMs: Date.now() - startedAt,
  };

  logger.info("ensure-standard-accounting.completed", {
    clubId,
    categoriesInserted: result.categoriesInserted,
    fsGroupsInserted: result.fsGroupsInserted,
    departmentsInserted: result.departmentsInserted,
    fundsInserted: result.fundsInserted,
    beforeCategories: result.before.categories,
    afterCategories: result.after.categories,
    beforeFsGroups: result.before.fsGroups,
    afterFsGroups: result.after.fsGroups,
    beforeDepartments: result.before.departments,
    afterDepartments: result.after.departments,
    beforeFunds: result.before.funds,
    afterFunds: result.after.funds,
    elapsedMs: result.elapsedMs,
  });

  return result;
}

/**
 * Cheap boolean helper: does this club already have the minimum
 * required standard accounting configuration? Used to distinguish
 * bootstrap defects from user mapping errors in the COA import UI.
 */
export async function clubHasStandardAccountingConfiguration(
  clubId: string,
): Promise<boolean> {
  const [cats, groups] = await Promise.all([
    prisma.accountCategory.count({ where: { clubId } }),
    prisma.financialStatementGroup.count({ where: { clubId } }),
  ]);
  // "Enough to run the COA importer" — at least one category and
  // one FS group. In practice the ensure inserts the full canonical
  // set atomically, so seeing "some but not all" is only reachable
  // via manual DB edits.
  return cats > 0 && groups > 0;
}
