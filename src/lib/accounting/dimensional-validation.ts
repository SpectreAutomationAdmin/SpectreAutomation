// DIM-1 (2026-09-29) — Centralised dimensional validation.
//
// Every posting pipeline (Manual JE, AP invoices, Payroll, Bank
// settlement, Budget, Forecast, historical TB import) that writes
// an accounting line MUST route its dimensional decisions through
// this service. The rules encoded here are the single source of
// truth for:
//
//   * Account.departmentPolicy — REQUIRED / OPTIONAL / NOT_APPLICABLE
//   * Account.fundPolicy       — same enum
//   * AccountDepartment applicability (which departments MAY use
//     this account)
//   * AccountFund applicability (which funds MAY use this account)
//   * Tenant scoping — every referenced id must belong to the same
//     clubId as the account
//
// Ad-hoc rule copies in individual pipelines are a design defect —
// they will drift, they will disagree, and the ledger will become
// inconsistent. If a pipeline needs behaviour this module does not
// expose, extend this module first.

import type { PrismaClient, Prisma } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";

export type DimensionPolicy = "REQUIRED" | "OPTIONAL" | "NOT_APPLICABLE";

/**
 * The shape a caller supplies for validation. `accountId` and
 * `clubId` are always required. `departmentId` and `fundId` are
 * the dimension values the caller INTENDS to persist on the line —
 * `null | undefined` means the caller is not attributing that
 * dimension.
 *
 * IMPORTANT: This service does NOT read Account.defaultDepartmentId
 * and does NOT synthesise dimension ids on the caller's behalf.
 * Callers who want to pre-populate from a suggestion must do that
 * at the input-validation layer, and then pass the resolved values
 * here explicitly.
 */
export type DimensionalValidationInput = {
  clubId: string;
  accountId: string;
  departmentId?: string | null;
  fundId?: string | null;
};

export type DimensionalValidationError = {
  code:
    | "ACCOUNT_NOT_FOUND"
    | "ACCOUNT_CROSS_TENANT"
    | "DEPARTMENT_REQUIRED"
    | "DEPARTMENT_NOT_APPLICABLE"
    | "DEPARTMENT_NOT_ALLOWED_ON_ACCOUNT"
    | "DEPARTMENT_CROSS_TENANT"
    | "DEPARTMENT_NOT_FOUND"
    | "FUND_REQUIRED"
    | "FUND_NOT_APPLICABLE"
    | "FUND_NOT_ALLOWED_ON_ACCOUNT"
    | "FUND_CROSS_TENANT"
    | "FUND_NOT_FOUND";
  message: string;
  dimension: "account" | "department" | "fund";
  accountId?: string;
  departmentId?: string;
  fundId?: string;
};

export type DimensionalValidationResult =
  | { ok: true }
  | { ok: false; errors: DimensionalValidationError[] };

type PrismaLike = PrismaClient | Prisma.TransactionClient;

function isPolicy(v: unknown): v is DimensionPolicy {
  return v === "REQUIRED" || v === "OPTIONAL" || v === "NOT_APPLICABLE";
}

/**
 * The heart of DIM-1 posting validation. Read-only against the
 * database. Callers must run this BEFORE writing the accounting
 * line.
 *
 * When `input.departmentId` or `input.fundId` is `null | undefined`,
 * the caller is saying "no attribution for this dimension." The
 * result depends on the account's policy for that dimension:
 *   * REQUIRED       → error `*_REQUIRED`
 *   * OPTIONAL       → ok
 *   * NOT_APPLICABLE → ok
 *
 * When an id IS supplied, the service checks:
 *   * the dimension row exists and belongs to the same clubId
 *   * the account's policy is not NOT_APPLICABLE
 *   * an AccountDepartment / AccountFund applicability row exists
 *     joining this account to the supplied dimension id (if any
 *     applicability rows exist for the account; an account with
 *     ZERO applicability rows for a dimension is treated as
 *     "any dimension allowed" — this is the DIM-1 default and
 *     lets an OPTIONAL policy remain useful before applicability
 *     is populated).
 */
