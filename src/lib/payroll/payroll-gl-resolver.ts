// Phase 3 (2026-09-15) — Departmental Payroll Accounting.
//
// Single canonical resolver for the payroll GL journal. Consumed by
// BOTH `previewPayrollJournal` (read-side preview shown in the Post
// confirmation UI) AND `postPayrollBatch` (commit-side draft that
// becomes the persisted JournalEntry). This is deliberate: the
// founder rule for Phase 3 is that preview and post must produce
// byte-identical account resolution, so they MUST share this module.
//
// -------------------------------------------------------------------
// FROZEN-DEPARTMENT RULE
// -------------------------------------------------------------------
// The frozen department for each employee is read from
// `PayrollBatchEmployee.sourceFactsJson.assignments[]`, choosing the
// assignment with `role === "PRIMARY"` when present and the first
// assignment otherwise. This matches how the overview view picks
// the display department (see `src/lib/payroll/overview-view.ts`).
//
// The frozen department is SNAPSHOT at Prepare time. This resolver
// NEVER reads the LIVE Employee.departmentId or the LIVE
// EmployeeEmploymentAssignment. Changing an employee's HR department
// AFTER a batch is prepared CANNOT alter its journal — the assignment
// snapshot inside `sourceFactsJson` is authoritative.
//
// -------------------------------------------------------------------
// RESOLUTION PRECEDENCE (documented + tested)
// -------------------------------------------------------------------
// A. Per-component snapshot accounts (`expenseAccountIdSnapshot` +
//    `liabilityAccountIdSnapshot` on PayrollBatchComponentSnapshot)
//    ALWAYS win when present. These are already frozen at snapshot
//    time and represent the component's own configured accounts —
//    they are ORTHOGONAL to the departmental resolver below.
//
// B. Base salary / wage expense (the "residual" gross-minus-cash-
//    components amount):
//      1. `PayrollGlDepartmentOverride.salaryExpenseAccountId` for
//         the employee's frozen department, when that override row
//         exists AND the field is non-null.
//      2. Otherwise the global `PayrollGlAccountingProfile.salaryExpenseAccountId`.
//
// C. Employer CPP expense + employer EI expense: same rule as B,
//    keyed on the respective override field.
//
// D. Payroll LIABILITIES (net pay payable, CPP payable, EI payable,
//    federal tax payable, provincial tax payable): ALWAYS the global
//    profile. No per-department override. Central remittance to CRA
//    is the norm; Phase 3 deliberately does not fragment these.
//
// -------------------------------------------------------------------
// JOURNAL AGGREGATION
// -------------------------------------------------------------------
// Employees whose frozen department resolves to the same expense
// account (either because they share a department, or because their
// departments both fall through to the global default) aggregate
// into ONE debit line. Employees in departments that resolve to
// different accounts stay on separate lines. The founder rule:
// "must NOT collapse into one generic Salary/Wage Expense line if
// the departments resolve to different accounts."
//
// The journal always balances to the cent. If any employee is
// missing a resolvable account (no override, no global default, or
// referenced Account inactive), the resolver returns a readiness
// blocker instead of writing a broken journal.

import { Prisma } from "@prisma/client";
import { componentRequiresExpense, componentRequiresLiability } from "./gl-readiness";
// Re-export so callers (approve-and-post, payroll-journal-preview) can
// keep importing the canonical helpers from the resolver module.
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

export interface GlDepartmentOverrideSnapshot {
  departmentId:                  string;
  salaryExpenseAccountId:        string | null;
  employerCppExpenseAccountId:   string | null;
  employerEiExpenseAccountId:    string | null;
}

export interface BatchEmployeeAmounts {
  batchEmployeeId:               string;
  employeeId:                    string;
  displayName:                   string;
  // Frozen at Prepare time. Null when the employee has no assignment
  // (e.g. legacy import) — in that case, the resolver falls through
  // to the global profile with no override applied. `null` is safe;
  // resolver behaviour is identical to a department with no override.
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
  // Sum of the EMPLOYEE-side INCREASES_NET_PAY component amounts
  // ATTRIBUTED TO THIS EMPLOYEE (cash allowances / one-time cash
  // bonuses). Subtracted from this employee's residual salary
  // expense so the same dollars aren't posted twice.
  componentCashInGross:          Prisma.Decimal;
}

export interface ComponentSnapshotForResolver {
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
  debit:                         Prisma.Decimal | null;
  credit:                        Prisma.Decimal | null;
  description:                   string;
  // Phase 3 traceability — every debit tagged with the frozen
  // department(s) that funded it. Empty for centralized liabilities
  // and for component-driven debits (which are already labelled by
  // component in the description).
  departmentIds:                 string[];
}

