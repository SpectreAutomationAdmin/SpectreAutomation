"use client";

// Slice C closeout (2026-09-18) — Employee → Payroll → Benefits & Deductions.
// Interactive workspace. Enrol / Change / End all route through the
// canonical `benefit-enrolments.ts` service via server actions passed in
// by the page loader.

import { useMemo, useState } from "react";

export type EnrolmentStatus = "ACTIVE" | "ENDED";

export interface BenefitEnrolmentRow {
  id: string;
  planId: string;
  planCode: string;
  planName: string;
  planKind: string;               // LTD | HEALTH_DENTAL | RRSP
  status: EnrolmentStatus;
  electionKind: "FIXED_AMOUNT" | "PERCENT_OF_ELIGIBLE_EARNINGS";
  amount: string | null;
  percentBps: number | null;
  effectiveFromIso: string;
  effectiveToIso: string | null;
}
export interface PlanChoice {
  id: string;
  code: string;
  name: string;
  kind: string;
  defaultElectionKind: "FIXED_AMOUNT" | "PERCENT_OF_ELIGIBLE_EARNINGS";
  effectiveFromIso: string;
  effectiveToIso: string | null;
}

export interface BenefitsDeductionsSectionProps {
  employeeId: string;
  rows: BenefitEnrolmentRow[];
  planChoices: PlanChoice[];
  canWrite: boolean;
  enrolAction: (form: FormData) => Promise<void>;
  changeAction: (form: FormData) => Promise<void>;
  endAction: (form: FormData) => Promise<void>;
  banner: { tone: "success" | "error"; text: string } | null;
}

function fmtCivil(iso: string): string {
  const d = new Date(iso);
  const y = d.getUTCFullYear(); const m = d.getUTCMonth(); const day = d.getUTCDate();
  return `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][m]} ${day}, ${y}`;
}
function formatMoney(v: string | null): string {
  if (v == null) return "—";
  const n = Number(v);
  return Number.isFinite(n)
    ? n.toLocaleString("en-CA", { style: "currency", currency: "CAD" })
    : v;
}
function humanKind(k: string): string {
  switch (k) {
    case "LTD":           return "Long-Term Disability";
    case "HEALTH_DENTAL": return "Health & Dental";
    case "RRSP":          return "RRSP";
    default:              return k;
  }
}
function humanElection(e: BenefitEnrolmentRow): string {
  if (e.electionKind === "FIXED_AMOUNT") return `${formatMoney(e.amount)} / pay`;
  if (e.electionKind === "PERCENT_OF_ELIGIBLE_EARNINGS" && e.percentBps != null) {
    return `${(e.percentBps / 100).toFixed(2)}% of eligible earnings`;
  }
  return "—";
}

