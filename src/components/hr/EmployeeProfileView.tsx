"use client";

// HR-2A.3 (2026-08-17) — Employee Profile client view.
//
// Presentation-only client component that renders the founder-
// approved profile grammar extracted from the Phase 20 MemberProfileView
// (commit 8668cef on branch work-intake-state-outlook-archive-fix,
// never merged to main). Uses the `spectre-person-*` CSS classes
// (appended to src/app/globals.css in the same commit as this file)
// — a rename of the Phase 20 `spectre-member-*` block so both
// Member and Employee profiles can share the primitives once Phase
// 20 lands on main.
//
// Structure (matches the attached reference screenshot):
//   • Identity header — back arrow + photo + name + secondary
//     meta line + right-side status affordance
//   • Primary tab rail — thin horizontal, Overview / Employment /
//     Payroll / Documents / Activity
//   • Overview body — "Employee info" heading + two columns:
//       LEFT  = dense BASIC DETAILS + EMPLOYMENT sections + optional
//               CLUB MEMBER
//       RIGHT = EMPLOYEE PICTURE + STATUS
//
// Read-only for HR-2A.3. Editing flows come later. The Invite
// action lives in the status affordance so it doesn't compete with
// the profile-photo hierarchy.

import { useState } from "react";
import Link from "next/link";
import { IconChevronLeft } from "@/components/spectre/icons";
import InviteToOnboardingButton from "@/app/app/admin/people/employees/[id]/InviteToOnboardingButton";
import AdminPhotoEditor from "@/components/hr/AdminPhotoEditor";
import ResendOnboardingButton, {
  type PriorInvitation,
} from "@/app/app/admin/people/employees/[id]/ResendOnboardingButton";

type Serialized<T> = T extends Date
  ? string
  : T extends null
    ? null
    : T extends undefined
      ? undefined
      : T extends Array<infer U>
        ? Array<Serialized<U>>
        : T extends object
          ? { [K in keyof T]: Serialized<T[K]> }
          : T;