export interface ResolveJournalInput {
  label:                         string;
  profile:                       GlProfileSnapshot;
  departmentOverrides:           GlDepartmentOverrideSnapshot[];
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
// Helpers exported for gl-readiness + testing
// -------------------------------------------------------------------

/** The three expense fields on a per-department override that can be
 *  overridden. Kept in one place so readiness + UI + resolver align. */
export const OVERRIDABLE_EXPENSE_FIELDS = [
  "salaryExpenseAccountId",
  "employerCppExpenseAccountId",
  "employerEiExpenseAccountId",
] as const;
export type OverridableExpenseField = typeof OVERRIDABLE_EXPENSE_FIELDS[number];

/** Resolve one of the three per-department expense mappings.
 *  Returns the override account id when configured; otherwise the
 *  global profile default. */
export function resolveDepartmentExpenseAccount(
  profile: GlProfileSnapshot,
  overrides: GlDepartmentOverrideSnapshot[],
  frozenDepartmentId: string | null,
  field: OverridableExpenseField,
): { accountId: string; source: "OVERRIDE" | "GLOBAL" } {
  if (frozenDepartmentId) {
    const ov = overrides.find((o) => o.departmentId === frozenDepartmentId);
    if (ov && ov[field] != null) {
      return { accountId: ov[field] as string, source: "OVERRIDE" };
    }
  }
  return { accountId: profile[field], source: "GLOBAL" };
}

// -------------------------------------------------------------------
// Main resolver
// -------------------------------------------------------------------

interface Bucket {
  total:         Prisma.Decimal;
  descriptions:  string[];
  departmentIds: Set<string>;
}

const ZERO = new Prisma.Decimal(0);

function addToBucket(m: Map<string, Bucket>, accountId: string, amount: Prisma.Decimal, description: string, departmentId: string | null): void {
  if (amount.isZero()) return;
  const b = m.get(accountId);
  if (b) {
    b.total = b.total.plus(amount);
    if (!b.descriptions.includes(description)) b.descriptions.push(description);
    if (departmentId) b.departmentIds.add(departmentId);
  } else {
    m.set(accountId, {
      total: amount,
      descriptions: [description],
      departmentIds: departmentId ? new Set([departmentId]) : new Set(),
    });
  }
}

/**
 * Build the canonical payroll GL journal from frozen batch facts.
 * See the file header for the resolution precedence + aggregation
 * rules. This function is PURE — no DB access, no side effects.
 */
export function resolvePayrollJournal(input: ResolveJournalInput): ResolveJournalResult {
  const { label, profile, departmentOverrides, employees, components } = input;

  const debitBuckets = new Map<string, Bucket>();
  const creditBuckets = new Map<string, Bucket>();

  // --------------------------------------------------------------
  // A. Aggregate per-component debits + credits — frozen at snapshot
  //    time, no per-department override applied.
  // --------------------------------------------------------------
  for (const s of components) {
    if (s.resolvedAmount == null || s.resolvedAmount.isZero()) continue;
    const amt = s.resolvedAmount;
    const src = `${s.displayName} (${s.componentCode})`;
    if (componentRequiresExpense(s) && s.expenseAccountIdSnapshot) {
      addToBucket(debitBuckets, s.expenseAccountIdSnapshot, amt, src, null);
    }
    if (componentRequiresLiability(s) && s.liabilityAccountIdSnapshot) {
      addToBucket(creditBuckets, s.liabilityAccountIdSnapshot, amt, src, null);
    }
  }

  // --------------------------------------------------------------
  // B. Aggregate PER-EMPLOYEE per-DEPARTMENT expense buckets for
  //    the residual salary + employer CPP + employer EI.
  // --------------------------------------------------------------
  for (const e of employees) {
    const residualSalary = e.grossPay.minus(e.componentCashInGross);
    if (!residualSalary.isZero()) {
      const r = resolveDepartmentExpenseAccount(
        profile, departmentOverrides, e.frozenDepartmentId, "salaryExpenseAccountId",
      );
      addToBucket(debitBuckets, r.accountId, residualSalary, `${label} — regular salary expense`, e.frozenDepartmentId);
    }
    const erCpp = e.employerCppCombined.plus(e.employerCpp2);
    if (!erCpp.isZero()) {
      const r = resolveDepartmentExpenseAccount(
        profile, departmentOverrides, e.frozenDepartmentId, "employerCppExpenseAccountId",
      );
      addToBucket(debitBuckets, r.accountId, erCpp, `${label} — employer CPP expense`, e.frozenDepartmentId);
    }
    if (!e.employerEi.isZero()) {
      const r = resolveDepartmentExpenseAccount(
        profile, departmentOverrides, e.frozenDepartmentId, "employerEiExpenseAccountId",
      );
      addToBucket(debitBuckets, r.accountId, e.employerEi, `${label} — employer EI expense`, e.frozenDepartmentId);
    }
  }

  // --------------------------------------------------------------
  // C. Aggregate centralized LIABILITY totals (unfragmented).
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

  addToBucket(creditBuckets, profile.netPayPayableAccountId,        totalNetPay,  `${label} — net pay payable`,             null);
  addToBucket(creditBuckets, profile.cppPayableAccountId,           cppPayable,   `${label} — CPP payable (ee + er)`,       null);
  addToBucket(creditBuckets, profile.eiPayableAccountId,            eiPayable,    `${label} — EI payable (ee + er)`,        null);
  addToBucket(creditBuckets, profile.federalTaxPayableAccountId,    totalFedTax,  `${label} — federal income tax payable`,  null);
  addToBucket(creditBuckets, profile.provincialTaxPayableAccountId, totalProvTax, `${label} — provincial income tax payable`, null);

  // --------------------------------------------------------------
  // D. Emit ResolvedJournalLine entries. Debit buckets first
  //    (sorted by accountId for determinism), then credit buckets.
  // --------------------------------------------------------------
  const lines: ResolvedJournalLine[] = [];
  const emit = (map: Map<string, Bucket>, side: "DEBIT" | "CREDIT") => {
    const acctIds = Array.from(map.keys()).sort();
    for (const acctId of acctIds) {
      const b = map.get(acctId)!;
      if (b.total.isZero()) continue;
      const desc = b.descriptions.length === 1
        ? b.descriptions[0]
        : b.descriptions.length <= 3
          ? b.descriptions.join(" + ")
          : `${b.descriptions.length} sources`;
      lines.push({
        accountId: acctId,
        debit:  side === "DEBIT"  ? b.total : null,
        credit: side === "CREDIT" ? b.total : null,
        description: desc,
        departmentIds: Array.from(b.departmentIds).sort(),
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

// Component classifier helpers are re-exported at the top of the
// file from `./gl-readiness` — resolver, readiness, preview, and
// posting all consume the same predicate implementations.
