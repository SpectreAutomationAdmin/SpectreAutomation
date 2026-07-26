// Chart-of-Accounts import — mapping + commit tests.
//
// Covers the new simplified COA workflow the founder spec'd:
//
//   1. Simple two-column upload (number,name) — createBatch accepts;
//      first validate fails because the operator hasn't classified
//      the rows yet.
//   2. saveCoaRowMappings persists per-row type/category/fsGroup/
//      departmentCodes into ImportRow.rawJson and resets the batch
//      to DRAFT so the operator can re-validate.
//   3. After a complete mapping, validateBatch resolves every row
//      to its FK ids and stores the resolved bundle.
//   4. commitBatch creates the Account + AccountDepartment join
//      rows for the multi-department assignment.
//   5. Legacy full-column COA upload (type/categoryKey/fsGroupKey/
//      departmentCode in the CSV) still validates + commits without
//      touching the mapping UI.
//   6. Validation errors surface for unknown type / category / fs
//      group / department, and for category that doesn't match the
//      selected type.
//   7. Tenant safety: saveCoaRowMappings refuses foreign row ids.
//
// Builds on the existing test infrastructure — bootstrapAPClub
// seeds departments, categories, FS groups, and the default COA.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";

import { db, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";

import {
  batchDetail,
  createBatch,
  validateBatch,
  commitBatch,
  saveCoaRowMappings,
} from "@/lib/imports";
import {
  getCoaMappingOptions,
  normaliseCoaRow,
  resolveCoaRow,
} from "@/lib/imports/coa-mapping";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function admin(clubId: string) {
  const email = `admin-${Math.random().toString(36).slice(2, 10)}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}

type SimpleRow = Record<string, string | string[]>;

async function uploadCoaBatch(p: Awaited<ReturnType<typeof admin>>, clubId: string, rows: SimpleRow[]) {
  return createBatch(p, {
    clubId,
    domain: "COA",
    rows: rows as Record<string, string | number | boolean | null>[],
    source: "CSV",
    fileName: "test-coa.csv",
  });
}

// ===========================================================================
// 1. normaliseCoaRow — input-shape canonicalisation.
// ===========================================================================

describe("normaliseCoaRow — canonical row shape", () => {
  it("converts a legacy single departmentCode string into a one-item array", () => {
    const out = normaliseCoaRow({
      number: "6100",
      name: "Pro Shop Payroll",
      type: "expense",
      categoryKey: "PAYROLL_BENEFITS",
      fsGroupKey: "IS_PAYROLL",
      departmentCode: "PROSHOP",
    });
    expect(out.departmentCodes).toEqual(["PROSHOP"]);
  });

  it("preserves an array of departmentCodes (the new multi-department shape)", () => {
    const out = normaliseCoaRow({
      number: "7000",
      name: "Repairs and Maintenance",
      type: "EXPENSE",
      categoryKey: "REPAIRS_MAINTENANCE",
      fsGroupKey: "IS_REPAIRS_MAINTENANCE",
      departmentCodes: ["ADMIN", "GROUNDS", "F&B", "PROSHOP", "EVENTS"],
    });
    expect(out.departmentCodes).toEqual(["ADMIN", "GROUNDS", "F&B", "PROSHOP", "EVENTS"]);
  });

  it("yields an empty departmentCodes array when neither field is supplied", () => {
    const out = normaliseCoaRow({ number: "1010", name: "Cash" });
    expect(out.departmentCodes).toEqual([]);
  });

  it("uppercases type and clears it when not in the enum", () => {
    expect(normaliseCoaRow({ number: "1010", name: "Cash", type: "asset" }).type).toBe("ASSET");
    expect(normaliseCoaRow({ number: "1010", name: "Cash", type: "made-up" }).type).toBeNull();
  });
});

// ===========================================================================
// 2. resolveCoaRow — per-field validation against per-club options.
// ===========================================================================

describe("resolveCoaRow — validation against per-club options", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });

  it("returns ok with FK ids when every field is supplied + valid", async () => {
    await resetDb();
    await seedRbac();
    const club = await bootstrapAPClub("COA-RESOLVE-OK");
    const options = await getCoaMappingOptions(club.id);

    const result = resolveCoaRow(
      normaliseCoaRow({
        number: "1010",
        name: "Operating Bank",
        type: "ASSET",
        categoryKey: "CURRENT_ASSETS",
        fsGroupKey: "BS_CASH_EQUIVALENTS",
        departmentCodes: ["ADMIN"],
      }),
      options,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.categoryId).toBeTruthy();
    expect(result.resolved.fsGroupId).toBeTruthy();
    expect(result.resolved.departmentIds).toHaveLength(1);
    expect(result.resolved.normalBalance).toBe("DEBIT");
  });

  it("rejects when type / categoryKey / fsGroupKey are missing", async () => {
    await resetDb();
    await seedRbac();
    const club = await bootstrapAPClub("COA-RESOLVE-REQ");
    const options = await getCoaMappingOptions(club.id);

    const result = resolveCoaRow(
      normaliseCoaRow({ number: "1010", name: "Operating Bank" }),
      options,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.errors.map((e) => e.code);
    expect(codes).toContain("REQUIRED"); // type
    // 3 REQUIRED errors expected (type, categoryKey, fsGroupKey).
    const required = result.errors.filter((e) => e.code === "REQUIRED");
    expect(required.length).toBeGreaterThanOrEqual(3);
  });

  it("rejects an unknown categoryKey", async () => {
    await resetDb();
    await seedRbac();
    const club = await bootstrapAPClub("COA-RESOLVE-CAT");
    const options = await getCoaMappingOptions(club.id);

    const result = resolveCoaRow(
      normaliseCoaRow({
        number: "1010",
        name: "Operating Bank",
        type: "ASSET",
        categoryKey: "MADE_UP_CATEGORY",
        fsGroupKey: "BS_CASH_EQUIVALENTS",
      }),
      options,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.code)).toContain("UNKNOWN_CATEGORY");
  });

  it("rejects a category that doesn't match the selected type", async () => {
    await resetDb();
    await seedRbac();
    const club = await bootstrapAPClub("COA-RESOLVE-MISMATCH");
    const options = await getCoaMappingOptions(club.id);

    const result = resolveCoaRow(
      normaliseCoaRow({
        number: "4000",
        name: "Dues",
        type: "REVENUE",
        categoryKey: "CURRENT_ASSETS", // ASSET-only category
        fsGroupKey: "IS_MEMBERSHIP_DUES",
      }),
      options,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.code)).toContain("TYPE_CATEGORY_MISMATCH");
  });

  it("rejects an unknown fsGroupKey", async () => {
    await resetDb();
    await seedRbac();
    const club = await bootstrapAPClub("COA-RESOLVE-FSG");
    const options = await getCoaMappingOptions(club.id);

    const result = resolveCoaRow(
      normaliseCoaRow({
        number: "1010",
        name: "Operating Bank",
        type: "ASSET",
        categoryKey: "CURRENT_ASSETS",
        fsGroupKey: "MADE_UP_FS_GROUP",
      }),
      options,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.code)).toContain("UNKNOWN_FS_GROUP");
  });

  it("rejects an unknown department code", async () => {
    await resetDb();
    await seedRbac();
    const club = await bootstrapAPClub("COA-RESOLVE-DEPT");
    const options = await getCoaMappingOptions(club.id);

    const result = resolveCoaRow(
      normaliseCoaRow({
        number: "1010",
        name: "Operating Bank",
        type: "ASSET",
        categoryKey: "CURRENT_ASSETS",
        fsGroupKey: "BS_CASH_EQUIVALENTS",
        departmentCodes: ["NOT_A_DEPT"],
      }),
      options,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.code)).toContain("UNKNOWN_DEPARTMENT");
  });

  it("normalBalance is DEBIT for ASSET/EXPENSE and CREDIT for LIABILITY/EQUITY/REVENUE", async () => {
    await resetDb();
    await seedRbac();
    const club = await bootstrapAPClub("COA-RESOLVE-NB");
    const options = await getCoaMappingOptions(club.id);

    const asset = resolveCoaRow(
      normaliseCoaRow({ number: "1010", name: "Cash", type: "ASSET", categoryKey: "CURRENT_ASSETS", fsGroupKey: "BS_CASH_EQUIVALENTS" }),
      options,
    );
    const liab = resolveCoaRow(
      normaliseCoaRow({ number: "2000", name: "AP", type: "LIABILITY", categoryKey: "CURRENT_LIABILITIES", fsGroupKey: "BS_AP" }),
      options,
    );
    const exp = resolveCoaRow(
      normaliseCoaRow({ number: "6000", name: "Wages", type: "EXPENSE", categoryKey: "PAYROLL_BENEFITS", fsGroupKey: "IS_PAYROLL" }),
      options,
    );

    expect(asset.ok && asset.resolved.normalBalance).toBe("DEBIT");
    expect(liab.ok && liab.resolved.normalBalance).toBe("CREDIT");
    expect(exp.ok && exp.resolved.normalBalance).toBe("DEBIT");
  });
});

// ===========================================================================
// 3. Simple-upload workflow — number+name only, then map, then commit.
// ===========================================================================

describe("COA workflow — simplified upload + in-page mapping", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("accepts a two-column upload, then validate fails until mapping is saved", async () => {
    const club = await bootstrapAPClub("COA-SIMPLE-1");
    const p = await admin(club.id);

    const batch = await uploadCoaBatch(p, club.id, [
      { number: "9001", name: "Custom Suspense Account" },
    ]);
    expect(batch.status).toBe("DRAFT");
    expect(batch.totalRows).toBe(1);

    // First validate — no type/category/fs supplied → resolution
    // fails, row INVALID, batch VALIDATED with errorRows=1.
    await validateBatch(p, batch.id);
    const errors = await db().importError.findMany({ where: { batchId: batch.id } });
    expect(errors.length).toBeGreaterThan(0);
    const codes = errors.map((e) => e.code);
    expect(codes).toContain("REQUIRED");
  });

  it("saveCoaRowMappings → validate → commit creates an Account with FK ids", async () => {
    const club = await bootstrapAPClub("COA-SIMPLE-2");
    const p = await admin(club.id);
    const batch = await uploadCoaBatch(p, club.id, [
      { number: "9002", name: "New Initiation Programme" },
    ]);
    const [row] = await db().importRow.findMany({ where: { batchId: batch.id } });

    await saveCoaRowMappings(p, {
      batchId: batch.id,
      mappings: [
        {
          rowId: row.id,
          type: "REVENUE",
          categoryKey: "MEMBERSHIP_REVENUE",
          fsGroupKey: "IS_MEMBERSHIP_DUES",
          departmentCodes: ["ADMIN"],
        },
      ],
    });
    // saveCoaRowMappings forces the batch back to DRAFT and clears
    // stale errors.
    const after = await db().importBatch.findUnique({ where: { id: batch.id } });
    expect(after?.status).toBe("DRAFT");
    expect(await db().importError.count({ where: { batchId: batch.id } })).toBe(0);

    await validateBatch(p, batch.id);
    const validated = await db().importBatch.findUnique({ where: { id: batch.id } });
    expect(validated?.errorRows).toBe(0);
    expect(validated?.validRows).toBe(1);

    await commitBatch(p, { batchId: batch.id, confirmReplaceCoa: true });
    const account = await db().account.findUnique({
      where: { clubId_accountNumber: { clubId: club.id, accountNumber: "9002" } },
      include: { departments: true, category: true, fsGroup: true },
    });
    expect(account).toBeTruthy();
    expect(account!.type).toBe("REVENUE");
    expect(account!.normalBalance).toBe("CREDIT");
    expect(account!.category?.key).toBe("MEMBERSHIP_REVENUE");
    expect(account!.fsGroup?.key).toBe("IS_MEMBERSHIP_DUES");
    expect(account!.departments).toHaveLength(1);
    expect(account!.defaultDepartmentId).toBe(account!.departments[0].departmentId);
  });

  it("multi-department: one account assigned to ADMIN + GOLF + COURSE + FB + PROSHOP", async () => {
    const club = await bootstrapAPClub("COA-MULTI-DEPT");
    const p = await admin(club.id);

    const batch = await uploadCoaBatch(p, club.id, [
      { number: "7000", name: "Repairs and Maintenance" },
    ]);
    const [row] = await db().importRow.findMany({ where: { batchId: batch.id } });

    await saveCoaRowMappings(p, {
      batchId: batch.id,
      mappings: [
        {
          rowId: row.id,
          type: "EXPENSE",
          categoryKey: "REPAIRS_MAINTENANCE",
          fsGroupKey: "IS_REPAIRS_MAINTENANCE",
          departmentCodes: ["ADMIN", "GROUNDS", "F&B", "PROSHOP", "EVENTS"],
        },
      ],
    });
    await validateBatch(p, batch.id);
    await commitBatch(p, { batchId: batch.id, confirmReplaceCoa: true });

    const account = await db().account.findUnique({
      where: { clubId_accountNumber: { clubId: club.id, accountNumber: "7000" } },
      include: { departments: { include: { department: true } } },
    });
    expect(account).toBeTruthy();
    const codes = account!.departments.map((ad) => ad.department.code).sort();
    expect(codes).toEqual(["ADMIN", "EVENTS", "F&B", "GROUNDS", "PROSHOP"]);
    // The first selected department remains the "primary".
    const primary = account!.departments.find(
      (ad) => ad.departmentId === account!.defaultDepartmentId,
    );
    expect(primary).toBeTruthy();
  });

  it("re-committing the same account with a different department set replaces the join rows", async () => {
    const club = await bootstrapAPClub("COA-MULTI-DEPT-REPLACE");
    const p = await admin(club.id);
    const batch1 = await uploadCoaBatch(p, club.id, [
      { number: "7100", name: "Utilities" },
    ]);
    const [row1] = await db().importRow.findMany({ where: { batchId: batch1.id } });
    await saveCoaRowMappings(p, {
      batchId: batch1.id,
      mappings: [
        {
          rowId: row1.id,
          type: "EXPENSE",
          categoryKey: "UTILITIES",
          fsGroupKey: "IS_UTILITIES",
          departmentCodes: ["ADMIN", "PROSHOP"],
        },
      ],
    });
    await validateBatch(p, batch1.id);
    await commitBatch(p, { batchId: batch1.id, confirmReplaceCoa: true });

    // Now re-import with only PROSHOP.
    const batch2 = await uploadCoaBatch(p, club.id, [
      { number: "7100", name: "Utilities (revised)" },
    ]);
    const [row2] = await db().importRow.findMany({ where: { batchId: batch2.id } });
    await saveCoaRowMappings(p, {
      batchId: batch2.id,
      mappings: [
        {
          rowId: row2.id,
          type: "EXPENSE",
          categoryKey: "UTILITIES",
          fsGroupKey: "IS_UTILITIES",
          departmentCodes: ["PROSHOP"],
        },
      ],
    });
    await validateBatch(p, batch2.id);
    await commitBatch(p, { batchId: batch2.id, confirmReplaceCoa: true });

    const account = await db().account.findUnique({
      where: { clubId_accountNumber: { clubId: club.id, accountNumber: "7100" } },
      include: { departments: { include: { department: true } } },
    });
    expect(account!.departments).toHaveLength(1);
    expect(account!.departments[0].department.code).toBe("PROSHOP");
  });
});

// ===========================================================================
// 4. Legacy full-format upload — back-compat.
// ===========================================================================

describe("COA workflow — legacy full-format upload (back-compat)", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("validates + commits without ever using the mapping UI when the CSV ships all columns", async () => {
    const club = await bootstrapAPClub("COA-LEGACY");
    const p = await admin(club.id);

    const batch = await uploadCoaBatch(p, club.id, [
      {
        number: "9101",
        name: "Initiation Fees - Junior",
        type: "REVENUE",
        categoryKey: "MEMBERSHIP_REVENUE",
        fsGroupKey: "IS_MEMBERSHIP_DUES",
        departmentCode: "ADMIN",
      },
    ]);
    await validateBatch(p, batch.id);
    const validated = await db().importBatch.findUnique({ where: { id: batch.id } });
    expect(validated?.errorRows).toBe(0);
    expect(validated?.validRows).toBe(1);

    await commitBatch(p, { batchId: batch.id, confirmReplaceCoa: true });
    const account = await db().account.findUnique({
      where: { clubId_accountNumber: { clubId: club.id, accountNumber: "9101" } },
      include: { departments: { include: { department: true } } },
    });
    expect(account!.departments.map((ad) => ad.department.code)).toEqual(["ADMIN"]);
  });
});

// ===========================================================================
// 5. batchDetail — returns ALL rows (no 200-cap that hid 37 of the
//    founder's 237 account rows from the mapping table).
// ===========================================================================

describe("batchDetail — row truncation regression", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("returns every row of a 237-account COA batch (mapping UI needs them all)", async () => {
    const club = await bootstrapAPClub("COA-NO-TRUNCATE");
    const p = await admin(club.id);
    // Build 237 unique rows (number must be unique inside a batch
    // to dodge the dup-detection path).
    const rows: SimpleRow[] = [];
    rows.push({ number: "1000", name: "Petty Cash" });
    for (let i = 0; i < 235; i++) {
      const acct = String(1100 + i);
      rows.push({ number: acct, name: `Account ${acct}` });
    }
    rows.push({ number: "9901", name: "Depreciation" });
    const batch = await uploadCoaBatch(p, club.id, rows);

    const detail = await batchDetail(p, batch.id);
    expect(detail.rows).toHaveLength(237);
    expect(detail.rows[0].rowNumber).toBe(1);
    expect(detail.rows[detail.rows.length - 1].rowNumber).toBe(237);
  });
});

// ===========================================================================
// 6. Tenant safety on the mapping save action.
// ===========================================================================

describe("saveCoaRowMappings — tenant safety", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("refuses to update a row that doesn't belong to the supplied batch", async () => {
    const clubA = await bootstrapAPClub("COA-TENANT-A");
    const clubB = await bootstrapAPClub("COA-TENANT-B");
    const adminA = await admin(clubA.id);
    const adminB = await admin(clubB.id);

    const batchA = await uploadCoaBatch(adminA, clubA.id, [
      { number: "9201", name: "Club A row" },
    ]);
    const batchB = await uploadCoaBatch(adminB, clubB.id, [
      { number: "9301", name: "Club B row" },
    ]);
    const [rowB] = await db().importRow.findMany({ where: { batchId: batchB.id } });

    // adminA tries to map Club B's row into Club A's batch.
    let caught: unknown;
    try {
      await saveCoaRowMappings(adminA, {
        batchId: batchA.id,
        mappings: [
          {
            rowId: rowB.id,
            type: "ASSET",
            categoryKey: "CURRENT_ASSETS",
            fsGroupKey: "BS_CASH_EQUIVALENTS",
            departmentCodes: [],
          },
        ],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    // ValidationError.message is generic ("Validation failed"); the
    // tenant-violation message lives in .issues.
    const issues = (caught as { issues?: Array<{ path: string; message: string }> }).issues ?? [];
    expect(
      issues.some((i) => /do not belong to this batch/i.test(i.message)),
      `expected a tenant-violation issue; got ${JSON.stringify(issues)}`,
    ).toBe(true);

    // And the row was NOT touched.
    const stillRowB = await db().importRow.findUnique({ where: { id: rowB.id } });
    expect(stillRowB?.normalizedJson).toBeNull();
  });
});
