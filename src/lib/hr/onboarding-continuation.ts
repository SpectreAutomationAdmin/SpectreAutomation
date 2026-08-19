// HR-2B.3.2 §2 (2026-08-18) — Canonical onboarding continuation resolver.
//
// Given an EmployeeOnboardingActor (or its constituent {sessionId,
// employeeId, clubId}), return the URL the employee should land on
// next. All invitation-entry, session-resume, and hub-redirect paths
// go through this ONE function — no scattered step-resolution logic.
//
// The resolution reads server-side persistent state ONLY. Browser
// state (localStorage, cookies) is deliberately not consulted, so
// resuming on a different browser or device produces the same
// canonical next step.
//
// Ordering (deterministic; matches the founder-accepted progress rail):
//
//   About You
//     name        — Employee.preferredName is non-empty
//     contact     — Employee.personalEmail OR .mobilePhone is non-empty
//     employment  — EmployeeOnboardingAcknowledgement(kind="employment_confirmation")
//                     OR ≥1 EmployeeOnboardingCorrection row
//     photo       — Employee.profilePhotoDocumentId is non-null
//   Payroll
//     sin              — EmployeeSensitiveIdentity row with sinLastThree
//     direct-deposit   — EmployeeBankAccount in a non-terminal status
//     td1-federal      — EmployeeTaxProfile row present AND
//                        EmployeeOnboardingAcknowledgement("td1_federal_attestation")
//     td1-provincial   — EmployeeOnboardingAcknowledgement("td1_provincial_attestation")
//   Review + Complete
//     review           — every above is complete
//     complete         — session.state === "SUBMITTED"/"APPROVED"/"REJECTED"
//
// A session in a terminal state (SUBMITTED/APPROVED/REJECTED/REVOKED)
// bypasses the resume flow and routes to the completion screen.

import { prisma } from "../prisma";
import { RESUMABLE_ONBOARDING_STATES } from "./employee-onboarding-state";

export interface ContinuationContext {
  sessionId: string;
  employeeId: string;
  clubId: string;
}

/** Return value of the resolver — always a URL path (leading slash). */
export type ContinuationTarget = string;

const URLS = {
  // About You
  aboutYouName: "/hr/onboarding/about-you/name",
  aboutYouContact: "/hr/onboarding/about-you/contact",
  aboutYouEmployment: "/hr/onboarding/about-you/employment",
  aboutYouPhoto: "/hr/onboarding/about-you/photo",
  aboutYouComplete: "/hr/onboarding/about-you/complete",
  // Payroll
  payrollSin: "/hr/onboarding/payroll/sin",
  payrollDirectDeposit: "/hr/onboarding/payroll/direct-deposit",
  payrollTd1Federal: "/hr/onboarding/payroll/td1-federal",
  payrollTd1Provincial: "/hr/onboarding/payroll/td1-provincial",
  payrollReview: "/hr/onboarding/payroll/review",
  payrollComplete: "/hr/onboarding/payroll/complete",
  // Terminal
  submitted: "/hr/onboarding/payroll/complete",
  expired: "/hr/onboarding/expired",
} as const;

/**
 * Resolve the canonical next-step URL for the given context. Reads
 * ONLY persistent server-side state — never a cookie, never a
 * search param, never a browser storage value.
 *
 * Returns:
 *   - a step URL when the employee still has work to do
 *   - `URLS.aboutYouComplete` when About You is done but payroll
 *     is not yet started (kept for continuity with the existing
 *     hand-off screen that has the "Continue to payroll" CTA)
 *   - `URLS.payrollComplete` when payroll is complete OR the
 *     session is in a terminal state (SUBMITTED/APPROVED/REJECTED)
 *   - `URLS.expired` when the session row cannot be resolved
 *     (should not happen for a valid actor, but defensive)
 */
