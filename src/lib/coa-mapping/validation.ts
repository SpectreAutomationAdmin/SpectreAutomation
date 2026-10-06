// COA-MAP-1 (2026-10-06) — mapping-change validation.
//
// VALID / WARNING / BLOCKED classifier per the directive.
// Decision 2 Option A: Fund stays authoritative; reportingRole is
// presentation only. The validation surfaces inconsistencies but
// does NOT silently rewrite fundApplicability.

import type { Prisma } from "@prisma/client";
import type { ReportingRole } from "./reporting-role";
import { statementForReportingRole } from "./reporting-role";

export type ValidationOutcome = "VALID" | "WARNING" | "BLOCKED";

export type ValidationReason = {
  code: string;
  message: string;
};

export type ValidationResult = {
  outcome: ValidationOutcome;
  reasons: ReadonlyArray<ValidationReason>;
};

export type AccountSnapshot = {
  id: string;
  accountNumber: string;
  name: string;
  type: string;          // ASSET | LIABILITY | EQUITY | REVENUE | EXPENSE
  normalBalance: string; // DEBIT | CREDIT
  fundApplicability: string | null;
};

export type GroupSnapshot = {
  id: string;
  key: string;
  name: string;
  statement: string;         // "INCOME_STATEMENT" | "BALANCE_SHEET" | "CASH_FLOW" | ...
  reportingRole: ReportingRole | string | null;
};

/**
 * Validate moving `account` into `targetGroup`. The function is
 * pure — it does not consult the DB or mutate anything.
 */
