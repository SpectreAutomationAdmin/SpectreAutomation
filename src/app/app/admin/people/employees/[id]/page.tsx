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
import { listAssignments, provisionInitialAssignmentIfMissing } from "@/lib/hr/employment-assignments";
import { listCompensationHistory } from "@/lib/hr/compensation";
import { listAllowances } from "@/lib/hr/allowances";
import {
  addAssignmentAction,
  endAssignmentAction,
  changeCompensationAction,
  addAllowanceAction,
  endAllowanceAction,
  createEmployeePositionInlineAction,
} from "./_employment-actions";
import { listEmployeeDocuments } from "@/lib/hr/documents";
import { listSessions, listTransitions } from "@/lib/hr/onboarding-sessions";
import { getSinMasked } from "@/lib/hr/sensitive-identity";
import { getBankAccountMasked } from "@/lib/hr/bank-account";
import { getTaxProfileMasked } from "@/lib/hr/tax-profile";
import { isAppError } from "@/lib/errors";
import EmployeeProfileView from "@/components/hr/EmployeeProfileView";
import EmployeeLifecycleControls from "@/components/hr/EmployeeLifecycleControls";
import EmployeeEmploymentSection from "@/components/hr/EmployeeEmploymentSection";
import EmployeeTrainingSection from "@/components/hr/EmployeeTrainingSection";
import { getEmployeeTrainingRecord } from "@/lib/hr/training/compliance";
import { listClubCourses } from "@/lib/hr/training/courses";
import { assignTrainingCourseAction } from "./_training-actions";

