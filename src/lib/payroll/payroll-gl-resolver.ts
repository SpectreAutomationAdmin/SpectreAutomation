// Phase 3 (2026-09-15, follow-up 2026-09-16) — Departmental Payroll
// Accounting via Spectre's canonical natural-account + department
// dimension model.
//
// -------------------------------------------------------------------
// ARCHITECTURE
// -------------------------------------------------------------------
// Spectre's General Ledger already stores department as a first-class
// dimension on every `JournalEntryLine.departmentId`. Financial
// reporting (`incomeStatementByDepartment`, `trialBalance`, department
// filters on `accountBalances`) reads that dimension via
// `line.departmentId ?? account.defaultDepartmentId`.
//
// The correct payroll accounting architecture is therefore:
//
//   NATURAL ACCOUNT (from PayrollGlAccountingProfile / component snapshot)
//   +
//   FROZEN EMPLOYEE DEPARTMENT (dimension on the journal line)
//
// This eliminates the need for a separate natural account per
// department: Salaries & Wages $6,000 can appear on one journal line
// per department dimension, all pointing at the same natural account.
// Departmental financial statements will attribute correctly through
// the existing incomeStatementByDepartment pipeline.
//
// The previous PayrollGlDepartmentOverride table (Phase 3 v1) has been
// dropped; see the corrective migration
// `20260916_drop_payroll_gl_dept_overrides`.
//
// -------------------------------------------------------------------
// FROZEN-DEPARTMENT RULE
// -------------------------------------------------------------------
// The frozen department for each employee is read from
// `PayrollBatchEmployee.sourceFactsJson.assignments[]`, choosing the
// assignment with `role === "PRIMARY"` when present and the first
// assignment otherwise. Matches the overview view's picker.
//
// The frozen department is SNAPSHOT at Prepare time. This resolver
// NEVER reads the LIVE Employee.departmentId. Changing an employee's
// HR department AFTER a batch is prepared CANNOT alter its journal.
//
// -------------------------------------------------------------------
// RESOLUTION PRECEDENCE (documented + tested)
// -------------------------------------------------------------------
// A. Per-component snapshot accounts (`expenseAccountIdSnapshot` +
//    `liabilityAccountIdSnapshot` on PayrollBatchComponentSnapshot)
//    ALWAYS win when present. These are already frozen at snapshot
//    time and represent the component's own configured natural
//    account. The frozen department is attached as the dimension.
//
// B. Base salary / wage expense (the "residual" gross-minus-cash-
//    components amount) posts to
//    `PayrollGlAccountingProfile.salaryExpenseAccountId` with the
//    frozen department dimension.
//
// C. Employer CPP + CPP2 expense posts to
//    `PayrollGlAccountingProfile.employerCppExpenseAccountId` with
//    the frozen department dimension.
//
// D. Employer EI expense posts to
//    `PayrollGlAccountingProfile.employerEiExpenseAccountId` with
//    the frozen department dimension.
//
// E. Payroll LIABILITIES (net pay payable, CPP payable, EI payable,
//    federal tax payable, provincial tax payable): ALWAYS the global
//    profile with NO department dimension (departmentId = null).
//    Central remittance to CRA is the norm; Phase 3 deliberately
//    keeps these Club-wide.
//
// -------------------------------------------------------------------
// JOURNAL AGGREGATION
// -------------------------------------------------------------------
// Journal lines are keyed by the (accountId, departmentId) PAIR.
// Two employees in the SAME department + same natural account
// aggregate into ONE line. Two employees in DIFFERENT departments
// (same natural account) produce TWO lines, differing only in the
// departmentId dimension — the founder-mandated separation.
//
// Central liabilities (departmentId=null) always aggregate into
// single Club-wide lines.

import { Prisma } from "@prisma/client";
import { componentRequiresExpense, componentRequiresLiability } from "./gl-readiness";
export { componentRequiresExpense, componentRequiresLiability };

// -------------------------------------------------------------------
// Public shapes
// -------------------------------------------------------------------

export interface GlProfileSnapshot {
  salaryExpenseAccountId:        string;
  employerCppExpenseAccountId:   string;
  employerEiExpenseAccountId:    string;
  netPayPayableAccountId:        string;
  cppPayableAccountId:           string;
  eiPayableAccountId:            string;
  federalTaxPayableAccountId:    string;
  provincialTaxPayableAccountId: string;
}

export interface BatchEmployeeAmounts {
  batchEmployeeId:               string;
  employeeId:                    string;
  displayName:                   string;
  /** Frozen at Prepare time. Null when the employee has no
   *  assignment; the resolver posts the expense with a null
   *  departmentId dimension (which reporting attributes to
   *  Account.defaultDepartmentId or "Unassigned"). */
  frozenDepartmentId:            string | null;
  grossPay:                      Prisma.Decimal;
  netPay:                        Prisma.Decimal;
  deductionCppEeCombined:        Prisma.Decimal;
  deductionCpp2Ee:               Prisma.Decimal;
  deductionEiEe:                 Prisma.Decimal;
  deductionFederalTax:           Prisma.Decimal;
  deductionProvincialTax:        Prisma.Decimal;
  employerCppCombined:           Prisma.Decimal;
  employerCpp2:                  Prisma.Decimal;
  employerEi:                    Prisma.Decimal;
  /** Sum of EMPLOYEE-side INCREASES_NET_PAY component amounts
   *  ATTRIBUTED TO THIS EMPLOYEE. Subtracted from this employee's
   *  residual salary expense so the same dollars aren't posted
   *  twice. */
  componentCashInGross:          Prisma.Decimal;
}

