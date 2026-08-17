// HR-2A (2026-08-16) — Onboarding list.
//
// Every in-flight onboarding session in the club: DRAFT (awaiting
// invitation), INVITED (magic link issued), IN_PROGRESS (employee
// filling out the questionnaire), SUBMITTED (waiting on staff
// approval). Terminal states (APPROVED, REJECTED, REVOKED) are
// intentionally excluded — this is a work-queue view.
//
// Discipline:
//   • Permission gate: `hr:onboarding:read`.
//   • List reads via `prisma.employeeOnboardingSession.findMany`
//     with an explicit `where: {clubId}` — the same convention the
//     Directory uses.
//   • The "invite status" column looks up the most recent
//     non-terminal `EmployeeOnboardingInvitation` for each employee
//     in one batched query.

import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

export default async function OnboardingListPage() {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!hasPermission(principal, clubId, "hr:onboarding:read")) {
    redirect("/app/admin");
  }

  const sessions = await prisma.employeeOnboardingSession.findMany({
    where: {
      clubId,
      state: { in: ["DRAFT", "INVITED", "IN_PROGRESS", "SUBMITTED"] },
    },
    select: {
      id: true,
      state: true,
      startedAt: true,
      submittedAt: true,
      approvedAt: true,
      rejectedAt: true,
      completedAt: true,
      employee: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          preferredName: true,
          expectedStartDate: true,
          payrollReadiness: true,
          department: { select: { name: true } },
          position: { select: { name: true } },
        },
      },
    },
    // Prisma orders by column position (state string) which is
    // enough to group DRAFTs together in the founder-approved
    // "work queue" reading order; secondary sort surfaces the most
    // recently touched row first inside each state.
    orderBy: [{ state: "asc" }, { startedAt: "desc" }],
  });

  // Most-recent non-terminal invitation per employee, single query.
  const invitations =
    sessions.length === 0
      ? []
      : await prisma.employeeOnboardingInvitation.findMany({
          where: {
            clubId,
            employeeId: { in: sessions.map((s) => s.employee.id) },
            revokedAt: null,
          },
          select: {
            employeeId: true,
            expiresAt: true,
            redeemedAt: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
        });
  const inviteByEmployee = new Map<
    string,
    { expiresAt: Date; redeemedAt: Date | null; createdAt: Date }
  >();
  for (const inv of invitations) {
    if (!inviteByEmployee.has(inv.employeeId)) {
      inviteByEmployee.set(inv.employeeId, inv);
    }
  }

  return (
    <div>
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="page-title">Onboarding</h1>
          <p className="mt-1 text-stone-500">
            Every in-flight employee onboarding: from DRAFT (awaiting invitation) through
            SUBMITTED (waiting on your review).
          </p>
        </div>
        <Link href="/app/admin/people/employees/new" className="btn btn-secondary">
          + Add Employee
        </Link>
      </div>

      <div className="card mt-6 overflow-hidden">
        <table className="table-base">
          <thead>
            <tr>
              <th>Employee</th>
              <th>Position</th>
              <th>Department</th>
              <th>Expected start</th>
              <th>State</th>
              <th>Invitation</th>
              <th>Last activity</th>
              <th>Payroll</th>
            </tr>
          </thead>
          <tbody>
            {sessions.length === 0 && (
              <tr>
                <td colSpan={8} className="px-6 py-10 text-center text-stone-500">
                  No in-flight onboarding sessions.
                </td>
              </tr>
            )}
            {sessions.map((s) => {
              const employee = s.employee;
              const displayName = employee.preferredName?.trim().length
                ? `${employee.preferredName} ${employee.lastName}`
                : `${employee.firstName} ${employee.lastName}`;
              const invite = inviteByEmployee.get(employee.id);
              const inviteStatus = !invite
                ? "None"
                : invite.redeemedAt
                  ? "Redeemed"
                  : invite.expiresAt.getTime() < Date.now()
                    ? "Expired"
                    : "Active";
              return (
                <tr key={s.id}>
                  <td>
                    <Link
                      href={`/app/admin/people/employees/${employee.id}`}
                      className="font-medium text-club-ink hover:text-club-green-700"
                    >
                      {displayName}
                    </Link>
                  </td>
                  <td className="text-stone-600">{employee.position?.name ?? "—"}</td>
                  <td className="text-stone-600">{employee.department?.name ?? "—"}</td>
                  <td className="text-xs text-stone-600">
                    {employee.expectedStartDate ? formatDate(employee.expectedStartDate) : "—"}
                  </td>
                  <td><Badge status={s.state} /></td>
                  <td className="text-xs">
                    {invite ? (
                      <span className="text-stone-600">
                        {inviteStatus}
                        {inviteStatus === "Active" && (
                          <span className="text-stone-400"> · exp {formatDate(invite.expiresAt)}</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-stone-400">{inviteStatus}</span>
                    )}
                  </td>
                  <td className="text-xs text-stone-600">
                    {formatDate(
                      s.completedAt ?? s.rejectedAt ?? s.approvedAt ?? s.submittedAt ?? s.startedAt,
                    )}
                  </td>
                  <td><Badge status={employee.payrollReadiness} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
