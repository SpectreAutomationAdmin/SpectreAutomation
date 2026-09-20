// EPW-2 (2026-09-20) — Employee → Payroll workspace.
//
// Founder-approved 1440×900 desktop grid: three cards in the top row
// (Base Compensation / Recurring Earnings & Deductions / One-Time
// Earnings), two cards in the middle row (Benefits & Deductions /
// Implementation & YTD), two cards in the bottom row (Payroll History /
// Year-to-Date Summary), and a compact information strip explaining
// employee-level vs Club-level payroll configuration.
//
// This component owns the layout and section chrome only. Every
// mutation (edit, add, enrol, change, end, set opening YTD) routes
// through server actions the parent page passes in as props. The
// component reuses the accepted BenefitsDeductionsSection and
// OpeningYtdInlineEditor for the interactive workflows; it does not
// duplicate their logic.

import Link from "next/link";
import BenefitsDeductionsSection, {
  type BenefitEnrolmentRow,
  type PlanChoice,
} from "./BenefitsDeductionsSection";
import OpeningYtdInlineEditor, {
  type OpeningYtdInlineEditorProps,
} from "./OpeningYtdInlineEditor";

// -------------------------------------------------------------------
// Types
// -------------------------------------------------------------------

type Money = string;

export interface EmployeePayrollGridProps {
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  employeeStatus: string;
  originalHireDateIso: string | null;
  spectreActivatedAtIso: string | null;
  payGroup: {
    id: string;
    code: string;
    name: string;
    payFrequency: string;
  } | null;
  nextPayDateIso: string | null;

  currentCompensation: {
    cadence: string;
    rate: Money;
    effectiveFromIso: string;
  } | null;
  compensationHistoryCount: number;
  compensationEditHref: string;
  viewCompensationHistoryHref: string;

  recurring: Array<{
    id: string;
    componentDisplayName: string;
    amount: Money | null;
    frequencyLabel: string;
    effectiveFromIso: string;
    active: boolean;
  }>;
  addRecurringHref: string;

  oneTime: Array<{
    id: string;
    componentDisplayName: string;
    amount: Money;
    payDateIso: string;
    status: string;
  }>;
  addOneTimeHref: string;

  benefits: {
    rows: BenefitEnrolmentRow[];
    planChoices: PlanChoice[];
    canWrite: boolean;
    enrolAction: (form: FormData) => Promise<void>;
    changeAction: (form: FormData) => Promise<void>;
    endAction: (form: FormData) => Promise<void>;
    banner: { tone: "success" | "error"; text: string } | null;
  };
  benefitHistoryHref: string;

  implementation: {
    mode: string | null;
    firstSpectrePayDateIso: string | null;
    taxYear: number;
  };
  openingYtd: OpeningYtdInlineEditorProps | null;

  history: Array<{
    id: string;
    payDateIso: string;
    periodStartIso: string;
    periodEndInclusiveIso: string;
    grossPay: Money;
    netPay: Money;
    status: string;
    href: string;
  }>;
  viewAllPayrollHref: string;

  ytd: {
    asOfIso: string;
    values: {
      ytdGrossEarnings: Money;
      ytdTaxableEarnings: Money;
      ytdCppEE: Money;
      ytdEiEE: Money;
      ytdFederalTax: Money;
      ytdProvincialTax: Money;
      ytdRrspEE: Money | null;
      ytdOtherDeductions: Money;
      ytdNetPay: Money;
    };
  } | null;
  viewYtdDetailsHref: string;

  payrollSettingsHref: string;
}

