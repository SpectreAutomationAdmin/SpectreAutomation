// HR-2A.3 (2026-08-17) — Employee profile page. Server component
// that loads all data through canonical HR services (getEmployee,
// listEmploymentPeriods, listEmployeeDocuments, listSessions,
// listTransitions) and hands serialized props to the presentation
// client component (`EmployeeProfileView`). All security boundaries
// preserved: no reveal APIs, masked sensitive data via getEmployee,
// tenant scope via the canonical services, permission checks unchanged.
//
// The presentation lives in EmployeeProfileView because HR-2A.3 uses
// the Phase 20 profile primitives (extracted from
// src/components/members/MemberProfileView.tsx at commit 8668cef on
// branch work-intake-state-outlook-archive-fix — not merged to main)
// as its visual template. See the founder's HR-2A.3 brief for the
// approved reference screenshot.

import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { getEmployee } from "@/lib/hr/employees";
import { listEmploymentPeriods } from "@/lib/hr/employment-periods";
import { listEmployeeDocuments } from "@/lib/hr/documents";
import { listSessions, listTransitions } from "@/lib/hr/onboarding-sessions";
import { isAppError } from "@/lib/errors";
import EmployeeProfileView from "@/components/hr/EmployeeProfileView";

export default async function EmployeeProfilePage({
  params,
}: {
  params: { id: string };
}) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");

  let profile: Awaited<ReturnType<typeof getEmployee>>;
  try {
    profile = await getEmployee(principal, params.id);
  } catch (err) {
    if (isAppError(err) && err.httpStatus === 404) notFound();
    if (isAppError(err) && err.httpStatus === 403) redirect("/app/admin");
    throw err;
  }

  const canReadDocuments = hasPermission(principal, profile.clubId, "hr:documents:read");
  const canReadOnboarding = hasPermission(principal, profile.clubId, "hr:onboarding:read");
  const canReadEmployment = hasPermission(principal, profile.clubId, "hr:employment:read");

  const [employmentPeriods, documents, sessions, memberLink, department, position, manager] =
    await Promise.all([
      canReadEmployment ? listEmploymentPeriods(principal, profile.id) : Promise.resolve([]),
      canReadDocuments ? listEmployeeDocuments(principal, profile.id) : Promise.resolve([]),
      canReadOnboarding ? listSessions(principal, profile.id) : Promise.resolve([]),
      profile.memberId
        ? prisma.member.findUnique({
            where: { id: profile.memberId },
            select: { id: true, memberNumber: true, firstName: true, lastName: true, clubId: true },
          })
        : Promise.resolve(null),
      profile.departmentId
        ? prisma.department.findUnique({
            where: { id: profile.departmentId },
            select: { id: true, name: true, code: true },
          })
        : Promise.resolve(null),
      profile.positionId
        ? prisma.employeePosition.findUnique({
            where: { id: profile.positionId },
            select: { id: true, name: true, code: true },
          })
        : Promise.resolve(null),
      profile.managerEmployeeId
        ? prisma.employee.findUnique({
            where: { id: profile.managerEmployeeId },
            select: { id: true, firstName: true, lastName: true, preferredName: true },
          })
        : Promise.resolve(null),
    ]);

  const currentSession =
    sessions.find((s) => s.state === "DRAFT")
    ?? sessions.find((s) => !["REVOKED", "APPROVED"].includes(s.state))
    ?? sessions[0]
    ?? null;
  const transitions =
    currentSession && canReadOnboarding
      ? await listTransitions(principal, currentSession.id)
      : [];

  const canInvite =
    hasPermission(principal, profile.clubId, "hr:onboarding:invite") &&
    currentSession?.state === "DRAFT";

  return (
    <EmployeeProfileView
      employee={{
        id: profile.id,
        clubId: profile.clubId,
        employeeNumber: profile.employeeNumber,
        firstName: profile.firstName,
        middleName: profile.middleName ?? null,
        lastName: profile.lastName,
        preferredName: profile.preferredName ?? null,
        email: profile.email ?? null,
        personalEmail: profile.personalEmail ?? null,
        phone: profile.phone ?? null,
        mobilePhone: profile.mobilePhone ?? null,
        hireDate: profile.hireDate ? profile.hireDate.toISOString() : null,
        expectedStartDate: profile.expectedStartDate ? profile.expectedStartDate.toISOString() : null,
        employmentType: profile.employmentType ?? null,
        employeeLifecycle: profile.employeeLifecycle,
        onboardingState: profile.onboardingState,
        payrollReadiness: profile.payrollReadiness,
        memberId: profile.memberId ?? null,
        profilePhotoDocumentId: profile.profilePhotoDocumentId ?? null,
      }}
      department={department ? { id: department.id, name: department.name, code: department.code } : null}
      position={position ? { id: position.id, name: position.name, code: position.code } : null}
      manager={
        manager
          ? {
              id: manager.id,
              firstName: manager.firstName,
              lastName: manager.lastName,
              preferredName: manager.preferredName ?? null,
            }
          : null
      }
      memberLink={
        memberLink
          ? {
              id: memberLink.id,
              memberNumber: memberLink.memberNumber,
              firstName: memberLink.firstName,
              lastName: memberLink.lastName,
            }
          : null
      }
      employmentPeriods={employmentPeriods.map((p) => ({
        id: p.id,
        effectiveFrom: p.effectiveFrom.toISOString(),
        effectiveTo: p.effectiveTo ? p.effectiveTo.toISOString() : null,
        employmentType: p.employmentType,
        reason: p.reason,
      }))}
      documents={documents.map((d) => ({
        id: d.id,
        category: d.category,
        displayName: d.displayName ?? null,
        sensitivity: d.sensitivity,
        uploadedAt: d.uploadedAt.toISOString(),
      }))}
      currentSession={
        currentSession ? { id: currentSession.id, state: currentSession.state } : null
      }
      transitions={transitions.map((t) => ({
        id: t.id,
        at: t.at.toISOString(),
        fromState: t.fromState,
        toState: t.toState,
        actorSource: t.actorSource,
        reason: t.reason ?? null,
      }))}
      canInvite={canInvite}
    />
  );
}
