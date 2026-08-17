// HR-2A (2026-08-16) — Employee profile shell.
//
// Server component. All data is fetched through canonical HR
// services (`getEmployee`, `listEmploymentPeriods`,
// `listEmployeeDocuments`, `listSessions`, `listTransitions`) so
// this file never touches sensitive fields directly and never calls
// any reveal API. `getEmployee` returns SIN / bank / tax in
// already-masked form; even those masks are only populated when the
// caller has the corresponding `hr:*:read` permission.
//
// Layout (HR-2A):
//   • Header — name + lifecycle / onboarding / payroll badges +
//     member-indicator link.
//   • Overview tab — profile card + role/team card + optional
//     Member indicator card.
//   • Employment tab — every EmploymentPeriod row (past + current).
//   • Payroll tab — empty state while payrollReadiness=NOT_READY.
//   • Documents tab — categorised list; RESTRICTED requires
//     `hr:sensitive:read` (service-enforced).
//   • Activity tab — onboarding state-transition timeline.
//
// The "Invite to complete onboarding" action lives in the Overview
// tab when the current session is DRAFT.

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { Badge } from "@/components/Badge";
import { Tabs } from "@/components/Tabs";
import EmployeeAvatar from "@/components/hr/EmployeeAvatar";
import { formatDate } from "@/lib/finance";
import { getEmployee } from "@/lib/hr/employees";
import { listEmploymentPeriods } from "@/lib/hr/employment-periods";
import { listEmployeeDocuments } from "@/lib/hr/documents";
import { listSessions, listTransitions } from "@/lib/hr/onboarding-sessions";
import { isAppError } from "@/lib/errors";

