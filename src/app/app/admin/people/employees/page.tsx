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
import { loadEmployeeDirectory, type EmployeeDirectoryScope } from "./loader";

function coerceScope(raw: string | string[] | undefined): EmployeeDirectoryScope {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === "archived" || v === "all") return v;
  return "active";
}

export default async function EmployeeDirectoryPage({
  searchParams,
}: {
  searchParams?: { scope?: string | string[] };
}) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!hasPermission(principal, clubId, "hr:directory:view")) {
    redirect("/app/admin");
  }

  const scope = coerceScope(searchParams?.scope);
  const employees = await loadEmployeeDirectory(clubId, scope);

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

      {/* HR-2B.3.6 — restrained scope filter. Default view hides
          ARCHIVED and TERMINATED. */}
      <nav
        aria-label="Employee directory filter"
        data-testid="directory-scope-filter"
        className="mt-4 flex items-center gap-1 text-xs"
      >
        {(["active", "archived", "all"] as EmployeeDirectoryScope[]).map((s) => {
          const label = s === "active" ? "Active" : s === "archived" ? "Archived" : "All";
          const isCurrent = scope === s;
          return (
            <Link
              key={s}
              href={s === "active" ? "/app/admin/people/employees" : `/app/admin/people/employees?scope=${s}`}
              className={`rounded-md px-2.5 py-1 ${
                isCurrent
                  ? "bg-stone-900 text-white"
                  : "text-stone-600 hover:bg-stone-100 hover:text-stone-900"
              }`}
              data-testid={`directory-scope-${s}`}
              aria-current={isCurrent ? "page" : undefined}
            >
              {label}
            </Link>
          );
        })}
      </nav>

      {employees.length === 0 ? (
        // HR-2A.1 (2026-08-17) — proper hero empty state instead of a
        // near-empty table row floating on cream. Founder brief §10:
        // "excessive whitespace" is a defect. Give the empty state
        // substance (explanation of what this page will contain +
        // primary CTA + secondary link to Onboarding) so the page
        // reads intentional rather than unfinished.
        <div className="card mt-6 p-10 md:p-12">
          <div className="max-w-2xl">
            <h2 className="font-serif text-2xl text-club-ink">
              Your employee roster starts here.
            </h2>
            <p className="mt-3 text-stone-500 leading-relaxed">
              Every active and pre-hire staff member at your club will appear here.
              When you add someone, they enter the onboarding queue — you invite them,
              they submit their own banking, SIN, and tax information, and Payroll
              Admin activates them. Their lifecycle, position, and payroll readiness
              live on this page from day one.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Link href="/app/admin/people/employees/new" className="btn btn-primary">
                + Add your first employee
              </Link>
              <Link
                href="/app/admin/people/onboarding"
                className="text-sm text-stone-500 hover:text-club-ink"
              >
                Already invited someone? Check the Onboarding queue →
              </Link>
            </div>
          </div>
        </div>
      ) : (
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
      )}
    </div>
  );
}