export function validateAccountReassignment(input: {
  account: AccountSnapshot;
  targetGroup: GroupSnapshot;
}): ValidationResult {
  const reasons: ValidationReason[] = [];
  let outcome: ValidationOutcome = "VALID";

  const accountIsBS =
    input.account.type === "ASSET" ||
    input.account.type === "LIABILITY" ||
    input.account.type === "EQUITY";
  const accountIsIS =
    input.account.type === "REVENUE" || input.account.type === "EXPENSE";

  const groupIsBS = input.targetGroup.statement === "BALANCE_SHEET";
  const groupIsIS = input.targetGroup.statement === "INCOME_STATEMENT";

  // ---- BLOCKED: BS account into IS group OR IS account into BS group.
  if (accountIsBS && groupIsIS) {
    outcome = "BLOCKED";
    reasons.push({
      code: "STATEMENT_MISMATCH_BS_INTO_IS",
      message:
        `Account ${input.account.accountNumber} is a balance-sheet account ` +
        `(type ${input.account.type}). It cannot be moved into the ` +
        `income-statement group "${input.targetGroup.name}".`,
    });
  }
  if (accountIsIS && groupIsBS) {
    outcome = "BLOCKED";
    reasons.push({
      code: "STATEMENT_MISMATCH_IS_INTO_BS",
      message:
        `Account ${input.account.accountNumber} is an income-statement account ` +
        `(type ${input.account.type}). It cannot be moved into the ` +
        `balance-sheet group "${input.targetGroup.name}".`,
    });
  }

  // ---- WARNING: role suggests a different statement than the group's
  //      statement field (shouldn't happen for well-formed groups, but
  //      guards against drift during migration).
  if (input.targetGroup.reportingRole) {
    const roleStatement = statementForReportingRole(
      input.targetGroup.reportingRole as ReportingRole,
    );
    if (
      roleStatement === "INCOME_STATEMENT" &&
      input.targetGroup.statement !== "INCOME_STATEMENT"
    ) {
      outcome = outcome === "BLOCKED" ? "BLOCKED" : "WARNING";
      reasons.push({
        code: "ROLE_STATEMENT_DRIFT",
        message:
          `Group "${input.targetGroup.name}" has reportingRole ` +
          `${input.targetGroup.reportingRole} (Income Statement) but its ` +
          `statement is ${input.targetGroup.statement}. Fix the group's ` +
          `statement or clear its role before assigning accounts.`,
      });
    }
    if (
      roleStatement === "BALANCE_SHEET" &&
      input.targetGroup.statement !== "BALANCE_SHEET"
    ) {
      outcome = outcome === "BLOCKED" ? "BLOCKED" : "WARNING";
      reasons.push({
        code: "ROLE_STATEMENT_DRIFT",
        message:
          `Group "${input.targetGroup.name}" has reportingRole ` +
          `${input.targetGroup.reportingRole} (Balance Sheet) but its ` +
          `statement is ${input.targetGroup.statement}.`,
      });
    }
  }

  // ---- WARNING: Fund axis conflict. If the account's fundApplicability
  //      is CAPITAL-only and the group's reportingRole suggests
  //      Operating, surface a warning. Decision 2 Option A: Fund stays
  //      authoritative — we do NOT silently change fundApplicability.
  if (accountIsIS && input.account.fundApplicability && input.targetGroup.reportingRole) {
    const funds = input.account.fundApplicability
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    const isCapitalOnly = funds.length > 0 && funds.every((f) => f === "CAPITAL");
    const isOperatingOnly = funds.length > 0 && funds.every((f) => f === "OPERATING");
    const operatingRoles: ReadonlyArray<string> = [
      "OPERATING_REVENUE", "MEMBERSHIP_DUES", "COGS", "PAYROLL",
      "OPERATING_EXPENSE", "DEPRECIATION",
      // Interest income is intentionally not operating here —
      // Coulee's 7100 is CAPITAL fund per CAPITAL-LIVE-1A.
    ];
    const capitalRoles: ReadonlyArray<string> = [
      "CAPITAL_ASSESSMENTS", "ENTRANCE_FEES", "CAPITAL_FUND_OTHER_REVENUE",
    ];
    if (isCapitalOnly && operatingRoles.includes(input.targetGroup.reportingRole as string)) {
      outcome = outcome === "BLOCKED" ? "BLOCKED" : "WARNING";
      reasons.push({
        code: "FUND_AXIS_CAPITAL_INTO_OPERATING",
        message:
          `Account ${input.account.accountNumber} is CAPITAL-fund. Moving it ` +
          `to an Operating-presentation group ("${input.targetGroup.name}") does ` +
          `NOT change its Fund classification — it will still report on the ` +
          `Capital side of Operating-vs-Capital statements. Edit the account's ` +
          `Fund assignment separately if that is the intent.`,
      });
    }
    if (isOperatingOnly && capitalRoles.includes(input.targetGroup.reportingRole as string)) {
      outcome = outcome === "BLOCKED" ? "BLOCKED" : "WARNING";
      reasons.push({
        code: "FUND_AXIS_OPERATING_INTO_CAPITAL",
        message:
          `Account ${input.account.accountNumber} is OPERATING-fund. Moving it ` +
          `to a Capital-presentation group ("${input.targetGroup.name}") does ` +
          `NOT change its Fund classification. Edit the account's Fund ` +
          `assignment separately if that is the intent.`,
      });
    }
  }

  // ---- WARNING: normal-balance mismatch (an account with CREDIT
  //      normal balance moving into a historically DEBIT group may
  //      indicate a misclassification, but we never block it — the
  //      Controller may have a legitimate reason).
  //      (Omitted here — generic BS/IS gate above covers the common cases.)

  return { outcome, reasons };
}

/**
 * Validate group deletion.
 */
export function validateGroupDeletion(input: {
  group: GroupSnapshot;
  assignmentCount: number;
  isTenantCreated: boolean;
}): ValidationResult {
  const reasons: ValidationReason[] = [];
  if (input.assignmentCount > 0) {
    return {
      outcome: "BLOCKED",
      reasons: [{
        code: "GROUP_HAS_ASSIGNMENTS",
        message:
          `Group "${input.group.name}" has ${input.assignmentCount} account ` +
          `assignment(s). Move those accounts to another group first.`,
      }],
    };
  }
  if (!input.isTenantCreated) {
    return {
      outcome: "BLOCKED",
      reasons: [{
        code: "DEFAULT_GROUP_PROTECTED",
        message:
          `Group "${input.group.name}" is a Spectre default group and cannot ` +
          `be deleted. Edit its name or children instead.`,
      }],
    };
  }
  return { outcome: "VALID", reasons };
}

// Keep Prisma reference so unused-import TS error does not fire.
export type _PrismaRef = Prisma.JsonObject;
