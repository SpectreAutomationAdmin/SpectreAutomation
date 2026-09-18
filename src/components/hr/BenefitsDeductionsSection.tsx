"use client";
// Slice C (2026-09-18) — Employee → Payroll → Benefits & Deductions.
// Read-only list surface for Slice C; write flows (Enrol / Change / End)
// land in a follow-up UI slice. The underlying services + audit trail
// are fully wired via benefit-enrolments.ts (`enrolEmployeeInBenefitPlan`,
// `changeEnrolment`, `endEnrolment`).

export type EnrolmentStatus = "ACTIVE" | "ENDED";

export interface BenefitEnrolmentRow {
  id: string;
  planCode: string;
  planName: string;
  planKind: string;                 // LTD | HEALTH_DENTAL | RRSP
  status: EnrolmentStatus;
  electionKind: "FIXED_AMOUNT" | "PERCENT_OF_ELIGIBLE_EARNINGS";
  amount: string | null;
  percentBps: number | null;
  effectiveFromIso: string;
  effectiveToIso: string | null;
}

export interface BenefitsDeductionsSectionProps {
  rows: BenefitEnrolmentRow[];
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
function Pill({ tone, children }: { tone: "ok" | "neutral"; children: React.ReactNode }) {
  const cls = tone === "ok"
    ? "bg-[#dcfce7] text-[#166534]"
    : "bg-stone-200 text-stone-700";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold tracking-wide uppercase ${cls}`}>
      {children}
    </span>
  );
}
function fmtCivil(iso: string): string {
  const d = new Date(iso);
  const y = d.getUTCFullYear(); const m = d.getUTCMonth(); const day = d.getUTCDate();
  return `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][m]} ${day}, ${y}`;
}

export default function BenefitsDeductionsSection(props: BenefitsDeductionsSectionProps) {
  const active = props.rows.filter((r) => r.status === "ACTIVE");
  const historical = props.rows.filter((r) => r.status === "ENDED");

  return (
    <div className="spectre-person-section mt-6" data-testid="payroll-benefits-deductions-slice-c">
      <div className="spectre-person-section-head">
        <h3 className="spectre-person-eyebrow">Benefits &amp; Deductions</h3>
      </div>
      {active.length === 0 && historical.length === 0 && (
        <p className="mt-2 text-sm text-stone-500">No active benefits or recurring deductions.</p>
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
                <dt className="text-stone-500">Employee premium</dt>
                <dd className="text-stone-900">{humanElection(r)}</dd>
                <dt className="text-stone-500">Effective</dt>
                <dd className="text-stone-900">{fmtCivil(r.effectiveFromIso)}</dd>
              </dl>
            </div>
          ))}
        </div>
      )}
      {historical.length > 0 && (
        <details className="mt-3">
          <summary className="text-xs text-stone-500 cursor-pointer">
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
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="mt-3 text-[10px] text-stone-400">
        Enrol / Change / End actions land in the next UI slice. Configure plans in
        <em> Payroll Settings → Payroll components + benefit plans</em>.
      </p>
    </div>
  );
}
