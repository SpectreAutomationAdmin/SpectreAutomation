// COA-RESET-1 · Preflight classification & script contract tests.
//
// Fixup 3 (2026-09-29) — covers the ten test scenarios in the founder's
// authorization pack:
//   1. PayrollBatch self-reference chain
//   2. PayrollOpeningBalanceComponent → PayrollComponent (NOACT)
//   3. EmployeeRecurringPayrollComponent → PayrollComponent (NOACT)
//   4. BudgetLine → Account (RESTRICT)
//   5. ForecastLine → Account (RESTRICT)
//   6. A restrictive dependency discovered by the preflight
//   7. CASCADE dependency accepted by the preflight
//   8. Unhandled live RESTRICT dependency causes preflight abort
//   9. Preflight abort ⇒ zero mutation (script structure invariant)
//  10. Tenant isolation (every destructive op is Coulee-scoped)
// Plus a multi-level dependency chain sanity check.
//
// Pure classifier tests use fabricated FK rows so no database is needed.
// Script-shape tests read the execute script and assert structural
// invariants (order of steps, clubId scoping, preflight before writes).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it, expect } from "vitest";

import {
  TARGET_TABLES,
  KNOWN_HANDLING,
  classifyRow,
  buildPreflightReport,
  formatPreflightReport,
} from "../scripts/lib/coa-reset-1-preflight.mjs";

// Read the destructive script once for structural assertions.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(__dirname, "..", "scripts", "coa-reset-1-coulee-execute.mjs");
const SCRIPT = readFileSync(SCRIPT_PATH, "utf8");

// A tiny factory keeps every test's raw FK row minimal + readable.
function fk(overrides: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    constraint_name: overrides.constraint_name ?? "fk_test",
    source_table: overrides.source_table ?? "X",
    source_col: overrides.source_col ?? "y",
    target_table: overrides.target_table ?? "Z",
    target_col: overrides.target_col ?? "id",
    on_delete: overrides.on_delete ?? "RESTRICT",
    live_rows: overrides.live_rows ?? 0,
    ...overrides,
  };
}

