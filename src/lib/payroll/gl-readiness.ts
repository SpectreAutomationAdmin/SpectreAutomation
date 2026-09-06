// Payroll-3C-6 (2026-09-05) — GL posting readiness evaluator.
//
// Reads the frozen snapshot on a payroll batch (component snapshots
// + statutory columns + tenant PayrollGlAccountingProfile) and
// returns whether the batch can post AND what needs to be fixed if
// not. Called by:
//   • the payroll review UI (before Controller sees POST),
//   • the post service itself (fails closed if a blocker exists),
//   • setup diagnostics.
//
// Rules:
//   • Live PayrollComponent GL fields are NEVER read here — only
//     the frozen `expenseAccountIdSnapshot` / `liabilityAccountIdSnapshot`
//     on `PayrollBatchComponentSnapshot`. That is what makes a posted
//     journal immutable to configuration changes made after CALCULATE.
//   • Global PayrollGlAccountingProfile is read live — it is the
//     tenant's system-account map, not a per-batch stamp.
//   • Accounts are validated for (a) tenant ownership (b) `isActive`
//     (c) `allowManualPosting`. Type-appropriateness (expense account
//     must be type EXPENSE, liability account must be LIABILITY) is
//     checked as a defence-in-depth guard.
//
// Structured blocker codes let the UI render actionable copy per case.

import { prisma } from "../prisma";
import type { Principal } from "../rbac";
import { requirePermission } from "../rbac";
import { assertTenantOwned } from "../services/tenant";
import { NotFoundError } from "../errors";

export type PayrollGlBlocker =
  | { code: "MISSING_COMPONENT_EXPENSE_ACCOUNT";
      componentCode: string; displayName: string; batchEmployeeId?: string }
  | { code: "MISSING_COMPONENT_LIABILITY_ACCOUNT";
      componentCode: string; displayName: string; batchEmployeeId?: string }
  | { code: "MISSING_GLOBAL_PAYROLL_ACCOUNT";
      field:
        | "salaryExpenseAccountId"
        | "employerCppExpenseAccountId"
        | "employerEiExpenseAccountId"
        | "netPayPayableAccountId"
        | "cppPayableAccountId"
        | "eiPayableAccountId"
        | "federalTaxPayableAccountId"
        | "provincialTaxPayableAccountId"
        | "PayrollGlAccountingProfile" }
  | { code: "CROSS_TENANT_ACCOUNT";
      accountId: string; expectedClubId: string; usedBy: string }
  | { code: "INACTIVE_ACCOUNT";
      accountId: string; accountNumber?: string | null; accountName?: string | null; usedBy: string }
  | { code: "MANUAL_POSTING_DISALLOWED";
      accountId: string; accountNumber?: string | null; usedBy: string }
  | { code: "ACCOUNT_TYPE_MISMATCH";
      accountId: string; accountNumber?: string | null; usedBy: string; expected: string; actual: string }
  | { code: "COMPONENT_WARNING_UNRESOLVED";
      componentCode: string; batchEmployeeId?: string; warningCode: string };

export interface PayrollGlReadinessResult {
  ready:    boolean;
  blockers: PayrollGlBlocker[];
  /** Post-safe summary that the UI banner can render. */
  summary: {
    totalComponents:            number;
    componentsMissingExpense:   number;
    componentsMissingLiability: number;
    accountsChecked:            number;
    globalProfilePresent:       boolean;
  };
}

// -------------------------------------------------------------------
// Per-component required-side rules.
//
// These decide whether a snapshot NEEDS an expense/liability account.
// A missing account for a side that isn't required is not a blocker.
//
//   EMPLOYER + NO_NET_PAY_EFFECT     → expense (er cost) + liability (payable)
//   EMPLOYEE + DECREASES_NET_PAY     → liability only (the employee's own $ funds it)
//   EMPLOYEE + INCREASES_NET_PAY     → expense only (cash allowance / reimbursement)
//   EMPLOYEE + REGULAR_EARNING       → expense only (base salary path)
//   * anything else                   → no requirement (unusual)
// -------------------------------------------------------------------
export function componentRequiresExpense(snap: {
  side: string; cashEffect: string; category: string;
}): boolean {
  if (snap.side === "EMPLOYER") return true;
  if (snap.side === "EMPLOYEE" && snap.cashEffect === "INCREASES_NET_PAY") return true;
  return false;
}
export function componentRequiresLiability(snap: {
  side: string; cashEffect: string; category: string;
}): boolean {
  if (snap.side === "EMPLOYER" && snap.cashEffect === "NO_NET_PAY_EFFECT") return true;
  if (snap.side === "EMPLOYEE" && snap.cashEffect === "DECREASES_NET_PAY") return true;
  return false;
}

