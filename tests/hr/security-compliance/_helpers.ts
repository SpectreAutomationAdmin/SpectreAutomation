// Shared HR security-compliance test helpers. Constructs the
// minimum fixture surface for the HR service tests — a Club, an
// Employee, and Principals representing every role we exercise (a
// PAYROLL_ADMIN with reveal grants, a CLUB_ADMIN with write-but-not-
// reveal, an AUDITOR_READ_ONLY, and a foreign-club CLUB_ADMIN for
// tenant boundary tests).
//
// Deliberately compact — the goal is one import per test file and
// idiomatic principal construction that matches what production
// code sees.

import { prisma } from "@/lib/prisma";
import type { Principal } from "@/lib/rbac";
import type { RoleKey } from "@/lib/permissions";
import { makeClub, makeUser, principalFor } from "../../util/db";

export interface HrFixture {
  club: { id: string; name: string };
  employee: { id: string; clubId: string };
  payrollAdmin: Principal;
  clubAdmin: Principal;
  auditor: Principal;
}

export async function makeEmployee(clubId: string, opts?: {
  firstName?: string; lastName?: string; email?: string;
}) {
  const employeeNumber = "E-" + Math.floor(Math.random() * 1_000_000);
  return prisma.employee.create({
    data: {
      clubId,
      employeeNumber,
      firstName: opts?.firstName ?? "Test",
      lastName: opts?.lastName ?? "Employee",
      email: opts?.email ?? `e${Date.now()}_${Math.floor(Math.random() * 10000)}@example.com`,
      compensationType: "HOURLY",
      payRate: 20,
      status: "ACTIVE",
    },
  });
}

async function makePrincipal(email: string, role: RoleKey, clubId: string): Promise<Principal> {
  await makeUser({ email, role, clubId });
  return principalFor(email);
}

export async function makeHrFixture(clubName = "Nightingale HR Club"): Promise<HrFixture> {
  const club = await makeClub(clubName);
  const employee = await makeEmployee(club.id, { firstName: "River", lastName: "Sensitive" });
  const payrollAdmin = await makePrincipal(
    `payroll-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    "PAYROLL_ADMIN",
    club.id,
  );
  const clubAdmin = await makePrincipal(
    `admin-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    "CLUB_ADMIN",
    club.id,
  );
  const auditor = await makePrincipal(
    `auditor-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    "AUDITOR_READ_ONLY",
    club.id,
  );
  return { club, employee, payrollAdmin, clubAdmin, auditor };
}

/** Return the most recent audit log entry for a given entity id. */
export async function latestAuditFor(entityId: string) {
  return prisma.auditLog.findFirst({
    where: { entityId },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Return the concatenation of every audit column that could carry
 * a plaintext value. Used by the redaction tests to search for
 * accidental plaintext SIN / bank / claim leaks.
 */
export function auditRowText(
  row: { beforeJson: string | null; afterJson: string | null; metaJson: string | null } | null,
): string {
  if (!row) return "";
  return `${row.beforeJson ?? ""} | ${row.afterJson ?? ""} | ${row.metaJson ?? ""}`;
}
