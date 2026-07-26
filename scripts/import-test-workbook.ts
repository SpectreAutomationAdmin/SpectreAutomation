// End-to-end import test for the user-supplied TEST.xlsx.
//
// Drives the SAME pipeline the UI uses:
//   1. Read the workbook bytes.
//   2. Run parseXlsxRows(domain=COA) → Record<string,string>[]
//   3. createBatch(principal, { domain: "COA", rows, source: "XLSX" })
//   4. Read the resulting ImportRow rows back from the DB.
//   5. resolveCoaRow against the live per-club options for every
//      row, count READY vs incomplete + report invalid keys.
//
// Cleans up the batch at the end so the dev DB stays tidy.

import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

import { createBatch, deleteDraftBatch } from "../src/lib/imports";
import { parseXlsxRows } from "../src/lib/imports/xlsx-parse";
import {
  getCoaMappingOptions,
  resolveCoaRow,
  normaliseCoaRow,
} from "../src/lib/imports/coa-mapping";

const SRC = path.resolve("test-results/uploaded/TEST.xlsx");

async function main() {
  const prisma = new PrismaClient();
  const adminRole = await prisma.userClubRole.findFirst({
    where: { roleKey: "CLUB_ADMIN" },
    include: { user: true, club: { select: { name: true } } },
  });
  if (!adminRole?.user) throw new Error("No CLUB_ADMIN user found in dev DB.");
  const club = adminRole.club;
  if (!club || !adminRole.clubId) throw new Error("CLUB_ADMIN role has no linked club.");
  const clubId: string = adminRole.clubId;
  const principal = {
    id: adminRole.user.id,
    name: adminRole.user.name,
    email: adminRole.user.email,
    status: "ACTIVE",
    memberships: [{ clubId: clubId, roleKey: "CLUB_ADMIN" as const }],
    activeClubId: clubId,
    memberId: null,
  };

  console.log(`Importing TEST.xlsx as ${adminRole.user.email} → ${club.name}\n`);

  // ── 1. Parse the workbook ──────────────────────────────────────
  const buf = fs.readFileSync(SRC);
  const rows = await parseXlsxRows(buf, { domain: "COA" });
  console.log(`Parsed ${rows.length} rows from the Chart of Accounts sheet.`);
  const hasAnyMapping = rows.filter((r) => r.type || r.categoryKey || r.fsGroupKey || r.departmentCodes).length;
  console.log(`  · ${hasAnyMapping} rows include pre-filled mapping data.`);
  console.log(`  · ${rows.length - hasAnyMapping} rows have only number + name.\n`);

  // ── 2. createBatch ─────────────────────────────────────────────
  let batchId: string | undefined;
  try {
    const result = await createBatch(principal, {
      clubId: clubId,
      domain: "COA",
      rows,
      source: "XLSX",
      fileName: "TEST.xlsx",
    });
    batchId = result.id;
    console.log(`createBatch OK — batch id ${batchId}`);
    console.log(`  status=${result.status}  totalRows=${result.totalRows ?? "?"}\n`);
  } catch (e) {
    console.error("createBatch FAILED:", (e as Error).message);
    await prisma.$disconnect();
    process.exit(1);
  }

  // ── 3. Read every ImportRow back + resolve against live options
  const importRows = await prisma.importRow.findMany({
    where: { batchId },
    orderBy: { rowNumber: "asc" },
    select: { id: true, rowNumber: true, rawJson: true },
  });
  if (importRows.length === 0) {
    console.log("No ImportRow records found — abort.");
    await prisma.$disconnect();
    return;
  }
  console.log(`Stored ${importRows.length} ImportRow records.\n`);

  const options = await getCoaMappingOptions(clubId);

  let ready = 0;
  let incomplete = 0;
  const errorsByCode = new Map<string, number>();
  const sampleErrors: Array<{ row: number; field: string; message: string }> = [];

  for (const ir of importRows) {
    const raw = ir.rawJson ? JSON.parse(String(ir.rawJson)) : {};
    const normalised = normaliseCoaRow(raw);
    const result = resolveCoaRow(normalised, options);
    if (result.ok) {
      ready++;
    } else {
      incomplete++;
      for (const err of result.errors) {
        errorsByCode.set(err.code, (errorsByCode.get(err.code) ?? 0) + 1);
        if (sampleErrors.length < 6) {
          sampleErrors.push({ row: ir.rowNumber, field: err.columnName ?? "?", message: err.message });
        }
      }
    }
  }

  console.log("─── Resolution summary ───");
  console.log(`  READY (every field resolves cleanly): ${ready}`);
  console.log(`  Needs additional mapping             : ${incomplete}`);
  if (errorsByCode.size > 0) {
    console.log("  Error codes (counts):");
    for (const [code, count] of errorsByCode) {
      console.log(`    ${code.padEnd(28)} ${count}`);
    }
    console.log("  Sample messages:");
    for (const s of sampleErrors) {
      console.log(`    row ${s.row} · ${s.field}: ${s.message}`);
    }
  }

  // ── 4. Cleanup ─────────────────────────────────────────────────
  if (batchId) {
    try {
      await deleteDraftBatch(principal, batchId);
      console.log(`\nCleaned up draft batch ${batchId}.`);
    } catch (e) {
      console.log(`\n(Batch ${batchId} could not be deleted — likely committed/sent already. Manual cleanup may be needed.)`);
      console.log(`  reason: ${(e as Error).message}`);
    }
  }

  // ── 5. Report ─────────────────────────────────────────────────
  console.log("\n─── End-to-end verdict ───");
  if (ready === importRows.length && importRows.length > 0) {
    console.log(`✓ ${importRows.length}/${importRows.length} rows imported successfully + every mapping resolved.`);
  } else if (ready > 0) {
    console.log(`✓ Workbook imports successfully (${importRows.length} rows). ${incomplete} rows need additional mapping in the Spectre UI (likely missing categoryKey or fsGroupKey for those rows).`);
  } else {
    console.log(`⚠ Workbook imports rows but none of the optional mappings resolve. Review the error counts above.`);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
