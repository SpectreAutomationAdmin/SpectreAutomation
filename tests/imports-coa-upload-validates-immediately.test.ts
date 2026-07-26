// Founder rule 2026-07-14: uploading a Chart of Accounts file
// must parse, create, AND validate the batch in the same
// workflow — the Data Imports list must never show a misleading
// "237 rows · 0 valid · 0 errors" state for a COA batch that
// just landed.
//
// Two layers of coverage:
//
//   • Behavioural tests via the service contract — call
//     createBatch + validateBatch (the exact sequence the server
//     action runs) and assert the persisted state.
//   • Source-contract tests on the server action — confirm the
//     action runs validateBatch for COA AND redirects to the
//     detail page so the existing auto-scroll-to-first-error
//     UX fires.

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
  if (!acct) throw new Error(`no ${type} seed`);
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

describe("Upload-then-validate sequence (what the COA path of createBatchAction runs)", () => {
  it("a COA upload with only number+name lands as VALIDATED with errors=totalRows (missing required mappings)", async () => {
    const c = await bootstrapAPClub("Upload-Missing-Mapping");
    const p = await adminFor(c.id);
    const created = await createBatch(p, {
      clubId: c.id,
      domain: "COA",
      rows: [
        { number: "10", name: "row a" },
        { number: "20", name: "row b" },
        { number: "30", name: "row c" },
      ],
      source: "CSV",
      fileName: "upload-missing.csv",
    });
    // The server action invokes validateBatch in the same call,
    // so we mirror that here.
    await validateBatch(p, created.id);

    const reloaded = await db().importBatch.findUnique({ where: { id: created.id } });
    expect(reloaded?.status).toBe("VALIDATED");
    expect(reloaded?.totalRows).toBe(3);
    expect(reloaded?.validRows).toBe(0);
    expect(reloaded?.errorRows).toBe(3);
    expect(reloaded?.dryRunAt).not.toBeNull();

    const errs = await db().importError.findMany({
      where: { batchId: created.id },
      orderBy: { rowNumber: "asc" },
    });
    expect(errs.length).toBeGreaterThan(0);
    // Every error references a real row.
    for (const e of errs) {
      expect([1, 2, 3]).toContain(e.rowNumber);
    }
  });

  it("a COA upload with valid pre-filled mappings lands as VALIDATED + zero errors", async () => {
    const c = await bootstrapAPClub("Upload-Clean");
    const p = await adminFor(c.id);
    const seed = await exemplarMapping(c.id, "ASSET");
    const created = await createBatch(p, {
      clubId: c.id,
      domain: "COA",
      rows: [{ number: "11", name: "clean" }],
      source: "CSV",
      fileName: "upload-clean.csv",
    });
    // Mirror the server-action's flow: createBatch only persists
    // number + name; the full mapping is applied via
    // saveCoaRowMappings (the in-page flow) OR comes from a
    // pre-filled workbook (full-row upload). For the
    // upload-and-validate guarantee, we then run validateBatch.
    const [row] = await db().importRow.findMany({ where: { batchId: created.id } });
    await saveCoaRowMappings(p, {
      batchId: created.id,
      mappings: [
        { rowId: row.id, type: "ASSET", categoryKey: seed.categoryKey, fsGroupKey: seed.fsGroupKey, departmentCodes: [] },
      ],
    });
    await validateBatch(p, created.id);

    const reloaded = await db().importBatch.findUnique({ where: { id: created.id } });
    expect(reloaded?.status).toBe("VALIDATED");
    expect(reloaded?.validRows).toBe(1);
    expect(reloaded?.errorRows).toBe(0);
    expect(reloaded?.dryRunAt).not.toBeNull();
  });

  it("a mixed upload — some valid, some missing — surfaces real counts (not 0/0)", async () => {
    const c = await bootstrapAPClub("Upload-Mixed");
    const p = await adminFor(c.id);
    const seed = await exemplarMapping(c.id, "ASSET");
    const created = await createBatch(p, {
      clubId: c.id,
      domain: "COA",
      rows: [
        { number: "21", name: "valid" },
        { number: "22", name: "missing-mapping" },
      ],
      source: "CSV",
      fileName: "mixed.csv",
    });
    const rows = await db().importRow.findMany({
      where: { batchId: created.id },
      orderBy: { rowNumber: "asc" },
    });
    // Only the first row gets a complete mapping.
    await saveCoaRowMappings(p, {
      batchId: created.id,
      mappings: [
        { rowId: rows[0].id, type: "ASSET", categoryKey: seed.categoryKey, fsGroupKey: seed.fsGroupKey, departmentCodes: [] },
      ],
    });
    await validateBatch(p, created.id);

    const reloaded = await db().importBatch.findUnique({ where: { id: created.id } });
    expect(reloaded?.validRows).toBe(1);
    expect(reloaded?.errorRows).toBe(1);
    expect(reloaded?.totalRows).toBe(2);
  });
});

