// HR-2A (2026-08-16) — Employee Directory loader.
//
// Extracted into its own module so the source-contract + directory-
// shape tests can exercise the exact query the page runs, without
// having to boot a Next.js render pipeline. The page module imports
// `loadEmployeeDirectory` and passes the resulting rows into the
// server component — no sensitive fields are ever selected here.
//
// Discipline:
//   • Never selects SIN, banking, tax, or restricted-document fields.
//   • Uses the tenant-scoped Prisma query pattern established by
//     the Members list (`prisma.<model>.findMany({where: {clubId}})`).
//   • Excludes TERMINATED employees by default — a future slice
//     will add a "Show terminated" toggle.

import { prisma } from "@/lib/prisma";

export interface EmployeeDirectoryRow {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  preferredName: string | null;
  email: string | null;
  employmentType: string | null;
  employeeLifecycle: string;
  onboardingState: string;
  payrollReadiness: string;
  expectedStartDate: Date | null;
  hireDate: Date | null;
  department: { id: string; name: string } | null;
  position: { id: string; title: string } | null;
  member: { id: string; memberNumber: string } | null;
  profilePhotoDocumentId: string | null;
}

export type EmployeeDirectoryScope = "active" | "archived" | "all";

export async function loadEmployeeDirectory(
  clubId: string,
  scope: EmployeeDirectoryScope = "active",
): Promise<EmployeeDirectoryRow[]> {
  // HR-2B.3.6 (2026-08-19) — Default view excludes ARCHIVED and
  // TERMINATED. The founder-facing directory filter (?scope=archived
  // / ?scope=all) flips this without ever destroying history.
  const lifecycleWhere =
    scope === "active"
      ? { in: ["PRE_HIRE", "ACTIVE", "LEAVE"] as string[] }
      : scope === "archived"
        ? { in: ["ARCHIVED", "TERMINATED"] as string[] }
        : undefined;
  const rows = await prisma.employee.findMany({
    where: {
      clubId,
      ...(lifecycleWhere ? { employeeLifecycle: lifecycleWhere } : {}),
    },
    select: {
      id: true,
      employeeNumber: true,
      firstName: true,
      lastName: true,
      preferredName: true,
      email: true,
      employmentType: true,
      employeeLifecycle: true,
      onboardingState: true,
      payrollReadiness: true,
      expectedStartDate: true,
      hireDate: true,
      profilePhotoDocumentId: true,
      department: { select: { id: true, name: true } },
      // EmployeePosition uses `name` as its title column — expose it
      // as `title` in the directory row so the UI + tests speak the
      // same language regardless of the underlying schema field.
      position: { select: { id: true, name: true } },
      member: { select: { id: true, memberNumber: true } },
    },
    orderBy: [
      { employeeLifecycle: "asc" },
      { lastName: "asc" },
      { firstName: "asc" },
    ],
  });
  return rows.map((r) => ({
    id: r.id,
    employeeNumber: r.employeeNumber,
    firstName: r.firstName,
    lastName: r.lastName,
    preferredName: r.preferredName,
    email: r.email,
    employmentType: r.employmentType,
    employeeLifecycle: r.employeeLifecycle,
    onboardingState: r.onboardingState,
    payrollReadiness: r.payrollReadiness,
    expectedStartDate: r.expectedStartDate,
    hireDate: r.hireDate,
    department: r.department,
    position: r.position ? { id: r.position.id, title: r.position.name } : null,
    member: r.member,
    profilePhotoDocumentId: r.profilePhotoDocumentId,
  }));
}