describe("COA-RESET-1 · pure classification via classifyRow()", () => {
  it("(1) PayrollBatch self-refs — corrects/paired/reverses — classify as C (self-ref broken)", () => {
    for (const col of ["correctsPayrollBatchId", "pairedReversalBatchId", "reversesPayrollBatchId"]) {
      const c = classifyRow(fk({
        source_table: "PayrollBatch", source_col: col,
        target_table: "PayrollBatch", target_col: "id",
        on_delete: "RESTRICT", live_rows: 5,
      }));
      expect(c.strategy).toBe("C");
      expect(c.reason).toMatch(/self-ref/i);
    }
  });

  it("(2) PayrollOpeningBalanceComponent → PayrollComponent (NOACT) — classify as A", () => {
    const c = classifyRow(fk({
      source_table: "PayrollOpeningBalanceComponent", source_col: "sourceComponentId",
      target_table: "PayrollComponent", target_col: "id",
      on_delete: "NO ACTION", live_rows: 7,
    }));
    expect(c.strategy).toBe("A");
    expect(c.reason).toMatch(/step G-1/);
  });

  it("(3) EmployeeRecurringPayrollComponent → PayrollComponent (NOACT) — classify as A", () => {
    const c = classifyRow(fk({
      source_table: "EmployeeRecurringPayrollComponent", source_col: "componentId",
      target_table: "PayrollComponent", target_col: "id",
      on_delete: "NO ACTION", live_rows: 3,
    }));
    expect(c.strategy).toBe("A");
    expect(c.reason).toMatch(/step G/);
  });

  it("(4) BudgetLine → Account (RESTRICT) — classify as A even with zero live rows today", () => {
    const c = classifyRow(fk({
      source_table: "BudgetLine", source_col: "accountId",
      target_table: "Account", target_col: "id",
      on_delete: "RESTRICT", live_rows: 0,
    }));
    expect(c.strategy).toBe("A");
    expect(c.reason).toMatch(/BudgetLine deleted step B0/);
  });

  it("(5) ForecastLine → Account (RESTRICT) — classify as A", () => {
    const c = classifyRow(fk({
      source_table: "ForecastLine", source_col: "accountId",
      target_table: "Account", target_col: "id",
      on_delete: "RESTRICT", live_rows: 0,
    }));
    expect(c.strategy).toBe("A");
    expect(c.reason).toMatch(/ForecastLine deleted step B0/);
  });

  it("(7) CASCADE FK — classifyRow returns N/A (not restrictive, no allowlist required)", () => {
    const c = classifyRow(fk({
      source_table: "PayrollBatchEmployee", source_col: "batchId",
      target_table: "PayrollBatch", target_col: "id",
      on_delete: "CASCADE", live_rows: 55,
    }));
    expect(c.strategy).toBe("N/A");
    expect(c.reason).toMatch(/CASCADE/);
  });

  it("(8a) Unhandled live RESTRICT → UNHANDLED", () => {
    const c = classifyRow(fk({
      source_table: "UnknownChildTable", source_col: "someId",
      target_table: "Account", target_col: "id",
      on_delete: "RESTRICT", live_rows: 3,
    }));
    expect(c.strategy).toBe("UNHANDLED");
    expect(c.reason).toMatch(/no explicit handling/i);
  });

  it("(8b) Unknown FK with ZERO live rows — auto-D, does NOT abort", () => {
    const c = classifyRow(fk({
      source_table: "UnknownChildTable", source_col: "someId",
      target_table: "Account", target_col: "id",
      on_delete: "RESTRICT", live_rows: 0,
    }));
    expect(c.strategy).toBe("D");
    expect(c.reason).toMatch(/auto-D/);
  });

  it("SET NULL / SET DEFAULT — classifier returns N/A (db-handled)", () => {
    for (const del of ["SET NULL", "SET DEFAULT"]) {
      const c = classifyRow(fk({ on_delete: del, live_rows: 100 }));
      expect(c.strategy).toBe("N/A");
    }
  });
});

