// COA-RESET-1 — Preflight classification library.
//
// Pure functions extracted from scripts/coa-reset-1-coulee-execute.mjs
// so the FK graph classification is testable independent of the
// destructive script and its live database.
//
// Public exports:
//   TARGET_TABLES           — set of tables the reset deletes rows from
//   KNOWN_HANDLING          — Map<`${sourceTable}.${column}`, {strategy, reason}>
//   classifyRow(row)        — pure classification for a single FK row
//   buildPreflightReport()  — full report given raw FK rows + live counts

// ---------------------------------------------------------------------------
// Destructive target set.
// ---------------------------------------------------------------------------
export const TARGET_TABLES = new Set([
  "Account", "AccountDepartment", "BankAccount",
  "JournalEntry", "JournalEntryLine", "JournalAttachment",
  "APInvoice", "APInvoiceLine", "VendorPayment",
  "PaymentRun", "PaymentInstruction", "PaymentDestinationSnapshot",
  "PaymentEvent", "PaymentBatch", "PaymentBatchItem", "PaymentAuthorization",
  "PayrollBatch",
  "PayrollBatchEmployee", "PayrollBatchEarning", "PayrollBatchDeduction",
  "PayrollBatchException", "PayrollBatchAllowanceSnapshot",
  "PayrollBatchComponentSnapshot", "PayrollBatchReviewAttestation",
  "PayrollZeroHoursAcknowledgement",
  "PayrollScheduledOneTimeEarning",
  "PayrollBenefitPlan", "EmployeeBenefitPlanEnrolment",
  "EmployeeRecurringPayrollComponent",
  "PayrollComponent", "PayrollGlAccountingProfile",
  "PayrollOpeningBalanceComponent",
  "BudgetLine", "ForecastLine",
  "FingerprintMismatchEvent",
  "POSSale", "InventoryTransaction", "InventoryReceiving",
  "PrivateEventDeposit", "LessonBooking",
  "AssetDepreciationEntry", "AssetDisposal", "CapitalAsset",
  "PayrollRun",
]);

// ---------------------------------------------------------------------------
// KNOWN_HANDLING — every RESTRICT / NO ACTION incoming FK this script
// explicitly covers. See README-shaped comment above each block for the
// step that resolves it.
// ---------------------------------------------------------------------------
export const KNOWN_HANDLING = new Map([
  // === Incoming to Account (target of step K) ===
  ["APInvoiceLine.expenseAccountId",
    { strategy: "A", reason: "APInvoiceLine deleted step D before Account (step K)" }],
  ["BankAccount.glAccountId",
    { strategy: "A", reason: "BankAccount deleted step H before Account (step K)" }],
  ["BudgetLine.accountId",
    { strategy: "A", reason: "BudgetLine deleted step B0 before Account (step K)" }],
  ["ForecastLine.accountId",
    { strategy: "A", reason: "ForecastLine deleted step B0 before Account (step K)" }],
  ["JournalEntryLine.accountId",
    { strategy: "A", reason: "JournalEntryLine cascades from JournalEntry.deleteMany step F, before Account step K" }],
  ["PayrollComponent.glAccountId",
    { strategy: "A", reason: "PayrollComponent deleted step G before Account (step K)" }],
  ["PayrollGlAccountingProfile.cppPayableAccountId",
    { strategy: "A", reason: "PayrollGlAccountingProfile deleted step G before Account (step K)" }],
  ["PayrollGlAccountingProfile.eiPayableAccountId",
    { strategy: "A", reason: "PayrollGlAccountingProfile deleted step G before Account (step K)" }],
  ["PayrollGlAccountingProfile.employerCppExpenseAccountId",
    { strategy: "A", reason: "PayrollGlAccountingProfile deleted step G before Account (step K)" }],
  ["PayrollGlAccountingProfile.employerEiExpenseAccountId",
    { strategy: "A", reason: "PayrollGlAccountingProfile deleted step G before Account (step K)" }],
  ["PayrollGlAccountingProfile.federalTaxPayableAccountId",
    { strategy: "A", reason: "PayrollGlAccountingProfile deleted step G before Account (step K)" }],
  ["PayrollGlAccountingProfile.netPayPayableAccountId",
    { strategy: "A", reason: "PayrollGlAccountingProfile deleted step G before Account (step K)" }],
  ["PayrollGlAccountingProfile.provincialTaxPayableAccountId",
    { strategy: "A", reason: "PayrollGlAccountingProfile deleted step G before Account (step K)" }],
  ["PayrollGlAccountingProfile.salaryExpenseAccountId",
    { strategy: "A", reason: "PayrollGlAccountingProfile deleted step G before Account (step K)" }],

  // === Incoming to APInvoice ===
  ["PaymentBatchItem.invoiceId",
    { strategy: "A", reason: "PaymentBatchItem deleted step C before APInvoice step D" }],

  // === Incoming to JournalEntry ===
  ["PayrollBatch.glJournalEntryId",
    { strategy: "A", reason: "PayrollBatch deleted step B before JournalEntry step F" }],

  // === Incoming to PayrollBatch ===
  ["FingerprintMismatchEvent.batchId",
    { strategy: "A", reason: "FingerprintMismatchEvent deleted step B0 before PayrollBatch step B" }],
  ["PayrollBatch.correctsPayrollBatchId",
    { strategy: "C", reason: "Self-ref nullified in step B pre-delete pass (Coulee-scoped)" }],
  ["PayrollBatch.pairedReversalBatchId",
    { strategy: "C", reason: "Self-ref nullified in step B pre-delete pass (Coulee-scoped)" }],
  ["PayrollBatch.reversesPayrollBatchId",
    { strategy: "C", reason: "Self-ref nullified in step B pre-delete pass (Coulee-scoped)" }],

  // === Incoming to PayrollBenefitPlan ===
  ["EmployeeBenefitPlanEnrolment.planId",
    { strategy: "A", reason: "EmployeeBenefitPlanEnrolment deleted step G before PayrollBenefitPlan step G" }],

  // === Incoming to PayrollComponent ===
  ["EmployeeRecurringPayrollComponent.componentId",
    { strategy: "A", reason: "EmployeeRecurringPayrollComponent deleted step G before PayrollComponent step G" }],
  ["PayrollBatchComponentSnapshot.sourceComponentId",
    { strategy: "A", reason: "PayrollBatchComponentSnapshot cascade-deleted with PayrollBatch step B, before PayrollComponent step G" }],
  ["PayrollOpeningBalanceComponent.sourceComponentId",
    { strategy: "A", reason: "PayrollOpeningBalanceComponent deleted step G-1 before PayrollComponent step G" }],
  ["PayrollScheduledOneTimeEarning.componentId",
    { strategy: "A", reason: "PayrollScheduledOneTimeEarning deleted step G before PayrollComponent step G" }],

  // === Incoming to PaymentDestinationSnapshot ===
  ["PaymentInstruction.destinationSnapshotId",
    { strategy: "A", reason: "PaymentInstruction deleted step C before PaymentDestinationSnapshot step C" }],
]);

