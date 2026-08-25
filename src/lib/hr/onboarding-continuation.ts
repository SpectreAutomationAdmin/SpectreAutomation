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
import { isDocumentsSectionComplete, isEmergencySectionComplete } from "./onboarding-requirements";
import type { EmployeeOnboardingActor } from "./employee-actor";

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
  // HR mobile-hotfix (2026-08-30) §1 — address step between contact
  // and employment.
  aboutYouAddress: "/hr/onboarding/about-you/address",
  aboutYouEmployment: "/hr/onboarding/about-you/employment",
  aboutYouPhoto: "/hr/onboarding/about-you/photo",
  aboutYouComplete: "/hr/onboarding/about-you/complete",
  // Payroll
  payrollSin: "/hr/onboarding/payroll/sin",
  payrollDirectDeposit: "/hr/onboarding/payroll/direct-deposit",
  payrollTd1Federal: "/hr/onboarding/payroll/td1-federal",
  payrollTd1Provincial: "/hr/onboarding/payroll/td1-provincial",
  payrollReview: "/hr/onboarding/payroll/review",
  // HR-2B.5 blocker fix (2026-08-20) — this route is now a pure
  // forward-router (see /hr/onboarding/payroll/complete/page.tsx). The
  // resolver NEVER emits this URL; kept only so a stale bookmark
  // resolves through the session entrypoint.
  payrollComplete: "/hr/onboarding/payroll/complete",
  // HR-2B.4 (2026-08-19) — post-payroll sections
  emergency: "/hr/onboarding/emergency",
  documents: "/hr/onboarding/documents",
  // HR-2B.5 (2026-08-19) — portal-password + real Review + Submit.
  //   `portalPassword` — the dedicated account-security step where the
  //     employee creates their permanent Employee Portal password.
  //   `review`         — the grouped Review page that replaces
  //     `readyForReview` as the pre-Submit boundary.
  portalPassword: "/hr/onboarding/portal-password",
  review: "/hr/onboarding/review",
  // HR-2B.4 stopping boundary — preserved for back-compat redirects
  // from old links; the resolver no longer emits it.
  readyForReview: "/hr/onboarding/ready-for-review",
  // Terminal
  submitted: "/hr/onboarding/complete",
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
 *   - `URLS.submitted` (`/hr/onboarding/complete`) when the session
 *     is in a terminal state (SUBMITTED/APPROVED/REJECTED). The old
 *     HR-2B.3 `URLS.payrollComplete` boundary was RETIRED in the
 *     HR-2B.5 blocker fix (2026-08-20) after it stranded the founder
 *     on staging with a disabled "Continue (available soon)" button.
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
    // SUBMITTED / APPROVED / REJECTED — bypass resume flow, land the
    // employee on the post-submit handoff (HR-2B.5 §31). REVOKED
    // sessions can't do anything useful and are routed the same
    // way — the terminal page detects state and redirects safely.
    if (session.state === "REVOKED") return URLS.expired;
    return URLS.submitted;
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
    addressAck,
    employmentAck,
    correctionCount,
    sinRow,
    bankRow,
    taxRow,
    fedAtt,
    provAtt,
    portalCredential,
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
    // HR mobile-hotfix (2026-08-30) §1 — address ack lives between
    // contact and employment.
    prisma.employeeOnboardingAcknowledgement.findFirst({
      where: {
        sessionId: ctx.sessionId,
        clubId: ctx.clubId,
        kind: "about_you_address_confirmation",
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
    // HR-2B.5 (2026-08-19) — portal credential is the authoritative
    // signal for "portal password set". The ack row is written next
    // to it but the credential row is what the login flow actually
    // consults, so it's the source of truth here too.
    prisma.employeePortalCredential.findFirst({
      where: { employeeId: ctx.employeeId, clubId: ctx.clubId },
      select: { id: true },
    }),
  ]);

  if (!employee) return URLS.expired;

  // 3. About You cascade — every predicate is now a persisted event.
  const nameDone = Boolean(nameAck);
  const contactDone = Boolean(contactAck);
  // HR mobile-hotfix (2026-08-30) §1 — address step between contact +
  // employment. Uses the same durable-ack shape as name / contact.
  const addressDone = Boolean(addressAck);
  const employmentDone = Boolean(employmentAck) || correctionCount > 0;
  const photoDone = Boolean(employee.profilePhotoDocumentId);

  if (!nameDone) return URLS.aboutYouName;
  if (!contactDone) return URLS.aboutYouContact;
  if (!addressDone) return URLS.aboutYouAddress;
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

  // 5. HR-2B.4 (2026-08-19) — Emergency, then Documents & Credentials.
  //
  // Payroll is canonically complete at this point; continuation now
  // moves to the post-payroll sections. Completion signals are the
  // same "persisted server-side state only" pattern as everything
  // above — no browser inference.
  //
  //   * Emergency  — a primary EmployeeEmergencyContact row exists
  //                  with name+relation+phone all non-empty.
  //   * Documents  — every REQUIRED applicable active OnboardingRequirement
  //                  is satisfied via its canonical fulfillment row
  //                  (EmployeeDocument / EmployeeCredential /
  //                  EmployeeOnboardingAcknowledgement keyed on code).
  //                  Optional requirements never block.
  //
  // When Documents is complete, HR-2B.4 has no further step to route
  // to — HR-2B.5 will own the real Review page + Submit action. The
  // canonical stopping boundary is /hr/onboarding/ready-for-review
  // which renders a truthful "Your final review is coming next"
  // message and does NOT expose a fake Submit button.
  const actorForSection: EmployeeOnboardingActor = {
    clubId: ctx.clubId,
    employeeId: ctx.employeeId,
    sessionId: ctx.sessionId,
    invitationId: "",
    sessionState: "IN_PROGRESS",
    redeemedAt: new Date().toISOString(),
  };
  const emergencyDone = await isEmergencySectionComplete(actorForSection);
  if (!emergencyDone) return URLS.emergency;
  const documentsDone = await isDocumentsSectionComplete(actorForSection);
  if (!documentsDone) return URLS.documents;

  // 6. HR-2B.5 §4 — Portal password. The employee must establish their
  //    permanent Employee Portal credential before Review. This step
  //    exists between Documents & Credentials and Review so the
  //    employee sees their Employee Number and creates their password
  //    while still inside the temporary onboarding session.
  const portalCredentialDone = Boolean(portalCredential);
  if (!portalCredentialDone) return URLS.portalPassword;

  // 7. HR-2B.5 §20 — Real Review page + Submit.
  return URLS.review;
}

/**
 * Enumerate every URL this resolver may return. Playwright + unit
 * tests use this to prove no step URL is missing from the mapping.
 */
export const ONBOARDING_CONTINUATION_URLS = Object.freeze(URLS);
