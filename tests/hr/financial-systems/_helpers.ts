// Shared HR financial-systems test helpers.
//
// Extends `tests/hr/security-compliance/_helpers.ts` +
// `tests/hr/admin-workflows/_helpers.ts` with fixtures specific to
// the compensation + payroll-profile services:
//   - a helper to establish the full activation trio (compensation
//     row + SIN + VERIFIED bank) so activation-precondition happy-
//     path tests read cleanly.
//
// Deliberately compact — most tests compose the primitives directly.

import { prisma } from "@/lib/prisma";
import { changeCompensation } from "@/lib/hr/compensation";
import { upsertSin } from "@/lib/hr/sensitive-identity";
import {
  upsertBankAccount,
  activateBankAccount,
} from "@/lib/hr/bank-account";
import { upsertPayrollProfile } from "@/lib/hr/payroll-profile";
import type { Principal } from "@/lib/rbac";

/**
 * Seed the compensation + SIN + verified banking + payroll-profile
 * draft rows for `employeeId`, mirroring what the seed's Employee B
 * fixture carries. Idempotent-ish — writes fresh rows each call.
 */
export async function seedActivationTrio(
  principal: Principal,
  employeeId: string,
  opts?: {
    amount?: number | string;
    cadence?: "HOURLY" | "SALARY" | "COMMISSION" | "PIECE_RATE";
    effectiveFrom?: Date;
    jurisdiction?: string;
    payGroup?: string;
    payFrequency?: "WEEKLY" | "BIWEEKLY" | "SEMI_MONTHLY" | "MONTHLY";
  },
) {
  await changeCompensation(principal, employeeId, {
    effectiveFrom: opts?.effectiveFrom ?? new Date("2024-01-01T00:00:00.000Z"),
    amount: opts?.amount ?? 22,
    cadence: opts?.cadence ?? "HOURLY",
    currency: "CAD",
  });
  await upsertSin(principal, employeeId, "123456789");
  await upsertBankAccount(principal, employeeId, {
    institutionNumber: "003",
    transitNumber: "12345",
    accountNumber: "9876543210",
    holderName: "River Sensitive",
  });
  await activateBankAccount(principal, employeeId);
  await upsertPayrollProfile(principal, employeeId, {
    jurisdiction: opts?.jurisdiction ?? "CA-ON",
    payGroup: opts?.payGroup ?? "BIWEEKLY_HOURLY",
    payFrequency: opts?.payFrequency ?? "BIWEEKLY",
  });
}

/**
 * Return the currently-open EmployeeCompensation row for the
 * employee (helper for assertions).
 */
export async function currentOpenCompensationRow(employeeId: string) {
  return prisma.employeeCompensation.findFirst({
    where: { employeeId, effectiveTo: null },
    orderBy: { effectiveFrom: "desc" },
  });
}

/**
 * Count rows where `effectiveTo IS NULL` for a given employee.
 */
export async function countOpenCompensationRows(employeeId: string) {
  return prisma.employeeCompensation.count({
    where: { employeeId, effectiveTo: null },
  });
}