export default async function EmployeeProfilePage({
  params, searchParams,
}: {
  params: { id: string };
  searchParams?: Promise<{ tab?: string }>;
}) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const sp = (await (searchParams ?? Promise.resolve({}))) as { tab?: string };
  const defaultTab = sp.tab?.trim() || undefined;

  let profile: Awaited<ReturnType<typeof getEmployee>>;
  try {
    profile = await getEmployee(principal, params.id);
  } catch (err) {
    if (isAppError(err) && err.httpStatus === 404) notFound();
    if (isAppError(err) && err.httpStatus === 403) redirect("/app/admin");
    throw err;
  }

  // HR-2C Employment Corrections (2026-08-24) — Ensure any legacy
  // employee viewed through this page has a canonical PRIMARY
  // assignment provisioned from their legacy Employee fields before
  // Employment reads run. Idempotent — no-op when an assignment
  // already exists.
  await provisionInitialAssignmentIfMissing(profile.clubId, profile.id, principal.id);

  const canReadDocuments = hasPermission(principal, profile.clubId, "hr:documents:read");
  const canReadOnboarding = hasPermission(principal, profile.clubId, "hr:onboarding:read");
  const canReadEmployment = hasPermission(principal, profile.clubId, "hr:employment:read");
  const canWriteEmployment = hasPermission(principal, profile.clubId, "hr:employment:write");
  const canReadCompensation = hasPermission(principal, profile.clubId, "hr:compensation:read");
  const canWriteCompensation = hasPermission(principal, profile.clubId, "hr:compensation:write");
  const canReadAllowance = hasPermission(principal, profile.clubId, "hr:allowance:read");
  const canWriteAllowance = hasPermission(principal, profile.clubId, "hr:allowance:write");
  const canReadSin = hasPermission(principal, profile.clubId, "hr:sin:read");
  const canReadBanking = hasPermission(principal, profile.clubId, "hr:banking:read");
  const canReadTax = hasPermission(principal, profile.clubId, "hr:tax:read");
  // HR-2B.4 (2026-08-19)
  const canReadEmergency = hasPermission(principal, profile.clubId, "hr:emergency:read");
  const canReadCredentials = hasPermission(principal, profile.clubId, "hr:credentials:read");
  // HR-2C B5 (2026-08-28) — Training compliance visibility on the
  // profile requires the same permission as the Compliance dashboard.
  const canReadTrainingCompliance = hasPermission(
    principal, profile.clubId, "hr:training:compliance:read",
  );
  const canAssignTraining = hasPermission(principal, profile.clubId, "hr:training:assign");

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

  // HR-2C Employment (2026-08-24) — Employment tab data.
  const [assignments, compensationHistory, allowances, deptOptions, positionOptions, managerOptions] = await Promise.all([
    canReadEmployment ? listAssignments(principal, profile.id) : Promise.resolve([]),
    canReadCompensation ? listCompensationHistory(principal, profile.id) : Promise.resolve([]),
    canReadAllowance ? listAllowances(principal, profile.id) : Promise.resolve([]),
    canReadEmployment
      ? prisma.department.findMany({
          where: { clubId: profile.clubId },
          select: { id: true, name: true, code: true },
          orderBy: { name: "asc" },
        })
      : Promise.resolve([]),
    canReadEmployment
      ? prisma.employeePosition.findMany({
          where: { clubId: profile.clubId, isActive: true },
          select: { id: true, name: true, code: true, departmentId: true },
          orderBy: { name: "asc" },
        })
      : Promise.resolve([]),
    canReadEmployment
      ? prisma.employee
          .findMany({
            where: { clubId: profile.clubId, status: { not: "TERMINATED" }, id: { not: profile.id } },
            select: { id: true, firstName: true, preferredName: true, lastName: true },
            orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
            take: 200,
          })
          .then((rows) =>
            rows.map((r) => ({ id: r.id, label: `${r.preferredName ?? r.firstName} ${r.lastName}` })),
          )
      : Promise.resolve([]),
  ]);

  // HR-2B.4 (2026-08-19) — Emergency contact + Credentials rollup for
  // the admin profile. Both are permission-gated. Emergency-contact
  // phone/email is HR-sensitive, so we redact structured plaintext
  // fields when the caller lacks `hr:emergency:read`.
  const [emergencyContacts, credentials] = await Promise.all([
    canReadEmergency
      ? prisma.employeeEmergencyContact.findMany({
          where: { employeeId: profile.id, clubId: profile.clubId },
          orderBy: [{ isPrimary: "desc" }, { name: "asc" }],
          select: { id: true, name: true, relation: true, phone: true, email: true, isPrimary: true, updatedAt: true },
        })
      : Promise.resolve([]),
    canReadCredentials
      ? prisma.employeeCredential.findMany({
          where: { employeeId: profile.id, clubId: profile.clubId },
          orderBy: [{ expiresAt: "asc" }, { credentialCode: "asc" }],
          select: {
            id: true, credentialCode: true, displayName: true,
            issuer: true, reference: true, issuedAt: true, expiresAt: true,
            documentId: true, updatedAt: true,
          },
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

  // HR-2C Employment Corrections (2026-08-24) — Overview canonical
  // derivation. Prefer the current PRIMARY assignment's
  // department/position/manager/employmentType. Fall back to legacy
  // Employee fields only when no primary assignment exists (e.g.
  // employees with zero legacy data too, where provisioning had
  // nothing to backfill from).
  const primaryAssignmentRow = assignments.find((a) => a.role === "PRIMARY" && a.isCurrent) ?? null;

  const overviewDeptId = primaryAssignmentRow?.departmentId ?? profile.departmentId ?? null;
  const overviewPositionId = primaryAssignmentRow?.positionId ?? profile.positionId ?? null;
  const overviewManagerId = primaryAssignmentRow?.managerEmployeeId ?? profile.managerEmployeeId ?? null;

  const canonicalDepartment = overviewDeptId
    ? (deptOptions.find((d) => d.id === overviewDeptId) ?? department)
    : null;
  const canonicalPosition = overviewPositionId
    ? (positionOptions.find((p) => p.id === overviewPositionId) ?? position)
    : null;
  const canonicalManager = overviewManagerId
    ? (manager?.id === overviewManagerId
        ? manager
        : await prisma.employee.findFirst({
            where: { id: overviewManagerId, clubId: profile.clubId },
            select: { id: true, firstName: true, lastName: true, preferredName: true },
          }))
    : null;

  const primaryOverview = {
    department: canonicalDepartment
      ? { id: canonicalDepartment.id, name: canonicalDepartment.name, code: canonicalDepartment.code }
      : null,
    position: canonicalPosition
      ? { id: canonicalPosition.id, name: canonicalPosition.name, code: canonicalPosition.code }
      : null,
    manager: canonicalManager
      ? {
          id: canonicalManager.id,
          firstName: canonicalManager.firstName,
          lastName: canonicalManager.lastName,
          preferredName: canonicalManager.preferredName ?? null,
        }
      : null,
    employmentType: primaryAssignmentRow?.employmentType ?? profile.employmentType ?? null,
  };

  // HR-2C B5 (2026-08-28) — Training record + publishable-course list
  // for the Training tab. Loaded ONLY when the caller holds
  // hr:training:compliance:read so the Prisma work is skipped
  // completely for unauthorised profile viewers.
  const trainingRecord = canReadTrainingCompliance
    ? await getEmployeeTrainingRecord(principal, profile.id)
    : null;
  const publishableCourses = canReadTrainingCompliance
    ? (await listClubCourses(principal, profile.clubId))
        .filter((c) => c.currentVersion && !c.retiredAt)
        .map((c) => ({ id: c.id, code: c.code, title: c.title }))
    : [];

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
        // HR-2C Employment Corrections (2026-08-24) — Overview
        // derives from the canonical PRIMARY assignment when one
        // exists; falls back to the legacy Employee.employmentType
        // only when no assignment has been provisioned yet
        // (e.g. an employee with zero legacy data too).
        employmentType: primaryOverview.employmentType,
        employeeLifecycle: profile.employeeLifecycle,
        onboardingState: profile.onboardingState,
        payrollReadiness: profile.payrollReadiness,
        memberId: profile.memberId ?? null,
        profilePhotoDocumentId: profile.profilePhotoDocumentId ?? null,
      }}
      department={primaryOverview.department}
      position={primaryOverview.position}
      manager={primaryOverview.manager}
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
      emergencyContacts={
        canReadEmergency
          ? emergencyContacts.map((c) => ({
              id: c.id, name: c.name, relation: c.relation,
              phone: c.phone, email: c.email, isPrimary: c.isPrimary,
              updatedAt: c.updatedAt.toISOString(),
            }))
          : null
      }
      credentials={
        canReadCredentials
          ? credentials.map((c) => ({
              id: c.id, code: c.credentialCode, displayName: c.displayName,
              issuer: c.issuer, reference: c.reference,
              issuedAt: c.issuedAt ? c.issuedAt.toISOString() : null,
              expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
              documentId: c.documentId,
              updatedAt: c.updatedAt.toISOString(),
            }))
          : null
      }
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
      employmentSection={
        canReadEmployment ? (
          <EmployeeEmploymentSection
            employeeId={profile.id}
            clubId={profile.clubId}
            assignments={assignments.map((a) => ({
              id: a.id,
              role: a.role,
              departmentId: a.departmentId,
              departmentName: a.departmentName,
              positionId: a.positionId,
              positionName: a.positionName,
              managerEmployeeId: a.managerEmployeeId,
              managerName: a.managerName,
              employmentType: a.employmentType,
              effectiveFrom: a.effectiveFrom.toISOString(),
              effectiveTo: a.effectiveTo ? a.effectiveTo.toISOString() : null,
              isCurrent: a.isCurrent,
              notes: a.notes,
            }))}
            compensationHistory={compensationHistory.map((c) => ({
              id: c.id,
              cadence: c.cadence,
              amount: c.rate.toString(),
              currency: c.currency,
              effectiveFrom: c.effectiveFrom.toISOString(),
              effectiveTo: c.effectiveTo ? c.effectiveTo.toISOString() : null,
              assignmentId: c.assignmentId ?? null,
              notes: c.notes,
            }))}
            allowances={allowances.map((a) => ({
              id: a.id,
              allowanceType: a.allowanceType,
              description: a.description,
              amount: a.amount,
              currency: a.currency,
              frequency: a.frequency,
              taxable: a.taxable,
              effectiveFrom: a.effectiveFrom.toISOString(),
              effectiveTo: a.effectiveTo ? a.effectiveTo.toISOString() : null,
              isCurrent: a.isCurrent,
              assignmentId: a.assignmentId,
            }))}
            departments={deptOptions}
            positions={positionOptions}
            managers={managerOptions}
            canReadCompensation={canReadCompensation}
            canWriteCompensation={canWriteCompensation}
            canReadAllowance={canReadAllowance}
            canWriteAllowance={canWriteAllowance}
            canWriteEmployment={canWriteEmployment}
            actions={{
              addAssignment: addAssignmentAction,
              endAssignment: endAssignmentAction,
              changeCompensation: changeCompensationAction,
              addAllowance: addAllowanceAction,
              endAllowance: endAllowanceAction,
              createPosition: createEmployeePositionInlineAction,
            }}
          />
        ) : null
      }
      trainingSection={
        canReadTrainingCompliance && trainingRecord ? (
          <EmployeeTrainingSection
            record={trainingRecord}
            employeeId={profile.id}
            canAssign={canAssignTraining}
            publishableCourses={publishableCourses}
            assignAction={assignTrainingCourseAction.bind(null, profile.id)}
          />
        ) : undefined
      }
      defaultTab={defaultTab}
    />
  );
}
