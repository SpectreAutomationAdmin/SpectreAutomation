// Founder rule 2026-07-13: validation state must persist across
// every navigation/refresh/Save-Mapping cycle. The list and the
// detail page must NEVER misleadingly read "0 valid · 0 errors"
// just because the operator saved a partial mapping — the
// counts represent the LAST validation run and stay intact.
//
// Two regressions this slice fixes:
//
//   1. saveCoaRowMappings blanket-reset every ImportRow + the
//      batch's validRows / errorRows / dryRunAt, and deleted every
//      persisted ImportError record. A DRAFT batch then read as
//      "237 rows · 0 valid · 0 errors" even though the prior
//      Validate had recorded a real error.
//
//   2. The Data Imports list rendered raw `0 / 0` for a batch
//      that had never been validated, which looked indistinguishable
//      from a validated-clean batch.
//
// Behavioural tests + page-source contract tests.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { db, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import {
  createBatch,
  validateBatch,
  saveCoaRowMappings,
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
  if (!acct) throw new Error(`No seeded ${type} account on ${clubId}`);
  const cat = await db().accountCategory.findUnique({ where: { id: acct.categoryId! } });
  const fsg = await db().financialStatementGroup.findUnique({ where: { id: acct.fsGroupId! } });
  if (!cat || !fsg) throw new Error("dangling cat/fsg");
  return { categoryKey: cat.key, fsGroupKey: fsg.key };
}

beforeAll(async () => {
  await seedRbac();
});
beforeEach(async () => {
  await resetDb();
  await seedRbac();
});

describe("Save Mapping preserves prior validation results", () => {
  it("does NOT zero out batch.validRows / errorRows / status after Save Mapping", async () => {
    const c = await bootstrapAPClub("StatePersist-Counts");
    const p = await adminFor(c.id);
    const seed = await exemplarMapping(c.id, "ASSET");
    const batch = await createBatch(p, {
      clubId: c.id,
      domain: "COA",
      rows: [
        { number: "1", name: "Will validate" },
        { number: "2", name: "Will not validate" },
      ],
      source: "CSV",
      fileName: "test.csv",
    });
    const rows = await db().importRow.findMany({
      where: { batchId: batch.id },
      orderBy: { rowNumber: "asc" },
    });
    // Map both rows correctly first.
    await saveCoaRowMappings(p, {
      batchId: batch.id,
      mappings: rows.map((r) => ({
        rowId: r.id,
        type: "ASSET",
        categoryKey: seed.categoryKey,
        fsGroupKey: seed.fsGroupKey,
        departmentCodes: [],
      })),
    });
    await validateBatch(p, batch.id);
    let after = await db().importBatch.findUnique({ where: { id: batch.id } });
    expect(after?.validRows).toBe(2);
    expect(after?.errorRows).toBe(0);
    expect(after?.dryRunAt).not.toBeNull();

    // Now Save Mapping AGAIN with the exact same mapping. Nothing
    // should clear; status / counts stay because nothing changed.
    await saveCoaRowMappings(p, {
      batchId: batch.id,
      mappings: rows.map((r) => ({
        rowId: r.id,
        type: "ASSET",
        categoryKey: seed.categoryKey,
        fsGroupKey: seed.fsGroupKey,
        departmentCodes: [],
      })),
    });
    after = await db().importBatch.findUnique({ where: { id: batch.id } });
    expect(after?.validRows).toBe(2);
    expect(after?.errorRows).toBe(0);
    expect(after?.dryRunAt).not.toBeNull();
  });

  it("preserves the previously-validated error count after a mapping change to ONE row", async () => {
    const c = await bootstrapAPClub("StatePersist-OneRow");
    const p = await adminFor(c.id);
    const seed = await exemplarMapping(c.id, "ASSET");
    const batch = await createBatch(p, {
      clubId: c.id,
      domain: "COA",
      rows: [
        { number: "10", name: "Clean row" },
        { number: "20", name: "Will be edited" },
      ],
      source: "CSV",
      fileName: "test.csv",
    });
    const rows = await db().importRow.findMany({
      where: { batchId: batch.id },
      orderBy: { rowNumber: "asc" },
    });
    await saveCoaRowMappings(p, {
      batchId: batch.id,
      mappings: rows.map((r) => ({
        rowId: r.id,
        type: "ASSET",
        categoryKey: seed.categoryKey,
        fsGroupKey: seed.fsGroupKey,
        departmentCodes: [],
      })),
    });
    await validateBatch(p, batch.id);
    const validated = await db().importBatch.findUnique({ where: { id: batch.id } });
    expect(validated?.validRows).toBe(2);
    expect(validated?.dryRunAt).not.toBeNull();

    // Edit ONLY row 20 — change departmentCodes (still a valid
    // mapping). The other row's mapping is unchanged. Per the
    // founder spec the batch counts must NOT be zeroed; only
    // dryRunAt is cleared so commit forces a fresh Validate.
    await saveCoaRowMappings(p, {
      batchId: batch.id,
      mappings: rows.map((r) => ({
        rowId: r.id,
        type: "ASSET",
        categoryKey: seed.categoryKey,
        fsGroupKey: seed.fsGroupKey,
        departmentCodes: r.rowNumber === 2 ? ["ADMIN"] : [],
      })),
    });
    const afterEdit = await db().importBatch.findUnique({ where: { id: batch.id } });
    // Counts preserved.
    expect(afterEdit?.validRows).toBe(2);
    expect(afterEdit?.errorRows).toBe(0);
    // Status preserved (was VALIDATED, stays VALIDATED).
    expect(afterEdit?.status).toBe("VALIDATED");
    // dryRunAt cleared because a row changed — commit must re-validate.
    expect(afterEdit?.dryRunAt).toBeNull();
  });
});