describe("COA-RESET-1 · aggregate report via buildPreflightReport()", () => {
  const OK_ROWS = [
    fk({ source_table: "APInvoiceLine", source_col: "expenseAccountId", target_table: "Account", on_delete: "RESTRICT", live_rows: 1 }),
    fk({ source_table: "BankAccount",   source_col: "glAccountId",      target_table: "Account", on_delete: "RESTRICT", live_rows: 1 }),
    fk({ source_table: "PayrollBatch",  source_col: "correctsPayrollBatchId", target_table: "PayrollBatch", on_delete: "RESTRICT", live_rows: 4 }),
    fk({ source_table: "BudgetLine",    source_col: "accountId",        target_table: "Account", on_delete: "RESTRICT", live_rows: 0 }),
    fk({ source_table: "PayrollBatchEmployee", source_col: "batchId",   target_table: "PayrollBatch", on_delete: "CASCADE",  live_rows: 55 }),
    fk({ source_table: "Vendor",        source_col: "defaultExpenseAccountId", target_table: "Account", on_delete: "SET NULL", live_rows: 1 }),
  ];

  it("(6) restrictive dependency IS surfaced by the report — appears in classifications", () => {
    const report = buildPreflightReport(OK_ROWS);
    const restrictive = report.classifications.map(c => `${c.source_table}.${c.source_col}`);
    expect(restrictive).toContain("PayrollBatch.correctsPayrollBatchId");
    expect(restrictive).toContain("APInvoiceLine.expenseAccountId");
    expect(restrictive).toContain("BudgetLine.accountId");
  });

  it("(7) CASCADE + SET NULL rows are bucketed separately from restrictive classifications", () => {
    const report = buildPreflightReport(OK_ROWS);
    expect(report.cascade.map((r: { source_table: string }) => r.source_table)).toContain("PayrollBatchEmployee");
    expect(report.setnull.map((r: { source_table: string }) => r.source_table)).toContain("Vendor");
    // CASCADE + SET NULL rows do NOT appear in restrictive classifications
    const restrictive = report.classifications.map((c: { source_table: string; source_col: string }) => `${c.source_table}.${c.source_col}`);
    expect(restrictive).not.toContain("PayrollBatchEmployee.batchId");
    expect(restrictive).not.toContain("Vendor.defaultExpenseAccountId");
  });

  it("(8) unhandled live RESTRICT causes report.ok === false", () => {
    const rows = [
      ...OK_ROWS,
      fk({
        source_table: "NewChildTable", source_col: "accountId",
        target_table: "Account", target_col: "id",
        on_delete: "RESTRICT", live_rows: 12,
      }),
    ];
    const report = buildPreflightReport(rows);
    expect(report.ok).toBe(false);
    expect(report.unhandledLive.map(u => u.source_table)).toContain("NewChildTable");
  });

  it("all-handled report — report.ok === true", () => {
    const report = buildPreflightReport(OK_ROWS);
    expect(report.ok).toBe(true);
    expect(report.unhandledLive).toEqual([]);
  });

  it("formatPreflightReport shows ABORT banner for unhandled + PASS banner otherwise", () => {
    const failing = buildPreflightReport([
      fk({ source_table: "NewChildTable", source_col: "accountId", target_table: "Account", on_delete: "RESTRICT", live_rows: 1 }),
    ]);
    expect(formatPreflightReport(failing)).toContain("PREFLIGHT ABORT");

    const passing = buildPreflightReport(OK_ROWS);
    expect(formatPreflightReport(passing)).toContain("PREFLIGHT PASS");
  });

  it("multi-level chain: PayrollBatch (target) has children PayrollBatchComponentSnapshot, whose sourceComponentId points to PayrollComponent — classifier walks each hop independently and A-classifies both restrictive edges", () => {
    const rows = [
      // 1st hop: PayrollBatchComponentSnapshot → PayrollBatch (CASCADE, db-handled)
      fk({ source_table: "PayrollBatchComponentSnapshot", source_col: "batchId", target_table: "PayrollBatch", on_delete: "CASCADE", live_rows: 300 }),
      // 2nd hop: PayrollBatchComponentSnapshot.sourceComponentId → PayrollComponent (NO ACTION, restrictive)
      fk({ source_table: "PayrollBatchComponentSnapshot", source_col: "sourceComponentId", target_table: "PayrollComponent", on_delete: "NO ACTION", live_rows: 300 }),
    ];
    const report = buildPreflightReport(rows);
    expect(report.ok).toBe(true);
    const hop2 = report.classifications.find(c => c.source_col === "sourceComponentId");
    expect(hop2?.strategy).toBe("A");
  });
});