// -------------------------------------------------------------------
// Formatters
// -------------------------------------------------------------------

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function fmtCivil(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

function fmtMoney(v: Money | null | undefined): string {
  if (v == null) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `$${n.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function humanCadence(c: string | null | undefined): string {
  switch ((c ?? "").toUpperCase()) {
    case "SALARY": return "Salary";
    case "HOURLY": return "Hourly";
    case "COMMISSION": return "Commission";
    case "PIECE_RATE": return "Piece rate";
    default: return c ?? "—";
  }
}

function humanFrequency(f: string | null | undefined): string {
  switch (f) {
    case "WEEKLY": return "Weekly";
    case "BIWEEKLY": return "Bi-weekly";
    case "SEMI_MONTHLY": return "Semi-Monthly";
    case "MONTHLY": return "Monthly";
    default: return f ?? "—";
  }
}

function humanImplementationMode(m: string | null | undefined): string {
  switch (m) {
    case "ZERO_OPENING_YTD":   return "Beginning-of-year";
    case "MID_YEAR_MIGRATION": return "Mid-year migration";
    default: return "Not declared";
  }
}

// -------------------------------------------------------------------
// Small helpers
// -------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "ACTIVE" || status === "POSTED"
      ? "bg-[#dcfce7] text-[#166534]"
      : status === "SCHEDULED"
      ? "bg-[#dbeafe] text-[#1e40af]"
      : status === "NOT_STARTED" || status === "NOT STARTED"
      ? "bg-[#fef3c7] text-[#92400e]"
      : "bg-stone-200 text-stone-700";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cls}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

function Card({
  title,
  actions,
  children,
  className,
  testId,
}: {
  title: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section
      data-testid={testId}
      className={`rounded-md border border-stone-200 bg-white p-4 shadow-[0_1px_0_rgba(0,0,0,0.02)] ${className ?? ""}`}
    >
      <header className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-stone-900">{title}</h3>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

function SmallLink({ href, children, testId }: { href: string; children: React.ReactNode; testId?: string }) {
  return (
    <Link href={href} data-testid={testId} className="text-xs font-medium text-[#2f5832] hover:underline">
      {children}
    </Link>
  );
}

// -------------------------------------------------------------------
// Grid
// -------------------------------------------------------------------

export default function EmployeePayrollGrid(props: EmployeePayrollGridProps) {
  return (
    <div className="space-y-4" data-testid="employee-payroll-grid">
      {/* Introduction */}
      <div>
        <h2 className="text-[20px] font-semibold text-stone-900">Payroll</h2>
        <p className="mt-0.5 text-xs text-stone-500">
          Manage this employee&apos;s compensation, deductions, benefits and payroll setup.
        </p>
      </div>

      {/* Row 1 — 3 columns */}
      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-3">
          <Card
            testId="grid-base-compensation"
            title={<span>1. Base Compensation</span>}
            actions={<SmallLink href={props.compensationEditHref} testId="grid-comp-edit">Edit</SmallLink>}
          >
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-[13px]">
              <dt className="text-stone-500">Type</dt>
              <dd className="text-stone-900" data-testid="grid-comp-cadence">
                {humanCadence(props.currentCompensation?.cadence)}
              </dd>
              <dt className="text-stone-500">Annual rate</dt>
              <dd className="text-stone-900" data-testid="grid-comp-rate">
                {props.currentCompensation ? fmtMoney(props.currentCompensation.rate) : "—"}
              </dd>
              <dt className="text-stone-500">Effective date</dt>
              <dd className="text-stone-900" data-testid="grid-comp-effective">
                {props.currentCompensation ? fmtCivil(props.currentCompensation.effectiveFromIso) : "—"}
              </dd>
              <dt className="text-stone-500">History</dt>
              <dd>
                <SmallLink href={props.viewCompensationHistoryHref} testId="grid-comp-history">
                  View compensation history →
                </SmallLink>
              </dd>
            </dl>
          </Card>
        </div>

        <div className="col-span-5" data-recurring-slot>
          <Card
            testId="grid-recurring"
            title={<span>2. Recurring Earnings &amp; Deductions</span>}
            actions={<SmallLink href={props.addRecurringHref} testId="grid-recurring-add">+ Add Component</SmallLink>}
          >
            {props.recurring.length === 0 ? (
              <p className="text-xs text-stone-500">No active recurring components.</p>
            ) : (
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wide text-stone-500">
                    <th className="py-1 pr-2 font-medium">Component</th>
                    <th className="py-1 pr-2 font-medium">Amount</th>
                    <th className="py-1 pr-2 font-medium">Frequency</th>
                    <th className="py-1 pr-2 font-medium">Effective</th>
                    <th className="py-1 pr-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {props.recurring.map((r) => (
                    <tr key={r.id} className="border-t border-stone-100">
                      <td className="py-1.5 pr-2 text-stone-900">{r.componentDisplayName}</td>
                      <td className="py-1.5 pr-2 text-stone-900">{fmtMoney(r.amount)}</td>
                      <td className="py-1.5 pr-2 text-stone-700">{r.frequencyLabel}</td>
                      <td className="py-1.5 pr-2 text-stone-700">{fmtCivil(r.effectiveFromIso)}</td>
                      <td className="py-1.5 pr-2">
                        <StatusBadge status={r.active ? "ACTIVE" : "ENDED"} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>

        <div className="col-span-4">
          <Card
            testId="grid-one-time"
            title={<span className="whitespace-nowrap">3. One-Time Earnings</span>}
            actions={<SmallLink href={props.addOneTimeHref} testId="grid-one-time-add">+ Add One-Time</SmallLink>}
          >
            {props.oneTime.length === 0 ? (
              <p className="text-xs text-stone-500">No other one-time earnings scheduled.</p>
            ) : (
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wide text-stone-500">
                    <th className="py-1 pr-2 font-medium">Component</th>
                    <th className="py-1 pr-2 font-medium">Amount</th>
                    <th className="py-1 pr-2 font-medium">Pay Date</th>
                    <th className="py-1 pr-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {props.oneTime.map((r) => (
                    <tr key={r.id} className="border-t border-stone-100">
                      <td className="py-1.5 pr-2 text-stone-900">{r.componentDisplayName}</td>
                      <td className="py-1.5 pr-2 text-stone-900">{fmtMoney(r.amount)}</td>
                      <td className="py-1.5 pr-2 text-stone-700">{fmtCivil(r.payDateIso)}</td>
                      <td className="py-1.5 pr-2">
                        <StatusBadge status={r.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      </div>

      {/* Row 2 — Benefits (wide) + Implementation & YTD (narrow) */}
      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-8">
          <Card
            testId="grid-benefits"
            title={<span>4. Benefits &amp; Deductions</span>}
          >
            <BenefitsDeductionsSection
              employeeId={props.employeeId}
              rows={props.benefits.rows}
              planChoices={props.benefits.planChoices}
              canWrite={props.benefits.canWrite}
              enrolAction={props.benefits.enrolAction}
              changeAction={props.benefits.changeAction}
              endAction={props.benefits.endAction}
              banner={props.benefits.banner}
              compact
            />
            <div className="mt-3">
              <SmallLink href={props.benefitHistoryHref} testId="grid-benefit-history">
                View benefit and deduction history →
              </SmallLink>
            </div>
          </Card>
        </div>

        <div className="col-span-4">
          <Card
            testId="grid-implementation-ytd"
            title={<span>5. Implementation &amp; YTD</span>}
            actions={
              <SmallLink href={`/app/admin/payroll/setup#payroll-implementation`} testId="grid-impl-edit">Edit</SmallLink>
            }
          >
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-[13px]">
              <dt className="text-stone-500">Original Hire Date</dt>
              <dd className="text-stone-900" data-testid="grid-original-hire-date">
                {fmtCivil(props.originalHireDateIso)}
              </dd>
              <dt className="text-stone-500">Spectre Activation</dt>
              <dd className="text-stone-900" data-testid="grid-spectre-activation">
                {fmtCivil(props.spectreActivatedAtIso)}
              </dd>
              <dt className="text-stone-500">Implementation Mode</dt>
              <dd className="text-stone-900" data-testid="grid-implementation-mode">
                {humanImplementationMode(props.implementation.mode)}
              </dd>
              <dt className="text-stone-500">First Spectre Pay Date</dt>
              <dd className="text-stone-900" data-testid="grid-first-spectre-pay">
                {fmtCivil(props.implementation.firstSpectrePayDateIso)}
              </dd>
            </dl>

            {/* Opening YTD panel */}
            <div
              className="mt-4 rounded border border-amber-200 bg-amber-50/60 p-3"
              data-testid="grid-opening-ytd"
            >
              {props.openingYtd ? (
                <OpeningYtdInlineEditor {...props.openingYtd} />
              ) : props.implementation.mode === "MID_YEAR_MIGRATION" ? (
                <p className="text-[11px] text-amber-900">
                  Opening YTD editor loading…
                </p>
              ) : (
                <div>
                  <div className="mb-1 flex items-center gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-stone-500">
                      Opening YTD
                    </span>
                    <StatusBadge status="ACTIVE" />
                  </div>
                  <p className="text-[11px] text-stone-600">
                    Spectre is the sole payroll system for {props.implementation.taxYear}. No opening YTD required.
                  </p>
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>

      {/* Row 3 — Payroll History (left) + YTD Summary (right, wider) */}
      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-5">
          <Card
            testId="grid-payroll-history"
            title={<span>6. Payroll History</span>}
            actions={
              <SmallLink href={props.viewAllPayrollHref} testId="grid-view-all-payroll">
                View All Payroll →
              </SmallLink>
            }
          >
            {props.history.length === 0 ? (
              <p className="text-xs text-stone-500">No posted payroll on record for this employee yet.</p>
            ) : (
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wide text-stone-500">
                    <th className="py-1 pr-2 font-medium">Pay Date</th>
                    <th className="py-1 pr-2 font-medium">Period</th>
                    <th className="py-1 pr-2 font-medium">Gross Pay</th>
                    <th className="py-1 pr-2 font-medium">Net Pay</th>
                    <th className="py-1 pr-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {props.history.map((h) => (
                    <tr key={h.id} className="border-t border-stone-100">
                      <td className="py-1.5 pr-2 text-stone-900">{fmtCivil(h.payDateIso)}</td>
                      <td className="py-1.5 pr-2 text-stone-700">
                        {`${fmtCivil(h.periodStartIso).replace(/,\s\d{4}$/, "")} – ${fmtCivil(h.periodEndInclusiveIso).replace(/,\s\d{4}$/, "")}`}
                      </td>
                      <td className="py-1.5 pr-2 text-stone-900">{fmtMoney(h.grossPay)}</td>
                      <td className="py-1.5 pr-2 text-stone-900">{fmtMoney(h.netPay)}</td>
                      <td className="py-1.5 pr-2">
                        <StatusBadge status={h.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>

        <div className="col-span-7">
          <Card
            testId="grid-ytd-summary"
            title={
              <span>
                7. Year-to-Date Summary
                {props.ytd ? (
                  <span className="ml-2 text-[11px] font-normal text-stone-500">
                    (as of {fmtCivil(props.ytd.asOfIso)})
                  </span>
                ) : null}
              </span>
            }
            actions={
              <SmallLink href={props.viewYtdDetailsHref} testId="grid-view-ytd-details">
                View Full Details →
              </SmallLink>
            }
          >
            {!props.ytd ? (
              <p className="text-xs text-stone-500">No posted payroll year-to-date yet.</p>
            ) : (
              <div className="grid grid-cols-2 gap-x-6 text-[13px]">
                <YtdColumn>
                  <YtdRow label="Gross earnings"       value={fmtMoney(props.ytd.values.ytdGrossEarnings)} />
                  <YtdRow label="Taxable earnings"     value={fmtMoney(props.ytd.values.ytdTaxableEarnings)} />
                  <YtdRow label="Employee CPP"         value={fmtMoney(props.ytd.values.ytdCppEE)} />
                  <YtdRow label="Employee EI"          value={fmtMoney(props.ytd.values.ytdEiEE)} />
                </YtdColumn>
                <YtdColumn>
                  <YtdRow label="Federal income tax"     value={fmtMoney(props.ytd.values.ytdFederalTax)} />
                  <YtdRow label="Provincial income tax"  value={fmtMoney(props.ytd.values.ytdProvincialTax)} />
                  {props.ytd.values.ytdRrspEE != null ? (
                    <YtdRow label="RRSP employee" value={fmtMoney(props.ytd.values.ytdRrspEE)} />
                  ) : null}
                  <YtdRow label="Total deductions" value={fmtMoney(props.ytd.values.ytdOtherDeductions)} />
                  <YtdRow label="Net pay" value={fmtMoney(props.ytd.values.ytdNetPay)} emphasized />
                </YtdColumn>
              </div>
            )}
          </Card>
        </div>
      </div>

      {/* Bottom information strip */}
      <div
        className="flex items-start gap-3 rounded-md border border-[#bfdbfe] bg-[#eff6ff] px-4 py-2.5 text-[12px] text-[#1e3a8a]"
        data-testid="grid-info-strip"
      >
        <span aria-hidden className="mt-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-[#3b82f6] text-[9px] font-bold text-white">
          i
        </span>
        <div className="flex-1">
          Employee-specific payroll configuration (compensation, recurring components, one-time earnings, benefit
          enrolments and opening YTD) is managed here. Club-level configuration (pay groups, payroll components,
          benefit plans, statutory settings) is managed in <em>Payroll Settings</em>.
        </div>
        <Link
          href={props.payrollSettingsHref}
          className="whitespace-nowrap text-[12px] font-medium text-[#1d4ed8] hover:underline"
          data-testid="grid-payroll-settings-link"
        >
          Go to Payroll Settings →
        </Link>
      </div>
    </div>
  );
}

function YtdColumn({ children }: { children: React.ReactNode }) {
  return <div className="space-y-1">{children}</div>;
}

function YtdRow({ label, value, emphasized }: { label: string; value: string; emphasized?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between border-b border-stone-100 py-1 last:border-b-0 ${emphasized ? "font-semibold text-stone-900" : ""}`}>
      <span className="text-stone-600">{label}</span>
      <span className="font-mono text-stone-900">{value}</span>
    </div>
  );
}