interface Props {
  employee: {
    id: string;
    clubId: string;
    employeeNumber: string;
    firstName: string;
    middleName: string | null;
    lastName: string;
    preferredName: string | null;
    email: string | null;
    personalEmail: string | null;
    phone: string | null;
    mobilePhone: string | null;
    hireDate: string | null;
    expectedStartDate: string | null;
    employmentType: string | null;
    employeeLifecycle: string;
    onboardingState: string;
    payrollReadiness: string;
    memberId: string | null;
    profilePhotoDocumentId: string | null;
  };
  department: { id: string; name: string; code: string | null } | null;
  position: { id: string; name: string; code: string | null } | null;
  manager: { id: string; firstName: string; lastName: string; preferredName: string | null } | null;
  memberLink: {
    id: string;
    memberNumber: string;
    firstName: string;
    lastName: string;
  } | null;
  employmentPeriods: Array<{
    id: string;
    effectiveFrom: string;
    effectiveTo: string | null;
    employmentType: string;
    reason: string;
  }>;
  documents: Array<{
    id: string;
    category: string;
    displayName: string | null;
    sensitivity: string;
    uploadedAt: string;
  }>;
  currentSession: { id: string; state: string } | null;
  transitions: Array<{
    id: string;
    at: string;
    fromState: string;
    toState: string;
    actorSource: string;
    reason: string | null;
  }>;
  canInvite: boolean;
  canWritePhoto?: boolean;
  /** True when the operator holds `hr:onboarding:invite` AND the
   *  session is still resumable (DRAFT / INVITED / IN_PROGRESS)
   *  AND at least one prior invitation exists for this employee. */
  canResendInvitation?: boolean;
  priorInvitation?: PriorInvitation | null;
  payroll?: {
    sinMasked: string | null;
    sinAccessible: boolean;
    bankingMasked: {
      accountMasked: string;
      holderName: string;
      status: string;
      activatedAt: string | null;
    } | null;
    bankingAccessible: boolean;
    taxProfileMasked: {
      province: string;
      td1FormVersion: string;
      effectiveFrom: string;
      hasAdditionalDeductions: boolean;
    } | null;
    taxAccessible: boolean;
    td1Attestations: Array<{ kind: string; acknowledgedAt: string }>;
  };
  /** HR-2B.4 (2026-08-19) — Emergency contact rollup. `null` when the
   *  caller does not hold `hr:emergency:read`. */
  emergencyContacts?: Array<{
    id: string; name: string; relation: string;
    phone: string; email: string | null; isPrimary: boolean;
    updatedAt: string;
  }> | null;
  /** HR-2B.4 (2026-08-19) — Credentials rollup. `null` when the caller
   *  does not hold `hr:credentials:read`. */
  credentials?: Array<{
    id: string; code: string; displayName: string;
    issuer: string | null; reference: string | null;
    issuedAt: string | null; expiresAt: string | null;
    documentId: string | null; updatedAt: string;
  }> | null;
  /** HR-2B.3.6 (2026-08-19) — Optional lifecycle controls slot (Delete /
   *  Archive). Rendered inside the profile's admin actions area on the
   *  Overview tab. The parent page decides whether to render — this
   *  component is presentation-only. */
  lifecycleControls?: React.ReactNode;
  /** HR mobile-hotfix (2026-08-30) — Optional Approve & Activate slot
   *  (§4). Rendered above lifecycleControls when the operator holds
   *  `hr:onboarding:read` so the readiness summary is visible to any
   *  HR viewer, while the write action inside the slot is gated on
   *  the caller's approve permission. */
  approvalSection?: React.ReactNode;
  /** HR-2C Employment (2026-08-24) — Optional Employment tab slot. When
   *  provided, replaces the default legacy Employment-history view with
   *  the multi-role + compensation + allowances section. The parent
   *  passes the fully-constructed section; this component just slots it
   *  in place so the tab rail + tab-switch chrome stays here. */
  employmentSection?: React.ReactNode;
  /** HR-2C B5 (2026-08-28) — Optional Training tab slot. Rendered when
   *  the caller holds `hr:training:compliance:read`. When omitted the
   *  Training tab itself is hidden from the tab rail so an
   *  unauthorised admin sees no dangling tab. */
  trainingSection?: React.ReactNode;
  /** HR-2C B5 (2026-08-28) — Initial tab, honoured on first render.
   *  Enables the Compliance dashboard's drill-through link
   *  (`?tab=training`) to land the profile directly on Training. */
  defaultTab?: string;
}

