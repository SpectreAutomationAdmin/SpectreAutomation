// Payroll-3D-3A (2026-09-05) — Tenant Admin surface for the
// DEPARTMENT_TIME_APPROVAL responsibility assignments. Config-gap
// Work Intake cards deep-link here (§9, §K of the 3D-3A brief).
//
// Query params:
//   ?departmentId=... — pre-focus a department row in edit mode

import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import {
  listDepartmentApprovers,
  listEligibleTimesheetApprovers,
} from "@/lib/tenant-admin/department-responsibilities";
import TimeApproversClient from "./TimeApproversClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function TimeApproversPage({
  searchParams,
}: {
  searchParams?: { departmentId?: string };
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  if (!hasPermission(principal, clubId, "users:roles:write")) {
    redirect("/app/admin");
  }

  const [departments, eligibleUsers, club] = await Promise.all([
    listDepartmentApprovers(principal, clubId),
    listEligibleTimesheetApprovers(principal, clubId),
    prisma.club.findUnique({ where: { id: clubId }, select: { name: true } }),
  ]);

  const rows = departments.map((d) => ({
    departmentId:   d.departmentId,
    departmentCode: d.departmentCode,
    departmentName: d.departmentName,
    approver: d.approver ? {
      userId:    d.approver.userId,
      userName:  d.approver.userName,
      userEmail: d.approver.userEmail,
      assignedAtIso: d.approver.assignedAt.toISOString(),
    } : null,
    hasReviewableTime: d.hasReviewableTime,
    // A department needs an approver if it has recorded time and no assignee.
    needsApprover: !d.approver && d.hasReviewableTime,
  }));

  return (
    <div className="max-w-[1120px]" data-testid="time-approvers-page">
      <header className="mb-spectre-6">
        <div
          className="text-[11px] font-semibold uppercase tracking-[0.06em]"
          style={{ color: "var(--spectre-text-muted)" }}
        >
          Settings · Tenant Administration
        </div>
        <h1 className="mt-1 text-spectre-h1 font-semibold" style={{ color: "var(--spectre-text-primary)" }}>
          Timesheet approvers
        </h1>
        <p className="mt-2 text-spectre-body" style={{ color: "var(--spectre-text-secondary)" }}>
          {club?.name ?? "Your Club"} — assign the person responsible for reviewing and
          approving recorded time in each department. Missing approvers block payroll processing
          until this is set.
        </p>
        <p className="mt-2 text-[11px] text-stone-500">
          <Link href="/app/mission-control" className="underline">Return to Mission Control</Link>
        </p>
      </header>

      <TimeApproversClient
        departments={rows}
        eligibleUsers={eligibleUsers.map((u) => ({
          id: u.id, name: u.name, email: u.email, primaryRoleKey: u.primaryRoleKey,
        }))}
        focusDepartmentId={searchParams?.departmentId ?? null}
      />
    </div>
  );
}