describe("Save Mapping preserves persisted ImportError records on unchanged rows", () => {
  it("only deletes ImportError rows whose row mapping actually changed in this save", async () => {
    const c = await bootstrapAPClub("StatePersist-PartialErrors");
    const p = await adminFor(c.id);
    const seed = await exemplarMapping(c.id, "ASSET");
    const batch = await createBatch(p, {
      clubId: c.id,
      domain: "COA",
      rows: [
        { number: "100", name: "Row that will stay broken" },
        { number: "200", name: "Row that will be fixed" },
      ],
      source: "CSV",
      fileName: "test.csv",
    });
    const rows = await db().importRow.findMany({
      where: { batchId: batch.id },
      orderBy: { rowNumber: "asc" },
    });

    // Initial mapping: BOTH rows have invalid (empty) type so
    // both fail validation.
    await saveCoaRowMappings(p, {
      batchId: batch.id,
      mappings: rows.map((r) => ({
        rowId: r.id,
        type: null,
        categoryKey: null,
        fsGroupKey: null,
        departmentCodes: [],
      })),
    });
    await validateBatch(p, batch.id);
    let errs = await db().importError.findMany({ where: { batchId: batch.id } });
    const beforeCount = errs.length;
    expect(beforeCount).toBeGreaterThan(0);

    const rowsByNumber = new Map(rows.map((r) => [r.rowNumber, r]));
    const broken = rowsByNumber.get(1)!;
    const fixable = rowsByNumber.get(2)!;
    const errorsForBroken = errs.filter((e) => e.rowNumber === broken.rowNumber).length;
    expect(errorsForBroken).toBeGreaterThan(0);

    // Save Mapping ONLY changes the second row (fix it). The
    // first row's mapping is unchanged.
    await saveCoaRowMappings(p, {
      batchId: batch.id,
      mappings: [
        // Row 1 — same null mapping (unchanged → no reset).
        {
          rowId: broken.id,
          type: null,
          categoryKey: null,
          fsGroupKey: null,
          departmentCodes: [],
        },
        // Row 2 — fixed mapping.
        {
          rowId: fixable.id,
          type: "ASSET",
          categoryKey: seed.categoryKey,
          fsGroupKey: seed.fsGroupKey,
          departmentCodes: [],
        },
      ],
    });

    errs = await db().importError.findMany({ where: { batchId: batch.id } });
    // ImportErrors tied to the FIXED row are cleared; ImportErrors
    // tied to the broken row survive.
    const survivedForBroken = errs.filter((e) => e.rowNumber === broken.rowNumber).length;
    const survivedForFixable = errs.filter((e) => e.rowNumber === fixable.rowNumber).length;
    expect(survivedForBroken).toBe(errorsForBroken);
    expect(survivedForFixable).toBe(0);

    // Per-row data: broken row is untouched (status still INVALID,
    // errorMessage still present); fixable row was reset to PENDING
    // so the next Validate gives it a fresh result.
    const brokenAfter = await db().importRow.findUnique({ where: { id: broken.id } });
    const fixableAfter = await db().importRow.findUnique({ where: { id: fixable.id } });
    expect(brokenAfter?.status).toBe("INVALID");
    expect(brokenAfter?.errorMessage).not.toBeNull();
    expect(fixableAfter?.status).toBe("PENDING");
    expect(fixableAfter?.errorMessage).toBeNull();
  });

  it("a Save Mapping that changes nothing returns rowsUpdated=0 and touches nothing", async () => {
    const c = await bootstrapAPClub("StatePersist-Noop");
    const p = await adminFor(c.id);
    const seed = await exemplarMapping(c.id, "ASSET");
    const batch = await createBatch(p, {
      clubId: c.id,
      domain: "COA",
      rows: [{ number: "300", name: "Clean" }],
      source: "CSV",
      fileName: "test.csv",
    });
    const [row] = await db().importRow.findMany({ where: { batchId: batch.id } });
    await saveCoaRowMappings(p, {
      batchId: batch.id,
      mappings: [
        {
          rowId: row.id,
          type: "ASSET",
          categoryKey: seed.categoryKey,
          fsGroupKey: seed.fsGroupKey,
          departmentCodes: [],
        },
      ],
    });
    await validateBatch(p, batch.id);
    const validated = await db().importBatch.findUnique({ where: { id: batch.id } });
    const validateDryRunAt = validated?.dryRunAt;
    expect(validateDryRunAt).not.toBeNull();

    // Re-save with the EXACT same mapping. Nothing changes, so
    // dryRunAt must NOT be cleared.
    const result = await saveCoaRowMappings(p, {
      batchId: batch.id,
      mappings: [
        {
          rowId: row.id,
          type: "ASSET",
          categoryKey: seed.categoryKey,
          fsGroupKey: seed.fsGroupKey,
          departmentCodes: [],
        },
      ],
    });
    expect(result.rowsUpdated).toBe(0);
    const reloaded = await db().importBatch.findUnique({ where: { id: batch.id } });
    expect(reloaded?.dryRunAt?.toISOString()).toBe(validateDryRunAt?.toISOString());
  });
});