// ---------------------------------------------------------------------------
// classifyRow — pure. Given one raw FK row with a live-Coulee count, decide
// whether it is A / B / C / D / UNHANDLED. Rows with `on_delete` other than
// RESTRICT / NO ACTION are returned as "N/A" (caller filters).
// ---------------------------------------------------------------------------
export function classifyRow(row) {
  if (row.on_delete !== "RESTRICT" && row.on_delete !== "NO ACTION") {
    return { strategy: "N/A", reason: `on_delete=${row.on_delete} — not restrictive` };
  }
  const key = `${row.source_table}.${row.source_col}`;
  const known = KNOWN_HANDLING.get(key);
  if (known) return { strategy: known.strategy, reason: known.reason };
  if ((row.live_rows ?? 0) === 0) {
    return { strategy: "D", reason: "auto-D: unlisted FK, zero live rows scoped to Coulee" };
  }
  return { strategy: "UNHANDLED", reason: "no explicit handling strategy + live Coulee rows" };
}

// ---------------------------------------------------------------------------
// buildPreflightReport — pure. Given an array of raw FK rows (each with an
// attached .live_rows count), returns the structured report used by the
// executable script and by tests.
// ---------------------------------------------------------------------------
export function buildPreflightReport(rows) {
  const restrict = rows.filter(r => r.on_delete === "RESTRICT" || r.on_delete === "NO ACTION");
  const cascade  = rows.filter(r => r.on_delete === "CASCADE");
  const setnull  = rows.filter(r => r.on_delete === "SET NULL" || r.on_delete === "SET DEFAULT");

  const classifications = [];
  const unhandledLive  = [];
  for (const r of restrict) {
    const { strategy, reason } = classifyRow(r);
    const entry = { ...r, strategy, reason };
    classifications.push(entry);
    if (strategy === "UNHANDLED") unhandledLive.push(entry);
  }
  return {
    totalFks: rows.length,
    classifications,
    cascade,
    setnull,
    unhandledLive,
    ok: unhandledLive.length === 0,
  };
}

// ---------------------------------------------------------------------------
// formatPreflightReport — printable string version of the report.
// ---------------------------------------------------------------------------
export function formatPreflightReport(report) {
  const out = [];
  const push = (s = "") => out.push(s);
  push("======================================================================");
  push("PREFLIGHT — pg_constraint dependency graph for the destructive target set");
  push("======================================================================");
  push(`Total incoming FKs on target tables: ${report.totalFks}`);
  push(`  RESTRICT / NO ACTION: ${report.classifications.length}`);
  push(`  CASCADE (db-handled): ${report.cascade.length}`);
  push(`  SET NULL / SET DEFAULT: ${report.setnull.length}`);
  push("");
  const byStrategy = { A: [], B: [], C: [], D: [], UNHANDLED: [] };
  for (const c of report.classifications) byStrategy[c.strategy].push(c);
  const banner = (label, list) => {
    push(`-- Strategy ${label} — ${list.length} --`);
    for (const c of list) {
      push(`  [${c.on_delete.padEnd(9)}] ${c.source_table}.${c.source_col} → ${c.target_table}.${c.target_col}  (live=${c.live_rows ?? 0})`);
      push(`     ${c.reason}`);
    }
    if (list.length) push("");
  };
  banner("A (explicitly deleted before target)", byStrategy.A);
  banner("B (explicitly nullified/cleared before target)", byStrategy.B);
  banner("C (self-reference explicitly broken)", byStrategy.C);
  banner("D (zero live Coulee rows, structurally accounted for)", byStrategy.D);
  if (report.unhandledLive.length) {
    push("======================================================================");
    push(`PREFLIGHT ABORT — ${report.unhandledLive.length} unhandled restrictive dependencies with live Coulee rows`);
    push("======================================================================");
    for (const u of report.unhandledLive) {
      push(`  [${u.on_delete}] ${u.source_table}.${u.source_col} → ${u.target_table}.${u.target_col}`);
      push(`    live_rows=${u.live_rows}  constraint=${u.constraint_name}`);
      push(`    reason: no explicit handling strategy in KNOWN_HANDLING`);
    }
  } else {
    push("PREFLIGHT PASS — every restrictive dependency is handled A/B/C/D.");
  }
  return out.join("\n");
}