export async function resolveOnboardingContinuation(
  ctx: ContinuationContext,
): Promise<ContinuationTarget> {
  // 1. Session state gate. Terminal → completion screen.
  const session = await prisma.employeeOnboardingSession.findFirst({
    where: {
      id: ctx.sessionId,
      employeeId: ctx.employeeId,
      clubId: ctx.clubId,
    },
    select: { id: true, state: true },
  });
  if (!session) return URLS.expired;
  if (!(RESUMABLE_ONBOARDING_STATES as readonly string[]).includes(session.state)) {
    // SUBMITTED / APPROVED / REJECTED / REVOKED — bypass resume flow.
    return URLS.payrollComplete;
  }

  // 2. Read every completion signal in parallel.
  //
  // HR-2B.3.3 (2026-08-18) — About You / Name + Contact are now
  // driven by durable ack rows (kinds `about_you_name_confirmation`
  // + `about_you_contact_confirmation`). The prior
  // "inferred from optional identity field" logic
  // (`Boolean(preferredName?.trim())` / `Boolean(personalEmail || mobilePhone)`)
  // caused the /about-you/complete → Continue-to-payroll backward-
  // navigation bug — an employee who submitted Name without a
  // preferred name looked "not done" to the resolver even though
  // the step action had advanced them past it. The ack row is now
  // the SINGLE canonical signal and is written by saveNameAction /
  // saveContactAction in the same transaction as the identity write.
  const [
    employee,
    nameAck,
    contactAck,
    employmentAck,
    correctionCount,
    sinRow,
    bankRow,
    taxRow,
    fedAtt,
    provAtt,
  ] = await Promise.all([
    prisma.employee.findFirst({
      where: { id: ctx.employeeId, clubId: ctx.clubId },
      select: {
        profilePhotoDocumentId: true,
      },
    }),
    prisma.employeeOnboardingAcknowledgement.findFirst({
      where: {
        sessionId: ctx.sessionId,
        clubId: ctx.clubId,
        kind: "about_you_name_confirmation",
      },
      select: { id: true },
    }),
    prisma.employeeOnboardingAcknowledgement.findFirst({
      where: {
        sessionId: ctx.sessionId,
        clubId: ctx.clubId,
        kind: "about_you_contact_confirmation",
      },
      select: { id: true },
    }),
    prisma.employeeOnboardingAcknowledgement.findFirst({
      where: {
        sessionId: ctx.sessionId,
        clubId: ctx.clubId,
        kind: "employment_confirmation",
      },
      select: { id: true },
    }),
    prisma.employeeOnboardingCorrection.count({
      where: {
        sessionId: ctx.sessionId,
        clubId: ctx.clubId,
        field: { in: ["positionId", "departmentId", "expectedStartDate", "employmentType"] },
      },
    }),
    prisma.employeeSensitiveIdentity.findFirst({
      where: { employeeId: ctx.employeeId, clubId: ctx.clubId },
      select: { sinLastThree: true },
    }),
    prisma.employeeBankAccount.findFirst({
      where: {
        employeeId: ctx.employeeId,
        clubId: ctx.clubId,
        status: { in: ["PENDING_PENNY_TEST", "VERIFIED"] },
      },
      select: { id: true },
    }),
    prisma.employeeTaxProfile.findFirst({
      where: { employeeId: ctx.employeeId, clubId: ctx.clubId },
      select: { id: true },
    }),
    prisma.employeeOnboardingAcknowledgement.findFirst({
      where: {
        sessionId: ctx.sessionId,
        clubId: ctx.clubId,
        kind: "td1_federal_attestation",
      },
      select: { id: true },
    }),
    prisma.employeeOnboardingAcknowledgement.findFirst({
      where: {
        sessionId: ctx.sessionId,
        clubId: ctx.clubId,
        kind: "td1_provincial_attestation",
      },
      select: { id: true },
    }),
  ]);

  if (!employee) return URLS.expired;

  // 3. About You cascade — every predicate is now a persisted event.
  const nameDone = Boolean(nameAck);
  const contactDone = Boolean(contactAck);
  const employmentDone = Boolean(employmentAck) || correctionCount > 0;
  const photoDone = Boolean(employee.profilePhotoDocumentId);

  if (!nameDone) return URLS.aboutYouName;
  if (!contactDone) return URLS.aboutYouContact;
  if (!employmentDone) return URLS.aboutYouEmployment;
  if (!photoDone) return URLS.aboutYouPhoto;

  // 4. Payroll cascade.
  const sinDone = Boolean(sinRow && sinRow.sinLastThree);
  const bankingDone = Boolean(bankRow);
  const taxRowExists = Boolean(taxRow);
  const federalAttestationDone = Boolean(fedAtt);
  const provincialAttestationDone = Boolean(provAtt);

  if (!sinDone) return URLS.payrollSin;
  if (!bankingDone) return URLS.payrollDirectDeposit;
  if (!taxRowExists || !federalAttestationDone) return URLS.payrollTd1Federal;
  if (!provincialAttestationDone) return URLS.payrollTd1Provincial;

  // 5. Everything done → review, then completion.
  return URLS.payrollReview;
}

/**
 * Enumerate every URL this resolver may return. Playwright + unit
 * tests use this to prove no step URL is missing from the mapping.
 */
export const ONBOARDING_CONTINUATION_URLS = Object.freeze(URLS);
