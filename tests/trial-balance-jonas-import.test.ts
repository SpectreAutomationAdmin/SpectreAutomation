// Founder rule 2026-06-30 v14 — Jonas Trial Balance import.
//
// Coverage:
//   1. Header aliasing (unit) — Jonas headers with embedded \n
//      normalise to the canonical `accountNumber` / `description`
//      / `debit` / `credit` keys.
//   2. XLSX end-to-end — the actual April 26 Trial Balance file
//      the founder attached reaches the preview step without
//      header-format errors.
//   3. CSV end-to-end — the same data saved as CSV also reaches
//      the preview step.
//   4. Batch-level validation — unmatched accounts, out-of-balance,
//      both-DR-and-CR, missing description, blank rows.
//   5. Preview UI source-contract — the totals card, unmatched
//      panel, and rows table all render for TB batches.
//
// Reuses tests/fixtures/jonas-april-2026-tb.xlsx (a copy of the
// founder's real Jonas export) so any header format the vendor
// ships in the wild is exercised end-to-end.

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAccountingClub } from "./util/gl";
import {
  createBatch, validateBatch, asAccountCode, commitBatch,
  setTrialBalanceAsOfDate, readTrialBalanceAsOfDate,
  voidCommittedBatch, deleteBatch,
} from "@/lib/imports";
import {
  parseXlsxRows, parseTrialBalanceXlsx, detectTrialBalancePeriod,
} from "@/lib/imports/xlsx-parse";
import { parseCsvRows, aliasHeaders, parseTrialBalanceCsv } from "@/lib/imports/csv-parse";
import { trialBalance, balanceSheet, incomeStatement } from "@/lib/accounting/reports";
import { ensureFiscalYear } from "@/lib/accounting/periods";