export async function validateLineDimensions(
  input: DimensionalValidationInput,
  client: PrismaLike = defaultPrisma,
): Promise<DimensionalValidationResult> {
  const errors: DimensionalValidationError[] = [];

  const account = await client.account.findUnique({
    where: { id: input.accountId },
    select: {
      id: true,
      clubId: true,
      departmentPolicy: true,
      fundPolicy: true,
    },
  });

  if (!account) {
    errors.push({
      code: "ACCOUNT_NOT_FOUND",
      message: `Account ${input.accountId} not found.`,
      dimension: "account",
      accountId: input.accountId,
    });
    return { ok: false, errors };
  }
  if (account.clubId !== input.clubId) {
    errors.push({
      code: "ACCOUNT_CROSS_TENANT",
      message: `Account ${input.accountId} belongs to a different tenant.`,
      dimension: "account",
      accountId: input.accountId,
    });
    return { ok: false, errors };
  }

  const departmentPolicy: DimensionPolicy = isPolicy(account.departmentPolicy)
    ? account.departmentPolicy
    : "OPTIONAL";
  const fundPolicy: DimensionPolicy = isPolicy(account.fundPolicy)
    ? account.fundPolicy
    : "OPTIONAL";

  const departmentId = input.departmentId ?? null;
  const fundId = input.fundId ?? null;

  // ---------------- Department -------------------------------------------
  if (departmentId === null) {
    if (departmentPolicy === "REQUIRED") {
      errors.push({
        code: "DEPARTMENT_REQUIRED",
        message: `Account ${input.accountId} requires a department.`,
        dimension: "department",
        accountId: input.accountId,
      });
    }
    // OPTIONAL + NOT_APPLICABLE both accept null
  } else {
    if (departmentPolicy === "NOT_APPLICABLE") {
      errors.push({
        code: "DEPARTMENT_NOT_APPLICABLE",
        message: `Account ${input.accountId} does not accept a department.`,
        dimension: "department",
        accountId: input.accountId,
        departmentId,
      });
    } else {
      const dept = await client.department.findUnique({
        where: { id: departmentId },
        select: { id: true, clubId: true },
      });
      if (!dept) {
        errors.push({
          code: "DEPARTMENT_NOT_FOUND",
          message: `Department ${departmentId} not found.`,
          dimension: "department",
          departmentId,
        });
      } else if (dept.clubId !== input.clubId) {
        errors.push({
          code: "DEPARTMENT_CROSS_TENANT",
          message: `Department ${departmentId} belongs to a different tenant.`,
          dimension: "department",
          departmentId,
        });
      } else {
        // Applicability: allowed if the account has ANY AccountDepartment
        // rows AND the supplied departmentId is one of them, OR the
        // account has no AccountDepartment rows at all ("unconstrained").
        const applicabilityCount = await client.accountDepartment.count({
          where: { accountId: input.accountId },
        });
        if (applicabilityCount > 0) {
          const allowed = await client.accountDepartment.count({
            where: {
              accountId: input.accountId,
              departmentId,
            },
          });
          if (allowed === 0) {
            errors.push({
              code: "DEPARTMENT_NOT_ALLOWED_ON_ACCOUNT",
              message: `Department ${departmentId} is not in the applicability set for account ${input.accountId}.`,
              dimension: "department",
              accountId: input.accountId,
              departmentId,
            });
          }
        }
      }
    }
  }

  // ---------------- Fund -------------------------------------------------
  if (fundId === null) {
    if (fundPolicy === "REQUIRED") {
      errors.push({
        code: "FUND_REQUIRED",
        message: `Account ${input.accountId} requires a fund.`,
        dimension: "fund",
        accountId: input.accountId,
      });
    }
  } else {
    if (fundPolicy === "NOT_APPLICABLE") {
      errors.push({
        code: "FUND_NOT_APPLICABLE",
        message: `Account ${input.accountId} does not accept a fund.`,
        dimension: "fund",
        accountId: input.accountId,
        fundId,
      });
    } else {
      const fund = await client.fund.findUnique({
        where: { id: fundId },
        select: { id: true, clubId: true, isActive: true },
      });
      if (!fund) {
        errors.push({
          code: "FUND_NOT_FOUND",
          message: `Fund ${fundId} not found.`,
          dimension: "fund",
          fundId,
        });
      } else if (fund.clubId !== input.clubId) {
        errors.push({
          code: "FUND_CROSS_TENANT",
          message: `Fund ${fundId} belongs to a different tenant.`,
          dimension: "fund",
          fundId,
        });
      } else {
        const applicabilityCount = await client.accountFund.count({
          where: { accountId: input.accountId },
        });
        if (applicabilityCount > 0) {
          const allowed = await client.accountFund.count({
            where: {
              accountId: input.accountId,
              fundId,
            },
          });
          if (allowed === 0) {
            errors.push({
              code: "FUND_NOT_ALLOWED_ON_ACCOUNT",
              message: `Fund ${fundId} is not in the applicability set for account ${input.accountId}.`,
              dimension: "fund",
              accountId: input.accountId,
              fundId,
            });
          }
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}

/**
 * Batched variant. Same semantics as `validateLineDimensions`,
 * applied to a set of proposed lines. All accounts must belong
 * to `clubId`. Returns a per-line result array in input order.
 */
export async function validateManyLineDimensions(
  clubId: string,
  lines: ReadonlyArray<{ accountId: string; departmentId?: string | null; fundId?: string | null }>,
  client: PrismaLike = defaultPrisma,
): Promise<Array<DimensionalValidationResult>> {
  const out: DimensionalValidationResult[] = [];
  for (const line of lines) {
    out.push(await validateLineDimensions({
      clubId,
      accountId: line.accountId,
      departmentId: line.departmentId ?? null,
      fundId: line.fundId ?? null,
    }, client));
  }
  return out;
}