const TABS = [
  { key: "overview",   label: "Overview" },
  { key: "employment", label: "Employment" },
  { key: "payroll",    label: "Payroll" },
  // HR-2C B5 (2026-08-28) — Training placed between Payroll and
  // Documents so the operational people-management tabs sit before
  // the archival Documents / Activity tail.
  { key: "training",   label: "Training" },
  { key: "documents",  label: "Documents" },
  { key: "activity",   label: "Activity" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "Not provided";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Not provided";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function initials(first: string | null, last: string | null): string {
  const a = (first ?? "").trim().charAt(0);
  const b = (last ?? "").trim().charAt(0);
  return `${a}${b}`.toUpperCase() || "·";
}

function humanize(s: string | null | undefined): string {
  if (!s) return "—";
  return s.replace(/_/g, " ");
}

export default function EmployeeProfileView(props: Props) {
  const { employee, department, position, manager, memberLink, employmentPeriods, documents, currentSession, transitions, canInvite, canWritePhoto, canResendInvitation, priorInvitation, payroll, emergencyContacts, credentials, lifecycleControls, approvalSection, employmentSection, trainingSection, defaultTab } = props;
  const initialTab: TabKey =
    (TABS as ReadonlyArray<{ key: TabKey }>).some((t) => t.key === defaultTab) &&
    (defaultTab !== "training" || trainingSection !== undefined)
      ? (defaultTab as TabKey)
      : "overview";
  const [tab, setTab] = useState<TabKey>(initialTab);

  const displayName = employee.preferredName?.trim().length
    ? `${employee.preferredName} ${employee.lastName}`
    : `${employee.firstName} ${employee.lastName}`;

  const managerName = manager
    ? (manager.preferredName?.trim().length
        ? `${manager.preferredName} ${manager.lastName}`
        : `${manager.firstName} ${manager.lastName}`)
    : null;

  const startDateIso = employee.expectedStartDate ?? employee.hireDate;
  const startLabel = startDateIso ? formatDate(startDateIso) : "Not scheduled";
  const status = employee.employeeLifecycle.toUpperCase();

  return (
    <div className="spectre-person-profile">
      {/* ---------------- Identity header ---------------- */}
      <header className="spectre-person-header">
        <Link href="/app/admin/people/employees" className="spectre-person-back" aria-label="Back to employee directory">
          <IconChevronLeft size={18} />
        </Link>
        <div className="spectre-person-header-photo">
          {employee.profilePhotoDocumentId ? (
            /* eslint-disable-next-line @next/next/no-img-element -- same-origin authenticated stream endpoint, cache-controlled server-side */
            <img
              src={`/api/hr/employees/${employee.id}/profile-photo?v=${employee.profilePhotoDocumentId}`}
              alt={`${displayName || "Employee"} profile photo`}
              className="spectre-person-header-photo-image"
            />
          ) : (
            <span className="spectre-person-header-photo-placeholder">
              {initials(employee.firstName, employee.lastName)}
            </span>
          )}
        </div>
        <div className="spectre-person-header-body">
          <h1 className="spectre-person-header-name">{displayName || "Employee"}</h1>
          <div className="spectre-person-header-meta">
            <span className="uppercase-eyebrow">Employee since {startLabel}</span>
            <span aria-hidden="true" className="spectre-person-header-sep">|</span>
            <span className="spectre-person-header-number spectre-mono">{employee.employeeNumber}</span>
          </div>
        </div>
        <span
          className={`spectre-person-status-pill spectre-person-status-pill--${employee.employeeLifecycle.toLowerCase()}`}
          data-testid="employee-status-pill"
        >
          {status.replace(/_/g, " ")}
        </span>
      </header>

      {/* ---------------- Primary tabs ---------------- */}
      <nav className="spectre-person-tabs" role="tablist" aria-label="Employee sections">
        {TABS.map((t) => {
          // Hide the Training tab entirely when the caller lacks
          // compliance-read permission — the parent server page
          // signals this by omitting the trainingSection prop.
          if (t.key === "training" && trainingSection === undefined) return null;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`spectre-person-tab${tab === t.key ? " is-active" : ""}`}
              data-testid={`employee-tab-${t.key}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          );
        })}
      </nav>

      {/* ---------------- Tab body ---------------- */}
      {tab === "overview" && (
        <section className="spectre-person-body" data-testid="employee-tab-body">
          <h2 className="spectre-person-section-title">Employee info</h2>

          <div className="spectre-person-columns">
            {/* LEFT column: BASIC DETAILS + EMPLOYMENT + optional CLUB MEMBER */}
            <div className="spectre-person-col-left">
              <div className="spectre-person-section" data-testid="employee-basic-details">
                <div className="spectre-person-section-head">
                  <h3 className="spectre-person-eyebrow">Basic Details</h3>
                </div>
                <dl className="spectre-person-grid">
                  <PersonRow label="Legal first name" value={employee.firstName} />
                  <PersonRow label="Middle name" value={employee.middleName} />
                  <PersonRow label="Legal last name" value={employee.lastName} />
                  <PersonRow label="Preferred name" value={employee.preferredName} />
                  <PersonRow label="Personal email" value={employee.personalEmail} kind="email" />
                  <PersonRow label="Mobile" value={employee.mobilePhone ?? employee.phone} kind="phone" />
                  {employee.email && <PersonRow label="Work email" value={employee.email} kind="email" />}
                </dl>
              </div>

              <div className="spectre-person-section" data-testid="employee-employment-info">
                <div className="spectre-person-section-head">
                  <h3 className="spectre-person-eyebrow">Employment</h3>
                </div>
                <dl className="spectre-person-grid">
                  <PersonRow label="Position" value={position?.name ?? null} />
                  <PersonRow label="Department" value={department?.name ?? null} />
                  <PersonRow label="Employment type" value={humanize(employee.employmentType)} raw />
                  <PersonRow label="Reports to" value={managerName} />
                  <PersonRow label="Expected start date" value={employee.expectedStartDate ? formatDate(employee.expectedStartDate) : null} raw />
                  <PersonRow label="Employee number" value={employee.employeeNumber} raw />
                </dl>
              </div>

              {memberLink && (
                <div className="spectre-person-section" data-testid="employee-club-member">
                  <div className="spectre-person-section-head">
                    <h3 className="spectre-person-eyebrow">Club Member</h3>
                  </div>
                  <dl className="spectre-person-grid">
                    <PersonRow
                      label="Member"
                      value={`${memberLink.firstName} ${memberLink.lastName}`}
                      raw
                    />
                    <div className="spectre-person-row">
                      <dt>Member number</dt>
                      <dd>
                        <Link href={`/app/admin/members/${memberLink.id}`} className="spectre-person-link">
                          {memberLink.memberNumber}
                        </Link>
                      </dd>
                    </div>
                  </dl>
                </div>
              )}
            </div>

            {/* RIGHT column: EMPLOYEE PICTURE + STATUS */}
            <div className="spectre-person-col-right">
              <div className="spectre-person-section" data-testid="employee-picture">
                <div className="spectre-person-section-head">
                  <h3 className="spectre-person-eyebrow">Employee Picture</h3>
                </div>
                <div className="spectre-person-picture-wrap">
                  {employee.profilePhotoDocumentId ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element -- same-origin authenticated stream endpoint */}
                      <img
                        src={`/api/hr/employees/${employee.id}/profile-photo?v=${employee.profilePhotoDocumentId}`}
                        alt={`${displayName || "Employee"} profile photo`}
                        className="spectre-person-picture spectre-person-picture--image"
                        data-testid="employee-picture-image"
                      />
                      <p className="spectre-person-picture-hint">
                        Photo on file for this employee.
                      </p>
                    </>
                  ) : (
                    <>
                      <div className="spectre-person-picture spectre-person-picture--placeholder">
                        <span>{initials(employee.firstName, employee.lastName)}</span>
                      </div>
                      <p className="spectre-person-picture-hint">No employee photo provided.</p>
                    </>
                  )}
                  {canWritePhoto && (
                    <AdminPhotoEditor
                      employeeId={employee.id}
                      hasPhoto={Boolean(employee.profilePhotoDocumentId)}
                    />
                  )}
                </div>
              </div>

              <div className="spectre-person-section" data-testid="employee-status">
                <div className="spectre-person-section-head">
                  <h3 className="spectre-person-eyebrow">Status</h3>
                </div>
                <dl className="spectre-person-grid">
                  <PersonRow label="Lifecycle" value={humanize(employee.employeeLifecycle)} raw />
                  <PersonRow label="Onboarding" value={humanize(employee.onboardingState)} raw />
                  <PersonRow label="Payroll readiness" value={humanize(employee.payrollReadiness)} raw />
                </dl>
                {canInvite && currentSession && (
                  <div className="spectre-person-section-actions">
                    <InviteToOnboardingButton employeeId={employee.id} />
                  </div>
                )}
                {canResendInvitation && (
                  <div className="spectre-person-section-actions">
                    <ResendOnboardingButton
                      employeeId={employee.id}
                      priorInvitation={priorInvitation ?? null}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* HR-2B.4 (2026-08-19) — Emergency contact rollup. */}
          {emergencyContacts !== undefined && (
            <div
              className="spectre-person-section mt-6"
              data-testid="employee-emergency-contacts"
            >
              <div className="spectre-person-section-head">
                <h3 className="spectre-person-eyebrow">Emergency contact</h3>
              </div>
              {emergencyContacts === null ? (
                <p className="text-sm text-stone-500">
                  You don&apos;t have permission to view emergency-contact details.
                </p>
              ) : emergencyContacts.length === 0 ? (
                <p className="text-sm text-stone-500">
                  No emergency contact on file yet.
                </p>
              ) : (
                <dl className="spectre-person-grid">
                  {emergencyContacts.filter((c) => c.isPrimary).slice(0, 1).map((c) => (
                    <div key={c.id} className="contents">
                      <PersonRow label="Name" value={c.name} />
                      <PersonRow label="Relationship" value={c.relation} />
                      <PersonRow label="Phone" value={c.phone} kind="phone" />
                      <PersonRow label="Email" value={c.email ?? "—"} kind="email" />
                    </div>
                  ))}
                </dl>
              )}
            </div>
          )}

          {/* HR mobile-hotfix (2026-08-30) — §4 Approve & Activate slot.
             Renders above lifecycle controls so approval is the most
             prominent action on a submitted onboarding. */}
          {approvalSection}

          {/* HR-2B.3.6 — Delete / Archive controls, parent-supplied. */}
          {lifecycleControls}
        </section>
      )}

      {tab === "employment" && (
        employmentSection ?? (
          <section className="spectre-person-body">
            <h2 className="spectre-person-section-title">Employment history</h2>
            <div className="spectre-person-section">
              <table className="table-base">
                <thead>
                  <tr><th>From</th><th>To</th><th>Type</th><th>Reason</th></tr>
                </thead>
                <tbody>
                  {employmentPeriods.length === 0 && (
                    <tr><td colSpan={4} className="px-4 py-8 text-center text-stone-500">No employment history yet.</td></tr>
                  )}
                  {employmentPeriods.map((p) => (
                    <tr key={p.id}>
                      <td>{formatDate(p.effectiveFrom)}</td>
                      <td>{p.effectiveTo ? formatDate(p.effectiveTo) : "current"}</td>
                      <td className="text-stone-600 text-xs">{humanize(p.employmentType)}</td>
                      <td className="text-stone-600 text-xs">{humanize(p.reason)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )
      )}

      {tab === "payroll" && (
        <section className="spectre-person-body" data-testid="employee-tab-body-payroll">
          <h2 className="spectre-person-section-title">Payroll</h2>

          <div className="spectre-person-columns">
            <div className="spectre-person-col-left">
              {/* SIN */}
              <div className="spectre-person-section" data-testid="payroll-sin">
                <div className="spectre-person-section-head">
                  <h3 className="spectre-person-eyebrow">Social Insurance Number</h3>
                </div>
                {payroll?.sinAccessible ? (
                  payroll.sinMasked ? (
                    <p className="text-base font-mono text-stone-900">{payroll.sinMasked}</p>
                  ) : (
                    <p className="spectre-person-not-provided">Not yet submitted</p>
                  )
                ) : (
                  <p className="text-xs text-stone-500">Requires Payroll Admin access</p>
                )}
              </div>

              {/* Direct deposit */}
              <div className="spectre-person-section" data-testid="payroll-banking">
                <div className="spectre-person-section-head">
                  <h3 className="spectre-person-eyebrow">Direct deposit</h3>
                </div>
                {payroll?.bankingAccessible ? (
                  payroll.bankingMasked ? (
                    <div>
                      <p className="text-sm text-stone-900">{payroll.bankingMasked.holderName}</p>
                      <p className="mt-0.5 text-sm font-mono text-stone-700">
                        Account ending in {payroll.bankingMasked.accountMasked.slice(-4)}
                      </p>
                      <p className="mt-1 text-xs uppercase tracking-wide text-stone-500">
                        {payroll.bankingMasked.status === "VERIFIED"
                          ? "Verified"
                          : payroll.bankingMasked.status === "PENDING_PENNY_TEST"
                            ? "Pending Club verification"
                            : humanize(payroll.bankingMasked.status)}
                      </p>
                    </div>
                  ) : (
                    <p className="spectre-person-not-provided">Not yet submitted</p>
                  )
                ) : (
                  <p className="text-xs text-stone-500">Requires Payroll Admin access</p>
                )}
              </div>
            </div>

            <div className="spectre-person-col-right">
              {/* Federal TD1 */}
              <div className="spectre-person-section" data-testid="payroll-td1-federal">
                <div className="spectre-person-section-head">
                  <h3 className="spectre-person-eyebrow">Federal TD1</h3>
                </div>
                <FederalTd1Panel payroll={payroll} />
              </div>

              {/* Provincial TD1 */}
              <div className="spectre-person-section" data-testid="payroll-td1-provincial">
                <div className="spectre-person-section-head">
                  <h3 className="spectre-person-eyebrow">
                    Provincial TD1
                    {payroll?.taxAccessible && payroll.taxProfileMasked && (
                      <span className="ml-1 text-stone-500 font-normal">
                        ({provinceName(payroll.taxProfileMasked.province)})
                      </span>
                    )}
                  </h3>
                </div>
                <ProvincialTd1Panel payroll={payroll} />
              </div>
            </div>
          </div>
        </section>
      )}

      {tab === "training" && trainingSection !== undefined && (
        <section className="spectre-person-body" data-testid="employee-tab-body-training">
          {trainingSection}
        </section>
      )}

      {tab === "documents" && (
        <section className="spectre-person-body">
          <h2 className="spectre-person-section-title">Documents</h2>
          <div className="spectre-person-section">
            <table className="table-base">
              <thead>
                <tr><th>Category</th><th>Display name</th><th>Uploaded</th><th>Sensitivity</th></tr>
              </thead>
              <tbody>
                {documents.length === 0 && (
                  <tr><td colSpan={4} className="px-4 py-8 text-center text-stone-500">No documents on file.</td></tr>
                )}
                {documents.map((d) => (
                  <tr key={d.id}>
                    <td className="text-xs uppercase tracking-wide text-stone-500">{humanize(d.category)}</td>
                    <td>{d.displayName ?? "—"}</td>
                    <td className="text-xs text-stone-600">{formatDate(d.uploadedAt)}</td>
                    <td className="text-xs uppercase tracking-wide">{humanize(d.sensitivity)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* HR-2B.4 (2026-08-19) — Credentials rollup. */}
          {credentials !== undefined && (
            <div
              className="spectre-person-section mt-6"
              data-testid="employee-credentials"
            >
              <div className="spectre-person-section-head">
                <h3 className="spectre-person-eyebrow">Credentials</h3>
              </div>
              {credentials === null ? (
                <p className="text-sm text-stone-500">
                  You don&apos;t have permission to view credentials.
                </p>
              ) : credentials.length === 0 ? (
                <p className="text-sm text-stone-500">No credentials on file yet.</p>
              ) : (
                <table className="table-base">
                  <thead>
                    <tr><th>Credential</th><th>Reference</th><th>Issued</th><th>Expires</th><th>Document</th></tr>
                  </thead>
                  <tbody>
                    {credentials.map((c) => (
                      <tr key={c.id} data-testid={`credential-row-${c.code}`}>
                        <td>
                          <div className="font-medium text-club-ink">{c.displayName}</div>
                          <div className="text-xs text-stone-500 font-mono">{c.code}</div>
                        </td>
                        <td className="text-xs text-stone-600">{c.reference ?? "—"}</td>
                        <td className="text-xs text-stone-600">{c.issuedAt ? formatDate(c.issuedAt) : "—"}</td>
                        <td className="text-xs">
                          {c.expiresAt ? (
                            <span className="text-emerald-800">Expires {formatDate(c.expiresAt)}</span>
                          ) : (
                            <span className="text-stone-400">—</span>
                          )}
                        </td>
                        <td className="text-xs text-stone-600">{c.documentId ? "Attached" : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </section>
      )}

      {tab === "activity" && (
        <section className="spectre-person-body">
          <h2 className="spectre-person-section-title">Activity</h2>
          <div className="spectre-person-section">
            {!currentSession ? (
              <p className="text-sm text-stone-600">No onboarding session yet.</p>
            ) : (
              <table className="table-base">
                <thead>
                  <tr><th>When</th><th>Transition</th><th>Actor</th><th>Notes</th></tr>
                </thead>
                <tbody>
                  {transitions.length === 0 && (
                    <tr><td colSpan={4} className="px-4 py-8 text-center text-stone-500">No transitions yet.</td></tr>
                  )}
                  {transitions.map((t) => (
                    <tr key={t.id}>
                      <td className="text-xs text-stone-600">{formatDate(t.at)}</td>
                      <td className="text-xs">{humanize(t.fromState)} → {humanize(t.toState)}</td>
                      <td className="text-xs text-stone-600">{t.actorSource.toLowerCase()}</td>
                      <td className="text-xs text-stone-500">{t.reason ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

const PROVINCE_NAMES: Record<string, string> = {
  AB: "Alberta", BC: "British Columbia", MB: "Manitoba", NB: "New Brunswick",
  NL: "Newfoundland and Labrador", NS: "Nova Scotia", NT: "Northwest Territories",
  NU: "Nunavut", ON: "Ontario", PE: "Prince Edward Island", QC: "Quebec",
  SK: "Saskatchewan", YT: "Yukon",
};

function provinceName(code: string): string {
  return PROVINCE_NAMES[code] ?? code;
}

function FederalTd1Panel({ payroll }: { payroll: Props["payroll"] }) {
  if (!payroll) return <p className="spectre-person-not-provided">Not yet completed</p>;
  if (!payroll.taxAccessible) {
    return <p className="text-xs text-stone-500">Requires Payroll Admin access</p>;
  }
  const attestation = payroll.td1Attestations.find(
    (a) => a.kind === "td1_federal_attestation",
  );
  if (!attestation) {
    return <p className="spectre-person-not-provided">Not yet completed</p>;
  }
  return (
    <div>
      <p className="text-sm text-stone-900">
        Completed {formatDate(attestation.acknowledgedAt)}
      </p>
      {payroll.taxProfileMasked && (
        <p className="mt-0.5 text-xs text-stone-500">
          Form: {payroll.taxProfileMasked.td1FormVersion}
        </p>
      )}
    </div>
  );
}

function ProvincialTd1Panel({ payroll }: { payroll: Props["payroll"] }) {
  if (!payroll) return <p className="spectre-person-not-provided">Not yet completed</p>;
  if (!payroll.taxAccessible) {
    return <p className="text-xs text-stone-500">Requires Payroll Admin access</p>;
  }
  const attestation = payroll.td1Attestations.find(
    (a) => a.kind === "td1_provincial_attestation",
  );
  if (!attestation) {
    return <p className="spectre-person-not-provided">Not yet completed</p>;
  }
  return (
    <div>
      <p className="text-sm text-stone-900">
        Completed {formatDate(attestation.acknowledgedAt)}
      </p>
      {payroll.taxProfileMasked && (
        <p className="mt-0.5 text-xs text-stone-500">
          Form: {payroll.taxProfileMasked.td1FormVersion}
        </p>
      )}
      {payroll.taxProfileMasked?.hasAdditionalDeductions && (
        <p className="mt-0.5 text-xs text-stone-500">
          Additional per-pay deduction requested
        </p>
      )}
    </div>
  );
}

function PersonRow({
  label,
  value,
  raw,
  kind,
}: {
  label: string;
  value: string | null | undefined;
  raw?: boolean;
  kind?: "email" | "phone";
}) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  const isMissing = !raw && !trimmed.length;
  return (
    <div className="spectre-person-row">
      <dt>{label}</dt>
      <dd>
        {isMissing ? (
          <span className="spectre-person-not-provided">Not provided</span>
        ) : kind === "email" && trimmed.length ? (
          <a href={`mailto:${trimmed}`} className="spectre-person-link">{trimmed}</a>
        ) : kind === "phone" && trimmed.length ? (
          <a href={`tel:${trimmed}`} className="spectre-person-link">{trimmed}</a>
        ) : (
          value ?? "—"
        )}
      </dd>
    </div>
  );
}
