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
// HR mobile-hotfix (2026-08-30) — §4 Approve & Activate.
import ApproveActivateEmployee from "@/components/hr/ApproveActivateEmployee";
import { getOnboardingApprovalReadiness } from "@/lib/hr/onboarding-approve-activate";
import { approveAndActivateAction } from "./_approve-actions";
// HR mobile-hotfix (2026-08-26) — admin-initiated portal password reset.
import SendPasswordResetButton from "@/components/hr/SendPasswordResetButton";
import { sendPortalPasswordResetAction } from "./_password-reset-actions";
// Payroll-3D-1A — Timekeeping method admin control.
import TimekeepingPanel from "./TimekeepingPanel";
// Phase 4 (2026-09-16) — Recurring payroll component assignments.
import EmployeeRecurringComponentsSection from "@/components/hr/EmployeeRecurringComponentsSection";
import { listPayrollComponents } from "@/lib/payroll/components-catalogue";
// Slice A (2026-09-18) — Canonical Payroll-tab workspace.
import EmployeePayrollWorkspaceSection from "@/components/hr/EmployeePayrollWorkspaceSection";
import EmployeePayrollGrid from "@/components/hr/EmployeePayrollGrid";
import { getEmployeePayrollYtd } from "@/lib/payroll/ytd";
import OpeningYtdInlineEditor from "@/components/hr/OpeningYtdInlineEditor";
import {
  saveEmployeeOpeningYtdDraftAction,
  validateEmployeeOpeningYtdAction,
  activateEmployeeOpeningYtdAction,
  addEmployeeOpeningYtdComponentAction,
  removeEmployeeOpeningYtdComponentAction,
} from "./_opening-ytd-actions";
import { getImplementationDeclaration } from "@/lib/payroll/implementation-declaration";
import { getActiveOpeningBalance, listOpeningComponentBalances } from "@/lib/payroll/opening-balance";
import { updateOriginalHireDateAction } from "./_hire-date-actions";
// Slice B (2026-09-18) — pre-batch scheduled one-time earnings.
import OneTimeEarningsSection from "@/components/hr/OneTimeEarningsSection";
import { listOneTimeEarningsForEmployee } from "@/lib/payroll/scheduled-one-time-earning";
import {
  scheduleOneTimeEarningAction,
  cancelOneTimeEarningAction,
} from "./_scheduled-earning-actions";
// Slice C (2026-09-18) — benefit plan enrolments.
import BenefitsDeductionsSection from "@/components/hr/BenefitsDeductionsSection";
import { listEnrolmentsForEmployee } from "@/lib/payroll/benefit-enrolments";
import { listBenefitPlans } from "@/lib/payroll/benefit-plans";
import {
  enrolAction as benefitsEnrolAction,
  changeAction as benefitsChangeAction,
  endAction as benefitsEndAction,
} from "./_benefit-actions";
import {
  addRecurringPayrollComponentAction,
  endRecurringPayrollComponentAction,
  changeRecurringPayrollComponentAction,
} from "./_recurring-component-actions";

// FPP-1 §2 (2026-09-20) — force dynamic to prevent RSC caching of the
// server loader between requests. Without this, Next.js may cache the
// fallback openingBalance findFirst result and the founder sees stale
// DRAFT state after saving.
export const dynamic = "force-dynamic";

