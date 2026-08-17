// HR-2A (2026-08-16) — Employee Directory.
//
// Club-side administrative view of every employee (excluding
// TERMINATED). The rows come from the shared loader helper
// (`./loader`) so the source-contract tests can exercise the same
// query the page runs.
//
// Discipline:
//   • Reads the tenant-scoped Employee list via a plain `findMany`
//     with an explicit `where: { clubId }` — the same pattern the
//     Members list uses. This is intentional per HR-2A: list reads
//     stay on the existing repo convention, mutations go through
//     canonical services (`src/lib/hr/**`).
//   • Never selects SIN / bank / tax fields; never calls any
//     reveal API. The "Member indicator" is a link derived from
//     `employee.member` (canonical link) — if `employee.memberId`
//     is null, nothing is rendered. Employee C fixture (child-of-
//     Member) MUST have no indicator.
//   • Permission gate: `hr:directory:view`.

import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { Badge } from "@/components/Badge";
import EmployeeAvatar from "@/components/hr/EmployeeAvatar";
import { formatDate } from "@/lib/finance";
import { loadEmployeeDirectory } from "./loader";

export default async function EmployeeDirectoryPage() {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!hasPermission(principal, clubId, "hr:directory:view")) {
    redirect("/app/admin");
  }

  const employees = await loadEmployeeDirectory(clubId);

  return (
    <div>
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="page-title">Employee Directory</h1>
          <p className="mt-1 text-stone-500">
            Every active and pre-hire employee at your club. Add a new employee to begin
            the onboarding workflow.
          </p>
        </div>
        <Link href="/app/admin/people/employees/new" className="btn btn-primary">
          + Add Employee
        </Link>
      </div>

      <div className="card mt-6 overflow-hidden">
        <table className="table-base">
          <thead>
            <tr>
              <th className="w-14"></th>
              <th>Employee</th>
              <th>Position</th>
              <th>Department</th>
              <th>Type</th>
              <th>Lifecycle</th>
              <th>Onboarding</th>
              <th>Payroll</th>
              <th>Start</th>
              <th>Member</th>
            </tr>
          </thead>
          <tbody>
            {employees.length === 0 && (
              <tr>
                <td colSpan={10} className="px-6 py-10 text-center">
                  <div className="text-stone-500">No employees on file yet.</div>
                  <div className="mt-4">
                    <Link href="/app/admin/people/employees/new" className="btn btn-primary">
                      + Add your first employee
                    </Link>
                  </div>
                </td>
              </tr>
            )}
            {employees.map((e) => {
              const displayName = e.preferredName?.trim().length
                ? `${e.preferredName} ${e.lastName}`
                : `${e.firstName} ${e.lastName}`;
              return (
                <tr key={e.id}>
                  <td>
                    <EmployeeAvatar
                      firstName={e.firstName}
                      lastName={e.lastName}
                      size={36}
                    />
                  </td>
                  <td>
                    <Link
                      href={`/app/admin/people/employees/${e.id}`}
                      className="font-medium text-club-ink hover:text-club-green-700"
                    >
                      {displayName}
                    </Link>
                    <div className="text-xs text-stone-500">
                      {e.email ?? e.employeeNumber}
                    </div>
                  </td>
                  <td className="text-stone-600">{e.position?.title ?? "—"}</td>
                  <td className="text-stone-600">{e.department?.name ?? "—"}</td>
                  <td className="text-stone-600 text-xs">
                    {e.employmentType?.replace(/_/g, " ") ?? "—"}
                  </td>
                  <td><Badge status={e.employeeLifecycle} /></td>
                  <td><Badge status={e.onboardingState} /></td>
                  <td><Badge status={e.payrollReadiness} /></td>
                  <td className="text-xs text-stone-600">
                    {e.expectedStartDate
                      ? formatDate(e.expectedStartDate)
                      : e.hireDate
                        ? formatDate(e.hireDate)
                        : "—"}
                  </td>
                  <td className="text-xs">
                    {e.member ? (
                      <Link
                        href={`/app/admin/members/${e.member.id}`}
                        className="text-club-green-700 hover:underline"
                      >
                        · #{e.member.memberNumber}
                      </Link>
                    ) : (
                      <span className="text-stone-400">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