export interface ComponentSnapshotForResolver {
  /** Batch-employee this snapshot belongs to. Used to look up the
   *  frozen department for the component's line. */
  batchEmployeeId:               string | null;
  componentCode:                 string;
  displayName:                   string;
  side:                          string; // EMPLOYEE | EMPLOYER
  cashEffect:                    string; // INCREASES_NET_PAY | DECREASES_NET_PAY | NO_NET_PAY_EFFECT
  category:                      string;
  provenance:                    string;
  resolvedAmount:                Prisma.Decimal | null;
  expenseAccountIdSnapshot:      string | null;
  liabilityAccountIdSnapshot:    string | null;
}

export interface ResolvedJournalLine {
  accountId:                     string;
  /** Department dimension. Null for centralized liability lines
   *  and for component expense/liability lines when no employee
   *  is attributable. */
  departmentId:                  string | null;
  debit:                         Prisma.Decimal | null;
  credit:                        Prisma.Decimal | null;
  description:                   string;
  /** For traceability: the list of every employee whose amounts
   *  contributed to this line. Empty for central liabilities. */
  employeeIds:                   string[];
}

export interface ResolveJournalInput {
  label:                         string;
  profile:                       GlProfileSnapshot;
  employees:                     BatchEmployeeAmounts[];
  components:                    ComponentSnapshotForResolver[];
}

export interface ResolveJournalResult {
  lines:                         ResolvedJournalLine[];
  totalDebits:                   Prisma.Decimal;
  totalCredits:                  Prisma.Decimal;
  balanced:                      boolean;
}

// -------------------------------------------------------------------
// Internals
// -------------------------------------------------------------------

interface Bucket {
  total:         Prisma.Decimal;
  descriptions:  string[];
  employeeIds:   Set<string>;
}

const ZERO = new Prisma.Decimal(0);
const BUCKET_KEY_NONE = "__null__";
const bucketKey = (accountId: string, departmentId: string | null): string =>
  `${accountId}␟${departmentId ?? BUCKET_KEY_NONE}`;
const parseBucketKey = (key: string): { accountId: string; departmentId: string | null } => {
  const [accountId, dept] = key.split("␟");
  return {
    accountId,
    departmentId: dept === BUCKET_KEY_NONE ? null : dept,
  };
};

function addToBucket(
  m: Map<string, Bucket>,
  accountId: string,
  departmentId: string | null,
  amount: Prisma.Decimal,
  description: string,
  employeeId: string | null,
): void {
  if (amount.isZero()) return;
  const k = bucketKey(accountId, departmentId);
  const b = m.get(k);
  if (b) {
    b.total = b.total.plus(amount);
    if (!b.descriptions.includes(description)) b.descriptions.push(description);
    if (employeeId) b.employeeIds.add(employeeId);
  } else {
    m.set(k, {
      total: amount,
      descriptions: [description],
      employeeIds: employeeId ? new Set([employeeId]) : new Set(),
    });
  }
}

// -------------------------------------------------------------------
// Main resolver — natural account + department dimension
// -------------------------------------------------------------------

