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
import { getDeleteEligibility, getEmployee } from "@/lib/hr/employees";
import { listEmploymentPeriods } from "@/lib/hr/employment-periods";
import { listEmployeeDocuments } from "@/lib/hr/documents";
import { listSessions, listTransitions } from "@/lib/hr/onboarding-sessions";
import { getSinMasked } from "@/lib/hr/sensitive-identity";
import { getBankAccountMasked } from "@/lib/hr/bank-account";
import { getTaxProfileMasked } from "@/lib/hr/tax-profile";
import { isAppError } from "@/lib/errors";
import EmployeeProfileView from "@/components/hr/EmployeeProfileView";
import EmployeeLifecycleControls from "@/components/hr/EmployeeLifecycleControls";

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
  const canReadSin = hasPermission(principal, profile.clubId, "hr:sin:read");
  const canReadBanking = hasPermission(principal, profile.clubId, "hr:banking:read");
  const canReadTax = hasPermission(principal, profile.clubId, "hr:tax:read");

  const [
    employmentPeriods,
    documents,
    sessions,
    memberLink,
    department,
    position,
    manager,
    sinMasked,
    bankingMasked,
    taxProfileMasked,
    td1Attestations,
  ] = await Promise.all([
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
    canReadSin ? getSinMasked(principal, profile.id) : Promise.resolve(null),
    canReadBanking ? getBankAccountMasked(principal, profile.id) : Promise.resolve(null),
    canReadTax ? getTaxProfileMasked(principal, profile.id) : Promise.resolve(null),
    canReadOnboarding
      ? prisma.employeeOnboardingAcknowledgement.findMany({
          where: {
            clubId: profile.clubId,
            employeeId: profile.id,
            kind: { in: ["td1_federal_attestation", "td1_provincial_attestation"] },
          },
          select: { kind: true, acknowledgedAt: true },
        })
      : Promise.resolve([]),
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
  const canWritePhoto = hasPermission(principal, profile.clubId, "hr:employee:write");

  // HR-2B.3.6 (2026-08-19) — Lifecycle controls: Delete vs Archive.
  // Only surface controls to operators with hr:employee:write; the API
  // route re-checks so the button never becomes an authority.
  const canLifecycle = hasPermission(principal, profile.clubId, "hr:employee:write");
  const deleteEligibility = canLifecycle
    ? await getDeleteEligibility(principal, profile.id)
    : null;

  // HR-2B.3.1 (2026-08-18) §5 — Resend invitation. The Invite button
  // covers the DRAFT case (never sent yet). Resend covers the "already
  // been in the employee's inbox" cases:
  //   • INVITED       — link may be lost, unused
  //   • IN_PROGRESS   — link already redeemed but employee needs a
  //                     fresh one to resume from another device / after
  //                     losing the email
  // Both branches require the operator's `hr:onboarding:invite` grant.
  const RESEND_STATES = ["INVITED", "IN_PROGRESS"] as const;
  const hasInviteGrant = hasPermission(principal, profile.clubId, "hr:onboarding:invite");
  const sessionResumable =
    currentSession != null && (RESEND_STATES as readonly string[]).includes(currentSession.state);
  const mostRecentInvitation = hasInviteGrant
    ? await prisma.employeeOnboardingInvitation.findFirst({
        where: { clubId: profile.clubId, employeeId: profile.id },
        orderBy: { createdAt: "desc" },
        select: { id: true, createdAt: true },
      })
    : null;
  const priorInvitation = mostRecentInvitation
    ? {
        createdAt: mostRecentInvitation.createdAt.toISOString(),
        recipientEmail: profile.personalEmail ?? profile.email ?? null,
      }
    : null;
  const canResendInvitation = hasInviteGrant && sessionResumable && mostRecentInvitation != null;

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
      canWritePhoto={canWritePhoto}
      canResendInvitation={canResendInvitation}
      priorInvitation={priorInvitation}
      payroll={{
        sinMasked: canReadSin ? sinMasked : null,
        sinAccessible: canReadSin,
        bankingMasked: canReadBanking && bankingMasked
          ? {
              accountMasked: bankingMasked.accountMasked,
              holderName: bankingMasked.holderName,
              status: bankingMasked.status,
              activatedAt: bankingMasked.activatedAt
                ? bankingMasked.activatedAt.toISOString()
                : null,
            }
          : null,
        bankingAccessible: canReadBanking,
        taxProfileMasked: canReadTax && taxProfileMasked
          ? {
              province: taxProfileMasked.province,
              td1FormVersion: taxProfileMasked.td1FormVersion,
              effectiveFrom: taxProfileMasked.effectiveFrom.toISOString(),
              hasAdditionalDeductions: taxProfileMasked.hasAdditionalDeductions,
            }
          : null,
        taxAccessible: canReadTax,
        td1Attestations: td1Attestations.map((a) => ({
          kind: a.kind,
          acknowledgedAt: a.acknowledgedAt.toISOString(),
        })),
      }}
      lifecycleControls={
        canLifecycle && deleteEligibility ? (
          <EmployeeLifecycleControls
            employeeId={profile.id}
            employeeName={`${profile.firstName} ${profile.lastName}`}
            eligibility={deleteEligibility}
            currentLifecycle={profile.employeeLifecycle}
          />
        ) : null
      }
    />
  );
}