export default async function EmployeeProfilePage({
  params, searchParams,
}: {
  params: { id: string };
  searchParams?: Promise<{ tab?: string; benefitsOk?: string; benefitsErr?: string }>;
}) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const sp = (await (searchParams ?? Promise.resolve({}))) as { tab?: string; benefitsOk?: string; benefitsErr?: string };
  const defaultTab = sp.tab?.trim() || undefined;
  const benefitsBanner: { tone: "success" | "error"; text: string } | null =
    sp.benefitsOk ? { tone: "success", text: sp.benefitsOk }
    : sp.benefitsErr ? { tone: "error", text: sp.benefitsErr }
    : null;

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
  // Phase 4 (2026-09-16) — Recurring payroll component assignments.
  const canReadPayrollRecurring = hasPermission(principal, profile.clubId, "payroll:read");
  const canWritePayrollRecurring = hasPermission(principal, profile.clubId, "payroll:write");

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
    taxReadiness,
    payrollComponentCatalogue,
    recurringComponentAssignments,
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
    // Payroll-readiness hotfix (2026-09-14) §7 — Employee Payroll tab TD1
    // completion state must reflect the canonical `EmployeeTaxProfile`, the
    // same source Prepare Payroll + approval readiness use. Reading the
    // acknowledgements alone (and gating on hr:onboarding:read) meant Marc's
    // TD1s displayed as "Not yet completed" on the Payroll tab even though
    // his EmployeeTaxProfile existed and Prepare Payroll marked
    // federalTd1Ready=true / provincialTd1Ready=true. The shared helper
    // ungates the read from onboarding-permission (payroll:read is enough
    // to see the payroll tab; the tax profile is not extra-sensitive here).
    (await import("@/lib/hr/tax-readiness")).getEmployeeTaxReadiness(profile.clubId, profile.id),
    // Phase 4 — active PayrollComponents catalogue (Add-flow picker).
    // The service defaults to active-only when includeInactive is
    // omitted, which is exactly what the Add form should show.
    canReadPayrollRecurring
      ? listPayrollComponents(principal, profile.clubId)
      : Promise.resolve([]),
    // Phase 4 — every recurring assignment for this employee (active +
    // upcoming + historical). Read directly from prisma; the service
    // layer's list returns only active-as-of.
    canReadPayrollRecurring
      ? prisma.employeeRecurringPayrollComponent.findMany({
          where: { clubId: profile.clubId, employeeId: profile.id },
          include: { component: true },
          orderBy: [{ effectiveFrom: "desc" }],
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
  // Post-onboarding-admin hotfix (2026-09-13) §16 — same permission
  // gates the Basic Details editor (name / email / phone / address).
  // SIN / banking / TD1 remain on their own sensitive-data workflows (§24).
  const canEditBasicDetails = hasPermission(principal, profile.clubId, "hr:employee:write");

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
  // Hotfix §17 (2026-09-13): canonical position lives on
  // Employee.orgPositionId (→ OrganizationalPosition). Legacy
  // Employee.positionId (→ EmployeePosition) is a fallback for
  // pre-migration rows only. Both go through positionOptions which
  // still indexes off EmployeePosition ids; when the canonical
  // orgPosition exists, use its name directly to bypass the legacy
  // catalogue.
  const overviewPositionId = primaryAssignmentRow?.positionId ?? profile.positionId ?? null;
  const canonicalOrgPosition = (profile as unknown as { orgPosition?: { id: string; name: string } | null }).orgPosition ?? null;
  const overviewManagerId = primaryAssignmentRow?.managerEmployeeId ?? profile.managerEmployeeId ?? null;

  const canonicalDepartment = overviewDeptId
    ? (deptOptions.find((d) => d.id === overviewDeptId) ?? department)
    : null;
  const canonicalPosition = canonicalOrgPosition
    ? { id: canonicalOrgPosition.id, name: canonicalOrgPosition.name, code: null as string | null }
    : overviewPositionId
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

  // HR mobile-hotfix (2026-08-30) — §4 Approve & Activate readiness.
  // The readiness projection is safe for any HR reader — only presence
  // flags + banking status; no plaintext SIN, no bank digits, no
  // fingerprints. The write action is gated inside the service.
  const approvalReadiness = canReadOnboarding
    ? await getOnboardingApprovalReadiness(principal, profile.id)
    : null;

  // Slice A (2026-09-18) — canonical Payroll-tab workspace data.
  const currentTaxYear = new Date().getUTCFullYear();
  const canReadPayrollConfig = hasPermission(principal, profile.clubId, "payroll:config:read");
  const [
    activePayGroupMembership,
    implementationDeclaration,
    activeOpeningBalance,
  ] = await Promise.all([
    canReadPayrollRecurring
      ? prisma.payrollPayGroupMember.findFirst({
          where: {
            clubId: profile.clubId,
            employeeId: profile.id,
            effectiveTo: null,
          },
          include: {
            payGroup: {
              select: { id: true, code: true, name: true, payFrequency: true, active: true },
            },
          },
          orderBy: { effectiveFrom: "desc" },
        })
      : Promise.resolve(null),
    canReadPayrollConfig
      ? getImplementationDeclaration(principal, profile.clubId, currentTaxYear).catch(() => null)
      : Promise.resolve(null),
    canReadPayrollRecurring
      ? getActiveOpeningBalance(profile.clubId, profile.id, currentTaxYear).catch(() => null)
      : Promise.resolve(null),
  ]);

  // FPP-1 (2026-09-19) §9 — if there is no ACTIVE opening balance yet,
  // surface the most-recent DRAFT / VALIDATED row so the founder can
  // resume editing (per-component openings especially). The editor's
  // status prop handles all four states.
  let editableOpeningBalance: {
    id: string;
    taxYear: number;
    status: "DRAFT" | "VALIDATED" | "ACTIVE" | "SUPERSEDED";
    throughPayDate: Date | null;
    priorPayrollKind: "PRIOR_SYSTEM_SAME_EMPLOYER" | "PRIOR_EMPLOYER" | "PRIOR_ADJUSTMENT" | null;
    values: {
      ytdGrossEarnings: string; ytdTaxableEarnings: string;
      ytdPensionableEarnings: string; ytdInsurableEarnings: string;
      ytdCppEE_Base: string; ytdCppEE_FirstAdd: string; ytdCppEE: string;
      ytdCpp2EE: string; ytdEiEE: string;
      ytdFederalTax: string; ytdProvincialTax: string;
      ytdCppER_Base: string; ytdCppER_FirstAdd: string; ytdCppER: string;
      ytdCpp2ER: string; ytdEiER: string;
    };
  } | null = activeOpeningBalance;
  if (!editableOpeningBalance && canReadPayrollRecurring) {
    const draftRow = await prisma.payrollOpeningBalance.findFirst({
      where: {
        clubId: profile.clubId,
        employeeId: profile.id,
        taxYear: currentTaxYear,
        status: { in: ["DRAFT", "VALIDATED"] },
      },
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
    });
    console.log("[FPP1-DEBUG] editableOpeningBalance loader:", {
      clubId: profile.clubId,
      employeeId: profile.id,
      taxYear: currentTaxYear,
      canReadPayrollRecurring,
      activeOpeningBalanceExists: activeOpeningBalance != null,
      foundDraftRow: draftRow != null,
      draftRowStatus: draftRow?.status ?? null,
    });
    if (draftRow) {
      editableOpeningBalance = {
        id: draftRow.id,
        taxYear: draftRow.taxYear,
        status: draftRow.status as "DRAFT" | "VALIDATED" | "ACTIVE" | "SUPERSEDED",
        throughPayDate: draftRow.throughPayDate,
        priorPayrollKind: draftRow.priorPayrollKind as
          "PRIOR_SYSTEM_SAME_EMPLOYER" | "PRIOR_EMPLOYER" | "PRIOR_ADJUSTMENT" | null,
        values: {
          ytdGrossEarnings: draftRow.ytdGrossEarnings.toString(),
          ytdTaxableEarnings: draftRow.ytdTaxableEarnings.toString(),
          ytdPensionableEarnings: draftRow.ytdPensionableEarnings.toString(),
          ytdInsurableEarnings: draftRow.ytdInsurableEarnings.toString(),
          ytdCppEE_Base: draftRow.ytdCppEE_Base.toString(),
          ytdCppEE_FirstAdd: draftRow.ytdCppEE_FirstAdd.toString(),
          ytdCppEE: draftRow.ytdCppEE.toString(),
          ytdCpp2EE: draftRow.ytdCpp2EE.toString(),
          ytdEiEE: draftRow.ytdEiEE.toString(),
          ytdFederalTax: draftRow.ytdFederalTax.toString(),
          ytdProvincialTax: draftRow.ytdProvincialTax.toString(),
          ytdCppER_Base: draftRow.ytdCppER_Base.toString(),
          ytdCppER_FirstAdd: draftRow.ytdCppER_FirstAdd.toString(),
          ytdCppER: draftRow.ytdCppER.toString(),
          ytdCpp2ER: draftRow.ytdCpp2ER.toString(),
          ytdEiER: draftRow.ytdEiER.toString(),
        },
      };
    }
  }

  // FPP-1 — per-Component opening rows for whichever balance we have,
  // and the Club's PayrollComponent catalogue for the "add" picker.
  console.log("[FPP1-DEBUG] editableOpeningBalance AFTER assignment:", {
    isNull: editableOpeningBalance == null,
    status: editableOpeningBalance?.status ?? null,
    id: editableOpeningBalance?.id ?? null,
  });
  const [openingComponentRows, openingComponentCatalogue] = await Promise.all([
    editableOpeningBalance && canReadPayrollRecurring
      ? listOpeningComponentBalances(principal, profile.clubId, editableOpeningBalance.id).catch(() => [])
      : Promise.resolve([]),
    canReadPayrollRecurring
      ? prisma.payrollComponent.findMany({
          where: { clubId: profile.clubId },
          select: {
            id: true, code: true, displayName: true, category: true,
            side: true, cashEffect: true, active: true,
          },
          orderBy: [{ side: "asc" }, { category: "asc" }, { displayName: "asc" }],
        })
      : Promise.resolve([]),
  ]);

  const currentCompensation = compensationHistory.find((c) => c.effectiveTo === null) ?? null;

  // Slice F (2026-09-19) §36 — overtime policy view. Reads the
  // Employee's overtimePolicyState + the Club's currently-configured
  // overtimePolicyKind. Neither is sensitive; both are safe under
  // payroll:read. Passed as-is to the workspace, which renders the
  // fail-closed-aware treatment card next to Base Compensation.
  const overtimePolicyView = canReadPayrollRecurring
    ? await (async () => {
        const [employeeRow, clubConfigRow] = await Promise.all([
          prisma.employee.findUnique({
            where: { id: profile.id },
            select: { overtimePolicyState: true },
          }),
          prisma.payrollClubConfig.findUnique({
            where: { clubId: profile.clubId },
            select: { overtimePolicyKind: true },
          }),
        ]);
        return {
          employeeState: employeeRow?.overtimePolicyState ?? "STANDARD",
          clubPolicyKind: clubConfigRow?.overtimePolicyKind ?? null,
        };
      })()
    : undefined;

  // Slice C (2026-09-18) — benefit enrolments for this employee.
  const benefitEnrolments = canReadPayrollRecurring
    ? await listEnrolmentsForEmployee(principal, profile.clubId, profile.id).catch(() => [])
    : [];
  // Slice C closeout (2026-09-18) — Club-active benefit plans the founder
  // can enrol this employee into. Only active plans are offered; the
  // service further filters overlap at the plan level.
  const activeBenefitPlans = canReadPayrollRecurring
    ? await listBenefitPlans(principal, profile.clubId).catch(() => [])
    : [];
  const canWriteBenefitEnrolment = hasPermission(principal, profile.clubId, "payroll:benefit_enrolment:write");

  // Slice B (2026-09-18) — pre-batch scheduled one-time earnings data.
  // Load the employee's history + eligible one-time components +
  // eligible future/open pay periods for their active pay group.
  const [oneTimeEarnings, oneTimeEligibleComponents, eligiblePayPeriods] = await Promise.all([
    canReadPayrollRecurring
      ? listOneTimeEarningsForEmployee(principal, profile.clubId, profile.id).catch(() => [])
      : Promise.resolve([]),
    canReadPayrollRecurring
      ? prisma.payrollComponent.findMany({
          where: {
            clubId: profile.clubId,
            active: true,
            usage: { in: ["ONE_TIME", "BOTH"] },
            side: "EMPLOYEE",
            cashEffect: "INCREASES_NET_PAY",
            calculationMethod: "FIXED_AMOUNT",
          },
          select: { id: true, code: true, displayName: true },
          orderBy: { displayName: "asc" },
        })
      : Promise.resolve([]),
    canReadPayrollRecurring && activePayGroupMembership?.payGroupId
      ? prisma.payrollPayPeriod.findMany({
          where: {
            clubId: profile.clubId,
            payGroupId: activePayGroupMembership.payGroupId,
            periodEnd: { gte: new Date() },
            NOT: { batches: { some: { status: "POSTED" } } },
          },
          select: { id: true, periodStart: true, periodEnd: true, payDate: true },
          orderBy: { payDate: "asc" },
          take: 12,
        })
      : Promise.resolve([]),
  ]);

  // EPW-2 (2026-09-20) — per-employee posted payroll history for the
  // Payroll History card, and the current YTD aggregate for the YTD
  // Summary card. Per-employee history filters PayrollBatchEmployee by
  // employeeId + batch.status=POSTED; the top 5 most recent are shown.
  const employeePayrollHistory = canReadPayrollRecurring
    ? await prisma.payrollBatchEmployee
        .findMany({
          where: { clubId: profile.clubId, employeeId: profile.id, batch: { status: "POSTED" } },
          select: {
            id: true, grossPay: true, netPay: true,
            batch: {
              select: {
                id: true, status: true,
                payPeriod: { select: { payDate: true, periodStart: true, periodEnd: true } },
              },
            },
          },
          orderBy: [{ batch: { payPeriod: { payDate: "desc" } } }],
          take: 5,
        })
        .catch(() => [])
    : [];
  const employeeYtd = canReadPayrollRecurring
    ? await getEmployeePayrollYtd(profile.clubId, profile.id, new Date()).catch(() => null)
    : null;
  const nextPayDate = activePayGroupMembership?.payGroupId
    ? await prisma.payrollPayPeriod
        .findFirst({
          where: {
            clubId: profile.clubId,
            payGroupId: activePayGroupMembership.payGroupId,
            payDate: { gte: new Date() },
          },
          orderBy: { payDate: "asc" },
          select: { payDate: true },
        })
        .catch(() => null)
    : null;

  const nowTs = Date.now();
  const monthShort = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const fmtCivil = (d: Date) => {
    const y = d.getUTCFullYear(); const m = d.getUTCMonth(); const day = d.getUTCDate();
    return `${monthShort[m]} ${day}, ${y}`;
  };
  const payPeriodOptions = eligiblePayPeriods.map((p) => {
    // Display inclusive end (periodEnd is exclusive in schema).
    const inclusiveEnd = new Date(p.periodEnd.getTime() - 86_400_000);
    const label = `${fmtCivil(p.periodStart)} – ${fmtCivil(inclusiveEnd)} — Pay ${fmtCivil(p.payDate)}`;
    const isCurrent = p.periodStart.getTime() <= nowTs && p.periodEnd.getTime() > nowTs;
    return { id: p.id, label, payDateIso: p.payDate.toISOString(), isCurrent };
  });
  const oneTimeRows = oneTimeEarnings.map((r) => {
    const p = eligiblePayPeriods.find((x) => x.id === r.payPeriodId);
    const label = p
      ? `${fmtCivil(p.periodStart)} – ${fmtCivil(new Date(p.periodEnd.getTime() - 86_400_000))} · Pay ${fmtCivil(p.payDate)}`
      : "—";
    return {
      id: r.id,
      componentId: r.componentId,
      componentCode: r.componentCode,
      componentDisplayName: r.componentDisplayName,
      amount: r.amount,
      reason: r.reason,
      status: r.status,
      payPeriodId: r.payPeriodId,
      payPeriodLabel: label,
      createdAt: r.createdAt,
      appliedAt: r.appliedAt,
      cancelledAt: r.cancelledAt,
    };
  });

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
        dateOfBirth: profile.dateOfBirth ? profile.dateOfBirth.toISOString() : null,
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
        homeAddressLine1: profile.homeAddressLine1 ?? null,
        homeAddressLine2: profile.homeAddressLine2 ?? null,
        homeCity: profile.homeCity ?? null,
        homeProvince: profile.homeProvince ?? null,
        homePostalCode: profile.homePostalCode ?? null,
        homeCountry: profile.homeCountry ?? null,
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
      canEditBasicDetails={canEditBasicDetails}
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
        // Payroll-readiness hotfix (2026-09-14) — canonical TD1 readiness.
        // See src/lib/hr/tax-readiness.ts. The panels render "Completed"
        // from `federalTd1Ready` / `provincialTd1Ready`, prefer the enriched
        // acknowledgement timestamp where present, otherwise fall back to
        // the tax profile's effectiveFrom.
        federalTd1Ready: taxReadiness.federal.ready,
        provincialTd1Ready: taxReadiness.provincial.ready,
        federalTd1CompletedAt: taxReadiness.federalCompletedAt?.toISOString() ?? taxReadiness.effectiveFrom?.toISOString() ?? null,
        provincialTd1CompletedAt: taxReadiness.provincialCompletedAt?.toISOString() ?? taxReadiness.effectiveFrom?.toISOString() ?? null,
        // Legacy passthrough — a few consumers still reach into this array;
        // keep it populated from the same acknowledgement data.
        td1Attestations: [
          taxReadiness.federalCompletedAt ? { kind: "td1_federal_attestation", acknowledgedAt: taxReadiness.federalCompletedAt.toISOString() } : null,
          taxReadiness.provincialCompletedAt ? { kind: "td1_provincial_attestation", acknowledgedAt: taxReadiness.provincialCompletedAt.toISOString() } : null,
        ].filter((x): x is { kind: string; acknowledgedAt: string } => x !== null),
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
      approvalSection={
        approvalReadiness ? (
          <ApproveActivateEmployee
            readiness={approvalReadiness}
            action={approveAndActivateAction.bind(null, profile.id)}
          />
        ) : null
      }
      credentialActions={
        canLifecycle ? (
          <SendPasswordResetButton
            employeeId={profile.id}
            employeeDisplayName={profile.preferredName?.trim()
              ? `${profile.preferredName} ${profile.lastName}`
              : `${profile.firstName} ${profile.lastName}`}
            hasPersonalEmail={Boolean(profile.personalEmail)}
            action={sendPortalPasswordResetAction.bind(null, profile.id)}
          />
        ) : null
      }
      employmentSection={
        canReadEmployment ? (
          <div className="space-y-4">
            {/* Payroll-3D-1A — Timekeeping method admin control.
                Sits at the TOP of Employment so it's discoverable without
                scrolling. Server action re-verifies hr:employee:write. */}
            <TimekeepingPanel
              employeeId={profile.id}
              initialMethod={(profile.timekeepingMethod ?? "NO_TIME_ENTRY_REQUIRED") as
                "NO_TIME_ENTRY_REQUIRED" | "CLOCK_REQUIRED" | "MANUAL_TIMESHEET" | "SCHEDULE_DERIVED"}
              canWrite={canWriteEmployment}
            />
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
          </div>
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
      payrollCompensationSection={
        canReadPayrollRecurring ? (
          <EmployeeRecurringComponentsSection
            employeeId={profile.id}
            clubId={profile.clubId}
            canWrite={canWritePayrollRecurring}
            catalogue={payrollComponentCatalogue
              .filter((c) => (c as unknown as { usage?: string }).usage !== "ONE_TIME")
              .map((c) => ({
              id: c.id,
              code: c.code,
              displayName: c.displayName,
              category: c.category,
              side: c.side,
              cashEffect: c.cashEffect,
              calculationMethod: c.calculationMethod as "FIXED_AMOUNT" | "PERCENT_OF_ELIGIBLE_EARNINGS",
              displaySection: c.displaySection,
            }))}
            assignments={recurringComponentAssignments.map((a) => ({
              id: a.id,
              componentId: a.componentId,
              componentCode: a.component.code,
              componentDisplayName: a.component.displayName,
              componentCategory: a.component.category,
              componentSide: a.component.side,
              cashEffect: a.component.cashEffect,
              calculationMethod: a.component.calculationMethod,
              displaySection: a.component.displaySection,
              amount: a.amount != null ? String(a.amount) : null,
              percentBps: a.percentBps,
              effectiveFrom: a.effectiveFrom.toISOString(),
              effectiveTo: a.effectiveTo?.toISOString() ?? null,
              active: a.active,
              notes: a.notes,
            }))}
            addAction={addRecurringPayrollComponentAction}
            endAction={endRecurringPayrollComponentAction}
            changeAction={changeRecurringPayrollComponentAction}
          />
        ) : undefined
      }
      payrollWorkspaceSection={
        canReadPayrollRecurring ? (
          <EmployeePayrollGrid
            employeeId={profile.id}
            employeeNumber={profile.employeeNumber}
            employeeName={`${profile.preferredName ?? profile.firstName} ${profile.lastName}`}
            employeeStatus={profile.status ?? "ACTIVE"}
            originalHireDateIso={profile.hireDate ? new Date(profile.hireDate).toISOString() : null}
            spectreActivatedAtIso={profile.activatedAt ? new Date(profile.activatedAt).toISOString() : null}
            payGroup={
              activePayGroupMembership?.payGroup
                ? {
                    id: activePayGroupMembership.payGroup.id,
                    code: activePayGroupMembership.payGroup.code,
                    name: activePayGroupMembership.payGroup.name,
                    payFrequency: activePayGroupMembership.payGroup.payFrequency,
                  }
                : null
            }
            nextPayDateIso={nextPayDate?.payDate ? nextPayDate.payDate.toISOString() : null}
            currentCompensation={
              currentCompensation
                ? {
                    cadence: currentCompensation.cadence,
                    rate: currentCompensation.rate.toString(),
                    effectiveFromIso: currentCompensation.effectiveFrom.toISOString(),
                  }
                : null
            }
            compensationHistoryCount={compensationHistory.length}
            compensationEditHref={`/app/admin/people/employees/${profile.id}?tab=employment#compensation`}
            viewCompensationHistoryHref={`/app/admin/people/employees/${profile.id}?tab=employment#compensation`}
            recurring={recurringComponentAssignments
              .filter((a) => a.active)
              .map((a) => ({
                id: a.id,
                componentDisplayName: a.component.displayName,
                amount: a.amount != null ? String(a.amount) : null,
                frequencyLabel: "Per Pay",
                effectiveFromIso: a.effectiveFrom.toISOString(),
                active: a.active,
              }))}
            addRecurringHref={`/app/admin/people/employees/${profile.id}?tab=payroll#recurring`}
            oneTime={oneTimeRows
              .filter((r) => r.status !== "CANCELLED")
              .slice(0, 5)
              .map((r) => ({
                id: r.id,
                componentDisplayName: r.componentDisplayName,
                amount: String(r.amount ?? "0"),
                payDateIso: r.payPeriodLabel ?? new Date().toISOString(),
                status: r.status,
              }))}
            addOneTimeHref={`/app/admin/people/employees/${profile.id}?tab=payroll#one-time`}
            benefits={{
              rows: benefitEnrolments.map((r) => {
                const plan = activeBenefitPlans.find((p) => p.id === r.planId) ?? null;
                return {
                  id: r.id,
                  planId: r.planId,
                  planCode: r.planCode,
                  planName: r.planName,
                  planKind: r.planKind,
                  status: r.status,
                  electionKind: r.electionKind,
                  amount: r.amount,
                  percentBps: r.percentBps,
                  effectiveFromIso: r.effectiveFromIso,
                  effectiveToIso: r.effectiveToIso,
                  employerMatchBps: plan?.employerMatchBps ?? null,
                  employerMatchCapBps: plan?.employerMatchCapBps ?? null,
                };
              }),
              planChoices: activeBenefitPlans.map((p) => ({
                id: p.id,
                code: p.code,
                name: p.name,
                kind: p.kind,
                defaultElectionKind: p.defaultElectionKind,
                effectiveFromIso: p.effectiveFromIso,
                effectiveToIso: p.effectiveToIso,
                employerMatchBps: p.employerMatchBps ?? null,
                employerMatchCapBps: p.employerMatchCapBps ?? null,
              })),
              canWrite: canWriteBenefitEnrolment,
              enrolAction: benefitsEnrolAction,
              changeAction: benefitsChangeAction,
              endAction: benefitsEndAction,
              banner: benefitsBanner,
            }}
            benefitHistoryHref={`/app/admin/people/employees/${profile.id}?tab=payroll#benefit-history`}
            implementation={{
              mode: implementationDeclaration?.mode ?? null,
              firstSpectrePayDateIso: implementationDeclaration?.firstSpectrePayDate?.toISOString() ?? null,
              taxYear: currentTaxYear,
            }}
            openingYtd={
              implementationDeclaration?.mode === "MID_YEAR_MIGRATION"
                ? {
                    employeeId: profile.id,
                    taxYear: currentTaxYear,
                    firstSpectrePayDateIso: implementationDeclaration.firstSpectrePayDate?.toISOString() ?? null,
                    canWrite: hasPermission(principal, profile.clubId, "payroll:run"),
                    status: (activeOpeningBalance?.status as "MISSING" | "DRAFT" | "VALIDATED" | "ACTIVE" | "SUPERSEDED") ?? "MISSING",
                    openingBalanceId: activeOpeningBalance?.id ?? null,
                    throughPayDateIso: activeOpeningBalance?.throughPayDate
                      ? new Date(activeOpeningBalance.throughPayDate).toISOString()
                      : null,
                    priorPayrollKind: (activeOpeningBalance?.priorPayrollKind ?? null) as
                      "PRIOR_SYSTEM_SAME_EMPLOYER" | "PRIOR_EMPLOYER" | "PRIOR_ADJUSTMENT" | null,
                    values: activeOpeningBalance?.values ?? null,
                    actions: {
                      saveDraft: saveEmployeeOpeningYtdDraftAction,
                      validate: validateEmployeeOpeningYtdAction,
                      activate: activateEmployeeOpeningYtdAction,
                    },
                  }
                : null
            }
            history={employeePayrollHistory.map((h) => ({
              id: h.id,
              payDateIso: h.batch.payPeriod.payDate.toISOString(),
              periodStartIso: h.batch.payPeriod.periodStart.toISOString(),
              periodEndInclusiveIso: new Date(h.batch.payPeriod.periodEnd.getTime() - 86_400_000).toISOString(),
              grossPay: String(h.grossPay ?? "0"),
              netPay: String(h.netPay ?? "0"),
              status: h.batch.status,
              href: `/app/admin/payroll/batches/${h.batch.id}/paystubs`,
            }))}
            viewAllPayrollHref="/app/admin/payroll/history"
            ytd={
              employeeYtd
                ? {
                    asOfIso: new Date().toISOString(),
                    values: {
                      ytdGrossEarnings:   employeeYtd.ytdGrossEarnings,
                      ytdTaxableEarnings: employeeYtd.ytdTaxableEarnings,
                      ytdCppEE:           employeeYtd.ytdCppEE,
                      ytdEiEE:            employeeYtd.ytdEiEE,
                      ytdFederalTax:      employeeYtd.ytdFederalTax,
                      ytdProvincialTax:   employeeYtd.ytdProvincialTax,
                      ytdRrspEE:          null,
                      ytdOtherDeductions: (
                        Number(employeeYtd.ytdCppEE ?? 0)
                        + Number(employeeYtd.ytdEiEE ?? 0)
                        + Number(employeeYtd.ytdFederalTax ?? 0)
                        + Number(employeeYtd.ytdProvincialTax ?? 0)
                      ).toFixed(2),
                      ytdNetPay: (
                        Number(employeeYtd.ytdGrossEarnings ?? 0)
                        - Number(employeeYtd.ytdCppEE ?? 0)
                        - Number(employeeYtd.ytdEiEE ?? 0)
                        - Number(employeeYtd.ytdFederalTax ?? 0)
                        - Number(employeeYtd.ytdProvincialTax ?? 0)
                      ).toFixed(2),
                    },
                  }
                : null
            }
            viewYtdDetailsHref={`/app/admin/people/employees/${profile.id}/ytd-detail`}
            payrollSettingsHref="/app/admin/payroll/setup"
          />
        ) : undefined
      }
      defaultTab={defaultTab}
    />
  );
}

/* Preserved legacy invocation (unused after EPW-2 grid swap). Kept
   commented so a future diff clearly shows the delta.
{
        canReadPayrollRecurring ? (
          <EmployeePayrollWorkspaceSection
            employeeId={profile.id}
            employeeNumber={profile.employeeNumber}
            employeeStatus={profile.status ?? "ACTIVE"}
            employeeName={`${profile.preferredName ?? profile.firstName} ${profile.lastName}`}
            originalHireDateIso={profile.hireDate ? new Date(profile.hireDate).toISOString() : null}
            spectreActivatedAtIso={profile.activatedAt ? new Date(profile.activatedAt).toISOString() : null}
            canEditHireDate={canWriteEmployment}
            payGroup={
              activePayGroupMembership?.payGroup
                ? {
                    id: activePayGroupMembership.payGroup.id,
                    code: activePayGroupMembership.payGroup.code,
                    name: activePayGroupMembership.payGroup.name,
                    payFrequency: activePayGroupMembership.payGroup.payFrequency,
                  }
                : null
            }
            payroll={{
              sinAccessible: canReadSin,
              sinMasked: sinMasked ?? null,
              bankingAccessible: canReadBanking,
              bankingMasked: bankingMasked
                ? {
                    holderName: bankingMasked.holderName ?? "",
                    accountMasked: bankingMasked.accountMasked ?? "",
                    status: bankingMasked.status ?? "",
                  }
                : null,
              taxAccessible: canReadTax,
              taxProfileMasked: taxProfileMasked
                ? { province: taxProfileMasked.province ?? null }
                : null,
              federal: taxReadiness?.federal ?? null,
              provincial: taxReadiness?.provincial ?? null,
            } as never}
            currentCompensation={
              currentCompensation
                ? {
                    id: currentCompensation.id,
                    cadence: currentCompensation.cadence,
                    rate: currentCompensation.rate.toString(),
                    currency: currentCompensation.currency ?? null,
                    effectiveFrom: currentCompensation.effectiveFrom.toISOString(),
                    effectiveTo: currentCompensation.effectiveTo?.toISOString() ?? null,
                  }
                : null
            }
            compensationHistoryCount={compensationHistory.length}
            implementationDeclaration={
              implementationDeclaration
                ? {
                    taxYear: implementationDeclaration.taxYear,
                    mode: implementationDeclaration.mode,
                    firstSpectrePayDateIso:
                      implementationDeclaration.firstSpectrePayDate?.toISOString() ?? null,
                  }
                : null
            }
            openingBalance={
              activeOpeningBalance
                ? {
                    id: activeOpeningBalance.id,
                    taxYear: activeOpeningBalance.taxYear,
                    status: activeOpeningBalance.status,
                    throughPayDateIso: activeOpeningBalance.throughPayDate
                      ? new Date(activeOpeningBalance.throughPayDate).toISOString()
                      : null,
                    priorPayrollKind: activeOpeningBalance.priorPayrollKind ?? null,
                    // Slice A closeout (2026-09-18) §5 — canonical
                    // OpeningBalanceFields DTO passed through 1:1. No
                    // guessing, no `as unknown as`. The service returns
                    // `values` typed as `OpeningBalanceFields` and the
                    // workspace types its prop as `OpeningYtdValues`
                    // (identical shape).
                    values: activeOpeningBalance.values,
                  }
                : null
            }
            actions={{ updateOriginalHireDate: updateOriginalHireDateAction }}
            overtimePolicy={overtimePolicyView}
            openingYtdEditor={
              implementationDeclaration?.mode === "MID_YEAR_MIGRATION" ? (
                <OpeningYtdInlineEditor
                  employeeId={profile.id}
                  taxYear={currentTaxYear}
                  firstSpectrePayDateIso={
                    implementationDeclaration.firstSpectrePayDate?.toISOString() ?? null
                  }
                  canWrite={hasPermission(principal, profile.clubId, "payroll:run")}
                  status={(editableOpeningBalance?.status as "MISSING" | "DRAFT" | "VALIDATED" | "ACTIVE" | "SUPERSEDED") ?? "MISSING"}
                  openingBalanceId={editableOpeningBalance?.id ?? null}
                  throughPayDateIso={
                    editableOpeningBalance?.throughPayDate
                      ? new Date(editableOpeningBalance.throughPayDate).toISOString()
                      : null
                  }
                  priorPayrollKind={(editableOpeningBalance?.priorPayrollKind ?? null) as
                    "PRIOR_SYSTEM_SAME_EMPLOYER" | "PRIOR_EMPLOYER" | "PRIOR_ADJUSTMENT" | null}
                  values={editableOpeningBalance?.values ?? null}
                  componentOpenings={openingComponentRows.map((r) => ({
                    id: r.id,
                    componentCode: r.componentCode,
                    displayName: r.displayName,
                    category: r.category,
                    side: r.side,
                    cashEffect: r.cashEffect,
                    ytdAmount: r.ytdAmount,
                  }))}
                  componentCatalogue={openingComponentCatalogue.map((c) => ({
                    id: c.id,
                    code: c.code,
                    displayName: c.displayName,
                    category: c.category,
                    side: c.side as "EMPLOYEE" | "EMPLOYER",
                    cashEffect: c.cashEffect as "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT",
                    active: c.active,
                  }))}
                  actions={{
                    saveDraft: saveEmployeeOpeningYtdDraftAction,
                    validate: validateEmployeeOpeningYtdAction,
                    activate: activateEmployeeOpeningYtdAction,
                    addComponent: addEmployeeOpeningYtdComponentAction,
                    removeComponent: removeEmployeeOpeningYtdComponentAction,
                  }}
                />
              ) : null
            }
            benefitsDeductionsSection={
              <BenefitsDeductionsSection
                employeeId={profile.id}
                rows={benefitEnrolments.map((r) => {
                  const plan = activeBenefitPlans.find((p) => p.id === r.planId) ?? null;
                  return {
                    id: r.id,
                    planId: r.planId,
                    planCode: r.planCode,
                    planName: r.planName,
                    planKind: r.planKind,
                    status: r.status,
                    electionKind: r.electionKind,
                    amount: r.amount,
                    percentBps: r.percentBps,
                    effectiveFromIso: r.effectiveFromIso,
                    effectiveToIso: r.effectiveToIso,
                    employerMatchBps: plan?.employerMatchBps ?? null,
                    employerMatchCapBps: plan?.employerMatchCapBps ?? null,
                  };
                })}
                planChoices={activeBenefitPlans.map((p) => ({
                  id: p.id,
                  code: p.code,
                  name: p.name,
                  kind: p.kind,
                  defaultElectionKind: p.defaultElectionKind,
                  effectiveFromIso: p.effectiveFromIso,
                  effectiveToIso: p.effectiveToIso,
                  employerMatchBps: p.employerMatchBps ?? null,
                  employerMatchCapBps: p.employerMatchCapBps ?? null,
                }))}
                canWrite={canWriteBenefitEnrolment}
                enrolAction={benefitsEnrolAction}
                changeAction={benefitsChangeAction}
                endAction={benefitsEndAction}
                banner={benefitsBanner}
              />
            }
            oneTimeEarningsSection={
              <OneTimeEarningsSection
                clubId={profile.clubId}
                employeeId={profile.id}
                canWrite={canWritePayrollRecurring}
                rows={oneTimeRows}
                eligibleComponents={oneTimeEligibleComponents}
                payPeriodOptions={payPeriodOptions}
                actions={{
                  schedule: scheduleOneTimeEarningAction,
                  cancel: cancelOneTimeEarningAction,
                }}
              />
            }
            federalTd1Panel={
              canReadTax
                ? taxReadiness?.federal?.ready
                  ? <p className="text-sm text-stone-900">Completed{taxReadiness.federalCompletedAt ? ` ${new Date(taxReadiness.federalCompletedAt).toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" })}` : ""}</p>
                  : <p className="text-sm text-stone-500">Not yet completed</p>
                : <p className="text-xs text-stone-500">Requires Payroll Admin access</p>
            }
            provincialTd1Panel={
              canReadTax
                ? taxReadiness?.provincial?.ready
                  ? <p className="text-sm text-stone-900">Completed{taxReadiness.provincialCompletedAt ? ` ${new Date(taxReadiness.provincialCompletedAt).toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" })}` : ""}</p>
                  : <p className="text-sm text-stone-500">Not yet completed</p>
                : <p className="text-xs text-stone-500">Requires Payroll Admin access</p>
            }
            recurringComponentsSection={
              <EmployeeRecurringComponentsSection
                employeeId={profile.id}
                clubId={profile.clubId}
                canWrite={canWritePayrollRecurring}
                catalogue={payrollComponentCatalogue
              .filter((c) => (c as unknown as { usage?: string }).usage !== "ONE_TIME")
              .map((c) => ({
                  id: c.id,
                  code: c.code,
                  displayName: c.displayName,
                  category: c.category,
                  side: c.side,
                  cashEffect: c.cashEffect,
                  calculationMethod: c.calculationMethod as "FIXED_AMOUNT" | "PERCENT_OF_ELIGIBLE_EARNINGS",
                  displaySection: c.displaySection,
                }))}
                assignments={recurringComponentAssignments.map((a) => ({
                  id: a.id,
                  componentId: a.componentId,
                  componentCode: a.component.code,
                  componentDisplayName: a.component.displayName,
                  componentCategory: a.component.category,
                  componentSide: a.component.side,
                  cashEffect: a.component.cashEffect,
                  calculationMethod: a.component.calculationMethod,
                  displaySection: a.component.displaySection,
                  amount: a.amount != null ? String(a.amount) : null,
                  percentBps: a.percentBps,
                  effectiveFrom: a.effectiveFrom.toISOString(),
                  effectiveTo: a.effectiveTo?.toISOString() ?? null,
                  active: a.active,
                  notes: a.notes,
                }))}
                addAction={addRecurringPayrollComponentAction}
                endAction={endRecurringPayrollComponentAction}
                changeAction={changeRecurringPayrollComponentAction}
              />
            }
          />
        ) : undefined
      }
      defaultTab={defaultTab}
    />
  );
}
*/
