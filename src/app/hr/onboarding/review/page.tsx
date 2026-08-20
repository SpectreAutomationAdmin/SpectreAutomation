// HR-2B.5 §20-31 (2026-08-19) — Final Review + Submit.
//
// Replaces the HR-2B.4 `ready-for-review` stopping boundary with the
// real grouped Review page. Every value on this page comes from
// persisted state — the resolver has already gated us here based on
// the same signals, but we re-read + display so the employee sees
// what they're about to submit.
//
// Sensitive-value discipline (§23):
//   - SIN: masked "XXX XXX 286" only.
//   - Direct deposit: "Account ending in 7890" only. Void cheque
//     appears as "Received" or "Not received", never a download link.
//   - Tax profiles: attestation status only, no numeric SIN or
//     claim-amount rehydration.
//   - Portal password: masked bullets. Absence blocks Submit.
//
// Submission (§28) goes through submitOnboardingAction which
// re-validates readiness server-side and refuses if any required
// piece is missing (never trusts route visitation).

import { redirect } from "next/navigation";
import Link from "next/link";
import { resolveEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import { getEmployeeOnboardingSession } from "@/lib/hr/employee-onboarding-session";
import { prisma } from "@/lib/prisma";
import {
  getSelfBankAccountMasked,
  getSelfBankingDocument,
  getSelfEmergencyContact,
  getSelfSinMasked,
  getSelfTaxProfileMasked,
  getSelfTd1Attestation,
  getSelfCurrentCompensation,
  getPayrollCompletion,
  listSelfEmploymentCorrections,
} from "@/lib/hr/employee-self-service";
import { resolveRequirementStatus } from "@/lib/hr/onboarding-requirements";
import { getProvincialTd1, TD1_FEDERAL_CURRENT } from "@/lib/hr/td1-forms";
import { submitOnboardingAction } from "../_hr2b5-actions";
import PostPayrollShell from "../_post-payroll-shell";
import ReviewSubmitForm from "./ReviewSubmitForm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function formatDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function formatEmploymentType(t: string | null): string {
  if (!t) return "—";
  return { FULL_TIME: "Full-time", PART_TIME: "Part-time", SEASONAL: "Seasonal", CONTRACT: "Contract" }[t] ?? t;
}