async function adminFor(clubId: string) {
  const email = `admin-${Math.random().toString(36).slice(2, 10)}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}

// CONTROLLER has coa:write; used for the full-COA fixture seed
// so createAccount doesn't hit ForbiddenError. Every other test
// uses adminFor because import isn't gated on coa:write.
async function controllerFor(clubId: string) {
  const email = `ctrl-${Math.random().toString(36).slice(2, 10)}@example.com`;
  await makeUser({ email, role: "CONTROLLER", clubId });
  return principalFor(email);
}

const FIXTURE_XLSX = path.resolve(process.cwd(), "tests/fixtures/jonas-april-2026-tb.xlsx");
const FIXTURE_PREHEADER = path.resolve(process.cwd(), "tests/fixtures/jonas-may-2026-tb-preheader.xlsx");

beforeAll(async () => { await seedRbac(); });
beforeEach(async () => { await resetDb(); await seedRbac(); });

// ---------------------------------------------------------------------------
// 1. Header aliasing — unit
// ---------------------------------------------------------------------------
describe("Jonas TB header aliasing", () => {
  it("collapses embedded \\n + case + whitespace and aliases the 4 Jonas headers to canonical keys", () => {
    const raw = ["G/L Account\nCode", "G/L Account\nDescription", "Closing Bal\nDebit", "Closing Bal\nCredit"];
    const aliased = aliasHeaders("OPENING_TRIAL_BALANCE", raw);
    expect(aliased).toEqual(["accountNumber", "description", "debit", "credit"]);
  });

  it("also accepts spaces-only variants + case variants + shorthand", () => {
    expect(aliasHeaders("OPENING_TRIAL_BALANCE", ["ACCOUNT #", "Account Name", "DEBIT", "CREDIT"]))
      .toEqual(["accountNumber", "description", "debit", "credit"]);
    expect(aliasHeaders("OPENING_TRIAL_BALANCE", ["code", "description", "debit amount", "credit amount"]))
      .toEqual(["accountNumber", "description", "debit", "credit"]);
  });

  it("asAccountCode strips '.0' suffix from Excel numeric cells (spec item 'account codes as strings')", () => {
    expect(asAccountCode(1000)).toBe("1000");
    expect(asAccountCode("1000.0")).toBe("1000");
    expect(asAccountCode("1000.00")).toBe("1000");
    expect(asAccountCode("  1200 ")).toBe("1200");
    expect(asAccountCode(null)).toBeNull();
    expect(asAccountCode("")).toBeNull();
    // A real decimal (like 1000.5) must NOT be truncated — only
    // trailing zeros after the decimal are stripped.
    expect(asAccountCode("1000.5")).toBe("1000.5");
  });
});

// ---------------------------------------------------------------------------
// 2. Fixture XLSX — end-to-end
// ---------------------------------------------------------------------------
describe("Jonas TB XLSX fixture — parses cleanly + reaches the preview step", () => {
  it("parseXlsxRows returns 237 rows with canonical keys", async () => {
    const buf = fs.readFileSync(FIXTURE_XLSX);
    const rows = await parseXlsxRows(buf, { domain: "OPENING_TRIAL_BALANCE" });
    expect(rows.length).toBe(237);
    const first = rows[0];
    expect(first.accountNumber).toBe("1000");
    expect(first.description).toBe("Petty Cash");
    // Excel numeric cells become strings (parser stringifies).
    // The batch validator asNumber() handles the parse.
    expect(first.debit).toBe("890.9");
    expect(first.credit).toBe("0");
  });

  // Founder rule 2026-06-30 v14.2 acceptance criterion:
  // "Confirm the attached April 26 Trial Balance imports to
  // preview as balanced." Even though many rows will land on
  // ACCOUNT_NOT_FOUND against a bootstrap COA, the debit +
  // credit reconciliation is done ONLY on VALID rows — proving
  // the balanced-file check works.
  it("April 26 Trial Balance fixture: NO false TB_OUT_OF_BALANCE error against a full-COA club", async () => {
    const club = await bootstrapAccountingClub("TB-FixtureBalanced");
    const p = await controllerFor(club.id);
    // Seed EVERY account referenced by the fixture so the
    // COA-existence check passes for every row → the totals
    // include every debit + credit → the balance check runs
    // on the full data set.
    const buf = fs.readFileSync(FIXTURE_XLSX);
    const rows = await parseXlsxRows(buf, { domain: "OPENING_TRIAL_BALANCE" });
    const seenNumbers = new Set(rows.map((r) => String(r.accountNumber).replace(/\.0+$/, "")));
    // Every account not already in the bootstrap seed: create as a generic EXPENSE.
    const { createAccount } = await import("@/lib/accounting/coa");
    const existing = new Set(
      (await db().account.findMany({ where: { clubId: club.id }, select: { accountNumber: true } }))
        .map((a) => a.accountNumber),
    );
    for (const num of seenNumbers) {
      if (existing.has(num)) continue;
      const row = rows.find((r) => String(r.accountNumber).replace(/\.0+$/, "") === num);
      const isCredit = Math.abs(Number(row?.credit ?? 0)) > 0;
      await createAccount(p, club.id, {
        accountNumber: num,
        name: String(row?.description ?? `Account ${num}`),
        type: isCredit ? "LIABILITY" : "ASSET",
      });
    }
    const batch = await createBatch(p, {
      clubId: club.id, domain: "OPENING_TRIAL_BALANCE", rows,
      source: "XLSX", fileName: "April 26 Trial Balance.xlsx",
    });
    await validateBatch(p, batch.id);
    // Zero ACCOUNT_NOT_FOUND (every account exists) + zero
    // TB_OUT_OF_BALANCE (Jonas credits absolute-valued cleanly
    // to reconcile against the debits).
    const errs = await db().importError.findMany({ where: { batchId: batch.id } });
    const outOfBalance = errs.filter((e) => e.code === "TB_OUT_OF_BALANCE");
    const unmatched = errs.filter((e) => e.code === "ACCOUNT_NOT_FOUND");
    expect(unmatched.length).toBe(0);
    expect(outOfBalance.length).toBe(0);
    const b = await db().importBatch.findUnique({ where: { id: batch.id } });
    expect(b?.errorRows).toBe(0);
    expect(b?.validRows).toBe(237);
  });

  it("validateBatch — clean seed COA covers a subset → unmatched accounts flagged, others balance", async () => {
    // Seed a partial COA (bootstrapAccountingClub gives us the
    // ~60 canonical seed accounts). Anything in the Jonas file
    // that's not in that seed will land on ACCOUNT_NOT_FOUND.
    const club = await bootstrapAccountingClub("TB-Jonas-XLSX");
    const p = await adminFor(club.id);
    const buf = fs.readFileSync(FIXTURE_XLSX);
    const rows = await parseXlsxRows(buf, { domain: "OPENING_TRIAL_BALANCE" });
    const batch = await createBatch(p, { clubId: club.id, domain: "OPENING_TRIAL_BALANCE", rows, source: "XLSX", fileName: "April 26 Trial Balance.xlsx" });
    await validateBatch(p, batch.id);
    const errs = await db().importError.findMany({ where: { batchId: batch.id }, orderBy: { rowNumber: "asc" } });
    // At least SOME rows fired ACCOUNT_NOT_FOUND (the seed COA
    // doesn't cover every Jonas account) — proves the existence
    // check ran end-to-end.
    const unmatchedCount = errs.filter((e) => e.code === "ACCOUNT_NOT_FOUND").length;
    expect(unmatchedCount).toBeGreaterThan(0);
    // Every unmatched error message includes the exact copy the
    // founder asked for.
    expect(errs.find((e) => e.code === "ACCOUNT_NOT_FOUND")!.message).toMatch(/Account number not found in Chart of Accounts/);
  });
});

// ---------------------------------------------------------------------------
// 3. Same data as CSV — end-to-end
// ---------------------------------------------------------------------------
describe("Jonas TB CSV fixture — same aliasing, same validation", () => {
  it("parseCsvRows applied to the Jonas headers (as CSV) returns canonical rows", () => {
    // Note the embedded \n inside a quoted header — RFC 4180
    // CSV parser MUST preserve it inside the quotes so the
    // aliaser sees the full "G/L Account\nCode".
    const csv = [
      `"G/L Account\nCode","G/L Account\nDescription","Closing Bal\nDebit","Closing Bal\nCredit"`,
      `1000,Petty Cash,890.90,0`,
      `1001,Bank - General,2126855.30,0`,
      `2000,Accounts Payable,0,45000.00`,
    ].join("\n");
    const rows = parseCsvRows(csv, { domain: "OPENING_TRIAL_BALANCE" });
    expect(rows).toEqual([
      { accountNumber: "1000", description: "Petty Cash", debit: "890.90", credit: "0" },
      { accountNumber: "1001", description: "Bank - General", debit: "2126855.30", credit: "0" },
      { accountNumber: "2000", description: "Accounts Payable", debit: "0", credit: "45000.00" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. Batch-level validation branches
// ---------------------------------------------------------------------------
describe("Jonas TB batch validation branches", () => {
  it("all accounts exist + debits === credits → batch is CLEAN (no errors)", async () => {
    const club = await bootstrapAccountingClub("TB-Balanced");
    const p = await adminFor(club.id);
    // Use two SEED accounts that definitely exist so no
    // ACCOUNT_NOT_FOUND fires.
    const created = await createBatch(p, {
      clubId: club.id, domain: "OPENING_TRIAL_BALANCE",
      rows: [
        { accountNumber: "1000", description: "Petty Cash",        debit: "500.00", credit: "0" },
        { accountNumber: "2000", description: "Accounts Payable",  debit: "0",      credit: "500.00" },
      ],
      source: "CSV", fileName: "balanced.csv",
    });
    await validateBatch(p, created.id);
    const errs = await db().importError.findMany({ where: { batchId: created.id } });
    expect(errs.length).toBe(0);
    const b = await db().importBatch.findUnique({ where: { id: created.id } });
    expect(b?.validRows).toBe(2);
    expect(b?.errorRows).toBe(0);
  });

  it("unbalanced batch → TB_OUT_OF_BALANCE error at row 0 with debit/credit/variance in the message", async () => {
    const club = await bootstrapAccountingClub("TB-Unbalanced");
    const p = await adminFor(club.id);
    const created = await createBatch(p, {
      clubId: club.id, domain: "OPENING_TRIAL_BALANCE",
      rows: [
        { accountNumber: "1000", description: "Petty Cash",        debit: "500.00", credit: "0" },
        { accountNumber: "2000", description: "Accounts Payable",  debit: "0",      credit: "400.00" },
      ],
      source: "CSV", fileName: "unbalanced.csv",
    });
    await validateBatch(p, created.id);
    const err = await db().importError.findFirstOrThrow({
      where: { batchId: created.id, code: "TB_OUT_OF_BALANCE" },
    });
    expect(err.rowNumber).toBe(0);
    expect(err.message).toMatch(/500\.00/);
    expect(err.message).toMatch(/400\.00/);
    expect(err.message).toMatch(/variance 100\.00/);
    expect(err.severity).toBe("ERROR");
    const b = await db().importBatch.findUnique({ where: { id: created.id } });
    expect(b?.errorRows).toBeGreaterThanOrEqual(1);
  });

  it("row with BOTH debit AND credit non-zero → BOTH_DR_CR + row marked INVALID", async () => {
    const club = await bootstrapAccountingClub("TB-BothSides");
    const p = await adminFor(club.id);
    const created = await createBatch(p, {
      clubId: club.id, domain: "OPENING_TRIAL_BALANCE",
      rows: [{ accountNumber: "1000", description: "Petty Cash", debit: "100", credit: "50" }],
      source: "CSV", fileName: "both.csv",
    });
    await validateBatch(p, created.id);
    const err = await db().importError.findFirstOrThrow({
      where: { batchId: created.id, code: "BOTH_DR_CR" },
    });
    expect(err.message).toMatch(/cannot carry both/i);
  });

  it("row with missing account number → REQUIRED error, row INVALID", async () => {
    const club = await bootstrapAccountingClub("TB-MissingNumber");
    const p = await adminFor(club.id);
    const created = await createBatch(p, {
      clubId: club.id, domain: "OPENING_TRIAL_BALANCE",
      rows: [{ accountNumber: "", description: "No number", debit: "0", credit: "100" }],
      source: "CSV", fileName: "missing-num.csv",
    });
    await validateBatch(p, created.id);
    const err = await db().importError.findFirstOrThrow({
      where: { batchId: created.id, code: "REQUIRED", columnName: "accountNumber" },
    });
    expect(err.message).toMatch(/Account number is required/);
  });

  it("row with missing description → REQUIRED error, row INVALID", async () => {
    const club = await bootstrapAccountingClub("TB-MissingDesc");
    const p = await adminFor(club.id);
    const created = await createBatch(p, {
      clubId: club.id, domain: "OPENING_TRIAL_BALANCE",
      rows: [{ accountNumber: "1000", description: "", debit: "100", credit: "0" }],
      source: "CSV", fileName: "missing-desc.csv",
    });
    await validateBatch(p, created.id);
    const err = await db().importError.findFirstOrThrow({
      where: { batchId: created.id, code: "REQUIRED", columnName: "description" },
    });
    expect(err.message).toMatch(/Account description is required/);
  });

  it("account not in COA → ACCOUNT_NOT_FOUND with number + description + debit + credit in the message", async () => {
    const club = await bootstrapAccountingClub("TB-Unmatched");
    const p = await adminFor(club.id);
    const created = await createBatch(p, {
      clubId: club.id, domain: "OPENING_TRIAL_BALANCE",
      rows: [{ accountNumber: "99999", description: "Made-Up Account", debit: "250.00", credit: "0" }],
      source: "CSV", fileName: "unmatched.csv",
    });
    await validateBatch(p, created.id);
    const err = await db().importError.findFirstOrThrow({
      where: { batchId: created.id, code: "ACCOUNT_NOT_FOUND" },
    });
    expect(err.message).toMatch(/Account 99999/);
    expect(err.message).toMatch(/Made-Up Account/);
    expect(err.message).toMatch(/Debit 250\.00/);
    expect(err.message).toMatch(/Credit 0\.00/);
    expect(err.message).toMatch(/Account number not found in Chart of Accounts/);
  });

  it("zero debit + zero credit rows are accepted (spec item 'zero values should be accepted')", async () => {
    const club = await bootstrapAccountingClub("TB-Zero");
    const p = await adminFor(club.id);
    const created = await createBatch(p, {
      clubId: club.id, domain: "OPENING_TRIAL_BALANCE",
      rows: [{ accountNumber: "1000", description: "Petty Cash", debit: "0", credit: "0" }],
      source: "CSV", fileName: "zero.csv",
    });
    await validateBatch(p, created.id);
    const errs = await db().importError.findMany({ where: { batchId: created.id } });
    expect(errs.length).toBe(0);
  });

  // Founder rule 2026-06-30 v14.2 — Jonas exports credits as
  // NEGATIVE numbers. The parser now takes the absolute value
  // of both debit + credit so the trial balance reconciles.
  it("Jonas-style negative credits are accepted + contribute their absolute value to the total", async () => {
    const club = await bootstrapAccountingClub("TB-NegativeCredits");
    const p = await adminFor(club.id);
    const created = await createBatch(p, {
      clubId: club.id, domain: "OPENING_TRIAL_BALANCE",
      rows: [
        { accountNumber: "1000", description: "Petty Cash",       debit: "3124602.44", credit: "0" },
        // Jonas convention: credits stored as NEGATIVE.
        { accountNumber: "2000", description: "Accounts Payable", debit: "0",          credit: "-3124602.44" },
      ],
      source: "CSV", fileName: "jonas-neg-credits.csv",
    });
    await validateBatch(p, created.id);
    const errs = await db().importError.findMany({ where: { batchId: created.id } });
    // ZERO errors: no NEGATIVE rejection, no TB_OUT_OF_BALANCE.
    expect(errs.length).toBe(0);
    const b = await db().importBatch.findUnique({ where: { id: created.id } });
    expect(b?.validRows).toBe(2);
    expect(b?.errorRows).toBe(0);
    // The reconciliation used absolute values.
    const rows = await db().importRow.findMany({ where: { batchId: created.id }, orderBy: { rowNumber: "asc" } });
    const normA = JSON.parse(rows[0].normalizedJson ?? "{}");
    const normB = JSON.parse(rows[1].normalizedJson ?? "{}");
    expect(normA.debit).toBe(3124602.44);
    expect(normA.credit).toBe(0);
    // Credit was stored as its absolute value.
    expect(normB.debit).toBe(0);
    expect(normB.credit).toBe(3124602.44);
  });

  it("both-populated rejection uses ABSOLUTE values (spec item 6: debit 100 + credit -100 is still invalid)", async () => {
    const club = await bootstrapAccountingClub("TB-BothAbs");
    const p = await adminFor(club.id);
    const created = await createBatch(p, {
      clubId: club.id, domain: "OPENING_TRIAL_BALANCE",
      rows: [{ accountNumber: "1000", description: "Petty Cash", debit: "100", credit: "-100" }],
      source: "CSV", fileName: "both-abs.csv",
    });
    await validateBatch(p, created.id);
    const err = await db().importError.findFirstOrThrow({
      where: { batchId: created.id, code: "BOTH_DR_CR" },
    });
    expect(err.message).toMatch(/cannot carry both/i);
  });

  it("blank + null + dash values in the amount columns are treated as zero", async () => {
    const club = await bootstrapAccountingClub("TB-BlankZero");
    const p = await adminFor(club.id);
    const created = await createBatch(p, {
      clubId: club.id, domain: "OPENING_TRIAL_BALANCE",
      rows: [
        { accountNumber: "1000", description: "Petty Cash",       debit: "500.00", credit: "" },        // blank credit
        { accountNumber: "2000", description: "Accounts Payable", debit: "-",     credit: "-500.00" },  // dash debit + negative credit
      ],
      source: "CSV", fileName: "blanks.csv",
    });
    await validateBatch(p, created.id);
    const errs = await db().importError.findMany({ where: { batchId: created.id } });
    // No errors: blanks/dashes coerce to zero, credit's absolute value balances the debit.
    expect(errs.length).toBe(0);
  });

  it("comma-formatted currency values parse correctly ('2,126,855.30' → 2126855.30)", async () => {
    const club = await bootstrapAccountingClub("TB-Commas");
    const p = await adminFor(club.id);
    const created = await createBatch(p, {
      clubId: club.id, domain: "OPENING_TRIAL_BALANCE",
      rows: [
        { accountNumber: "1000", description: "Petty Cash", debit: "2,126,855.30", credit: "0" },
        { accountNumber: "2000", description: "AP",         debit: "0",             credit: "2,126,855.30" },
      ],
      source: "CSV", fileName: "commas.csv",
    });
    await validateBatch(p, created.id);
    const errs = await db().importError.findMany({ where: { batchId: created.id } });
    expect(errs.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Preview UI source-contract
// ---------------------------------------------------------------------------
describe("Trial Balance preview UI — source-contract", () => {
  const PAGE_SRC = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/imports/[id]/page.tsx"),
    "utf8",
  );

  it("renders TrialBalancePreview when batch.domain === OPENING_TRIAL_BALANCE", () => {
    expect(PAGE_SRC).toMatch(/batch\.domain === "OPENING_TRIAL_BALANCE"/);
    expect(PAGE_SRC).toMatch(/<TrialBalancePreview batch=\{batch\}/);
  });

  it("totals card exposes debit + credit + variance testids", () => {
    expect(PAGE_SRC).toMatch(/data-testid="tb-preview-totals"/);
    expect(PAGE_SRC).toMatch(/data-testid="tb-total-debit"/);
    expect(PAGE_SRC).toMatch(/data-testid="tb-total-credit"/);
    expect(PAGE_SRC).toMatch(/data-testid="tb-variance"/);
    expect(PAGE_SRC).toMatch(/data-balanced=\{isBalanced \? "true" : "false"\}/);
  });

  it("out-of-balance banner + unmatched-accounts panel + parsed rows table are wired up", () => {
    expect(PAGE_SRC).toMatch(/data-testid="tb-out-of-balance-banner"/);
    expect(PAGE_SRC).toMatch(/data-testid="tb-unmatched-panel"/);
    expect(PAGE_SRC).toMatch(/data-testid="tb-preview-rows"/);
    // The unmatched panel renders the founder's exact copy per row.
    expect(PAGE_SRC).toMatch(/Account number not found in Chart of Accounts/);
  });
});

// ---------------------------------------------------------------------------
// 6. Non-regression — COA imports still work
// ---------------------------------------------------------------------------
describe("COA import is not affected by TB additions", () => {
  it("COA header aliases still produce canonical `number` + `name`", () => {
    expect(aliasHeaders("COA", ["G/L Account\nCode", "G/L Account\nDescription"]))
      .toEqual(["number", "name"]);
  });
});

// ---------------------------------------------------------------------------
// 7. v14.1 — supportsXlsx helper + upload picker + server-action gating
// ---------------------------------------------------------------------------
describe("v14.1 — XLSX file picker + server-action accept the Jonas TB workbook", () => {
  it("supportsXlsx: COA + OPENING_TRIAL_BALANCE are the ONLY XLSX-enabled domains today", async () => {
    const { supportsXlsx } = await import("@/lib/imports/templates");
    expect(supportsXlsx("COA")).toBe(true);
    expect(supportsXlsx("OPENING_TRIAL_BALANCE")).toBe(true);
    // Every other current domain stays CSV-only unless explicitly opted in.
    expect(supportsXlsx("MEMBERS")).toBe(false);
    expect(supportsXlsx("VENDORS")).toBe(false);
    expect(supportsXlsx("INVENTORY")).toBe(false);
    expect(supportsXlsx("EMPLOYEES")).toBe(false);
    expect(supportsXlsx("EVENTS")).toBe(false);
    expect(supportsXlsx("AR_HISTORY")).toBe(false);
  });

  it("NewBatchForm renders the file picker with an accept attribute driven by supportsXlsx (not hardcoded 'isCoa')", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/app/admin/imports/NewBatchForm.tsx"),
      "utf8",
    );
    // Uses the shared helper.
    expect(src).toMatch(/import \{[\s\S]*supportsXlsx[\s\S]*\} from "@\/lib\/imports\/templates"/);
    expect(src).toMatch(/const xlsxOk = supportsXlsx\(metadata\.domain\)/);
    // Accept attribute includes .xlsx MIME + extension when xlsxOk.
    expect(src).toMatch(/xlsxOk[\s\S]*\.xlsx,\.csv,application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet,text\/csv/);
    expect(src).toMatch(/accept=\{acceptAttr\}/);
    // Label copy uses displayName so it reads "Upload Opening Trial Balance (.xlsx or .csv)"
    expect(src).toMatch(/Upload \$\{metadata\.displayName\} \(\.xlsx or \.csv\)/);
    // No hardcoded isCoa gating on the accept attribute.
    expect(src).not.toMatch(/const isCoa = metadata\.domain === "COA"/);
  });

  it("_actions.ts: file-type gating + copy strings are driven by supportsXlsx / IMPORT_TEMPLATE_METADATA (not hardcoded on COA)", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/app/admin/imports/_actions.ts"),
      "utf8",
    );
    expect(src).toMatch(/import \{[\s\S]*supportsXlsx[\s\S]*\} from "@\/lib\/imports\/templates"/);
    expect(src).toMatch(/const xlsxOk = supportsXlsx\(domain\)/);
    // Copy strings use xlsxOk instead of isCoa for the file-input branches.
    expect(src).toMatch(/xlsxOk[\s\S]*upload a workbook \/ CSV file OR paste CSV content/);
    expect(src).toMatch(/xlsxOk[\s\S]*Unsupported file type\. Upload an \.xlsx workbook/);
    // TB auto-validates + redirects to the preview screen.
    expect(src).toMatch(/const isTb = domain === "OPENING_TRIAL_BALANCE"/);
    expect(src).toMatch(/else if \(isTb\)/);
    expect(src).toMatch(/\(isCoa \|\| isTb\) && createdBatchId/);
  });

  it("end-to-end: uploading the real Jonas .xlsx via parseXlsxRows + createBatch + validateBatch reaches the preview state", async () => {
    // Proves the wire (parser → createBatch → validateBatch) that
    // the server action drives. The server action itself needs a
    // Next.js request context to run, so this test exercises the
    // same steps directly against the lib.
    const club = await bootstrapAccountingClub("TB-UI-E2E");
    const p = await adminFor(club.id);
    const buf = fs.readFileSync(FIXTURE_XLSX);
    const rows = await parseXlsxRows(buf, { domain: "OPENING_TRIAL_BALANCE" });
    expect(rows.length).toBe(237);
    const batch = await createBatch(p, {
      clubId: club.id,
      domain: "OPENING_TRIAL_BALANCE",
      rows,
      source: "XLSX",
      fileName: "April 26 Trial Balance.xlsx",
    });
    const validated = await validateBatch(p, batch.id);
    // Reaches the VALIDATED status — batch is in "preview" state.
    expect(validated.status).toBe("VALIDATED");
    expect(validated.totalRows).toBe(237);
    // dryRunAt is stamped → the detail page renders the preview panel.
    expect(validated.dryRunAt).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 8. Founder rule 2026-06-30 v14.3 — auto-detect the report period
// ---------------------------------------------------------------------------
describe("v14.3 — Trial Balance period auto-detection", () => {
  it("detectTrialBalancePeriod extracts the last day of the month for common Jonas titles", () => {
    expect(detectTrialBalancePeriod([["Trial Balance for May, 2026"]])).toEqual(new Date(Date.UTC(2026, 4, 31)));
    expect(detectTrialBalancePeriod([["Trial Balance for April, 2026"]])).toEqual(new Date(Date.UTC(2026, 3, 30)));
    expect(detectTrialBalancePeriod([["Trial Balance for February, 2025"]])).toEqual(new Date(Date.UTC(2025, 1, 28)));
    expect(detectTrialBalancePeriod([["Trial Balance for February, 2024"]])).toEqual(new Date(Date.UTC(2024, 1, 29))); // leap
    expect(detectTrialBalancePeriod([["Trial Balance for December, 2026"]])).toEqual(new Date(Date.UTC(2026, 11, 31)));
    // Accepts abbreviations + case variants.
    expect(detectTrialBalancePeriod([["TRIAL BALANCE FOR MAY 2026"]])).toEqual(new Date(Date.UTC(2026, 4, 31)));
    expect(detectTrialBalancePeriod([["Trial Balance for Apr, 2026"]])).toEqual(new Date(Date.UTC(2026, 3, 30)));
    // Scans multiple rows (pre-header layout).
    expect(detectTrialBalancePeriod([
      ["01 - Silver Springs Golf & Country Club"],
      ["Trial Balance for May, 2026"],
      ["Closing Period Balances"],
    ])).toEqual(new Date(Date.UTC(2026, 4, 31)));
    // Returns null when no title row matches — commit will require manual entry.
    expect(detectTrialBalancePeriod([["Some other title"], ["No dates here"]])).toBeNull();
    expect(detectTrialBalancePeriod([])).toBeNull();
  });

  it("parseTrialBalanceXlsx: pre-header fixture (title on row 2, headers on row 4) → detects 2026-05-31 + parses data rows", async () => {
    const buf = fs.readFileSync(FIXTURE_PREHEADER);
    const { rows, detectedAsOfDate } = await parseTrialBalanceXlsx(buf);
    // Period: last day of May 2026 = 2026-05-31.
    expect(detectedAsOfDate?.toISOString().slice(0, 10)).toBe("2026-05-31");
    // Data rows land canonical, header rows dropped.
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ accountNumber: "1000", description: "Petty Cash", debit: "500" });
    expect(rows[1]).toMatchObject({ accountNumber: "2000", description: "Accounts Payable", credit: "-500" });
  });

  it("parseTrialBalanceCsv: title row + blank row + header row + data rows", () => {
    const csv = [
      `"01 - Silver Springs Golf & Country Club"`,
      `"Trial Balance for May, 2026"`,
      ``,
      `"G/L Account\nCode","G/L Account\nDescription","Closing Bal\nDebit","Closing Bal\nCredit"`,
      `1000,Petty Cash,500.00,0`,
      `2000,Accounts Payable,0,-500.00`,
    ].join("\n");
    const { rows, detectedAsOfDate } = parseTrialBalanceCsv(csv);
    expect(detectedAsOfDate?.toISOString().slice(0, 10)).toBe("2026-05-31");
    expect(rows.length).toBe(2);
    expect(rows[0].accountNumber).toBe("1000");
    expect(rows[1].credit).toBe("-500.00");
  });

  it("parseTrialBalanceXlsx: the older row-1-header April fixture (no title row) → detectedAsOfDate is null", async () => {
    const buf = fs.readFileSync(FIXTURE_XLSX);
    const { rows, detectedAsOfDate } = await parseTrialBalanceXlsx(buf);
    expect(detectedAsOfDate).toBeNull();
    expect(rows.length).toBe(237);
  });
});

describe("v14.3 — Trial Balance commit posts a POSTED journal on the detected date", () => {
  async function tbClub(name: string) {
    const club = await bootstrapAccountingClub(name);
    // Ensure the fiscal year covering the target period exists.
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    return club;
  }

  it("auto-detected date → commit posts a POSTED JournalEntry dated 2026-05-31; trialBalance() at that date shows imported balances", async () => {
    const club = await tbClub("TB-Commit-Detected");
    const p = await controllerFor(club.id);
    const buf = fs.readFileSync(FIXTURE_PREHEADER);
    const { rows, detectedAsOfDate } = await parseTrialBalanceXlsx(buf);
    expect(detectedAsOfDate?.toISOString().slice(0, 10)).toBe("2026-05-31");
    const batch = await createBatch(p, {
      clubId: club.id, domain: "OPENING_TRIAL_BALANCE", rows,
      source: "XLSX", fileName: "may.xlsx",
      options: { asOfDate: detectedAsOfDate!.toISOString() },
    });
    await validateBatch(p, batch.id);
    // Confirm the batch's optionsJson round-trips the date.
    const validated = await db().importBatch.findFirstOrThrow({ where: { id: batch.id } });
    expect(readTrialBalanceAsOfDate(validated.optionsJson)?.toISOString().slice(0, 10)).toBe("2026-05-31");
    // Commit.
    const committed = await commitBatch(p, { batchId: batch.id });
    expect(committed.status).toBe("COMMITTED");
    // Journal entry landed on the correct date.
    const je = await db().journalEntry.findFirstOrThrow({
      where: { clubId: club.id, sourceEntityType: "ImportBatch", sourceEntityId: batch.id },
      include: { lines: true },
    });
    expect(je.status).toBe("POSTED");
    expect(je.entryDate.toISOString().slice(0, 10)).toBe("2026-05-31");
    expect(je.lines.length).toBe(2);
    // Debits === credits (balanced) — 500 / 500.
    expect(Number(je.totalDebits)).toBe(500);
    expect(Number(je.totalCredits)).toBe(500);
    // Finance → Trial Balance report at 2026-05-31 shows the imported balances.
    const tb = await trialBalance(club.id, new Date("2026-05-31T00:00:00.000Z"));
    expect(tb.isBalanced).toBe(true);
    // Petty Cash 1000 has a debit balance of 500; AP 2000 has a credit balance of 500.
    const petty = tb.rows.find((r) => r.accountNumber === "1000");
    const ap = tb.rows.find((r) => r.accountNumber === "2000");
    expect(petty).toBeTruthy();
    expect(ap).toBeTruthy();
    expect(Number(petty!.debit)).toBe(500);
    expect(Number(ap!.credit)).toBe(500);
  });

  it("commit REJECTS when as-of date is missing (row-1-header fallback requires manual entry)", async () => {
    const club = await tbClub("TB-Commit-NoDate");
    const p = await controllerFor(club.id);
    // Use the April fixture (no title row) — parser returns null.
    const buf = fs.readFileSync(FIXTURE_XLSX);
    const { rows, detectedAsOfDate } = await parseTrialBalanceXlsx(buf);
    expect(detectedAsOfDate).toBeNull();
    // Seed every account so validateBatch passes cleanly.
    const seen = new Set(rows.map((r) => String(r.accountNumber).replace(/\.0+$/, "")));
    const existing = new Set(
      (await db().account.findMany({ where: { clubId: club.id }, select: { accountNumber: true } }))
        .map((a) => a.accountNumber),
    );
    const { createAccount } = await import("@/lib/accounting/coa");
    for (const num of seen) {
      if (existing.has(num)) continue;
      const row = rows.find((r) => String(r.accountNumber).replace(/\.0+$/, "") === num);
      const isCredit = Math.abs(Number(row?.credit ?? 0)) > 0;
      await createAccount(p, club.id, { accountNumber: num, name: String(row?.description ?? `Acct ${num}`), type: isCredit ? "LIABILITY" : "ASSET" });
    }
    const batch = await createBatch(p, {
      clubId: club.id, domain: "OPENING_TRIAL_BALANCE", rows,
      source: "XLSX", fileName: "april.xlsx",
      // NO options.asOfDate → simulates the fallback state.
    });
    await validateBatch(p, batch.id);
    await expect(commitBatch(p, { batchId: batch.id })).rejects.toThrow(/Trial Balance as-of date is not set/);
  });

  it("setTrialBalanceAsOfDate: manual entry → commit succeeds on the entered date", async () => {
    const club = await tbClub("TB-Manual-Then-Commit");
    const p = await controllerFor(club.id);
    const batch = await createBatch(p, {
      clubId: club.id, domain: "OPENING_TRIAL_BALANCE",
      rows: [
        { accountNumber: "1000", description: "Petty Cash",       debit: "500.00", credit: "0" },
        { accountNumber: "2000", description: "Accounts Payable", debit: "0",     credit: "-500.00" },
      ],
      source: "CSV", fileName: "no-title.csv",
    });
    await validateBatch(p, batch.id);
    // First commit attempt should fail — no as-of date yet.
    await expect(commitBatch(p, { batchId: batch.id })).rejects.toThrow(/as-of date is not set/);
    // Operator enters the date manually.
    await setTrialBalanceAsOfDate(p, batch.id, new Date("2026-04-30T00:00:00.000Z"));
    // Second commit succeeds.
    const committed = await commitBatch(p, { batchId: batch.id });
    expect(committed.status).toBe("COMMITTED");
    const je = await db().journalEntry.findFirstOrThrow({
      where: { clubId: club.id, sourceEntityId: batch.id },
    });
    expect(je.entryDate.toISOString().slice(0, 10)).toBe("2026-04-30");
  });
});

// ---------------------------------------------------------------------------
// 9. Founder rule 2026-06-30 v14.5 — TB batch lifecycle:
//    supersede on new commit, void with reversal, delete cleanup.
// ---------------------------------------------------------------------------
describe("v14.5 — Trial Balance batch lifecycle: supersede + void + report accuracy", () => {
  async function commitTb(
    p: Awaited<ReturnType<typeof principalFor>>,
    clubId: string,
    asOfDate: Date,
    rows: Array<{ accountNumber: string; description: string; debit: string; credit: string }>,
    fileName = `tb-${asOfDate.toISOString().slice(0, 10)}.csv`,
  ) {
    const b = await createBatch(p, {
      clubId, domain: "OPENING_TRIAL_BALANCE", rows,
      source: "CSV", fileName,
      options: { asOfDate: asOfDate.toISOString() },
    });
    await validateBatch(p, b.id);
    return commitBatch(p, { batchId: b.id });
  }

  it("second commit supersedes the first: prior batch marked SUPERSEDED + prior JE reversed", async () => {
    const club = await bootstrapAccountingClub("TB-Supersede");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    // First commit — 500 Petty Cash / 500 AP.
    const first = await commitTb(p, club.id, new Date("2026-04-30T00:00:00.000Z"), [
      { accountNumber: "1000", description: "Petty Cash",       debit: "500.00", credit: "0" },
      { accountNumber: "2000", description: "Accounts Payable", debit: "0",     credit: "-500.00" },
    ]);
    expect(first.status).toBe("COMMITTED");
    expect(first.supersededAt).toBeNull();
    expect(first.voidedAt).toBeNull();
    // Second commit — 750 / 750. Should supersede first.
    const second = await commitTb(p, club.id, new Date("2026-05-31T00:00:00.000Z"), [
      { accountNumber: "1000", description: "Petty Cash",       debit: "750.00", credit: "0" },
      { accountNumber: "2000", description: "Accounts Payable", debit: "0",     credit: "-750.00" },
    ]);
    expect(second.status).toBe("COMMITTED");
    const priorReloaded = await db().importBatch.findFirstOrThrow({ where: { id: first.id } });
    expect(priorReloaded.status).toBe("SUPERSEDED");
    expect(priorReloaded.supersededAt).toBeTruthy();
    expect(priorReloaded.supersededByBatchId).toBe(second.id);
    // Original JE + reversal JE both exist. Reversal is linked
    // via reversesId.
    const reversal = await db().journalEntry.findFirstOrThrow({
      where: { clubId: club.id, sourceEntityId: first.id, entryNumber: { endsWith: "-R" } },
    });
    expect(reversal.status).toBe("POSTED");
    expect(Number(reversal.totalDebits)).toBe(500);
    expect(Number(reversal.totalCredits)).toBe(500);
  });

  it("Finance Trial Balance report reflects ONLY the live commit (net of superseded + reversal)", async () => {
    const club = await bootstrapAccountingClub("TB-ReportLive");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    await commitTb(p, club.id, new Date("2026-04-30T00:00:00.000Z"), [
      { accountNumber: "1000", description: "Petty Cash",       debit: "500.00", credit: "0" },
      { accountNumber: "2000", description: "Accounts Payable", debit: "0",     credit: "-500.00" },
    ]);
    await commitTb(p, club.id, new Date("2026-05-31T00:00:00.000Z"), [
      { accountNumber: "1000", description: "Petty Cash",       debit: "750.00", credit: "0" },
      { accountNumber: "2000", description: "Accounts Payable", debit: "0",     credit: "-750.00" },
    ]);
    // At 2026-05-31, the live balance should be 750 / 750 —
    // NOT 1250 / 1250 (which would happen if both batches
    // stacked).
    const tb = await trialBalance(club.id, new Date("2026-05-31T00:00:00.000Z"));
    const petty = tb.rows.find((r) => r.accountNumber === "1000");
    const ap = tb.rows.find((r) => r.accountNumber === "2000");
    expect(Number(petty!.debit)).toBe(750);
    expect(Number(ap!.credit)).toBe(750);
    expect(tb.isBalanced).toBe(true);
  });

  it("voidCommittedBatch on the LIVE batch reverses the ledger + flips status to VOIDED", async () => {
    const club = await bootstrapAccountingClub("TB-VoidLive");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    const committed = await commitTb(p, club.id, new Date("2026-04-30T00:00:00.000Z"), [
      { accountNumber: "1000", description: "Petty Cash",       debit: "500.00", credit: "0" },
      { accountNumber: "2000", description: "Accounts Payable", debit: "0",     credit: "-500.00" },
    ]);
    const voided = await voidCommittedBatch(p, committed.id, "wrong period, needed to re-import");
    expect(voided.status).toBe("VOIDED");
    expect(voided.voidedAt).toBeTruthy();
    expect(voided.voidReason).toBe("wrong period, needed to re-import");
    // Reversal JE exists.
    const reversal = await db().journalEntry.findFirst({
      where: { clubId: club.id, sourceEntityId: committed.id, entryNumber: { endsWith: "-R" } },
    });
    expect(reversal).toBeTruthy();
    // Trial Balance is now flat — every debit/credit netted out
    // to zero per account (the original + reversal cancel).
    const tb = await trialBalance(club.id, new Date("2026-04-30T00:00:00.000Z"));
    const petty = tb.rows.find((r) => r.accountNumber === "1000");
    const ap = tb.rows.find((r) => r.accountNumber === "2000");
    expect(Number(petty?.debit ?? 0)).toBe(0);
    expect(Number(petty?.credit ?? 0)).toBe(0);
    expect(Number(ap?.debit ?? 0)).toBe(0);
    expect(Number(ap?.credit ?? 0)).toBe(0);
    expect(tb.isBalanced).toBe(true);
  });

  it("voidCommittedBatch on a SUPERSEDED batch does NOT double-reverse (ledger already zeroed)", async () => {
    const club = await bootstrapAccountingClub("TB-VoidSuperseded");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    const first = await commitTb(p, club.id, new Date("2026-04-30T00:00:00.000Z"), [
      { accountNumber: "1000", description: "Petty Cash",       debit: "500.00", credit: "0" },
      { accountNumber: "2000", description: "Accounts Payable", debit: "0",     credit: "-500.00" },
    ]);
    await commitTb(p, club.id, new Date("2026-05-31T00:00:00.000Z"), [
      { accountNumber: "1000", description: "Petty Cash",       debit: "750.00", credit: "0" },
      { accountNumber: "2000", description: "Accounts Payable", debit: "0",     credit: "-750.00" },
    ]);
    // First batch is now SUPERSEDED — its JE has already been
    // reversed at supersede time. Voiding it should flip status
    // + record reason WITHOUT posting a second reversal.
    const reversalsBefore = await db().journalEntry.count({
      where: { clubId: club.id, sourceEntityId: first.id, entryNumber: { endsWith: "-R" } },
    });
    expect(reversalsBefore).toBe(1);
    const voided = await voidCommittedBatch(p, first.id, "housekeeping — old test data");
    expect(voided.status).toBe("VOIDED");
    const reversalsAfter = await db().journalEntry.count({
      where: { clubId: club.id, sourceEntityId: first.id, entryNumber: { endsWith: "-R" } },
    });
    expect(reversalsAfter).toBe(1); // No second reversal.
  });

  it("voidCommittedBatch rejects when reason is empty", async () => {
    const club = await bootstrapAccountingClub("TB-VoidNoReason");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    const committed = await commitTb(p, club.id, new Date("2026-04-30T00:00:00.000Z"), [
      { accountNumber: "1000", description: "Petty Cash", debit: "500.00", credit: "0" },
      { accountNumber: "2000", description: "AP",         debit: "0",     credit: "-500.00" },
    ]);
    await expect(voidCommittedBatch(p, committed.id, "  ")).rejects.toThrow(/reason is required/i);
  });

  it("deleteBatch of a SUPERSEDED TB batch succeeds (ledger already reversed → safe cleanup)", async () => {
    const club = await bootstrapAccountingClub("TB-DeleteSuperseded");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    const first = await commitTb(p, club.id, new Date("2026-04-30T00:00:00.000Z"), [
      { accountNumber: "1000", description: "Petty Cash", debit: "500.00", credit: "0" },
      { accountNumber: "2000", description: "AP",         debit: "0",     credit: "-500.00" },
    ]);
    await commitTb(p, club.id, new Date("2026-05-31T00:00:00.000Z"), [
      { accountNumber: "1000", description: "Petty Cash", debit: "750.00", credit: "0" },
      { accountNumber: "2000", description: "AP",         debit: "0",     credit: "-750.00" },
    ]);
    // Delete the superseded batch — should succeed.
    await deleteBatch(p, first.id);
    const gone = await db().importBatch.findUnique({ where: { id: first.id } });
    expect(gone).toBeNull();
    // Live batch's balances still intact.
    const tb = await trialBalance(club.id, new Date("2026-05-31T00:00:00.000Z"));
    const petty = tb.rows.find((r) => r.accountNumber === "1000");
    expect(Number(petty!.debit)).toBe(750);
  });

  it("deleteBatch of a LIVE (COMMITTED + not superseded / voided) TB batch is REJECTED — must void first", async () => {
    const club = await bootstrapAccountingClub("TB-NoDeleteLive");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    const live = await commitTb(p, club.id, new Date("2026-04-30T00:00:00.000Z"), [
      { accountNumber: "1000", description: "Petty Cash", debit: "500.00", credit: "0" },
      { accountNumber: "2000", description: "AP",         debit: "0",     credit: "-500.00" },
    ]);
    await expect(deleteBatch(p, live.id)).rejects.toThrow(/audit history/i);
  });

  // -------------------------------------------------------------
  // Founder rule 2026-06-30 v14.6 — Trial Balance report tolerance
  // -------------------------------------------------------------
  it("v14.6 — exact equal totals: isBalanced=true, no false out-of-balance", async () => {
    const club = await bootstrapAccountingClub("TB-Report-Exact");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    // Plant balances via a TB commit — 29,656,391.67 each side, matching the founder's April screenshot.
    await commitTb(p, club.id, new Date("2026-04-30T00:00:00.000Z"), [
      { accountNumber: "1000", description: "Petty Cash",       debit: "29656391.67", credit: "0" },
      { accountNumber: "2000", description: "Accounts Payable", debit: "0",           credit: "-29656391.67" },
    ]);
    const tb = await trialBalance(club.id, new Date("2026-04-30T00:00:00.000Z"));
    expect(tb.totalDebit.toFixed(2)).toBe("29656391.67");
    expect(tb.totalCredit.toFixed(2)).toBe("29656391.67");
    expect(tb.isBalanced).toBe(true);
  });

  // Plant an intentional-imbalance ledger directly (bypassing the
  // v14 TB commit validator's balance guard) so we can test the
  // v14.6 REPORT tolerance in isolation.
  async function plantLedger(
    clubId: string,
    entryDate: Date,
    postedByUserId: string,
    lines: Array<{ accountNumber: string; debit: number; credit: number }>,
  ) {
    const period = await db().fiscalPeriod.findFirstOrThrow({
      where: { fiscalYear: { clubId }, startDate: { lte: entryDate }, endDate: { gte: entryDate } },
    });
    const accts = await db().account.findMany({
      where: { clubId, accountNumber: { in: lines.map((l) => l.accountNumber) } },
      select: { id: true, accountNumber: true },
    });
    const idByNum = new Map(accts.map((a) => [a.accountNumber, a.id]));
    const totalDebit = lines.reduce((s, l) => s + l.debit, 0);
    const totalCredit = lines.reduce((s, l) => s + l.credit, 0);
    const je = await db().journalEntry.create({
      data: {
        clubId,
        entryNumber: `TB-TEST-${Math.random().toString(36).slice(2, 8)}`,
        entryDate, periodId: period.id,
        description: "planted for tolerance test",
        status: "POSTED",
        postedAt: new Date(),
        postedByUserId,
        totalDebits: totalDebit,
        totalCredits: totalCredit,
      },
    });
    await db().journalEntryLine.createMany({
      data: lines.map((l, i) => ({
        clubId, journalEntryId: je.id, lineNumber: i + 1,
        accountId: idByNum.get(l.accountNumber)!,
        debit: l.debit, credit: l.credit,
      })),
    });
  }

  it("v14.6 — one-cent variance is still marked BALANCED (tolerance = $0.01)", async () => {
    const club = await bootstrapAccountingClub("TB-Report-OneCent");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    await plantLedger(club.id, new Date("2026-04-30T00:00:00.000Z"), p.id, [
      { accountNumber: "1000", debit: 500.00, credit: 0 },
      { accountNumber: "2000", debit: 0,     credit: 499.99 }, // 1-cent short
    ]);
    const tb = await trialBalance(club.id, new Date("2026-04-30T00:00:00.000Z"));
    expect(tb.totalDebit.minus(tb.totalCredit).abs().toFixed(2)).toBe("0.01");
    expect(tb.isBalanced).toBe(true);
  });

  it("v14.6 — variance above the $0.01 tolerance is flagged out-of-balance", async () => {
    const club = await bootstrapAccountingClub("TB-Report-TrueDiff");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    await plantLedger(club.id, new Date("2026-04-30T00:00:00.000Z"), p.id, [
      { accountNumber: "1000", debit: 500.00, credit: 0 },
      { accountNumber: "2000", debit: 0,     credit: 499.98 }, // 2-cent short
    ]);
    const tb = await trialBalance(club.id, new Date("2026-04-30T00:00:00.000Z"));
    expect(tb.totalDebit.minus(tb.totalCredit).abs().toFixed(2)).toBe("0.02");
    expect(tb.isBalanced).toBe(false);
  });

  it("v14.6 — TB report page renders green 'balanced' banner when isBalanced + red banner otherwise", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/app/admin/reports/trial-balance/page.tsx"),
      "utf8",
    );
    expect(src).toMatch(/Trial balance is balanced\./);
    expect(src).toMatch(/data-testid="tb-report-balanced-banner"/);
    expect(src).toMatch(/data-testid="tb-report-imbalance-banner"/);
    // The negation branch fires ONLY when !isBalanced.
    expect(src).toMatch(/tb\.isBalanced \?/);
  });

  it("v14.6 — reports.ts uses a tolerance comparison (not exact .equals()) on the totals", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/accounting/reports.ts"),
      "utf8",
    );
    // Rounds to cents + uses .lte with a tolerance string, mirroring the balance-sheet check.
    expect(src).toMatch(/toDecimalPlaces\(2\)/);
    expect(src).toMatch(/\.lte\(toMoney\("0\.01"\)\)/);
    // The old exact-equals check is gone from the trial-balance path.
    expect(src).not.toMatch(/isBalanced:\s*totalDebit\.equals\(totalCredit\)/);
  });

  // ---------------------------------------------------------------
  // Founder rule 2026-07-01 v14.7 — imported TB flows into Income Statement
  // ---------------------------------------------------------------
  it("v14.7 — imported Trial Balance with P&L accounts populates Balance Sheet + Trial Balance + Income Statement (Jan 1 → Apr 30)", async () => {
    const club = await bootstrapAccountingClub("TB-IS-Flow");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    // Full-picture TB: Assets, Liabilities, Equity, Revenue,
    // Cost of Sales, and Operating Expenses. Jonas convention:
    // credits are stored as negative numbers → the parser takes
    // the absolute value.
    const asOf = new Date("2026-04-30T00:00:00.000Z");
    await commitTb(p, club.id, asOf, [
      // Balance-sheet accounts (verified seeded in DEFAULT_ACCOUNTS).
      { accountNumber: "1000", description: "Cash & Bank",              debit: "500000.00", credit: "0" },
      { accountNumber: "2000", description: "Accounts Payable",         debit: "0",         credit: "-200000.00" },
      { accountNumber: "3100", description: "Retained Earnings",        debit: "0",         credit: "-140000.00" },
      // P&L — REVENUE (IS_MEMBERSHIP_DUES + IS_GREEN_FEES).
      { accountNumber: "4000", description: "Membership Dues",          debit: "0",         credit: "-500000.00" },
      { accountNumber: "4100", description: "Greens & Guest Fees",      debit: "0",         credit: "-120000.00" },
      // P&L — COGS (IS_COGS_FOOD + IS_COGS_MERCHANDISE).
      { accountNumber: "5000", description: "Cost of Sales — F&B",      debit: "80000.00",  credit: "0" },
      { accountNumber: "5100", description: "Cost of Sales — Pro Shop", debit: "40000.00",  credit: "0" },
      // P&L — OPEX (IS_PAYROLL + IS_SMALL_TOOLS).
      { accountNumber: "6000", description: "Course Salaries & Wages",  debit: "260000.00", credit: "0" },
      { accountNumber: "6010", description: "Course Supplies",          debit: "80000.00",  credit: "0" },
    ]);

    // === Trial Balance ===
    const tb = await trialBalance(club.id, asOf);
    expect(tb.isBalanced).toBe(true);
    expect(Number(tb.totalDebit)).toBeGreaterThan(0);
    expect(Number(tb.totalCredit)).toBeGreaterThan(0);
    const revRow = tb.rows.find((r) => r.accountNumber === "4000");
    expect(Number(revRow!.credit)).toBe(500000);

    // === Balance Sheet ===
    const bs = await balanceSheet(club.id, asOf);
    expect(bs.isBalanced).toBe(true);
    expect(Number(bs.totalAssets)).toBeGreaterThan(0);

    // === Income Statement — window INCLUDES the TB as-of date ===
    // v14.6 bug: revenue/cogs/opex were all $0 because the filter
    // matched legacy keys that don't exist in the canonical
    // taxonomy. v14.7 fix: filter by accountType + `IS_COGS_`
    // prefix instead.
    const isIn = await incomeStatement(club.id, new Date("2026-01-01T00:00:00.000Z"), asOf);
    expect(Number(isIn.totalRevenue)).toBe(500000 + 120000);
    expect(Number(isIn.totalCogs)).toBe(80000 + 40000);
    expect(Number(isIn.totalOpex)).toBe(260000 + 80000);
    expect(Number(isIn.grossMargin)).toBe(500000 + 120000 - 80000 - 40000);
    expect(Number(isIn.netIncome)).toBe(500000 + 120000 - 80000 - 40000 - 260000 - 80000);

    // === Income Statement — window ends BEFORE the TB as-of date ===
    // No activity should have been posted before 2026-04-30, so the report is zero.
    const isBefore = await incomeStatement(club.id, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-04-29T00:00:00.000Z"));
    expect(Number(isBefore.totalRevenue)).toBe(0);
    expect(Number(isBefore.totalCogs)).toBe(0);
    expect(Number(isBefore.totalOpex)).toBe(0);
    expect(Number(isBefore.netIncome)).toBe(0);
  });

  it("v14.7 — revenue nodes contain the actual FS Groups from the taxonomy (IS_MEMBERSHIP_DUES / IS_GREEN_FEES) — not the legacy IS_REVENUE_* prefix", async () => {
    const club = await bootstrapAccountingClub("TB-IS-Classification");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    const asOf = new Date("2026-04-30T00:00:00.000Z");
    await commitTb(p, club.id, asOf, [
      { accountNumber: "1000", description: "Bank",            debit: "100.00", credit: "0" },
      { accountNumber: "4000", description: "Membership Dues", debit: "0",     credit: "-100.00" },
    ]);
    const is = await incomeStatement(club.id, new Date("2026-01-01T00:00:00.000Z"), asOf);
    // Revenue nodes exist + carry the IS_MEMBERSHIP_DUES key
    // (the RIGHT canonical key), not a nonexistent IS_REVENUE_*.
    const membership = is.revenue.find((n) => n.key === "IS_MEMBERSHIP_DUES");
    expect(membership).toBeTruthy();
    expect(is.revenue.every((n) => !n.key.startsWith("IS_REVENUE_"))).toBe(true);
  });

  it("COA committed batches remain audit-locked (non-regression on the v14.5 delete guard)", async () => {
    const club = await bootstrapAccountingClub("TB-COANonRegression");
    const p = await controllerFor(club.id);
    // Create a fake COMMITTED COA batch (no journal side-effects
    // needed for the guard test — the delete branch is what we
    // care about).
    const coa = await db().importBatch.create({
      data: {
        clubId: club.id,
        domain: "COA",
        source: "CSV",
        status: "COMMITTED",
        fileName: "coa.csv",
        totalRows: 0, validRows: 0, errorRows: 0,
        createdByUserId: p.id,
      },
    });
    await expect(deleteBatch(p, coa.id)).rejects.toThrow(/audit history/i);
  });
});

describe("v14.5 — page source-contract: lifecycle badges + as-of column + void modal", () => {
  const PAGE = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/imports/page.tsx"),
    "utf8",
  );
  const ACTIONS = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/imports/_actions.ts"),
    "utf8",
  );

  it("batch list has an As-of column showing the persisted TB period", () => {
    expect(PAGE).toMatch(/<th>As-of<\/th>/);
    expect(PAGE).toMatch(/data-testid=\{`batch-asof-\$\{b\.id\}`\}/);
    expect(PAGE).toMatch(/readTrialBalanceAsOfDate\(b\.optionsJson\)/);
  });

  it("Live / Superseded / Voided lifecycle badge renders for TB batches", () => {
    expect(PAGE).toMatch(/data-testid=\{`tb-lifecycle-\$\{b\.id\}`\}/);
    expect(PAGE).toMatch(/tbLifecycle === "LIVE"/);
    expect(PAGE).toMatch(/tbLifecycle === "SUPERSEDED"/);
    expect(PAGE).toMatch(/tbLifecycle === "VOIDED"/);
  });

  it("action column: LIVE TB → Void link; SUPERSEDED/VOIDED → Delete; other COMMITTED → Audit-locked", () => {
    expect(PAGE).toMatch(/data-testid=\{`void-batch-\$\{b\.id\}`\}/);
    expect(PAGE).toMatch(/isTb && tbLifecycle === "LIVE"/);
    expect(PAGE).toMatch(/data-testid=\{`delete-batch-committed-hint-\$\{b\.id\}`\}/);
  });

  it("void-confirmation modal is URL-driven (?void=<id>) + carries the founder's exact copy + requires a reason", () => {
    expect(PAGE).toMatch(/data-testid="tb-void-modal"/);
    expect(PAGE).toMatch(/searchParams\.void/);
    expect(PAGE).toMatch(/This will remove the ledger impact of this imported Trial Balance batch\. Continue\?/);
    // Reason field is required + has minLength=3.
    expect(PAGE).toMatch(/data-testid="tb-void-reason"/);
    expect(PAGE).toMatch(/minLength=\{3\}/);
    expect(PAGE).toMatch(/data-testid="tb-void-confirm"/);
  });

  it("_actions.ts exports voidBatchAction wired to voidCommittedBatch", () => {
    expect(ACTIONS).toMatch(/export async function voidBatchAction/);
    expect(ACTIONS).toMatch(/voidCommittedBatch\(principal, batchId, reason\)/);
    expect(ACTIONS).toMatch(/reason is required/i);
  });
});