describe("COA-RESET-1 · TARGET_TABLES + KNOWN_HANDLING invariants", () => {
  it("TARGET_TABLES contains every reset destination surfaced by fixup 3", () => {
    for (const t of [
      "Account", "BankAccount", "JournalEntry",
      "PayrollBatch", "PayrollComponent", "PayrollGlAccountingProfile",
      "PayrollOpeningBalanceComponent", "BudgetLine", "ForecastLine",
      "FingerprintMismatchEvent",
    ]) expect(TARGET_TABLES.has(t)).toBe(true);
  });

  it("KNOWN_HANDLING covers all three PayrollBatch self-refs", () => {
    for (const key of [
      "PayrollBatch.correctsPayrollBatchId",
      "PayrollBatch.pairedReversalBatchId",
      "PayrollBatch.reversesPayrollBatchId",
    ]) expect(KNOWN_HANDLING.get(key)?.strategy).toBe("C");
  });

  it("KNOWN_HANDLING covers all 7 PayrollGlAccountingProfile → Account FKs", () => {
    for (const col of [
      "cppPayableAccountId", "eiPayableAccountId",
      "employerCppExpenseAccountId", "employerEiExpenseAccountId",
      "federalTaxPayableAccountId", "netPayPayableAccountId",
      "provincialTaxPayableAccountId", "salaryExpenseAccountId",
    ]) {
      const key = `PayrollGlAccountingProfile.${col}`;
      expect(KNOWN_HANDLING.get(key)?.strategy).toBe("A");
    }
  });

  it("Fixup 3b — PaymentRun.fundingBankAccountId classified A with step C→step H ordering", () => {
    const entry = KNOWN_HANDLING.get("PaymentRun.fundingBankAccountId");
    expect(entry?.strategy).toBe("A");
    expect(entry?.reason).toMatch(/PaymentRun deleted step C before BankAccount step H/);
  });

  it("Fixup 3b — PayrollBatchComponentSnapshot.sourceAssignmentId classified A with explicit-deleteMany reason (NOT cascade)", () => {
    const entry = KNOWN_HANDLING.get("PayrollBatchComponentSnapshot.sourceAssignmentId");
    expect(entry?.strategy).toBe("A");
    // Actual mechanism: explicit tx.payrollBatchComponentSnapshot.deleteMany in step B2.
    // Must NOT be labelled cascade — the row is removed by the explicit deleteMany,
    // not by CASCADE from PayrollBatch (that CASCADE would also work but is not what
    // the code relies on).
    expect(entry?.reason).toMatch(/explicit payrollBatchComponentSnapshot\.deleteMany in step B2/);
    expect(entry?.reason).not.toMatch(/cascade/i);
  });

  it("Fixup 3b — PayrollBatchComponentSnapshot.sourceComponentId reason corrected to explicit-deleteMany (was inaccurately labelled cascade)", () => {
    const entry = KNOWN_HANDLING.get("PayrollBatchComponentSnapshot.sourceComponentId");
    expect(entry?.strategy).toBe("A");
    expect(entry?.reason).toMatch(/explicit payrollBatchComponentSnapshot\.deleteMany in step B2/);
    expect(entry?.reason).not.toMatch(/cascade/i);
  });

  it("Fixup 3b invariant — the explicit payrollBatchComponentSnapshot.deleteMany that both entries cite really exists in the execute script BEFORE payrollBatch.deleteMany", () => {
    const snapDelete = SCRIPT.indexOf("payrollBatchComponentSnapshot.deleteMany");
    const batchDelete = SCRIPT.indexOf("payrollBatch.deleteMany({ where: w })");
    expect(snapDelete).toBeGreaterThan(0);
    expect(batchDelete).toBeGreaterThan(0);
    expect(snapDelete).toBeLessThan(batchDelete);
  });

  it("Fixup 3b invariant — paymentRun.deleteMany really precedes bankAccount.deleteMany in the execute script", () => {
    const pmRun = SCRIPT.indexOf("paymentRun.deleteMany({ where: w })");
    const bank  = SCRIPT.indexOf("bankAccount.deleteMany({ where: w })");
    expect(pmRun).toBeGreaterThan(0);
    expect(bank).toBeGreaterThan(0);
    expect(pmRun).toBeLessThan(bank);
  });
});