function formatMoney(n: number | string | { toString(): string } | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const s = typeof n === "string" ? n : n.toString();
  const num = Number(s);
  if (!Number.isFinite(num)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(num);
}

export default async function ReviewStep() {
  // HR-2B.5 §46 (2026-08-19) — Idempotence: a returning employee
  // whose session already moved to a terminal state (SUBMITTED /
  // APPROVED / REJECTED) must be routed to /complete, not /expired.
  // Because `resolveEmployeeOnboardingActor()` (correctly) rejects
  // non-resumable states as a mutation guard, we read the cookie
  // directly to detect the terminal state BEFORE calling the
  // actor resolver.
  const cookie = await getEmployeeOnboardingSession();
  if (cookie.sessionId && cookie.employeeId && cookie.clubId) {
    const priorSession = await prisma.employeeOnboardingSession.findFirst({
      where: { id: cookie.sessionId, employeeId: cookie.employeeId, clubId: cookie.clubId },
      select: { state: true },
    });
    if (priorSession && (
      priorSession.state === "SUBMITTED" ||
      priorSession.state === "APPROVED" ||
      priorSession.state === "REJECTED"
    )) {
      redirect("/hr/onboarding/complete");
    }
  }

  const actor = await resolveEmployeeOnboardingActor();
  if (!actor) redirect("/hr/onboarding/expired");

  // Defence-in-depth: only TERMINAL states redirect to /complete;
  // DRAFT / INVITED / IN_PROGRESS all render the Review page. (An
  // INVITED session that reached Review is a legitimate state in
  // some test fixture paths — the redemption INVITED→IN_PROGRESS
  // transition may not have fired yet.)
  const session = await prisma.employeeOnboardingSession.findFirst({
    where: { id: actor.sessionId, employeeId: actor.employeeId, clubId: actor.clubId },
    select: { state: true },
  });
  if (session && (
    session.state === "SUBMITTED" ||
    session.state === "APPROVED" ||
    session.state === "REJECTED"
  )) {
    redirect("/hr/onboarding/complete");
  }

  const [
    employee,
    payroll,
    sinMasked,
    banking,
    voidCheque,
    taxProfileMasked,
    fedAtt,
    provAtt,
    emergency,
    requirementStatus,
    compensation,
    corrections,
    portalCredential,
  ] = await Promise.all([
    prisma.employee.findFirst({
      where: { id: actor.employeeId, clubId: actor.clubId },
      select: {
        employeeNumber: true,
        firstName: true,
        lastName: true,
        middleName: true,
        preferredName: true,
        personalEmail: true,
        mobilePhone: true,
        expectedStartDate: true,
        employmentType: true,
        profilePhotoDocumentId: true,
        department: { select: { name: true } },
        position: { select: { name: true } },
        manager: { select: { firstName: true, lastName: true, preferredName: true } },
      },
    }),
    getPayrollCompletion(actor),
    getSelfSinMasked(actor),
    getSelfBankAccountMasked(actor),
    getSelfBankingDocument(actor),
    getSelfTaxProfileMasked(actor),
    getSelfTd1Attestation(actor, "federal"),
    getSelfTd1Attestation(actor, "provincial"),
    getSelfEmergencyContact(actor),
    resolveRequirementStatus(actor),
    getSelfCurrentCompensation(actor),
    listSelfEmploymentCorrections(actor),
    prisma.employeePortalCredential.findFirst({
      where: { employeeId: actor.employeeId, clubId: actor.clubId },
      select: { id: true, passwordUpdatedAt: true },
    }),
  ]);

  if (!employee) redirect("/hr/onboarding/expired");

  // Defensive: if the resolver would send us elsewhere (a required
  // piece is missing), route there. Never let the employee attempt
  // Submit on an incomplete session — the server action would refuse
  // anyway, but this keeps the UX honest.
  if (!payroll.complete) redirect("/hr/onboarding/payroll");
  if (!portalCredential) redirect("/hr/onboarding/portal-password");

  const legalName = [employee.firstName, employee.middleName, employee.lastName].filter(Boolean).join(" ");
  const managerName = employee.manager
    ? (employee.manager.preferredName ?? employee.manager.firstName) + " " + employee.manager.lastName
    : null;

  const correctionByField = new Map(corrections.map((c) => [c.field, c] as const));

  const provincialTd1Spec = taxProfileMasked?.province ? getProvincialTd1(taxProfileMasked.province) : null;
  const provincialLabel = provincialTd1Spec?.title.split(" ")[0] ?? "Provincial";

  return (
    <PostPayrollShell
      actor={actor}
      currentSection="review"
      headline="Ready to submit, {name}?"
      subhead="Take a moment to review what you're about to send your Club. Sensitive information is masked — only your Club sees the full values."
    >
      <div className="space-y-6" data-testid="review-root">
        {/* ABOUT YOU (§21) */}
        <Section
          title="About you"
          testId="review-section-about-you"
          editHref="/hr/onboarding/about-you"
        >
          <Row label="Legal name">{legalName}</Row>
          {employee.preferredName && <Row label="Preferred name">{employee.preferredName}</Row>}
          <Row label="Personal email">{employee.personalEmail ?? "—"}</Row>
          <Row label="Mobile">{employee.mobilePhone ?? "—"}</Row>
          <Row label="Profile photo">{employee.profilePhotoDocumentId ? "Uploaded" : "Not uploaded"}</Row>
        </Section>

        {/* EMPLOYMENT (§22) */}
        <Section
          title="Employment"
          testId="review-section-employment"
          editHref="/hr/onboarding/about-you/employment"
        >
          <Row label="Employee number">
            <span className="font-mono">{employee.employeeNumber}</span>
          </Row>
          <Row label="Position" correction={correctionByField.get("positionId")?.employeeStatedValue}>
            {employee.position?.name ?? "—"}
          </Row>
          <Row label="Department" correction={correctionByField.get("departmentId")?.employeeStatedValue}>
            {employee.department?.name ?? "—"}
          </Row>
          <Row label="Employment type" correction={correctionByField.get("employmentType")?.employeeStatedValue}>
            {formatEmploymentType(employee.employmentType)}
          </Row>
          <Row label="Compensation">
            {compensation
              ? compensation.cadence === "HOURLY"
                ? `${formatMoney(compensation.rate)} / hour`
                : `${formatMoney(compensation.rate)} / year`
              : "Not set"}
          </Row>
          <Row label="Expected start date" correction={correctionByField.get("expectedStartDate")?.employeeStatedValue}>
            {formatDate(employee.expectedStartDate)}
          </Row>
          {managerName && <Row label="Reports to">{managerName}</Row>}
          {corrections.length > 0 && (
            <p className="text-xs text-amber-700 mt-2" data-testid="review-corrections-notice">
              Your Club will review your correction request before onboarding is approved. Your record isn&apos;t changed automatically.
            </p>
          )}
        </Section>

        {/* PAYROLL — MASKED (§23) */}
        <Section
          title="Payroll"
          testId="review-section-payroll"
          editHref="/hr/onboarding/payroll"
        >
          <Row label="SIN">
            <span className="font-mono">{sinMasked ?? "Not on file"}</span>
          </Row>
          <Row label="Direct deposit">
            {banking ? (
              <span>
                <span className="font-mono">{banking.accountMasked}</span>{" "}
                <span className="text-stone-500">— {banking.holderName}</span>
              </span>
            ) : (
              "Not on file"
            )}
          </Row>
          <Row label="Void cheque / direct-deposit form">
            {voidCheque ? "Received" : "Not received"}
          </Row>
          <Row label="Federal TD1">
            {fedAtt ? `Completed (${TD1_FEDERAL_CURRENT.version})` : "Not attested"}
          </Row>
          <Row label={`${provincialLabel} TD1`}>
            {provAtt ? "Completed" : "Not attested"}
          </Row>
        </Section>

        {/* EMERGENCY (§24) */}
        <Section
          title="Emergency contact"
          testId="review-section-emergency-contact"
          editHref="/hr/onboarding/emergency"
        >
          {emergency ? (
            <>
              <Row label="Name">{emergency.name}</Row>
              <Row label="Relation">{emergency.relation}</Row>
              <Row label="Phone">{emergency.phone}</Row>
              {emergency.email && <Row label="Email">{emergency.email}</Row>}
            </>
          ) : (
            <p className="text-sm text-stone-500">No emergency contact on file.</p>
          )}
        </Section>

        {/* DOCUMENTS & CREDENTIALS (§25) */}
        <Section
          title="Documents &amp; credentials"
          testId="review-section-documents-credentials"
          editHref="/hr/onboarding/documents"
        >
          {requirementStatus.requirements.length === 0 ? (
            <p className="text-sm text-stone-500">No requirements assigned.</p>
          ) : (
            <ul className="space-y-1.5" data-testid="review-requirements">
              {requirementStatus.requirements.map(({ requirement, fulfillment }) => (
                <li key={requirement.id} className="flex items-center justify-between text-sm">
                  <span className="text-stone-800">
                    {requirement.displayName}
                    {requirement.required ? "" : <span className="text-stone-400"> (optional)</span>}
                  </span>
                  <span
                    className={
                      fulfillment.satisfied ? "text-emerald-700" : "text-stone-500"
                    }
                    data-testid={`review-req-${requirement.code}`}
                  >
                    {fulfillment.satisfied ? "Complete" : "Not complete"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* PORTAL ACCOUNT (§26) */}
        <Section
          title="Employee portal"
          testId="review-section-employee-portal"
          editHref="/hr/onboarding/portal-password"
        >
          <Row label="Username">
            <span className="font-mono" data-testid="review-portal-username">
              {employee.employeeNumber}
            </span>
          </Row>
          <Row label="Password">
            {portalCredential
              ? <span data-testid="review-portal-password-mask">••••••••••••</span>
              : <span className="text-amber-700">Not set</span>}
          </Row>
        </Section>

        {/* SUBMIT (§27-28) */}
        <ReviewSubmitForm
          action={submitOnboardingAction}
          canSubmit={Boolean(portalCredential) && payroll.complete}
        />

        <div className="flex items-center justify-start pt-2">
          <Link
            href="/hr/onboarding/portal-password"
            className="text-sm text-stone-500 hover:text-stone-800"
          >
            &larr; Back
          </Link>
        </div>
      </div>
    </PostPayrollShell>
  );
}

// -- Local presentational primitives -----------------------------------------

function Section({
  title, testId, editHref, children,
}: { title: string; testId: string; editHref: string; children: React.ReactNode }) {
  return (
    <section
      className="rounded-lg border border-stone-200 bg-white px-5 py-5 md:px-6 md:py-6"
      data-testid={testId}
    >
      <div className="flex items-baseline justify-between">
        <h2 className="font-serif text-lg text-stone-900" dangerouslySetInnerHTML={{ __html: title }} />
        <Link href={editHref} className="text-xs text-stone-500 hover:text-stone-800 underline underline-offset-4">
          Edit
        </Link>
      </div>
      <dl className="mt-3 space-y-2">
        {children}
      </dl>
    </section>
  );
}

function Row({
  label, correction, children,
}: { label: string; correction?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-4 py-1">
      <dt className="text-sm text-stone-500">{label}</dt>
      <dd className="col-span-2 text-sm text-stone-900">
        {children}
        {correction && (
          <div className="mt-0.5 text-xs text-amber-700" data-testid={`review-correction-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`}>
            Correction requested: {correction}
          </div>
        )}
      </dd>
    </div>
  );
}