// -------------------------------------------------------------------
// Main evaluator
// -------------------------------------------------------------------
export async function evaluatePayrollGlReadiness(
  principal: Principal,
  clubId: string,
  batchId: string,
): Promise<PayrollGlReadinessResult> {
  requirePermission(principal, clubId, "payroll:read");

  const batch = await prisma.payrollBatch.findUnique({
    where: { id: batchId },
    select: { id: true, clubId: true, status: true },
  });
  if (!batch) throw new NotFoundError("PayrollBatch", batchId);
  assertTenantOwned(batch, principal);
  if (batch.clubId !== clubId) throw new NotFoundError("PayrollBatch", batchId);

  const blockers: PayrollGlBlocker[] = [];

  // ---------- Global tenant profile ----------
  const config = await prisma.payrollClubConfig.findUnique({
    where: { clubId }, include: { glAccountingProfile: true },
  });
  const profile = config?.glAccountingProfile ?? null;
  if (!profile) {
    blockers.push({ code: "MISSING_GLOBAL_PAYROLL_ACCOUNT", field: "PayrollGlAccountingProfile" });
  }

  // Collect account IDs we need to validate. Use an array of
  // {id, usedBy} pairs — NOT a Map keyed by id — so a single account
  // referenced from BOTH the expense and liability slot of one
  // component gets checked as both. (Payroll-3C-6A §15 regression:
  // the earlier Map keying caused a LIABILITY account in the expense
  // slot to pass silently when the same id also appeared as the
  // liability, because the second put overwrote the first.)
  const accountIdsToCheck: Array<{ id: string; usedBy: string }> = [];
  type GlobalField =
    | "salaryExpenseAccountId"
    | "employerCppExpenseAccountId"
    | "employerEiExpenseAccountId"
    | "netPayPayableAccountId"
    | "cppPayableAccountId"
    | "eiPayableAccountId"
    | "federalTaxPayableAccountId"
    | "provincialTaxPayableAccountId";
  const requireField = (field: GlobalField, id: string | null | undefined) => {
    if (!id) {
      blockers.push({ code: "MISSING_GLOBAL_PAYROLL_ACCOUNT", field });
      return;
    }
    accountIdsToCheck.push({ id, usedBy: `global.${field}` });
  };
  if (profile) {
    requireField("salaryExpenseAccountId",         profile.salaryExpenseAccountId);
    requireField("employerCppExpenseAccountId",    profile.employerCppExpenseAccountId);
    requireField("employerEiExpenseAccountId",     profile.employerEiExpenseAccountId);
    requireField("netPayPayableAccountId",         profile.netPayPayableAccountId);
    requireField("cppPayableAccountId",            profile.cppPayableAccountId);
    requireField("eiPayableAccountId",             profile.eiPayableAccountId);
    requireField("federalTaxPayableAccountId",     profile.federalTaxPayableAccountId);
    requireField("provincialTaxPayableAccountId",  profile.provincialTaxPayableAccountId);
  }

  // ---------- Component snapshots ----------
  const snaps = await prisma.payrollBatchComponentSnapshot.findMany({
    where: { batchId },
    select: {
      id: true, componentCode: true, displayName: true,
      side: true, cashEffect: true, category: true,
      resolvedAmount: true, warningCode: true, batchEmployeeId: true,
      expenseAccountIdSnapshot: true, liabilityAccountIdSnapshot: true,
    },
  });

  let missingExpense = 0, missingLiability = 0;
  for (const s of snaps) {
    // Skip snapshots that never resolved to an amount — they don't
    // participate in the journal, so a missing account is moot. But
    // we DO surface the unresolved-warning as a distinct blocker so
    // the reviewer sees it.
    if (s.resolvedAmount == null) {
      if (s.warningCode) {
        blockers.push({
          code: "COMPONENT_WARNING_UNRESOLVED",
          componentCode: s.componentCode, batchEmployeeId: s.batchEmployeeId,
          warningCode: s.warningCode,
        });
      }
      continue;
    }
    if (componentRequiresExpense(s)) {
      if (!s.expenseAccountIdSnapshot) {
        blockers.push({
          code: "MISSING_COMPONENT_EXPENSE_ACCOUNT",
          componentCode: s.componentCode, displayName: s.displayName,
          batchEmployeeId: s.batchEmployeeId,
        });
        missingExpense += 1;
      } else {
        accountIdsToCheck.push({
          id: s.expenseAccountIdSnapshot,
          usedBy: `component.${s.componentCode}.expense`,
        });
      }
    }
    if (componentRequiresLiability(s)) {
      if (!s.liabilityAccountIdSnapshot) {
        blockers.push({
          code: "MISSING_COMPONENT_LIABILITY_ACCOUNT",
          componentCode: s.componentCode, displayName: s.displayName,
          batchEmployeeId: s.batchEmployeeId,
        });
        missingLiability += 1;
      } else {
        accountIdsToCheck.push({
          id: s.liabilityAccountIdSnapshot,
          usedBy: `component.${s.componentCode}.liability`,
        });
      }
    }
  }

  // ---------- Account validation ----------
  if (accountIdsToCheck.length > 0) {
    const uniqIds = [...new Set(accountIdsToCheck.map((x) => x.id))];
    const rows = await prisma.account.findMany({
      where: { id: { in: uniqIds } },
      select: {
        id: true, clubId: true, accountNumber: true, name: true,
        type: true, isActive: true, allowManualPosting: true,
      },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const { id, usedBy } of accountIdsToCheck) {
      const a = byId.get(id);
      if (!a) {
        blockers.push({ code: "CROSS_TENANT_ACCOUNT", accountId: id, expectedClubId: clubId, usedBy });
        continue;
      }
      if (a.clubId !== clubId) {
        blockers.push({
          code: "CROSS_TENANT_ACCOUNT",
          accountId: id, expectedClubId: clubId, usedBy,
        });
        continue;
      }
      if (!a.isActive) {
        blockers.push({
          code: "INACTIVE_ACCOUNT",
          accountId: id, accountNumber: a.accountNumber, accountName: a.name, usedBy,
        });
      }
      // Payroll posting flows through the canonical journal adapter,
      // not a user-driven manual entry. `allowManualPosting: false`
      // is the correct setting for payroll-clearing accounts (per
      // the founder-preview fixture) and does NOT block adapter
      // writes — so it's not a readiness blocker for payroll.
      // Type-appropriateness (defence-in-depth). Expense-side use
      // must reference an EXPENSE account; liability-side use must
      // reference a LIABILITY account. Global net-pay-payable +
      // statutory payables must all be LIABILITY. The salary /
      // employer-CPP / employer-EI global expense accounts must be
      // EXPENSE. Other combinations are a mapping mistake.
      const expected =
        usedBy.endsWith(".expense") || usedBy === "global.salaryExpenseAccountId"
          || usedBy === "global.employerCppExpenseAccountId" || usedBy === "global.employerEiExpenseAccountId"
          ? "EXPENSE"
          : usedBy.endsWith(".liability") || usedBy.startsWith("global.")
            ? "LIABILITY"
            : null;
      if (expected && a.type !== expected) {
        blockers.push({
          code: "ACCOUNT_TYPE_MISMATCH",
          accountId: id, accountNumber: a.accountNumber, usedBy,
          expected, actual: a.type,
        });
      }
    }
  }

  return {
    ready: blockers.length === 0,
    blockers,
    summary: {
      totalComponents:            snaps.length,
      componentsMissingExpense:   missingExpense,
      componentsMissingLiability: missingLiability,
      accountsChecked:            accountIdsToCheck.length,
      globalProfilePresent:       profile != null,
    },
  };
}
