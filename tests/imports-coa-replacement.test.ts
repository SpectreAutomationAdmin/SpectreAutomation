// COA Replacement on Commit (founder spec 2026-07-07).
//
// A club has exactly one active Chart of Accounts. Committing a
// COA import REPLACES the prior COA atomically:
//
//   • requires an explicit confirmReplaceCoa flag when an
//     existing active COA is present,
//   • runs every write inside a single DB transaction,
//   • soft-deactivates stale accounts (isActive=false +
//     archivedAt=now) — NEVER hard delete, so JournalEntryLine
//     references stay valid,
//   • reactivates accounts that match the import by number,
//   • emits an `import.coa.replace` audit row with the counts.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";

import { db, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";

import {
  createBatch,
  validateBatch,
  commitBatch,
  planCoaReplacement,
  saveCoaRowMappings,
} from "@/lib/imports";
import {
  RequiresCoaReplacementConfirmationError,
  isAppError,
} from "@/lib/errors";

async function adminFor(clubId: string) {
  const email = `admin-${Math.random().toString(36).slice(2, 10)}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}

/**
 * Find an existing seeded account of the given type and return
 * the (categoryKey, fsGroupKey) pair the COA importer can re-use
 * for a synthetic row of the same type. The bootstrap helper
 * seeds the full default COA so every type is available.
 */
async function exemplarMapping(
  clubId: string,
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE",
) {
  const acct = await db().account.findFirst({
    where: {
      clubId,
      type,
      isActive: true,
      categoryId: { not: null },
      fsGroupId: { not: null },
    },
  });
  if (!acct) throw new Error(`Test fixture: no seeded ${type} account on club ${clubId}`);
  const cat = await db().accountCategory.findUnique({ where: { id: acct.categoryId! } });
  const fsg = await db().financialStatementGroup.findUnique({ where: { id: acct.fsGroupId! } });
  if (!cat || !fsg) throw new Error(`Test fixture: dangling category/fsGroup on ${type} account`);
  return { categoryKey: cat.key, fsGroupKey: fsg.key };
}

async function uploadValidateAndMap(
  p: Awaited<ReturnType<typeof adminFor>>,
  clubId: string,
  rows: Array<{
    number: string;
    name: string;
    type: string;
    categoryKey: string;
    fsGroupKey: string;
    departmentCodes?: string[];
  }>,
) {
  // Match the existing test pattern: upload number + name only,
  // then thread mapping through saveCoaRowMappings (which writes
  // directly into ImportRow.rawJson) before validating. This
  // mirrors the in-page operator flow.
  const batch = await createBatch(p, {
    clubId,
    domain: "COA",
    rows: rows.map((r) => ({ number: r.number, name: r.name })),
    source: "CSV",
    fileName: "coa-replacement-test.csv",
  });
  const importRows = await db().importRow.findMany({
    where: { batchId: batch.id },
    orderBy: { rowNumber: "asc" },
  });
  await saveCoaRowMappings(p, {
    batchId: batch.id,
    mappings: importRows.map((ir, i) => ({
      rowId: ir.id,
      type: rows[i].type,
      categoryKey: rows[i].categoryKey,
      fsGroupKey: rows[i].fsGroupKey,
      departmentCodes: rows[i].departmentCodes ?? [],
    })),
  });
  await validateBatch(p, batch.id);
  return batch;
}

beforeAll(async () => {
  await seedRbac();
});

beforeEach(async () => {
  await resetDb();
  await seedRbac();
});

describe("planCoaReplacement", () => {
  it("returns requiresConfirmation=false when the club has no active accounts", async () => {
    const { id: clubId } = await bootstrapAPClub();
    const p = await adminFor(clubId);
    const seed = await exemplarMapping(clubId, "ASSET");
    await db().account.updateMany({
      where: { clubId },
      data: { isActive: false, archivedAt: new Date() },
    });
    const batch = await uploadValidateAndMap(p, clubId, [
      { number: "1010", name: "Cash", type: "ASSET", ...seed },
    ]);
    const plan = await planCoaReplacement(p, batch.id);
    expect(plan.existingActiveCount).toBe(0);
    expect(plan.requiresConfirmation).toBe(false);
    expect(plan.importedRowCount).toBe(1);
    expect(plan.deactivateCount).toBe(0);
  });

  it("counts matching vs. to-deactivate when the club already has an active COA", async () => {
    const { id: clubId } = await bootstrapAPClub();
    const p = await adminFor(clubId);
    const existing = await db().account.findMany({
      where: { clubId, isActive: true },
      select: { accountNumber: true, name: true, type: true, categoryId: true, fsGroupId: true },
      take: 3,
    });
    const cats = await db().accountCategory.findMany({ where: { clubId } });
    const fsgs = await db().financialStatementGroup.findMany({ where: { clubId } });
    const assetSeed = await exemplarMapping(clubId, "ASSET");

    const batch = await uploadValidateAndMap(p, clubId, [
      {
        number: existing[0].accountNumber,
        name: existing[0].name + " (renamed)",
        type: existing[0].type,
        categoryKey: cats.find((c) => c.id === existing[0].categoryId)!.key,
        fsGroupKey: fsgs.find((f) => f.id === existing[0].fsGroupId)!.key,
      },
      {
        number: existing[1].accountNumber,
        name: existing[1].name,
        type: existing[1].type,
        categoryKey: cats.find((c) => c.id === existing[1].categoryId)!.key,
        fsGroupKey: fsgs.find((f) => f.id === existing[1].fsGroupId)!.key,
      },
      { number: "9999", name: "Brand New", type: "ASSET", ...assetSeed },
    ]);
    const plan = await planCoaReplacement(p, batch.id);
    const totalActive = await db().account.count({ where: { clubId, isActive: true } });
    expect(plan.existingActiveCount).toBe(totalActive);
    expect(plan.importedRowCount).toBe(3);
    expect(plan.matchingImportCount).toBe(2);
    expect(plan.deactivateCount).toBe(totalActive - 2);
    expect(plan.requiresConfirmation).toBe(true);
  });
});

describe("commitBatch — COA replacement requires explicit confirmation", () => {
  it("throws RequiresCoaReplacementConfirmationError when an existing COA is present and the flag isn't set", async () => {
    const { id: clubId } = await bootstrapAPClub();
    const p = await adminFor(clubId);
    const seed = await exemplarMapping(clubId, "ASSET");
    const batch = await uploadValidateAndMap(p, clubId, [
      { number: "1010", name: "Cash", type: "ASSET", ...seed },
    ]);

    await expect(commitBatch(p, { batchId: batch.id })).rejects.toBeInstanceOf(
      RequiresCoaReplacementConfirmationError,
    );

    // The existing COA is exactly as it was before.
    const stillActive = await db().account.count({ where: { clubId, isActive: true } });
    expect(stillActive).toBeGreaterThan(0);

    // The error carries the impact payload the modal renders.
    try {
      await commitBatch(p, { batchId: batch.id });
    } catch (err) {
      expect(isAppError(err)).toBe(true);
      expect(err).toBeInstanceOf(RequiresCoaReplacementConfirmationError);
      const e = err as RequiresCoaReplacementConfirmationError;
      expect(e.code).toBe("COA_REPLACEMENT_REQUIRES_CONFIRMATION");
      expect(e.httpStatus).toBe(409);
      expect(e.details.importedRowCount).toBe(1);
      expect(e.details.existingActiveCount).toBeGreaterThan(0);
    }

    // Batch stays VALIDATED, not COMMITTED.
    const reloaded = await db().importBatch.findUnique({ where: { id: batch.id } });
    expect(reloaded?.status).toBe("VALIDATED");
  });

  it("skips the confirmation gate when there are NO existing active accounts", async () => {
    const { id: clubId } = await bootstrapAPClub();
    const p = await adminFor(clubId);
    const seed = await exemplarMapping(clubId, "EXPENSE");
    await db().account.updateMany({
      where: { clubId },
      data: { isActive: false, archivedAt: new Date() },
    });
    const batch = await uploadValidateAndMap(p, clubId, [
      { number: "5000", name: "Operating Expenses", type: "EXPENSE", ...seed },
    ]);
    const updated = await commitBatch(p, { batchId: batch.id });
    expect(updated.status).toBe("COMMITTED");
    expect(updated.committedRows).toBe(1);
  });
});

describe("Replacement — accounts not in the import are soft-deactivated", () => {
  it("matched accounts stay active; unmatched go isActive=false; new rows are created", async () => {
    const { id: clubId } = await bootstrapAPClub();
    const p = await adminFor(clubId);
    const existing = await db().account.findMany({
      where: { clubId, isActive: true },
      select: { id: true, accountNumber: true, name: true, type: true, categoryId: true, fsGroupId: true },
    });
    expect(existing.length).toBeGreaterThan(2);
    const keep = existing[0];
    const cats = await db().accountCategory.findMany({ where: { clubId } });
    const fsgs = await db().financialStatementGroup.findMany({ where: { clubId } });
    const assetSeed = await exemplarMapping(clubId, "ASSET");

    const batch = await uploadValidateAndMap(p, clubId, [
      {
        number: keep.accountNumber,
        name: keep.name + " (kept)",
        type: keep.type,
        categoryKey: cats.find((c) => c.id === keep.categoryId)!.key,
        fsGroupKey: fsgs.find((f) => f.id === keep.fsGroupId)!.key,
      },
      { number: "9100", name: "Brand New Cash", type: "ASSET", ...assetSeed },
    ]);

    const result = await commitBatch(p, { batchId: batch.id, confirmReplaceCoa: true });
    expect(result.status).toBe("COMMITTED");

    const reloadedKeep = await db().account.findUnique({
      where: { clubId_accountNumber: { clubId, accountNumber: keep.accountNumber } },
    });
    expect(reloadedKeep?.isActive).toBe(true);
    expect(reloadedKeep?.name).toContain("(kept)");

    const newAcct = await db().account.findUnique({
      where: { clubId_accountNumber: { clubId, accountNumber: "9100" } },
    });
    expect(newAcct?.isActive).toBe(true);

    const stale = await db().account.findMany({
      where: {
        clubId,
        accountNumber: { in: existing.slice(1).map((e) => e.accountNumber) },
      },
    });
    expect(stale.length).toBe(existing.length - 1);
    for (const a of stale) {
      expect(a.isActive).toBe(false);
      expect(a.archivedAt).not.toBeNull();
    }
  });

  it("REACTIVATES a previously-archived account when the import re-introduces its number", async () => {
    const { id: clubId } = await bootstrapAPClub();
    const p = await adminFor(clubId);
    const cats = await db().accountCategory.findMany({ where: { clubId } });
    const fsgs = await db().financialStatementGroup.findMany({ where: { clubId } });
    const target = await db().account.findFirst({ where: { clubId, isActive: true } });
    if (!target) throw new Error("Test fixture: no seed account");
    await db().account.update({
      where: { id: target.id },
      data: { isActive: false, archivedAt: new Date() },
    });

    const batch = await uploadValidateAndMap(p, clubId, [
      {
        number: target.accountNumber,
        name: "Reactivated Cash",
        type: target.type,
        categoryKey: cats.find((c) => c.id === target.categoryId)!.key,
        fsGroupKey: fsgs.find((f) => f.id === target.fsGroupId)!.key,
      },
    ]);
    await commitBatch(p, { batchId: batch.id, confirmReplaceCoa: true });
    const reloaded = await db().account.findUnique({ where: { id: target.id } });
    expect(reloaded?.isActive).toBe(true);
    expect(reloaded?.archivedAt).toBeNull();
    expect(reloaded?.name).toBe("Reactivated Cash");
  });
});

describe("Replacement is atomic (one bad row = no replacement)", () => {
  it("if any row's commit write throws, the whole replacement rolls back", async () => {
    const { id: clubId } = await bootstrapAPClub();
    const p = await adminFor(clubId);
    const baseline = await db().account.count({ where: { clubId, isActive: true } });
    expect(baseline).toBeGreaterThan(0);
    const assetSeed = await exemplarMapping(clubId, "ASSET");

    const batch = await uploadValidateAndMap(p, clubId, [
      { number: "8001", name: "Row One", type: "ASSET", ...assetSeed },
      { number: "8002", name: "Row Two", type: "ASSET", ...assetSeed },
    ]);
    // Corrupt the second row's normalizedJson so the commit throws
    // on it. Whole transaction must abort and leave nothing inserted.
    const rows = await db().importRow.findMany({
      where: { batchId: batch.id, status: "VALID" },
      orderBy: { rowNumber: "asc" },
    });
    const second = rows[1];
    const parsed = JSON.parse(second.normalizedJson ?? "{}");
    delete parsed.number;
    await db().importRow.update({
      where: { id: second.id },
      data: { normalizedJson: JSON.stringify(parsed) },
    });

    await expect(
      commitBatch(p, { batchId: batch.id, confirmReplaceCoa: true }),
    ).rejects.toThrow();

    const after = await db().account.count({ where: { clubId, isActive: true } });
    expect(after).toBe(baseline);
    const wouldBeInserted = await db().account.findUnique({
      where: { clubId_accountNumber: { clubId, accountNumber: "8001" } },
    });
    expect(wouldBeInserted).toBeNull();
    const reloaded = await db().importBatch.findUnique({ where: { id: batch.id } });
    expect(reloaded?.status).toBe("VALIDATED");
  });
});

describe("Tenant isolation", () => {
  it("commit only touches accounts in the batch's club; another club's COA is untouched", async () => {
    const a = await bootstrapAPClub("Tenant-Iso-A"); const aClubId = a.id;
    const b = await bootstrapAPClub("Tenant-Iso-B"); const bClubId = b.id;
    const pA = await adminFor(aClubId);
    const otherBaseline = await db().account.count({ where: { clubId: bClubId, isActive: true } });
    const assetSeed = await exemplarMapping(aClubId, "ASSET");
    const batch = await uploadValidateAndMap(pA, aClubId, [
      { number: "7700", name: "Cash", type: "ASSET", ...assetSeed },
    ]);
    await commitBatch(pA, { batchId: batch.id, confirmReplaceCoa: true });
    const otherAfter = await db().account.count({ where: { clubId: bClubId, isActive: true } });
    expect(otherAfter).toBe(otherBaseline);
  });
});

describe("Historical references preserved", () => {
  it("does not delete Account rows referenced by JournalEntryLine — soft-deactivation only", async () => {
    const { id: clubId } = await bootstrapAPClub();
    const p = await adminFor(clubId);
    const target = await db().account.findFirst({ where: { clubId, isActive: true } });
    if (!target) throw new Error("No seed account");
    const period = await db().fiscalPeriod.findFirst({ where: { clubId } });
    if (!period) throw new Error("No seeded fiscal period");
    const je = await db().journalEntry.create({
      data: {
        clubId,
        entryNumber: `JE-TEST-${Date.now()}`,
        entryDate: new Date(),
        periodId: period.id,
        description: "Test JE for COA-replacement preservation",
        memo: "test entry",
        source: "MANUAL",
        status: "POSTED",
        postedAt: new Date(),
      },
    });
    await db().journalEntryLine.create({
      data: {
        clubId,
        journalEntryId: je.id,
        lineNumber: 1,
        accountId: target.id,
        debit: 100,
        credit: 0,
        description: "test debit",
      },
    });
    const beforeLineCount = await db().journalEntryLine.count({ where: { accountId: target.id } });

    const expenseSeed = await exemplarMapping(clubId, "EXPENSE");
    const batch = await uploadValidateAndMap(p, clubId, [
      { number: "6666", name: "Just Some Expense", type: "EXPENSE", ...expenseSeed },
    ]);
    await commitBatch(p, { batchId: batch.id, confirmReplaceCoa: true });

    const reloaded = await db().account.findUnique({ where: { id: target.id } });
    expect(reloaded).not.toBeNull();
    expect(reloaded?.isActive).toBe(false);
    const afterLineCount = await db().journalEntryLine.count({ where: { accountId: target.id } });
    expect(afterLineCount).toBe(beforeLineCount);
  });
});

describe("Audit trail", () => {
  it("emits import.coa.replace with the replacement counts when a confirmed replace runs", async () => {
    const { id: clubId } = await bootstrapAPClub();
    const p = await adminFor(clubId);
    const baselineActive = await db().account.count({ where: { clubId, isActive: true } });
    const assetSeed = await exemplarMapping(clubId, "ASSET");
    const batch = await uploadValidateAndMap(p, clubId, [
      { number: "7000", name: "New Asset", type: "ASSET", ...assetSeed },
    ]);
    await commitBatch(p, { batchId: batch.id, confirmReplaceCoa: true });
    const auditEntries = await db().auditLog.findMany({
      where: { clubId, entityType: "ImportBatch", entityId: batch.id },
      orderBy: { createdAt: "asc" },
    });
    const replace = auditEntries.find((a) => a.action === "import.coa.replace");
    expect(replace).toBeTruthy();
    expect(replace?.userId).toBe(p.id);
    const after = replace?.afterJson ? JSON.parse(String(replace.afterJson)) : {};
    expect(after.importedRowCount).toBe(1);
    expect(after.existingActiveCount).toBe(baselineActive);
    expect(after.deactivateCount).toBe(baselineActive);
    expect(after.matchingImportCount).toBe(0);
    expect(after.committed).toBe(1);
  });

  it("does NOT emit import.coa.replace for an empty-COA first import (no destructive intent)", async () => {
    const { id: clubId } = await bootstrapAPClub();
    const p = await adminFor(clubId);
    const assetSeed = await exemplarMapping(clubId, "ASSET");
    await db().account.updateMany({
      where: { clubId },
      data: { isActive: false, archivedAt: new Date() },
    });
    const batch = await uploadValidateAndMap(p, clubId, [
      { number: "1500", name: "Inventory", type: "ASSET", ...assetSeed },
    ]);
    await commitBatch(p, { batchId: batch.id });
    const audits = await db().auditLog.findMany({
      where: { clubId, entityType: "ImportBatch", entityId: batch.id },
    });
    expect(audits.some((a) => a.action === "import.batch.commit")).toBe(true);
    expect(audits.some((a) => a.action === "import.coa.replace")).toBe(false);
  });
});

describe("After a confirmed replace, the batch is COMMITTED", () => {
  it("saveCoaRowMappings is rejected because the batch is no longer DRAFT/VALIDATED", async () => {
    const { id: clubId } = await bootstrapAPClub();
    const p = await adminFor(clubId);
    const assetSeed = await exemplarMapping(clubId, "ASSET");
    const batch = await uploadValidateAndMap(p, clubId, [
      { number: "1010", name: "Cash", type: "ASSET", ...assetSeed },
    ]);
    await commitBatch(p, { batchId: batch.id, confirmReplaceCoa: true });
    const rows = await db().importRow.findMany({ where: { batchId: batch.id } });
    await expect(
      saveCoaRowMappings(p, {
        batchId: batch.id,
        mappings: rows.map((r) => ({
          rowId: r.id,
          type: "ASSET",
          categoryKey: assetSeed.categoryKey,
          fsGroupKey: assetSeed.fsGroupKey,
          departmentCodes: [],
        })),
      }),
    ).rejects.toThrow();
  });
});