export function resolvePayrollJournal(input: ResolveJournalInput): ResolveJournalResult {
  const { label, profile, employees, components } = input;

  // Employee -> frozen department, for component attribution.
  const deptByBatchEmployeeId = new Map<string, string | null>(
    employees.map((e) => [e.batchEmployeeId, e.frozenDepartmentId]),
  );
  const empIdByBatchEmployeeId = new Map<string, string>(
    employees.map((e) => [e.batchEmployeeId, e.employeeId]),
  );

  const debitBuckets  = new Map<string, Bucket>();
  const creditBuckets = new Map<string, Bucket>();

  // --------------------------------------------------------------
  // A. Component snapshots — natural account from snapshot,
  //    department dimension from the owning batch employee.
  // --------------------------------------------------------------
  for (const s of components) {
    if (s.resolvedAmount == null || s.resolvedAmount.isZero()) continue;
    const amt = s.resolvedAmount;
    const src = `${s.displayName} (${s.componentCode})`;
    const dept = s.batchEmployeeId ? (deptByBatchEmployeeId.get(s.batchEmployeeId) ?? null) : null;
    const empId = s.batchEmployeeId ? (empIdByBatchEmployeeId.get(s.batchEmployeeId) ?? null) : null;
    if (componentRequiresExpense(s) && s.expenseAccountIdSnapshot) {
      addToBucket(debitBuckets, s.expenseAccountIdSnapshot, dept, amt, src, empId);
    }
    if (componentRequiresLiability(s) && s.liabilityAccountIdSnapshot) {
      // Component-driven liabilities (e.g. RRSP-EE payable) keep the
      // department dimension too — the payable IS attributable to
      // the employee whose deduction created it, and departmental
      // reporting for liability aging + remittance benefits.
      addToBucket(creditBuckets, s.liabilityAccountIdSnapshot, dept, amt, src, empId);
    }
  }

  // --------------------------------------------------------------
  // B. Per-employee residual salary + employer CPP + employer EI.
  //    Same natural account for every employee; department
  //    dimension is the frozen dept.
  // --------------------------------------------------------------
  for (const e of employees) {
    const residualSalary = e.grossPay.minus(e.componentCashInGross);
    if (!residualSalary.isZero()) {
      addToBucket(debitBuckets, profile.salaryExpenseAccountId, e.frozenDepartmentId, residualSalary, `${label} — regular salary expense`, e.employeeId);
    }
    const erCpp = e.employerCppCombined.plus(e.employerCpp2);
    if (!erCpp.isZero()) {
      addToBucket(debitBuckets, profile.employerCppExpenseAccountId, e.frozenDepartmentId, erCpp, `${label} — employer CPP expense`, e.employeeId);
    }
    if (!e.employerEi.isZero()) {
      addToBucket(debitBuckets, profile.employerEiExpenseAccountId, e.frozenDepartmentId, e.employerEi, `${label} — employer EI expense`, e.employeeId);
    }
  }

  // --------------------------------------------------------------
  // C. Centralized LIABILITY totals — always Club-wide, no dept.
  // --------------------------------------------------------------
  const totalNetPay  = sumOver(employees, "netPay");
  const totalEeCpp   = sumOver(employees, "deductionCppEeCombined").plus(sumOver(employees, "deductionCpp2Ee"));
  const totalEeEi    = sumOver(employees, "deductionEiEe");
  const totalFedTax  = sumOver(employees, "deductionFederalTax");
  const totalProvTax = sumOver(employees, "deductionProvincialTax");
  const totalErCpp   = sumOver(employees, "employerCppCombined").plus(sumOver(employees, "employerCpp2"));
  const totalErEi    = sumOver(employees, "employerEi");
  const cppPayable   = totalEeCpp.plus(totalErCpp);
  const eiPayable    = totalEeEi.plus(totalErEi);

  addToBucket(creditBuckets, profile.netPayPayableAccountId,        null, totalNetPay,  `${label} — net pay payable`,             null);
  addToBucket(creditBuckets, profile.cppPayableAccountId,           null, cppPayable,   `${label} — CPP payable (ee + er)`,       null);
  addToBucket(creditBuckets, profile.eiPayableAccountId,            null, eiPayable,    `${label} — EI payable (ee + er)`,        null);
  addToBucket(creditBuckets, profile.federalTaxPayableAccountId,    null, totalFedTax,  `${label} — federal income tax payable`,  null);
  addToBucket(creditBuckets, profile.provincialTaxPayableAccountId, null, totalProvTax, `${label} — provincial income tax payable`, null);

  // --------------------------------------------------------------
  // D. Emit ResolvedJournalLine entries. Debit buckets first
  //    (sorted deterministically), then credit buckets.
  // --------------------------------------------------------------
  const lines: ResolvedJournalLine[] = [];
  const emit = (map: Map<string, Bucket>, side: "DEBIT" | "CREDIT") => {
    const keys = Array.from(map.keys()).sort();
    for (const k of keys) {
      const b = map.get(k)!;
      if (b.total.isZero()) continue;
      const { accountId, departmentId } = parseBucketKey(k);
      const desc = b.descriptions.length === 1
        ? b.descriptions[0]
        : b.descriptions.length <= 3
          ? b.descriptions.join(" + ")
          : `${b.descriptions.length} sources`;
      lines.push({
        accountId,
        departmentId,
        debit:  side === "DEBIT"  ? b.total : null,
        credit: side === "CREDIT" ? b.total : null,
        description: desc,
        employeeIds: Array.from(b.employeeIds).sort(),
      });
    }
  };
  emit(debitBuckets,  "DEBIT");
  emit(creditBuckets, "CREDIT");

  const totalDebits  = lines.reduce((s, l) => s.plus(l.debit  ?? ZERO), new Prisma.Decimal(0));
  const totalCredits = lines.reduce((s, l) => s.plus(l.credit ?? ZERO), new Prisma.Decimal(0));
  return {
    lines,
    totalDebits,
    totalCredits,
    balanced: totalDebits.equals(totalCredits),
  };
}

function sumOver(rows: BatchEmployeeAmounts[], field: keyof BatchEmployeeAmounts): Prisma.Decimal {
  let acc = new Prisma.Decimal(0);
  for (const r of rows) {
    const v = r[field];
    if (v instanceof Prisma.Decimal) acc = acc.plus(v);
  }
  return acc;
}