import InviteToOnboardingButton from "./InviteToOnboardingButton";

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
            select: { name: true, code: true },
          })
        : Promise.resolve(null),
      profile.positionId
        ? prisma.employeePosition.findUnique({
            where: { id: profile.positionId },
            select: { name: true, code: true },
          })
        : Promise.resolve(null),
      profile.managerEmployeeId
        ? prisma.employee.findUnique({
            where: { id: profile.managerEmployeeId },
            select: { id: true, firstName: true, lastName: true, preferredName: true },
          })
        : Promise.resolve(null),
    ]);

  // Most recent in-flight onboarding session (drives the invite
  // action visibility + the activity timeline).
  const currentSession = sessions.find((s) => s.state === "DRAFT")
    ?? sessions.find((s) => !["REVOKED", "APPROVED"].includes(s.state))
    ?? sessions[0]
    ?? null;
  const transitions =
    currentSession && canReadOnboarding
      ? await listTransitions(principal, currentSession.id)
      : [];

  const displayName = profile.preferredName?.trim().length
    ? `${profile.preferredName} ${profile.lastName}`
    : `${profile.firstName} ${profile.lastName}`;
  const legalName =
    profile.middleName?.trim().length
      ? `${profile.firstName} ${profile.middleName} ${profile.lastName}`
      : `${profile.firstName} ${profile.lastName}`;

  const canInvite =
    hasPermission(principal, profile.clubId, "hr:onboarding:invite") &&
    currentSession?.state === "DRAFT";

  return (
    <div>
      <Link
        href="/app/admin/people/employees"
        className="text-sm text-stone-500 hover:text-club-ink"
      >
        ← Employee Directory
      </Link>

      {/* HR-2A.2 (2026-08-17) — header mirrors Member profile
          composition: modest avatar, h1 name, optional legal-name
          subtitle when it differs, three-badge status row grouped
          with an identity subordinate line, optional Member
          reciprocal subordinate xs text. Right side hosts the
          primary action (Invite) — same slot Member uses for
          "Current balance". */}
      <div className="mt-3 flex flex-wrap items-start gap-6 justify-between">
        <div className="flex items-start gap-4">
          <EmployeeAvatar firstName={profile.firstName} lastName={profile.lastName} size={44} />
          <div>
            <h1 className="page-title">{displayName}</h1>
            {displayName !== legalName && (
              <div className="mt-0.5 text-xs text-stone-500">Legal: {legalName}</div>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge status={profile.employeeLifecycle} />
              <Badge status={profile.onboardingState} />
              <Badge status={profile.payrollReadiness} />
              <span className="text-sm text-stone-500">
                {profile.employeeNumber}
                {position?.name ? ` · ${position.name}` : ""}
                {department?.name ? ` · ${department.name}` : ""}
              </span>
            </div>
            {memberLink && (
              <div className="mt-2 text-xs text-stone-500">
                Also a{" "}
                <Link
                  href={`/app/admin/members/${memberLink.id}`}
                  className="text-club-green-700 hover:underline"
                >
                  Club Member · #{memberLink.memberNumber}
                </Link>
              </div>
            )}
          </div>
        </div>
        {canInvite && currentSession && (
          <InviteToOnboardingButton employeeId={profile.id} />
        )}
      </div>

      <div className="mt-8">
        <Tabs
          tabs={[
            {
              id: "overview",
              label: "Overview",
              content: (
                // HR-2A.2 (2026-08-17) — Overview mirrors the Member
                // profile's grouped structure: 2/3 left column with
                // meaningful groupings (Employment + Contact) instead
                // of one flat field dump; 1/3 right rail with a
                // Current status summary card and an optional Club
                // Member card. Right rail is ALWAYS present (so the
                // page composition is balanced) even without a Member
                // link — the Current status card fills it.
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                  <div className="lg:col-span-2 space-y-6">
                    <div className="card card-body space-y-4">
                      <h3 className="section-title text-lg">Employment</h3>
                      <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                        <Field label="Position">{position?.name ?? "—"}</Field>
                        <Field label="Department">{department?.name ?? "—"}</Field>
                        <Field label="Employment type">
                          {profile.employmentType?.replace(/_/g, " ") ?? "—"}
                        </Field>
                        <Field label="Reports to">
                          {manager
                            ? (manager.preferredName?.trim().length
                                ? `${manager.preferredName} ${manager.lastName}`
                                : `${manager.firstName} ${manager.lastName}`)
                            : "—"}
                        </Field>
                        <Field label="Expected start date">
                          {profile.expectedStartDate ? formatDate(profile.expectedStartDate) : "—"}
                        </Field>
                        <Field label="Employee number">{profile.employeeNumber}</Field>
                      </dl>
                    </div>
                    <div className="card card-body space-y-4">
                      <h3 className="section-title text-lg">Contact</h3>
                      <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                        <Field label="Personal email">{profile.personalEmail ?? "—"}</Field>
                        <Field label="Mobile phone">{profile.mobilePhone ?? "—"}</Field>
                        {profile.email && <Field label="Work email">{profile.email}</Field>}
                      </dl>
                    </div>
                  </div>
                  <div className="space-y-4">
                    <div className="card card-body">
                      <h3 className="section-title text-lg">Current status</h3>
                      <dl className="mt-3 space-y-3 text-sm">
                        <StatusRow
                          label="Lifecycle"
                          badgeStatus={profile.employeeLifecycle}
                          hint={lifecycleHint(profile.employeeLifecycle)}
                        />
                        <StatusRow
                          label="Onboarding"
                          badgeStatus={profile.onboardingState}
                          hint={onboardingHint(profile.onboardingState)}
                        />
                        <StatusRow
                          label="Payroll"
                          badgeStatus={profile.payrollReadiness}
                          hint={payrollHint(profile.payrollReadiness)}
                        />
                      </dl>
                    </div>
                    {memberLink && (
                      <div className="card card-body">
                        <h3 className="section-title text-lg">Club Member</h3>
                        <p className="mt-2 text-sm text-stone-600">
                          {memberLink.firstName} {memberLink.lastName} · #{memberLink.memberNumber}
                        </p>
                        <Link
                          href={`/app/admin/members/${memberLink.id}`}
                          className="btn btn-secondary btn-sm mt-3"
                        >
                          Open member profile
                        </Link>
                      </div>
                    )}
                  </div>
                </div>
              ),
            },
            {
              id: "employment",
              label: "Employment",
              content: (
                <div className="card overflow-hidden">
                  <table className="table-base">
                    <thead>
                      <tr>
                        <th>From</th>
                        <th>To</th>
                        <th>Type</th>
                        <th>Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {employmentPeriods.length === 0 && (
                        <tr>
                          <td colSpan={4} className="px-4 py-8 text-center text-stone-500">
                            No employment history yet.
                          </td>
                        </tr>
                      )}
                      {employmentPeriods.map((p) => (
                        <tr key={p.id}>
                          <td>{formatDate(p.effectiveFrom)}</td>
                          <td>{p.effectiveTo ? formatDate(p.effectiveTo) : "current"}</td>
                          <td className="text-stone-600 text-xs">
                            {p.employmentType.replace(/_/g, " ")}
                          </td>
                          <td className="text-stone-600 text-xs">
                            {p.reason.replace(/_/g, " ")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ),
            },
            {
              id: "payroll",
              label: "Payroll",
              content: (
                <div className="card card-body max-w-2xl">
                  {profile.payrollReadiness === "NOT_READY" ? (
                    <div className="text-stone-500">
                      <h3 className="section-title text-lg text-club-ink">Payroll not yet configured</h3>
                      <p className="mt-2 text-sm">
                        Payroll setup completes during employee onboarding. Once the employee
                        submits banking, SIN, and tax information (and Payroll Admin approves),
                        this tab will show their payroll profile.
                      </p>
                    </div>
                  ) : (
                    <div className="text-sm text-stone-500">
                      Payroll readiness: <Badge status={profile.payrollReadiness} />
                    </div>
                  )}
                </div>
              ),
            },
            {
              id: "documents",
              label: "Documents",
              content: (
                <div className="card overflow-hidden">
                  <table className="table-base">
                    <thead>
                      <tr>
                        <th>Category</th>
                        <th>Display name</th>
                        <th>Uploaded</th>
                        <th>Sensitivity</th>
                      </tr>
                    </thead>
                    <tbody>
                      {documents.length === 0 && (
                        <tr>
                          <td colSpan={4} className="px-4 py-8 text-center text-stone-500">
                            No documents on file.
                          </td>
                        </tr>
                      )}
                      {documents.map((d) => (
                        <tr key={d.id}>
                          <td className="text-xs uppercase tracking-wide text-stone-500">
                            {d.category.replace(/_/g, " ")}
                          </td>
                          <td>{d.displayName ?? "—"}</td>
                          <td className="text-xs text-stone-600">{formatDate(d.uploadedAt)}</td>
                          <td><Badge status={d.sensitivity} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ),
            },
            {
              id: "activity",
              label: "Activity",
              content: (
                <div className="card overflow-hidden">
                  {!currentSession && (
                    <div className="px-6 py-10 text-center text-stone-500">
                      No onboarding session yet.
                    </div>
                  )}
                  {currentSession && (
                    <table className="table-base">
                      <thead>
                        <tr>
                          <th>When</th>
                          <th>Transition</th>
                          <th>Actor</th>
                          <th>Notes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {transitions.length === 0 && (
                          <tr>
                            <td colSpan={4} className="px-4 py-8 text-center text-stone-500">
                              No transitions yet.
                            </td>
                          </tr>
                        )}
                        {transitions.map((t) => (
                          <tr key={t.id}>
                            <td className="text-xs text-stone-600">{formatDate(t.at)}</td>
                            <td className="text-xs">
                              {t.fromState.replace(/_/g, " ")} → {t.toState.replace(/_/g, " ")}
                            </td>
                            <td className="text-xs text-stone-600">
                              {t.actorSource.toLowerCase()}
                            </td>
                            <td className="text-xs text-stone-500">{t.reason ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              ),
            },
          ]}
        />
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-stone-500">{label}</dt>
      <dd className="mt-1 text-club-ink">{children}</dd>
    </div>
  );
}

function StatusRow({ label, badgeStatus, hint }: { label: string; badgeStatus: string; hint: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <dt className="text-xs uppercase tracking-wide text-stone-500">{label}</dt>
        <dd className="mt-1 text-xs text-stone-600">{hint}</dd>
      </div>
      <Badge status={badgeStatus} />
    </div>
  );
}

function lifecycleHint(state: string): string {
  switch (state) {
    case "PRE_HIRE": return "Not yet activated for payroll.";
    case "ACTIVE": return "On the club roster.";
    case "LEAVE": return "Currently on leave.";
    case "TERMINATED": return "No longer on the roster.";
    default: return "";
  }
}

function onboardingHint(state: string): string {
  switch (state) {
    case "DRAFT": return "Awaiting invitation.";
    case "INVITED": return "Invitation issued, awaiting employee.";
    case "IN_PROGRESS": return "Employee is completing their profile.";
    case "SUBMITTED": return "Awaiting Controller review.";
    case "APPROVED": return "Onboarding complete.";
    case "REJECTED": return "Onboarding rejected.";
    case "REVOKED": return "Invitation revoked.";
    default: return "";
  }
}

function payrollHint(state: string): string {
  switch (state) {
    case "NOT_READY": return "SIN, banking, or tax data missing.";
    case "READY": return "All requirements collected; awaiting activation.";
    case "ACTIVE": return "Payroll active for this employee.";
    default: return "";
  }
}