describe("COA-RESET-1 · execute script structural invariants", () => {
  it("(9) Preflight aborts BEFORE any destructive write — process.exit(2) called from outside p.$transaction", () => {
    const preflightAbortIdx = SCRIPT.indexOf("preflight failed, zero mutation performed");
    const transactionIdx    = SCRIPT.indexOf("p.$transaction(async (tx)");
    expect(preflightAbortIdx).toBeGreaterThan(0);
    expect(transactionIdx).toBeGreaterThan(0);
    expect(preflightAbortIdx).toBeLessThan(transactionIdx);
    // process.exit(2) sits between them
    const exitIdx = SCRIPT.indexOf("process.exit(2)");
    expect(exitIdx).toBeGreaterThan(preflightAbortIdx);
    expect(exitIdx).toBeLessThan(transactionIdx);
  });

  it("(9b) Preflight is called BEFORE the manifest count block that would otherwise mutate nothing but still touch the DB", () => {
    const preflightCall = SCRIPT.indexOf("await preflight(p)");
    const manifest      = SCRIPT.indexOf("BEFORE — Coulee accounting counts");
    expect(preflightCall).toBeGreaterThan(0);
    expect(manifest).toBeGreaterThan(0);
    expect(preflightCall).toBeLessThan(manifest);
  });

  it("PayrollBatch self-ref nullify precedes payrollBatch.deleteMany", () => {
    const selfRefBlock  = SCRIPT.indexOf("payrollBatch self-refs cleared");
    const batchDel      = SCRIPT.indexOf("payrollBatch.deleteMany({ where: w })");
    expect(selfRefBlock).toBeGreaterThan(0);
    expect(batchDel).toBeGreaterThan(0);
    expect(selfRefBlock).toBeLessThan(batchDel);
  });

  it("PayrollOpeningBalanceComponent delete precedes PayrollComponent delete", () => {
    const openBal = SCRIPT.indexOf("payrollOpeningBalanceComponent.deleteMany");
    const pc      = SCRIPT.indexOf("payrollComponent.deleteMany({ where: w })");
    expect(openBal).toBeGreaterThan(0);
    expect(pc).toBeGreaterThan(0);
    expect(openBal).toBeLessThan(pc);
  });

  it("BudgetLine / ForecastLine / FingerprintMismatchEvent deletes are present (schema-shaped)", () => {
    expect(SCRIPT).toMatch(/budgetLine\.deleteMany/);
    expect(SCRIPT).toMatch(/forecastLine\.deleteMany/);
    expect(SCRIPT).toMatch(/fingerprintMismatchEvent\.deleteMany/);
    expect(SCRIPT).toMatch(/payrollZeroHoursAcknowledgement\.deleteMany/);
  });

  it("(10) tenant isolation — every deleteMany/updateMany in the destructive transaction is Coulee-scoped (either via `w` or an explicit clubId: COULEE)", () => {
    const txStart = SCRIPT.indexOf("await p.$transaction(async (tx)");
    expect(txStart).toBeGreaterThan(0);
    const txEnd = SCRIPT.indexOf("}, { timeout: 180000, maxWait: 30000 })", txStart);
    expect(txEnd).toBeGreaterThan(txStart);
    const txBody = SCRIPT.slice(txStart, txEnd);
    const writeCallRe = /\btx\.(\w+)\.(deleteMany|updateMany)\(\s*\{[\s\S]*?\}\s*\)/g;
    let match;
    let checked = 0;
    while ((match = writeCallRe.exec(txBody)) !== null) {
      const [call] = match;
      // Every write must reference either `where: w` (which is { clubId: COULEE })
      // or an explicit `clubId: COULEE` in the where clause.
      const scoped = /where:\s*w\b/.test(call) || /clubId:\s*COULEE/.test(call);
      expect(scoped, `Unscoped write: ${call.slice(0, 200)}`).toBe(true);
      checked++;
    }
    expect(checked, "expected at least a dozen scoped writes in the transaction").toBeGreaterThan(12);
  });

  it("COULEE constant is the Coulee Ridge staging club id (not empty, not another tenant)", () => {
    expect(SCRIPT).toMatch(/const\s+COULEE\s*=\s*"cmrvdeny7000144372ktmmg9c"/);
  });

  it("--commit gate + CONFIRM_TOKEN gate both present", () => {
    expect(SCRIPT).toMatch(/const\s+DRY_RUN\s*=\s*!args\.includes\("--commit"\)/);
    expect(SCRIPT).toMatch(/CONFIRM\s*===\s*CONFIRM_TOKEN/);
    expect(SCRIPT).toMatch(/COA_RESET_1_CONFIRM/);
  });
});