describe("Imports list page contract — 'Not validated' state", () => {
  const PAGE = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/imports/page.tsx"),
    "utf8",
  );
  const DETAIL = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/imports/[id]/page.tsx"),
    "utf8",
  );

  it("the list derives `validated` from b.dryRunAt and shows em-dash for the unvalidated counts", () => {
    expect(PAGE).toMatch(/const validated = b\.dryRunAt !== null/);
    // Both Valid + Errors cells render the em-dash branch.
    expect(PAGE).toMatch(/validated \? b\.validRows : <span className="text-stone-400">—<\/span>/);
    expect(PAGE).toMatch(/validated \? b\.errorRows : <span className="text-stone-400">—<\/span>/);
  });

  it("the list renders a 'Not validated' hint ONLY when status === 'DRAFT' (founder rule 2026-07-20 — never alongside a VALIDATED badge)", () => {
    expect(PAGE).toContain('data-testid={`batch-not-validated-hint-${b.id}`}');
    expect(PAGE).toContain("Not validated");
    // The earlier "non-COMMITTED non-ARCHIVED" gate produced a
    // VALIDATED + Not-validated contradiction after Save Mapping
    // cleared dryRunAt; the gate is now narrowed to status===DRAFT.
    expect(PAGE).toMatch(/!validated && b\.status === "DRAFT"/);
  });

  it("the detail page header substitutes 'Not validated' for the counts when dryRunAt is null", () => {
    expect(DETAIL).toMatch(/batch\.dryRunAt/);
    expect(DETAIL).toContain('data-testid="batch-detail-not-validated"');
    expect(DETAIL).toContain("Not validated");
  });
});

describe("Save Mapping does NOT regress the founder's complaint", () => {
  it("validate → save-mapping with no actual changes → reload list → counts persist (not 0/0)", async () => {
    const c = await bootstrapAPClub("Regression-Reload");
    const p = await adminFor(c.id);
    const seed = await exemplarMapping(c.id, "ASSET");
    const batch = await createBatch(p, {
      clubId: c.id,
      domain: "COA",
      rows: [
        { number: "1", name: "row a" },
        { number: "2", name: "row b" },
      ],
      source: "CSV",
      fileName: "test.csv",
    });
    const rows = await db().importRow.findMany({
      where: { batchId: batch.id },
      orderBy: { rowNumber: "asc" },
    });
    await saveCoaRowMappings(p, {
      batchId: batch.id,
      mappings: rows.map((r) => ({
        rowId: r.id,
        type: "ASSET",
        categoryKey: seed.categoryKey,
        fsGroupKey: seed.fsGroupKey,
        departmentCodes: [],
      })),
    });
    await validateBatch(p, batch.id);
    const validated = await db().importBatch.findUnique({ where: { id: batch.id } });
    expect(validated?.validRows).toBe(2);
    expect(validated?.errorRows).toBe(0);

    // Operator opens the batch detail again and clicks Save
    // Mapping without changing anything (common UX — they
    // reviewed and saved). Counts must persist; dryRunAt must
    // persist; status must persist.
    await saveCoaRowMappings(p, {
      batchId: batch.id,
      mappings: rows.map((r) => ({
        rowId: r.id,
        type: "ASSET",
        categoryKey: seed.categoryKey,
        fsGroupKey: seed.fsGroupKey,
        departmentCodes: [],
      })),
    });
    const afterReSave = await db().importBatch.findUnique({ where: { id: batch.id } });
    expect(afterReSave?.validRows).toBe(2);
    expect(afterReSave?.errorRows).toBe(0);
    expect(afterReSave?.status).toBe("VALIDATED");
    expect(afterReSave?.dryRunAt).not.toBeNull();
  });
});
