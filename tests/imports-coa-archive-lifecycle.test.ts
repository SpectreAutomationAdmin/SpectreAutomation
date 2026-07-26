// Founder rule 2026-07-12: a COA commit replaces the active
// Chart of Accounts, so any prior COMMITTED COA batch is flipped
// to ARCHIVED in the same transaction. Deleting an ARCHIVED COA
// batch does NOT touch the active accounts — it removes only the
// import staging rows. Only COMMITTED batches are protected from
// deletion.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { db, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";

import {
  createBatch,
  validateBatch,
  commitBatch,
  saveCoaRowMappings,
  deleteBatch,
} from "@/lib/imports";

async function adminFor(clubId: string) {
  const email = `admin-${Math.random().toString(36).slice(2, 10)}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}

async function exemplarMapping(
  clubId: string,
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE",
) {
  const acct = await db().account.findFirst({
    where: { clubId, type, isActive: true, categoryId: { not: null }, fsGroupId: { not: null } },
  });
  if (!acct) throw new Error(`No seeded ${type} account for ${clubId}`);
  const cat = await db().accountCategory.findUnique({ where: { id: acct.categoryId! } });
  const fsg = await db().financialStatementGroup.findUnique({ where: { id: acct.fsGroupId! } });
  if (!cat || !fsg) throw new Error("dangling cat/fsg");
  return { categoryKey: cat.key, fsGroupKey: fsg.key };
}

async function uploadValidateAndMap(
  p: Awaited<ReturnType<typeof adminFor>>,
  clubId: string,
  rows: Array<{ number: string; name: string; type: string; categoryKey: string; fsGroupKey: string }>,
) {
  const batch = await createBatch(p, {
    clubId,
    domain: "COA",
    rows: rows.map((r) => ({ number: r.number, name: r.name })),
    source: "CSV",
    fileName: "archive-lifecycle-test.csv",
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
      departmentCodes: [],
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

describe("Archival on new COA commit", () => {
  it("flips prior COMMITTED COA batch(es) to ARCHIVED when a new COA commit lands", async () => {
    const c = await bootstrapAPClub("ARC-Promote");
    const p = await adminFor(c.id);
    const assetSeed = await exemplarMapping(c.id, "ASSET");
    const expSeed = await exemplarMapping(c.id, "EXPENSE");

    const first = await uploadValidateAndMap(p, c.id, [
      { number: "7001", name: "First Asset", type: "ASSET", ...assetSeed },
    ]);
    await commitBatch(p, { batchId: first.id, confirmReplaceCoa: true });
    const firstReloaded = await db().importBatch.findUnique({ where: { id: first.id } });
    expect(firstReloaded?.status).toBe("COMMITTED");

    const second = await uploadValidateAndMap(p, c.id, [
      { number: "7002", name: "Second Asset", type: "ASSET", ...assetSeed },
      { number: "7003", name: "Second Expense", type: "EXPENSE", ...expSeed },
    ]);
    await commitBatch(p, { batchId: second.id, confirmReplaceCoa: true });

    // The first batch is now ARCHIVED; the second is the active COMMITTED.
    const firstAfter = await db().importBatch.findUnique({ where: { id: first.id } });
    const secondAfter = await db().importBatch.findUnique({ where: { id: second.id } });
    expect(firstAfter?.status).toBe("ARCHIVED");
    expect(secondAfter?.status).toBe("COMMITTED");
  });

  it("archives ALL prior COMMITTED COA batches when a 3rd import lands", async () => {
    const c = await bootstrapAPClub("ARC-Multi");
    const p = await adminFor(c.id);
    const seed = await exemplarMapping(c.id, "ASSET");
    const a = await uploadValidateAndMap(p, c.id, [
      { number: "8001", name: "A", type: "ASSET", ...seed },
    ]);
    await commitBatch(p, { batchId: a.id, confirmReplaceCoa: true });
    const b = await uploadValidateAndMap(p, c.id, [
      { number: "8002", name: "B", type: "ASSET", ...seed },
    ]);
    await commitBatch(p, { batchId: b.id, confirmReplaceCoa: true });
    const cBatch = await uploadValidateAndMap(p, c.id, [
      { number: "8003", name: "C", type: "ASSET", ...seed },
    ]);
    await commitBatch(p, { batchId: cBatch.id, confirmReplaceCoa: true });

    const archived = await db().importBatch.findMany({
      where: { clubId: c.id, domain: "COA", status: "ARCHIVED" },
    });
    expect(archived.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    const committed = await db().importBatch.findMany({
      where: { clubId: c.id, domain: "COA", status: "COMMITTED" },
    });
    expect(committed.map((x) => x.id)).toEqual([cBatch.id]);
  });

  it("does NOT archive COMMITTED batches of OTHER domains", async () => {
    const c = await bootstrapAPClub("ARC-Other-Domain");
    const p = await adminFor(c.id);
    // Forge a "committed" Members batch directly (the Members
    // commit path is tested elsewhere; here we only need a
    // COMMITTED non-COA batch sitting alongside.)
    const memberBatch = await db().importBatch.create({
      data: {
        clubId: c.id,
        domain: "MEMBERS",
        source: "CSV",
        status: "COMMITTED",
        totalRows: 0,
      },
    });
    const seed = await exemplarMapping(c.id, "ASSET");
    const coa = await uploadValidateAndMap(p, c.id, [
      { number: "8101", name: "X", type: "ASSET", ...seed },
    ]);
    await commitBatch(p, { batchId: coa.id, confirmReplaceCoa: true });

    const memberAfter = await db().importBatch.findUnique({ where: { id: memberBatch.id } });
    expect(memberAfter?.status).toBe("COMMITTED"); // untouched
  });

  it("emits import.coa.replace audit with archivedPriorBatches count", async () => {
    const c = await bootstrapAPClub("ARC-Audit");
    const p = await adminFor(c.id);
    const seed = await exemplarMapping(c.id, "ASSET");
    const first = await uploadValidateAndMap(p, c.id, [
      { number: "8201", name: "first", type: "ASSET", ...seed },
    ]);
    await commitBatch(p, { batchId: first.id, confirmReplaceCoa: true });
    const second = await uploadValidateAndMap(p, c.id, [
      { number: "8202", name: "second", type: "ASSET", ...seed },
    ]);
    await commitBatch(p, { batchId: second.id, confirmReplaceCoa: true });
    const audits = await db().auditLog.findMany({
      where: {
        clubId: c.id,
        entityType: "ImportBatch",
        entityId: second.id,
        action: "import.coa.replace",
      },
    });
    expect(audits.length).toBe(1);
    const after = JSON.parse(String(audits[0].afterJson ?? "{}"));
    expect(after.archivedPriorBatches).toBe(1);
  });
});

describe("Deleting an ARCHIVED COA batch is safe", () => {
  it("removes the import batch + its rows; leaves active accounts intact", async () => {
    const c = await bootstrapAPClub("ARC-Safe-Delete");
    const p = await adminFor(c.id);
    const seed = await exemplarMapping(c.id, "ASSET");
    const first = await uploadValidateAndMap(p, c.id, [
      { number: "9001", name: "Cash A", type: "ASSET", ...seed },
    ]);
    await commitBatch(p, { batchId: first.id, confirmReplaceCoa: true });
    const second = await uploadValidateAndMap(p, c.id, [
      { number: "9002", name: "Cash B", type: "ASSET", ...seed },
    ]);
    await commitBatch(p, { batchId: second.id, confirmReplaceCoa: true });
    // The first batch is now ARCHIVED.
    const firstReloaded = await db().importBatch.findUnique({ where: { id: first.id } });
    expect(firstReloaded?.status).toBe("ARCHIVED");

    const activeBefore = await db().account.findMany({
      where: { clubId: c.id, isActive: true },
      select: { accountNumber: true },
    });
    const result = await deleteBatch(p, first.id);
    expect(result.deleted).toBe(true);

    // Active accounts are unchanged.
    const activeAfter = await db().account.findMany({
      where: { clubId: c.id, isActive: true },
      select: { accountNumber: true },
    });
    expect(activeAfter.map((a) => a.accountNumber).sort()).toEqual(
      activeBefore.map((a) => a.accountNumber).sort(),
    );

    // The second (active COMMITTED) batch still exists.
    const secondAfter = await db().importBatch.findUnique({ where: { id: second.id } });
    expect(secondAfter).not.toBeNull();
    expect(secondAfter?.status).toBe("COMMITTED");
  });
});

describe("UI source contract", () => {
  const PAGE = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/imports/page.tsx"),
    "utf8",
  );
  const BUTTON = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "src/app/app/admin/imports/DeleteDraftBatchButton.tsx",
    ),
    "utf8",
  );

  it("Imports list shows Delete for every NON-COMMITTED batch and the audit-locked hint for COMMITTED", () => {
    expect(PAGE).toMatch(/b\.status === "COMMITTED" \?/);
    expect(PAGE).toContain('data-testid={`delete-batch-committed-hint-${b.id}`}');
    expect(PAGE).toContain("Audit-locked");
  });

  it("Imports list surfaces the 'Overridden by newer COA import' helper for ARCHIVED COA rows", () => {
    expect(PAGE).toMatch(/b\.status === "ARCHIVED" && b\.domain === "COA"/);
    expect(PAGE).toContain("Overridden by newer COA import");
    expect(PAGE).toContain('data-testid={`batch-archived-hint-${b.id}`}');
  });

  it("DeleteDraftBatchButton renders a real modal with the founder's exact title + body + buttons", () => {
    expect(BUTTON).toContain("Delete import batch?");
    expect(BUTTON).toContain(
      "This will permanently delete this import batch and its staged",
    );
    expect(BUTTON).toContain("This cannot be undone.");
    expect(BUTTON).toContain("Delete batch");
    expect(BUTTON).toContain("Cancel");
  });

  it("DeleteDraftBatchButton appends the archive-specific line when status is ARCHIVED/SUPERSEDED", () => {
    expect(BUTTON).toMatch(/status === "ARCHIVED" \|\| status === "SUPERSEDED"/);
    // JSX wraps the body across two lines; collapse whitespace
    // so the assertion checks the rendered sentence.
    const collapsed = BUTTON.replace(/\s+/g, " ");
    expect(collapsed).toContain(
      "This batch has already been overridden by a newer Chart of Accounts import.",
    );
    expect(BUTTON).toContain(
      'data-testid={`delete-batch-archived-hint-${batchId}`}',
    );
  });

  it("DeleteDraftBatchButton exposes the canonical modal testids", () => {
    expect(BUTTON).toContain("`delete-batch-modal-${batchId}`");
    expect(BUTTON).toContain("`delete-batch-modal-title-${batchId}`");
    expect(BUTTON).toContain("`delete-batch-modal-cancel-${batchId}`");
    expect(BUTTON).toContain("`delete-batch-modal-confirm-${batchId}`");
  });
});