function Pill({ tone, children }: { tone: "ok" | "neutral" | "warn"; children: React.ReactNode }) {
  const cls = tone === "ok"
    ? "bg-[#dcfce7] text-[#166534]"
    : tone === "warn"
    ? "bg-[#fef3c7] text-[#92400e]"
    : "bg-stone-200 text-stone-700";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold tracking-wide uppercase ${cls}`}>
      {children}
    </span>
  );
}

export default function BenefitsDeductionsSection(props: BenefitsDeductionsSectionProps) {
  const today = new Date();
  const active   = props.rows.filter((r) => r.status === "ACTIVE" && new Date(r.effectiveFromIso) <= today);
  const upcoming = props.rows.filter((r) => r.status === "ACTIVE" && new Date(r.effectiveFromIso) >  today);
  const historical = props.rows.filter((r) => r.status === "ENDED");

  const [enrolling, setEnrolling] = useState(false);
  const [changingId, setChangingId] = useState<string | null>(null);
  const [endingId, setEndingId] = useState<string | null>(null);

  // Plans that already have an active or upcoming enrolment are excluded
  // from Enrol (overlap guard is authoritative server-side, but this
  // makes the UI reflect it).
  const availablePlans = useMemo(() => {
    const used = new Set([...active, ...upcoming].map((r) => r.planId));
    return props.planChoices.filter((p) => !used.has(p.id));
  }, [active, upcoming, props.planChoices]);

  return (
    <div className="spectre-person-section mt-6" id="benefits" data-testid="payroll-benefits-deductions-slice-c">
      <div className="spectre-person-section-head flex items-center justify-between">
        <h3 className="spectre-person-eyebrow">Benefits &amp; Deductions</h3>
        {props.canWrite && !enrolling && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            data-testid="benefits-enrol-btn"
            onClick={() => setEnrolling(true)}
          >
            + Enrol in benefit
          </button>
        )}
      </div>

      {props.banner && (
        <div
          role="alert"
          className="mt-3 rounded px-3 py-2 text-sm"
          data-testid="benefits-workspace-banner"
          style={
            props.banner.tone === "success"
              ? { background: "#ecfdf5", color: "#065f46", border: "1px solid #a7f3d0" }
              : { background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca" }
          }
        >
          {props.banner.text}
        </div>
      )}

      {active.length === 0 && upcoming.length === 0 && historical.length === 0 && !enrolling && (
        <p className="mt-3 text-sm text-stone-500">No active benefits.</p>
      )}

      {active.length > 0 && (
        <div className="mt-3 space-y-3">
          {active.map((r) => (
            <div
              key={r.id}
              className="rounded border border-stone-200 p-3"
              data-testid={`benefit-enrolment-active-${r.id}`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-stone-900">
                  {humanKind(r.planKind)} — {r.planName}
                </span>
                <Pill tone="ok">Active</Pill>
              </div>
              <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-xs">
                <dt className="text-stone-500">
                  {r.electionKind === "FIXED_AMOUNT" ? "Employee premium" : "Employee election"}
                </dt>
                <dd className="text-stone-900">{humanElection(r)}</dd>
                <dt className="text-stone-500">Effective</dt>
                <dd className="text-stone-900">
                  {fmtCivil(r.effectiveFromIso)}
                  {r.effectiveToIso ? ` — ${fmtCivil(r.effectiveToIso)}` : " · no end date"}
                </dd>
              </dl>

              {props.canWrite && (
                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    data-testid={`benefit-change-btn-${r.id}`}
                    onClick={() => { setChangingId(r.id); setEndingId(null); }}
                  >
                    Change
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    data-testid={`benefit-end-btn-${r.id}`}
                    onClick={() => { setEndingId(r.id); setChangingId(null); }}
                  >
                    End
                  </button>
                </div>
              )}

              {changingId === r.id && (
                <ChangeForm
                  row={r}
                  employeeId={props.employeeId}
                  action={props.changeAction}
                  onCancel={() => setChangingId(null)}
                />
              )}
              {endingId === r.id && (
                <EndForm
                  row={r}
                  employeeId={props.employeeId}
                  action={props.endAction}
                  onCancel={() => setEndingId(null)}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {upcoming.length > 0 && (
        <section className="mt-4" data-testid="benefits-upcoming-section">
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-stone-500">Upcoming</div>
          <ul className="mt-2 space-y-1 text-xs text-stone-700">
            {upcoming.map((r) => (
              <li key={r.id} data-testid={`benefit-enrolment-upcoming-${r.id}`}>
                {humanKind(r.planKind)} — {r.planName} · starts {fmtCivil(r.effectiveFromIso)} · {humanElection(r)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {historical.length > 0 && (
        <details className="mt-4" data-testid="benefits-history-disclosure">
          <summary className="cursor-pointer text-xs text-stone-500">
            History ({historical.length})
          </summary>
          <ul className="mt-2 space-y-1 text-xs text-stone-600">
            {historical.map((r) => (
              <li key={r.id} data-testid={`benefit-enrolment-history-${r.id}`}>
                {humanKind(r.planKind)} — {r.planName}
                {" · "}
                {fmtCivil(r.effectiveFromIso)}
                {" – "}
                {r.effectiveToIso ? fmtCivil(r.effectiveToIso) : "open"}
                {" · "}
                {humanElection(r)}
              </li>
            ))}
          </ul>
        </details>
      )}

      {enrolling && props.canWrite && (
        <EnrolForm
          employeeId={props.employeeId}
          plans={availablePlans}
          action={props.enrolAction}
          onCancel={() => setEnrolling(false)}
        />
      )}
    </div>
  );
}

function EnrolForm(props: {
  employeeId: string;
  plans: PlanChoice[];
  action: (form: FormData) => Promise<void>;
  onCancel: () => void;
}) {
  const [planId, setPlanId] = useState<string>(props.plans[0]?.id ?? "");
  const selected = props.plans.find((p) => p.id === planId);
  const isPercent = selected?.defaultElectionKind === "PERCENT_OF_ELIGIBLE_EARNINGS";
  return (
    <form
      action={props.action}
      className="mt-4 rounded border border-stone-200 p-3 space-y-3"
      data-testid="benefits-enrol-form"
    >
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-stone-600">Enrol in benefit</div>
      <input type="hidden" name="employeeId" value={props.employeeId} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="text-[11px] font-semibold uppercase tracking-[0.04em] text-stone-600">Plan</label>
          {props.plans.length === 0 ? (
            <p className="mt-1 text-xs text-stone-500">
              All configured plans already have an active enrolment for this employee.
            </p>
          ) : (
            <select
              name="planId"
              required
              value={planId}
              onChange={(e) => setPlanId(e.target.value)}
              className="mt-1 w-full rounded border px-2 py-1 text-sm"
              data-testid="benefits-enrol-plan-select"
            >
              {props.plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.kind === "LTD" ? "Long-Term Disability" : p.kind === "HEALTH_DENTAL" ? "Health & Dental" : p.kind}
                  {" — "}{p.name}
                </option>
              ))}
            </select>
          )}
          <input type="hidden" name="electionKind" value={selected?.defaultElectionKind ?? "FIXED_AMOUNT"} />
        </div>
        <div>
          <label className="text-[11px] font-semibold uppercase tracking-[0.04em] text-stone-600">Effective date</label>
          <input
            type="date"
            name="effectiveFrom"
            required
            className="mt-1 w-full rounded border px-2 py-1 text-sm"
            data-testid="benefits-enrol-effective-from"
          />
        </div>
        {isPercent ? (
          <div>
            <label className="text-[11px] font-semibold uppercase tracking-[0.04em] text-stone-600">Percentage</label>
            <div className="mt-1 flex items-center gap-1">
              <input
                type="number"
                step="0.01"
                min="0.01"
                max="100"
                name="percent"
                required
                className="w-full rounded border px-2 py-1 text-sm"
                placeholder="5.00"
                data-testid="benefits-enrol-percent"
              />
              <span className="text-sm text-stone-500">%</span>
            </div>
            <p className="mt-1 text-[10px] text-stone-500">Of eligible earnings each pay period.</p>
          </div>
        ) : (
          <div>
            <label className="text-[11px] font-semibold uppercase tracking-[0.04em] text-stone-600">Amount per pay</label>
            <div className="mt-1 flex items-center gap-1">
              <span className="text-sm text-stone-500">$</span>
              <input
                type="number"
                step="0.01"
                min="0.01"
                name="amount"
                required
                className="w-full rounded border px-2 py-1 text-sm"
                placeholder="42.50"
                data-testid="benefits-enrol-amount"
              />
            </div>
          </div>
        )}
      </div>
      <div>
        <label className="text-[11px] font-semibold uppercase tracking-[0.04em] text-stone-600">Notes (optional)</label>
        <input name="notes" className="mt-1 w-full rounded border px-2 py-1 text-sm" />
      </div>
      <div className="flex items-center gap-2">
        <button type="submit" className="btn btn-primary btn-sm" data-testid="benefits-enrol-submit"
                disabled={props.plans.length === 0}>
          Enrol
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function ChangeForm(props: {
  row: BenefitEnrolmentRow;
  employeeId: string;
  action: (form: FormData) => Promise<void>;
  onCancel: () => void;
}) {
  const isPercent = props.row.electionKind === "PERCENT_OF_ELIGIBLE_EARNINGS";
  return (
    <form
      action={props.action}
      className="mt-3 rounded border border-stone-200 p-3 space-y-3 bg-stone-50"
      data-testid={`benefits-change-form-${props.row.id}`}
    >
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-stone-600">
        Change enrolment — effective-dated (predecessor preserved)
      </div>
      <input type="hidden" name="employeeId" value={props.employeeId} />
      <input type="hidden" name="enrolmentId" value={props.row.id} />
      <input type="hidden" name="electionKind" value={props.row.electionKind} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="text-[11px] font-semibold uppercase tracking-[0.04em] text-stone-600">
            New effective date
          </label>
          <input
            type="date"
            name="effectiveFrom"
            required
            className="mt-1 w-full rounded border px-2 py-1 text-sm"
            data-testid={`benefits-change-effective-from-${props.row.id}`}
          />
        </div>
        {isPercent ? (
          <div>
            <label className="text-[11px] font-semibold uppercase tracking-[0.04em] text-stone-600">New percentage</label>
            <div className="mt-1 flex items-center gap-1">
              <input type="number" step="0.01" min="0.01" max="100" name="percent" required
                     className="w-full rounded border px-2 py-1 text-sm" />
              <span className="text-sm text-stone-500">%</span>
            </div>
          </div>
        ) : (
          <div>
            <label className="text-[11px] font-semibold uppercase tracking-[0.04em] text-stone-600">New amount per pay</label>
            <div className="mt-1 flex items-center gap-1">
              <span className="text-sm text-stone-500">$</span>
              <input type="number" step="0.01" min="0.01" name="amount" required
                     className="w-full rounded border px-2 py-1 text-sm"
                     data-testid={`benefits-change-amount-${props.row.id}`} />
            </div>
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button type="submit" className="btn btn-primary btn-sm" data-testid={`benefits-change-submit-${props.row.id}`}>
          Apply change
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function EndForm(props: {
  row: BenefitEnrolmentRow;
  employeeId: string;
  action: (form: FormData) => Promise<void>;
  onCancel: () => void;
}) {
  return (
    <form
      action={props.action}
      className="mt-3 rounded border border-stone-200 p-3 space-y-3 bg-stone-50"
      data-testid={`benefits-end-form-${props.row.id}`}
    >
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-stone-600">
        End enrolment
      </div>
      <input type="hidden" name="employeeId" value={props.employeeId} />
      <input type="hidden" name="enrolmentId" value={props.row.id} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="text-[11px] font-semibold uppercase tracking-[0.04em] text-stone-600">
            Effective end date
          </label>
          <input
            type="date"
            name="effectiveTo"
            required
            className="mt-1 w-full rounded border px-2 py-1 text-sm"
            data-testid={`benefits-end-effective-to-${props.row.id}`}
          />
          <p className="mt-1 text-[10px] text-stone-500">
            The enrolment stops applying at 00:00 on this date. The pay period starting on
            or after this date is the first period without coverage.
          </p>
        </div>
        <div>
          <label className="text-[11px] font-semibold uppercase tracking-[0.04em] text-stone-600">
            Reason (optional)
          </label>
          <input name="endReason" className="mt-1 w-full rounded border px-2 py-1 text-sm" />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button type="submit" className="btn btn-primary btn-sm" data-testid={`benefits-end-submit-${props.row.id}`}>
          End enrolment
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