describe("Re-validate after corrections still works (Dry-run / Validate button)", () => {
  it("operator fixes the broken row, clicks Validate again → status reflects the fix", async () => {
    const c = await bootstrapAPClub("ReValidate");
    const p = await adminFor(c.id);
    const seed = await exemplarMapping(c.id, "ASSET");
    const created = await createBatch(p, {
      clubId: c.id,
      domain: "COA",
      rows: [{ number: "30", name: "to-fix" }],
      source: "CSV",
      fileName: "fix.csv",
    });
    // Initial validate — missing mapping → 1 error.
    await validateBatch(p, created.id);
    let reloaded = await db().importBatch.findUnique({ where: { id: created.id } });
    expect(reloaded?.errorRows).toBe(1);

    // Operator edits → save → re-validate.
    const [row] = await db().importRow.findMany({ where: { batchId: created.id } });
    await saveCoaRowMappings(p, {
      batchId: created.id,
      mappings: [
        { rowId: row.id, type: "ASSET", categoryKey: seed.categoryKey, fsGroupKey: seed.fsGroupKey, departmentCodes: [] },
      ],
    });
    await validateBatch(p, created.id);
    reloaded = await db().importBatch.findUnique({ where: { id: created.id } });
    expect(reloaded?.validRows).toBe(1);
    expect(reloaded?.errorRows).toBe(0);
    expect(reloaded?.dryRunAt).not.toBeNull();
  });
});

describe("Source contract: createBatchAction runs validate + redirects for COA only", () => {
  const ACTIONS = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/imports/_actions.ts"),
    "utf8",
  );

  it("imports validateBatch and calls it inside createBatchAction", () => {
    expect(ACTIONS).toMatch(/from "@\/lib\/imports"[\s\S]*validateBatch/);
    expect(ACTIONS).toMatch(/await validateBatch\(principal, created\.id\)/);
  });

  it("the immediate-validate branch is gated on the COA domain", () => {
    // The action computes `isCoa` earlier in the function; the
    // validate call is inside the `if (isCoa) { ... }` block.
    expect(ACTIONS).toMatch(
      /if \(isCoa\) \{[\s\S]+?await validateBatch\(principal, created\.id\);[\s\S]+?\}/,
    );
  });

  it("after a successful COA upload, the action redirects to the batch detail page (so auto-scroll-to-first-error fires)", () => {
    expect(ACTIONS).toMatch(/redirect\(`\/app\/admin\/imports\/\$\{createdBatchId\}`\)/);
    // Other domains keep the original "land on the list" flow.
    expect(ACTIONS).toMatch(/revalidatePath\("\/app\/admin\/imports"\)/);
  });

  it("only redirects when both isCoa AND createdBatchId are truthy (no surprise redirects on non-COA or failed creates)", () => {
    expect(ACTIONS).toMatch(/if \(isCoa && createdBatchId\) \{/);
  });
});

describe("Lifecycle invariants — the founder's 'no misleading 0/0' rule", () => {
  it("a COA batch that was upload+validated never sits in the DB with dryRunAt=null and totalRows>0", async () => {
    const c = await bootstrapAPClub("Invariant-COA");
    const p = await adminFor(c.id);
    const created = await createBatch(p, {
      clubId: c.id,
      domain: "COA",
      rows: [{ number: "1", name: "x" }],
      source: "CSV",
      fileName: "x.csv",
    });
    await validateBatch(p, created.id);
    const reloaded = await db().importBatch.findUnique({ where: { id: created.id } });
    expect(reloaded?.dryRunAt).not.toBeNull();
  });
});
