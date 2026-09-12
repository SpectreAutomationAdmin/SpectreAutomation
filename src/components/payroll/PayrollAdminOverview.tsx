// Payroll Admin 3A (2026-09-10) — DATA-DRIVEN Payroll Overview surface.
//
// Renders the founder-approved Payroll Admin layout with real props
// supplied by the /app/admin/payroll server component. Preserves the
// exact visual composition from `PayrollAdminSurface` (which remains
// the Phase 1 preview shell); the two diverge only where fixture
// values are replaced by prop-driven values or the "—" placeholder.
//
// Read-only. No client-side mutations. Change Period navigates via URL.
//
// Reference:  docs/design/payroll/payroll-admin-desktop-1440x900-approved.png
// SHA-256:    d741321543eedbf3fa7991978132956d1f57359c4b01fce9f939c7948e72a7ce

"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { useFormStatus } from "react-dom";
import type { PayrollOverviewViewModel, PayrollOverviewPayPeriodRef } from "@/lib/payroll/overview-view";

// Payroll 3A date-boundary hotfix (2026-09-11) — timezone-agnostic
// calendar-date formatting for payroll period dates.
//
// PROBLEM: `new Date("2026-08-30").toLocaleDateString("en-CA", …)` in an
// Alberta browser converts the UTC-midnight instant to the previous
// evening in MDT (UTC−6) and renders "Aug 29" — one day earlier than
// the persisted business date. This broke the header display while
// the selector (formatted server-side in UTC) was correct.
//
// FIX: parse the ISO `YYYY-MM-DD` prefix as a pure calendar date and
// compute the weekday via UTC methods only. The output is stable in
// every viewer timezone, honours the domain's date-only intent, and
// never crosses a day boundary due to DST or timezone conversion.
const MONTH_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const WEEKDAY_SHORT = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

export function fmtCalendarDate(iso: string): string {
  if (!iso) return iso;
  const raw = iso.slice(0, 10);
  const [y, m, d] = raw.split("-").map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return iso;
  // Build a Date pinned to UTC midnight for that calendar day, then
  // read the weekday via getUTCDay so the local browser timezone
  // never enters the calculation.
  const dt = new Date(Date.UTC(y, m - 1, d));
  const weekday = WEEKDAY_SHORT[dt.getUTCDay()];
  const month = MONTH_SHORT[m - 1];
  return `${weekday}, ${month} ${d}, ${y}`;
}
function payDateLongLabel(payPeriod: PayrollOverviewPayPeriodRef): string {
  return fmtCalendarDate(payPeriod.payDateISO);
}
function periodLongLabel(payPeriod: PayrollOverviewPayPeriodRef): string {
  return `${fmtCalendarDate(payPeriod.periodStartISO)} – ${fmtCalendarDate(payPeriod.periodEndISO)}`;
}

/* Inline SVGs — same set as the approved shell. */
function CalendarIcon({ className = "" }: { className?: string }) {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 9h18M8 3v4M16 3v4" /></svg>);
}
function ChevronDown({ className = "" }: { className?: string }) {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>);
}
function ChevronRightSmall({ className = "" }: { className?: string }) {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>);
}
function ChevronLeftSmall({ className = "" }: { className?: string }) {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>);
}
function SearchIcon({ className = "" }: { className?: string }) {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>);
}
function CheckCircleIcon({ className = "" }: { className?: string }) {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></svg>);
}
function CircleOutline({ className = "" }: { className?: string }) {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className={className} aria-hidden="true"><circle cx="12" cy="12" r="9" /></svg>);
}
function AlertTriangleIcon({ className = "" }: { className?: string }) {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true"><path d="M12 3 2 20h20L12 3z" /><path d="M12 10v5M12 18v.5" /></svg>);
}
function ClockIcon({ className = "" }: { className?: string }) {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>);
}
function DollarIcon({ className = "" }: { className?: string }) {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true"><path d="M12 3v18M17 7c-1-2-3-3-5-3s-4 1-4 3 1 3 4 3 5 1 5 4-2 4-5 4-5-1-6-3" /></svg>);
}
function DocIcon({ className = "" }: { className?: string }) {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" /><path d="M14 3v5h5" /></svg>);
}
function UsersRoundIcon({ className = "" }: { className?: string }) {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true"><circle cx="9" cy="9" r="3" /><circle cx="17" cy="10" r="2.5" /><path d="M3 20c1-3 3.5-5 6-5s5 2 6 5" /><path d="M14 20c.5-2.5 2-4 4-4s3.5 1.5 4 4" /></svg>);
}
function DownloadIcon({ className = "" }: { className?: string }) {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true"><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M4 20h16" /></svg>);
}
function PlusIcon({ className = "" }: { className?: string }) {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>);
}
function SpinnerIcon({ className = "" }: { className?: string }) {
  // Indeterminate spinner — no fake percentage. Rotates via Tailwind's
  // animate-spin utility so it works without extra CSS.
  return (
    <svg viewBox="0 0 24 24" fill="none" className={"animate-spin " + className} aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity={0.25} strokeWidth={3} />
      <path d="M21 12a9 9 0 0 1-9 9" stroke="currentColor" strokeWidth={3} strokeLinecap="round" />
    </svg>
  );
}
function RefreshIcon({ className = "" }: { className?: string }) {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" /></svg>);
}
function EyeCheckIcon({ className = "" }: { className?: string }) {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></svg>);
}
function CalcIcon({ className = "" }: { className?: string }) {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 7h8M8 12h2M12 12h2M16 12h.5M8 16h2M12 16h2M16 16h.5" /></svg>);
}
function ArrowRight({ className = "" }: { className?: string }) {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true"><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></svg>);
}

/* ============================================================
   Workflow — derived from batch status.
   ============================================================ */
type WorkflowState = "done" | "current" | "pending";
function deriveWorkflow(batchStatus: string | null | undefined): Array<{ n: number; label: string; sub: string; state: WorkflowState }> {
  const status = batchStatus ?? "PRE_PREPARE";
  const map: Record<string, [WorkflowState, WorkflowState, WorkflowState, WorkflowState, WorkflowState, WorkflowState, WorkflowState, WorkflowState]> = {
    PRE_PREPARE:              ["current", "pending", "pending", "pending", "pending", "pending", "pending", "pending"],
    DRAFT:                    ["done", "current", "pending", "pending", "pending", "pending", "pending", "pending"],
    PREPARED:                 ["done", "done", "current", "pending", "pending", "pending", "pending", "pending"],
    CALCULATED:               ["done", "done", "done", "done", "current", "pending", "pending", "pending"],
    SUBMITTED_FOR_APPROVAL:   ["done", "done", "done", "done", "done", "done", "current", "pending"],
    APPROVED:                 ["done", "done", "done", "done", "done", "done", "done", "current"],
    POSTED:                   ["done", "done", "done", "done", "done", "done", "done", "done"],
    VOIDED:                   ["current", "pending", "pending", "pending", "pending", "pending", "pending", "pending"],
  };
  const st = map[status] ?? map.PRE_PREPARE;
  return [
    { n: 1, label: "Prepare",           sub: "",              state: st[0] },
    { n: 2, label: "Review",            sub: "Exceptions",    state: st[1] },
    { n: 3, label: "Approvals",         sub: "(Dept. Heads)", state: st[2] },
    { n: 4, label: "Calculate",         sub: "Payroll",       state: st[3] },
    { n: 5, label: "Review & Adjust",   sub: "",              state: st[4] },
    { n: 6, label: "Submit",            sub: "for Approval",  state: st[5] },
    { n: 7, label: "Approved",          sub: "(Controller)",  state: st[6] },
    { n: 8, label: "Posted",            sub: "Complete",      state: st[7] },
  ];
}

const STATUS_LABELS: Record<string, string> = {
  PRE_PREPARE:              "No batch yet",
  DRAFT:                    "DRAFT — blocked",
  PREPARED:                 "PREPARED",
  CALCULATED:               "CALCULATED",
  SUBMITTED_FOR_APPROVAL:   "SUBMITTED FOR APPROVAL",
  APPROVED:                 "APPROVED",
  POSTED:                   "POSTED",
  VOIDED:                   "VOIDED",
};

/* ============================================================
   Composition — server-driven from PayrollOverviewViewModel.
   ============================================================ */
export interface PayrollAdminOverviewProps {
  view: PayrollOverviewViewModel;
  prepare?: PrepareControls | null;
  freeze?: FreezeControls | null;
  adjustments?: AdjustmentControls | null;
  recurring?: RecurringControls | null;
}

export default function PayrollAdminOverview({
  view, prepare = null, freeze = null, adjustments = null, recurring = null,
}: PayrollAdminOverviewProps) {
  return (
    <div className="w-full" data-testid="payroll-admin-surface">
      <Header view={view} prepare={prepare} />
      <KpiStrip view={view} />
      <div className="px-8 mt-1 grid grid-cols-[minmax(0,1fr)_320px] gap-3">
        <Workspace view={view} prepare={prepare} freeze={freeze} adjustments={adjustments} recurring={recurring} />
        <div className="space-y-2">
          <ActionsCard view={view} />
          <ChecklistCard view={view} />
          <PayPeriodInfoCard view={view} />
        </div>
      </div>
      <Footer />
    </div>
  );
}

/* ============================================================
   REGION 2 — HEADER + 8-STAGE WORKFLOW
   ============================================================ */
function Header({ view, prepare }: { view: PayrollOverviewViewModel; prepare: PrepareControls | null }) {
  // Payroll Admin Slice 3B: workflow states come from the view model
  // (server-computed from real exceptions + approvals + batch state).
  const workflow = view.workflow;
  const firstFilled = workflow.findLastIndex((w) => w.state === "done");
  const connectorFillPct = firstFilled >= 0 ? ((firstFilled) * (100 / 7)) : 0;

  const heading = view.payGroup?.frequencyLabel ? `${view.payGroup.frequencyLabel} Payroll` : "Payroll";
  const badgeText = view.batch ? STATUS_LABELS[view.batch.status] ?? view.batch.status : "NO BATCH YET";
  const badgeTone = badgeToneFor(view.batch?.status ?? null);

  return (
    <section className="px-8 pt-3" data-testid="payroll-admin-header">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-semibold text-[28px] text-stone-900 leading-[1.1]">{heading}</h1>
            <span className={"inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-semibold tracking-[0.06em] " + badgeTone}>
              {badgeText}
            </span>
          </div>
          <div className="mt-2 text-[13px] text-stone-600 flex items-center gap-8">
            <span data-testid="payroll-admin-period-line">
              <span className="font-semibold text-stone-700">Period:</span>&nbsp;
              {view.payPeriod ? periodLongLabel(view.payPeriod) : "—"}
            </span>
            <span data-testid="payroll-admin-pay-date-line">
              <span className="font-semibold text-stone-700">Pay Date:</span>&nbsp;
              {view.payPeriod ? payDateLongLabel(view.payPeriod) : "—"}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {prepare && prepare.canPrepare && !view.hasBatch && view.payPeriod ? (
            <form action={prepare.action}>
              <input type="hidden" name="payPeriodId" value={view.payPeriod.id} />
              <PrepareSubmitButton />
            </form>
          ) : null}
          <ChangePeriodPicker view={view} />
        </div>
      </div>

      <div className="mt-4 relative" data-testid="payroll-admin-workflow">
        <div className="absolute top-[14px] left-[68px] right-[68px] h-[2px] bg-stone-300" />
        <div className="absolute top-[14px] h-[2px] bg-[#0f5f3f]" style={{ left: 68, width: `calc(${connectorFillPct}% - 68px + 68px)` }} />
        <div className="grid grid-cols-8 relative">
          {workflow.map((s) => (
            <div key={s.n} className="flex flex-col items-center relative">
              <div className={"relative z-10 grid place-items-center rounded-full text-[12px] font-semibold h-[28px] w-[28px] " +
                (s.state === "done" ? "bg-[#0f5f3f] text-white ring-4 ring-[#0f5f3f]/15"
                  : s.state === "current" ? "bg-white text-[#0f5f3f] border-2 border-[#0f5f3f]"
                  : "bg-white text-stone-400 border border-stone-300")}>
                {s.n}
              </div>
              <div className="mt-2 text-center leading-tight">
                <p className={"text-[12.5px] " + (s.state === "current" ? "text-[#0f5f3f] font-semibold underline underline-offset-4 decoration-2" : "text-stone-800 font-medium")}>{s.label}</p>
                {s.sub && <p className="text-[11.5px] text-stone-500 mt-0.5">{s.sub}</p>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
function badgeToneFor(status: string | null): string {
  if (!status) return "bg-stone-100 text-stone-600";
  switch (status) {
    case "DRAFT":     return "bg-[#fee2e2] text-[#991b1b]";
    case "PREPARED":  return "bg-[#dcfce7] text-[#166534]";
    case "CALCULATED":
    case "SUBMITTED_FOR_APPROVAL": return "bg-[#e0f2fe] text-[#075985]";
    case "APPROVED":  return "bg-[#dcfce7] text-[#166534]";
    case "POSTED":    return "bg-stone-200 text-stone-700";
    case "VOIDED":    return "bg-stone-200 text-stone-500";
    default:          return "bg-stone-100 text-stone-600";
  }
}

/* ============================================================
   Change Period — URL-driven navigation, no mutation.
   ============================================================ */
function ChangePeriodPicker({ view }: { view: PayrollOverviewViewModel }) {
  const router = useRouter();
  const pathname = usePathname() ?? "/app/admin/payroll";
  const params = useSearchParams();
  function selectPeriod(id: string) {
    const p = new URLSearchParams(params?.toString() ?? "");
    if (view.payGroup) p.set("payGroupId", view.payGroup.id);
    p.set("payPeriodId", id);
    // Reset filter/pagination on period switch — §17 rule.
    ["q", "department", "employmentType", "status", "page"].forEach((k) => p.delete(k));
    router.push(`${pathname}?${p.toString()}`);
  }
  return (
    <div className="relative">
      <label className="sr-only" htmlFor="payroll-admin-period-select">Change Period</label>
      <select
        id="payroll-admin-period-select"
        data-testid="payroll-admin-change-period"
        className="appearance-none inline-flex items-center gap-2 rounded-md border border-stone-200 bg-white pl-9 pr-8 py-2 text-[13px] text-stone-700 hover:bg-stone-50 min-w-[220px]"
        value={view.payPeriod?.id ?? ""}
        onChange={(e) => selectPeriod(e.target.value)}
      >
        {view.availablePayPeriods.length === 0 && <option value="">No pay periods available</option>}
        {view.availablePayPeriods.map((p) => (<option key={p.id} value={p.id}>{p.label}</option>))}
      </select>
      <CalendarIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-500 pointer-events-none" />
      <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-stone-400 pointer-events-none" />
    </div>
  );
}

/* ============================================================
   REGION 3 — 5-CARD KPI STRIP
   ============================================================ */
function KpiStrip({ view }: { view: PayrollOverviewViewModel }) {
  const k = view.kpi;
  const empValue = k.employeesInRun == null ? "—" : String(k.employeesInRun);
  const empSub = k.employeesInRun == null
    ? "No batch prepared"
    : `${k.hourlyCount ?? 0} hourly · ${k.salaryCount ?? 0} salary`;
  const adjValue = k.adjustmentsCount == null ? "—" : String(k.adjustmentsCount);
  const excValue = k.exceptionsCount == null ? "—" : String(k.exceptionsCount);
  const excIsZero = k.exceptionsCount === 0;
  return (
    <section className="px-8 mt-1.5 grid grid-cols-5 gap-4" data-testid="payroll-admin-kpi-strip">
      <KpiCard icon={<UsersRoundIcon className="h-7 w-7" />} iconColor="text-[#3f7042]"
        label="Employees" value={empValue} sub={empSub} testId="payroll-admin-kpi-employees" />
      <KpiCard icon={<ClockIcon className="h-7 w-7" />} iconColor="text-[#2563eb]"
        label="Total Hours" value={k.totalHoursDisplay}
        subEl={<span className="text-stone-400 text-[11.5px]">&nbsp;</span>}
        testId="payroll-admin-kpi-total-hours" />
      <KpiCard icon={<DollarIcon className="h-7 w-7" />} iconColor="text-[#3f7042]"
        label={k.grossPaySemantics === "PREPARED_ESTIMATE" ? "Estimated Gross Pay" :
               k.grossPaySemantics === "CALCULATED" ? "Gross Pay (Calculated)" :
               k.grossPaySemantics === "POSTED" ? "Gross Pay (Posted)" : "Estimated Gross Pay"}
        value={k.grossPayDisplay}
        subEl={<span className="text-stone-400 text-[11.5px]">&nbsp;</span>}
        testId="payroll-admin-kpi-gross-pay" />
      <KpiCard icon={<DocIcon className="h-7 w-7" />} iconColor="text-[#7c3aed]"
        label="Adjustments" value={adjValue} sub={k.adjustmentsCount == null ? "" : "One-time"}
        testId="payroll-admin-kpi-adjustments" />
      <KpiCard icon={<AlertTriangleIcon className="h-7 w-7" />}
        iconColor={k.exceptionsCount == null ? "text-stone-400" : (excIsZero ? "text-stone-400" : "text-[#dc2626]")}
        label="Exceptions" value={excValue}
        valueColor={k.exceptionsCount == null || excIsZero ? "text-stone-500" : "text-[#dc2626]"}
        subEl={k.exceptionsCount == null
          ? <span className="text-stone-400 text-[11.5px]">No batch prepared</span>
          : excIsZero
            ? <span className="text-stone-500 text-[11.5px]">No open exceptions</span>
            : (
              <span className="inline-flex items-center gap-3">
                <span className="text-[#dc2626] text-[11.5px]" data-testid="payroll-admin-kpi-exceptions-breakdown">
                  {(k.exceptionsBlockerCount ?? 0)} blocker{(k.exceptionsBlockerCount ?? 0) === 1 ? "" : "s"}
                  {" · "}
                  {(k.exceptionsWarningCount ?? 0)} warning{(k.exceptionsWarningCount ?? 0) === 1 ? "" : "s"}
                </span>
                <ExceptionsKpiViewLink />
              </span>
            )}
        testId="payroll-admin-kpi-exceptions" />
    </section>
  );
}
function ExceptionsKpiViewLink() {
  const router = useRouter();
  const pathname = usePathname() ?? "/app/admin/payroll";
  const params = useSearchParams();
  const onClick = () => {
    const p = new URLSearchParams(params?.toString() ?? "");
    p.set("tab", "exceptions");
    p.delete("page");
    router.push(`${pathname}?${p.toString()}`);
  };
  return (
    <button type="button" onClick={onClick} className="text-[11.5px] text-[#1e40af] hover:underline" data-testid="payroll-admin-kpi-exceptions-view">
      View exceptions →
    </button>
  );
}

function KpiCard({ icon, iconColor, label, value, valueColor, sub, subEl, testId }: {
  icon: ReactNode; iconColor: string; label: string; value: string;
  valueColor?: string; sub?: string; subEl?: ReactNode; testId?: string;
}) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white px-4 py-1.5" data-testid={testId}>
      <div className="flex items-start gap-3">
        <div className={"shrink-0 " + iconColor}>{icon}</div>
        <div className="min-w-0">
          <p className="text-[12px] text-stone-500 leading-tight">{label}</p>
          <p className={"mt-0.5 text-[24px] font-semibold leading-[1.1] tabular-nums " + (valueColor ?? "text-stone-900")}>{value}</p>
          {sub && <p className="mt-1 text-[11.5px] text-stone-500">{sub}</p>}
          {subEl && <p className="mt-1 text-[11.5px]">{subEl}</p>}
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   REGION 4 — WORKSPACE (tabs + filters + table + pagination)
   ============================================================ */
export interface PrepareControls {
  action: (formData: FormData) => Promise<void>;
  canPrepare: boolean;
}

// 3B semantics-hotfix (2026-09-12) — Freeze server-action bundle,
// passed into the Approvals tab so an APPROVED_UNFROZEN scope can
// be frozen without navigating away to /app/admin/payroll/process.
export interface FreezeControls {
  action: (formData: FormData) => Promise<void>;
  canFreeze: boolean;
}

// Slice 3C (2026-09-12) — one-time adjustment + recurring
// component write actions. Passed into the Adjustments tab so its
// drawers can invoke the canonical domain services without
// duplicating them client-side.
export interface AdjustmentControls {
  addAction: (formData: FormData) => Promise<void>;
  removeAction: (formData: FormData) => Promise<void>;
  canEdit: boolean;
}
export interface RecurringControls {
  createAction: (formData: FormData) => Promise<void>;
  endAction: (formData: FormData) => Promise<void>;
  canWrite: boolean;
}

// Prepare Payroll submit control — MUST live inside the <form action=…>
// so `useFormStatus` can read the pending state of the surrounding
// server-action submission. While the server action runs (network
// round-trip + preparePayrollBatch — up to several seconds for a
// pay group with many employees), the button:
//   • disables (blocking a second click),
//   • swaps its icon to an indeterminate spinner (no fake percentage),
//   • swaps its label to "Preparing Payroll…" so the click is
//     visibly acknowledged.
// After the server action returns and Next.js redirects+revalidates,
// the button vanishes on the next render (view.hasBatch flips true).
function PrepareSubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      data-testid="payroll-admin-prepare"
      data-pending={pending ? "true" : "false"}
      className={
        "inline-flex items-center gap-2 rounded-md text-white px-3.5 py-2 text-[13px] font-medium " +
        (pending
          ? "bg-[#1e40af]/70 cursor-wait"
          : "bg-[#1e40af] hover:bg-[#1e3a8a]")
      }
    >
      {pending ? <SpinnerIcon className="h-4 w-4" /> : <PlusIcon className="h-4 w-4" />}
      {pending ? "Preparing Payroll…" : "Prepare Payroll"}
    </button>
  );
}

function Workspace({ view, prepare, freeze, adjustments, recurring }: {
  view: PayrollOverviewViewModel;
  prepare: PrepareControls | null;
  freeze: FreezeControls | null;
  adjustments: AdjustmentControls | null;
  recurring: RecurringControls | null;
}) {
  const activeTab = view.activeTab;
  return (
    <section className="rounded-lg border border-stone-200 bg-white overflow-hidden" data-testid="payroll-admin-workspace">
      <WorkspaceTabs view={view} />
      {activeTab === "employees"   && <EmployeesTabContent view={view} prepare={prepare} />}
      {activeTab === "exceptions"  && <ExceptionsTabContent view={view} />}
      {activeTab === "approvals"   && <ApprovalsTabContent view={view} freeze={freeze} />}
      {activeTab === "adjustments" && <AdjustmentsTabContent view={view} adjustments={adjustments} recurring={recurring} />}
      {activeTab === "summary"     && <FutureTabContent label="Summary" note="Summary view becomes functional after Calculate." />}
    </section>
  );
}

function WorkspaceTabs({ view }: { view: PayrollOverviewViewModel }) {
  const router = useRouter();
  const pathname = usePathname() ?? "/app/admin/payroll";
  const params = useSearchParams();
  const setTab = (t: string) => {
    const p = new URLSearchParams(params?.toString() ?? "");
    if (t === "employees") p.delete("tab");
    else p.set("tab", t);
    p.delete("page");
    router.push(`${pathname}?${p.toString()}`);
  };
  const isActive = (t: string) => (t === "employees" ? view.activeTab === "employees" : view.activeTab === t);
  const tabCls = (t: string) =>
    "pb-2.5 " +
    (isActive(t)
      ? "text-[#1e40af] font-semibold border-b-2 border-[#1e40af]"
      : "text-stone-500 hover:text-stone-700");
  const exCount = view.kpi.exceptionsCount;
  const apReq = view.kpi.approvalsRequiredCount;
  const apDone = view.kpi.approvalsCompleteCount;
  const apLabel = apReq == null || apReq === 0 ? "" : ` (${apDone}/${apReq})`;
  return (
    <div className="px-6 pt-3 border-b border-stone-100">
      <nav className="flex items-end gap-8 text-[13.5px]" data-testid="payroll-admin-tabs">
        <button type="button" data-testid="payroll-admin-tab-employees"   className={tabCls("employees")}   onClick={() => setTab("employees")}>Employees</button>
        <button type="button" data-testid="payroll-admin-tab-exceptions"  className={tabCls("exceptions")}  onClick={() => setTab("exceptions")}>Exceptions {exCount == null ? "" : `(${exCount})`}</button>
        <button type="button" data-testid="payroll-admin-tab-adjustments" className={tabCls("adjustments")} onClick={() => setTab("adjustments")}>Adjustments {view.kpi.adjustmentsCount == null ? "" : `(${view.kpi.adjustmentsCount})`}</button>
        <button type="button" data-testid="payroll-admin-tab-approvals"   className={tabCls("approvals")}   onClick={() => setTab("approvals")}>Approvals{apLabel}</button>
        <button type="button" data-testid="payroll-admin-tab-summary"     className={tabCls("summary")}     onClick={() => setTab("summary")}>Summary</button>
      </nav>
    </div>
  );
}

function EmployeesTabContent({ view, prepare }: { view: PayrollOverviewViewModel; prepare: PrepareControls | null }) {
  const totalCount = view.employeeTable.filteredTotal;
  const start = totalCount === 0 ? 0 : (view.employeeTable.page - 1) * view.employeeTable.pageSize + 1;
  const end = Math.min(view.employeeTable.page * view.employeeTable.pageSize, totalCount);
  return (
    <>
      <FilterBar view={view} />
      <div className="border-t border-stone-100">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-[12px] text-stone-500 bg-[#fbfaf7]">
              <th className="pl-6 py-2.5 font-medium w-[38px]"><input type="checkbox" readOnly className="align-middle" /></th>
              <th className="py-2.5 font-medium">Employee</th>
              <th className="py-2.5 font-medium">Department</th>
              <th className="py-2.5 font-medium text-right pr-6">Regular Hrs</th>
              <th className="py-2.5 font-medium text-right pr-6">OT Hrs</th>
              <th className="py-2.5 font-medium text-right pr-6">Total Hrs</th>
              <th className="py-2.5 font-medium text-right pr-6">Gross Pay</th>
              <th className="py-2.5 font-medium">Status</th>
              <th className="py-2.5 font-medium pr-6">Actions</th>
            </tr>
          </thead>
          <tbody data-testid="payroll-admin-employee-tbody">
            {view.employeeTable.rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="text-center text-stone-500 text-[13px] py-10" data-testid="payroll-admin-employee-empty">
                  {view.hasBatch ? (
                    "No employees match the current filters."
                  ) : (
                    <>
                      <p className="text-stone-700">No batch prepared for this pay period.</p>
                      {prepare && prepare.canPrepare ? (
                        <p className="mt-2 text-stone-500 text-[12.5px]">
                          Click <span className="font-semibold">Prepare Payroll</span> above to create the employee population for this pay period.
                        </p>
                      ) : null}
                    </>
                  )}
                </td>
              </tr>
            ) : view.employeeTable.rows.map((r) => (
              <tr key={r.batchEmployeeId} className="border-t border-stone-100" data-testid={`payroll-admin-employee-row-${r.batchEmployeeId}`}>
                <td className="pl-6 py-0.5"><input type="checkbox" readOnly className="align-middle" /></td>
                <td className="py-0.5 text-stone-900">{r.displayName}</td>
                <td className="py-0.5 text-stone-700">{r.department}</td>
                <td className="py-0.5 text-right text-stone-800 pr-6 tabular-nums">{r.regularHrs}</td>
                <td className="py-0.5 text-right text-stone-800 pr-6 tabular-nums">{r.otHrs}</td>
                <td className="py-0.5 text-right text-stone-800 pr-6 tabular-nums">{r.totalHrs}</td>
                <td className="py-0.5 text-right text-stone-800 pr-6 tabular-nums">{r.grossPay}</td>
                <td className="py-0.5"><StatusPill status={r.status} /></td>
                <td className="py-0.5 pr-6">
                  <Link href={r.viewHref} className="text-[#1e40af]" data-testid={`payroll-admin-employee-view-${r.batchEmployeeId}`}>View</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-6 py-2 flex items-center justify-between text-[12.5px] text-stone-500 border-t border-stone-100">
        <p data-testid="payroll-admin-pagination-summary">Showing {start}–{end} of {totalCount} employees</p>
        <Pagination view={view} />
        <PageSizeControl view={view} />
      </div>
    </>
  );
}

function ExceptionsTabContent({ view }: { view: PayrollOverviewViewModel }) {
  const rows = view.exceptions;
  if (!view.hasBatch) {
    return (
      <div className="px-6 py-10 text-center text-stone-500 text-[13px]" data-testid="payroll-admin-exceptions-empty">
        <p className="text-stone-700">No batch prepared for this pay period.</p>
        <p className="mt-2 text-stone-500 text-[12.5px]">Prepare payroll to see exceptions here.</p>
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="px-6 py-10 text-center text-stone-500 text-[13px]" data-testid="payroll-admin-exceptions-empty">
        <p className="text-stone-700">No unresolved exceptions.</p>
        <p className="mt-2 text-stone-500 text-[12.5px]">Every payroll input for this batch is either valid or acknowledged.</p>
      </div>
    );
  }
  const groupedByEmployee = new Map<string, typeof rows>();
  const orphan: typeof rows = [];
  for (const r of rows) {
    const key = r.employeeId ?? "__batch__";
    if (key === "__batch__") { orphan.push(r); continue; }
    const arr = groupedByEmployee.get(key) ?? [];
    arr.push(r);
    groupedByEmployee.set(key, arr);
  }
  return (
    <div className="border-t border-stone-100" data-testid="payroll-admin-exceptions-tab">
      <ul className="divide-y divide-stone-100">
        {Array.from(groupedByEmployee.entries()).map(([empId, empRows]) => (
          <li key={empId} className="px-6 py-3" data-testid={`payroll-admin-exception-group-${empId}`}>
            <p className="text-[13px] font-semibold text-stone-900">
              {empRows[0]?.employeeDisplayName ?? "(unassigned)"}
            </p>
            <ul className="mt-1.5 space-y-2">
              {empRows.map((r) => (<ExceptionRow key={r.id} row={r} />))}
            </ul>
          </li>
        ))}
        {orphan.length > 0 && (
          <li className="px-6 py-3" data-testid="payroll-admin-exception-group-batch">
            <p className="text-[13px] font-semibold text-stone-900">Batch-level</p>
            <ul className="mt-1.5 space-y-2">
              {orphan.map((r) => (<ExceptionRow key={r.id} row={r} />))}
            </ul>
          </li>
        )}
      </ul>
    </div>
  );
}

function ExceptionRow({ row }: { row: PayrollOverviewViewModel["exceptions"][number] }) {
  const sevPill = row.severity === "BLOCKER"
    ? { bg: "bg-[#fee2e2]", text: "text-[#991b1b]", dot: "bg-[#dc2626]", label: "Blocker" }
    : row.severity === "WARNING"
      ? { bg: "bg-[#fef3c7]", text: "text-[#92400e]", dot: "bg-[#d97706]", label: "Warning" }
      : { bg: "bg-[#e0f2fe]", text: "text-[#075985]", dot: "bg-[#0ea5e9]", label: "Info" };
  return (
    <li className="rounded-md border border-stone-200 px-3 py-2" data-testid={`payroll-admin-exception-${row.id}`} data-severity={row.severity} data-code={row.code}>
      <div className="flex items-center gap-2">
        <span className={"inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] " + sevPill.bg + " " + sevPill.text}>
          <span className={"h-1.5 w-1.5 rounded-full " + sevPill.dot} />
          {sevPill.label}
        </span>
        <p className="text-[13px] font-medium text-stone-900">{row.label}</p>
      </div>
      <p className="mt-1 text-[12.5px] text-stone-600">{row.message}</p>
      {row.recommendedAction ? (
        <p className="mt-1 text-[12.5px] text-stone-500">
          <span className="font-medium text-stone-600">Recommended:</span>&nbsp;{row.recommendedAction}
        </p>
      ) : null}
      {row.remediation.href ? (
        <p className="mt-1.5">
          <Link href={row.remediation.href} className="text-[12.5px] text-[#1e40af] inline-flex items-center gap-1" data-testid={`payroll-admin-exception-remediate-${row.id}`}>
            {row.remediation.label} <ArrowRight className="h-3 w-3" />
          </Link>
        </p>
      ) : null}
    </li>
  );
}

function ApprovalsTabContent({ view, freeze }: { view: PayrollOverviewViewModel; freeze: FreezeControls | null }) {
  // 3B semantics-hotfix (2026-09-12) — the Approvals tab tracks TWO
  // governance gates independently:
  //   Gate 1 (Manager approval) : the tab-badge, workflow Step 3,
  //     and checklist item 2 all report progress on THIS gate.
  //   Gate 2 (Payroll Admin freeze) : each row's state pill +
  //     the aggregate sub-caption below report progress on this
  //     separately.
  const rows = view.approvals;
  const approved = view.kpi.approvalsCompleteCount ?? 0;
  const required = view.kpi.approvalsRequiredCount ?? 0;
  const awaitingFreeze = view.kpi.awaitingFreezeScopeCount ?? 0;
  const frozen        = view.kpi.payrollFrozenScopeCount ?? 0;

  if (rows.length === 0) {
    return (
      <div className="px-6 py-10 text-center text-stone-500 text-[13px]" data-testid="payroll-admin-approvals-empty">
        <p className="text-stone-700">No departments have time to approve for this period.</p>
        {!view.hasBatch ? (
          <p className="mt-2 text-stone-500 text-[12.5px]">Reviewable time appears here as soon as any employee clocks in.</p>
        ) : null}
      </div>
    );
  }
  return (
    <div className="border-t border-stone-100" data-testid="payroll-admin-approvals-tab">
      {/* Aggregate sub-caption — approval vs freeze progress as two
          separate dimensions (§6). */}
      <div className="px-6 py-2 flex items-center justify-between text-[12px] text-stone-600 bg-[#fbfaf7] border-b border-stone-100" data-testid="payroll-admin-approvals-aggregate">
        <p>
          <span className="font-semibold text-stone-800" data-testid="payroll-admin-approvals-aggregate-approved">{approved} approved</span>
          {required > 0 ? <span className="text-stone-400"> of {required}</span> : null}
          {awaitingFreeze > 0 ? (
            <>
              <span className="mx-2 text-stone-300">·</span>
              <span data-testid="payroll-admin-approvals-aggregate-awaiting-freeze">{awaitingFreeze} awaiting freeze</span>
            </>
          ) : null}
          {frozen > 0 ? (
            <>
              <span className="mx-2 text-stone-300">·</span>
              <span data-testid="payroll-admin-approvals-aggregate-frozen">{frozen} frozen</span>
            </>
          ) : null}
        </p>
      </div>
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left text-[12px] text-stone-500 bg-[#fbfaf7]">
            <th className="pl-6 py-2.5 font-medium">Department</th>
            <th className="py-2.5 font-medium">Employees</th>
            <th className="py-2.5 font-medium text-right pr-6">Hours</th>
            <th className="py-2.5 font-medium">State</th>
            <th className="py-2.5 font-medium">Approved at</th>
            <th className="py-2.5 font-medium pr-6">Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.departmentId} className="border-t border-stone-100" data-testid={`payroll-admin-approval-row-${r.departmentId}`}>
              <td className="pl-6 py-1.5 text-stone-900">
                <p className="font-medium">{r.departmentName}</p>
                <p className="text-[11.5px] text-stone-500">{r.departmentCode}</p>
              </td>
              <td className="py-1.5 text-stone-700 tabular-nums">{r.employeeCount}</td>
              <td className="py-1.5 text-right text-stone-800 pr-6 tabular-nums">{r.totalHoursDisplay}</td>
              <td className="py-1.5"><ApprovalPill state={r.state} label={r.stateLabel} /></td>
              <td className="py-1.5 text-stone-600 text-[12.5px]">{r.approvedAt ? new Date(r.approvedAt).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }) : "—"}</td>
              <td className="py-1.5 pr-6">
                <ApprovalRowAction row={r} freeze={freeze} periodId={view.payPeriod?.id ?? ""} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// 3B semantics-hotfix (2026-09-12) — per-row action selector. An
// APPROVED_UNFROZEN scope gets an inline "Freeze into Payroll →"
// server-action form (delegates to freezeApprovedScopeIntoPayroll —
// the domain-canonical freeze service — the same one behind the
// /app/admin/payroll/process page's Freeze button). Every other
// state shows the existing "Review time →" deep-link into the
// scope-version-safe workspace.
function ApprovalRowAction({ row, freeze, periodId }: {
  row: PayrollOverviewViewModel["approvals"][number];
  freeze: FreezeControls | null;
  periodId: string;
}) {
  const canFreeze = freeze?.canFreeze === true;
  if (row.state === "APPROVED_UNFROZEN" && canFreeze && periodId) {
    return (
      <form action={freeze!.action} className="inline-flex">
        <input type="hidden" name="payPeriodId"  value={periodId} />
        <input type="hidden" name="departmentId" value={row.departmentId} />
        <FreezeSubmitButton departmentId={row.departmentId} />
      </form>
    );
  }
  return (
    <Link href={row.reviewHref} className="text-[#1e40af] inline-flex items-center gap-1 text-[13px]" data-testid={`payroll-admin-approval-review-${row.departmentId}`}>
      Review time <ArrowRight className="h-3 w-3" />
    </Link>
  );
}

function FreezeSubmitButton({ departmentId }: { departmentId: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      data-testid={`payroll-admin-approval-freeze-${departmentId}`}
      data-pending={pending ? "true" : "false"}
      className={
        "inline-flex items-center gap-1 rounded-md text-white px-2.5 py-1 text-[12.5px] font-medium " +
        (pending ? "bg-[#0f5f3f]/70 cursor-wait" : "bg-[#0f5f3f] hover:bg-[#0d4f34]")
      }
    >
      {pending ? <SpinnerIcon className="h-3 w-3" /> : null}
      {pending ? "Freezing…" : "Freeze into Payroll"}
      {!pending ? <ArrowRight className="h-3 w-3" /> : null}
    </button>
  );
}

function ApprovalPill({ state, label }: { state: string; label: string }) {
  // 3B acceptance hotfix (2026-09-12) — pill palette now covers the
  // FROZEN vs APPROVED_UNFROZEN distinction so a manager can see at
  // a glance whether a Payroll Admin still needs to click Freeze.
  const cfg = state === "FROZEN"
    ? { bg: "bg-[#dcfce7]",  text: "text-[#166534]", dot: "bg-[#16a34a]" }
    : state === "APPROVED_UNFROZEN"
      ? { bg: "bg-[#e0f2fe]", text: "text-[#075985]", dot: "bg-[#0ea5e9]" }
      : state === "REOPENED"
        ? { bg: "bg-[#fef3c7]", text: "text-[#92400e]", dot: "bg-[#d97706]" }
        : state === "NEEDS_ATTENTION"
          ? { bg: "bg-[#fee2e2]", text: "text-[#991b1b]", dot: "bg-[#dc2626]" }
          : { bg: "bg-stone-100", text: "text-stone-600", dot: "bg-stone-400" };
  return (
    <span className={"inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11.5px] " + cfg.bg + " " + cfg.text} data-state={state}>
      <span className={"h-1.5 w-1.5 rounded-full " + cfg.dot} />
      {label}
    </span>
  );
}

function FutureTabContent({ label, note }: { label: string; note: string }) {
  return (
    <div className="px-6 py-10 text-center text-stone-500 text-[13px]" data-testid={`payroll-admin-future-tab-${label.toLowerCase()}`}>
      <p className="text-stone-700">{label}</p>
      <p className="mt-2 text-stone-500 text-[12.5px]">{note}</p>
    </div>
  );
}

// Slice 3C — Adjustments tab (functional). Two clearly-labelled
// sections: One-Time Adjustments (batch-specific) and Recurring
// Components (frozen at Prepare). Add / Remove wired to the
// canonical domain services; batch-status gating is enforced by
// the domain (assertBatchAcceptsAdjustments — PREPARED-only).
function AdjustmentsTabContent({ view, adjustments, recurring }: {
  view: PayrollOverviewViewModel;
  adjustments: AdjustmentControls | null;
  recurring: RecurringControls | null;
}) {
  if (!view.hasBatch) {
    return (
      <div className="px-6 py-10 text-center text-stone-500 text-[13px]" data-testid="payroll-admin-adjustments-empty">
        <p className="text-stone-700">Prepare payroll before adding batch-specific adjustments.</p>
        <p className="mt-2 text-stone-500 text-[12.5px]">Recurring employee setup can still be edited from an employee profile.</p>
      </div>
    );
  }
  const canAdd  = adjustments?.canEdit === true && view.batchAcceptsAdjustments;
  const canRemove = adjustments?.canEdit === true && view.batchAcceptsAdjustments;
  const canRecur = recurring?.canWrite === true;
  const employeePickerRows = view.employeeTable.rows.map((r) => ({
    batchEmployeeId: r.batchEmployeeId,
    employeeId: r.employeeId,
    displayName: r.displayName,
  }));
  const payPeriodId = view.payPeriod?.id ?? "";
  const batchId = view.batch?.id ?? "";
  return (
    <div className="border-t border-stone-100" data-testid="payroll-admin-adjustments-tab">
      <AdjustmentsSectionHeader
        title="One-Time Adjustments"
        subtitle="Batch-specific corrections attached to this payroll run"
        right={canAdd ? (
          <details className="relative">
            <summary className="list-none cursor-pointer inline-flex items-center gap-1 rounded-md bg-[#1e40af] text-white px-3 py-1.5 text-[12.5px] font-medium hover:bg-[#1e3a8a]" data-testid="payroll-admin-adjustments-add-open">
              <PlusIcon className="h-3.5 w-3.5" /> Add One-Time Adjustment
            </summary>
            <AddAdjustmentPanel
              action={adjustments!.addAction}
              payPeriodId={payPeriodId}
              batchId={batchId}
              employees={employeePickerRows}
              components={view.componentPicker}
            />
          </details>
        ) : (
          <button
            disabled
            title={
              !view.batchAcceptsAdjustments
                ? "Batch must be PREPARED to add adjustments"
                : "Insufficient permissions"
            }
            data-testid="payroll-admin-adjustments-add-disabled"
            className="inline-flex items-center gap-1 rounded-md bg-stone-200 text-stone-500 px-3 py-1.5 text-[12.5px] font-medium cursor-not-allowed"
          >
            <PlusIcon className="h-3.5 w-3.5" /> Add One-Time Adjustment
          </button>
        )}
      />
      {view.oneTimeAdjustments.length === 0 ? (
        <p className="px-6 py-4 text-[12.5px] text-stone-500" data-testid="payroll-admin-adjustments-none">
          No one-time adjustments on this batch.
        </p>
      ) : (
        <table className="w-full text-[13px]" data-testid="payroll-admin-adjustments-table">
          <thead>
            <tr className="text-left text-[12px] text-stone-500 bg-[#fbfaf7]">
              <th className="pl-6 py-2 font-medium">Employee</th>
              <th className="py-2 font-medium">Component</th>
              <th className="py-2 font-medium text-right pr-4">Amount</th>
              <th className="py-2 font-medium">Reason</th>
              <th className="py-2 font-medium pr-6">Action</th>
            </tr>
          </thead>
          <tbody>
            {view.oneTimeAdjustments.map((a) => (
              <tr key={a.id} className="border-t border-stone-100" data-testid={`payroll-admin-adjustment-row-${a.id}`}>
                <td className="pl-6 py-1.5 text-stone-900">{a.employeeDisplayName}</td>
                <td className="py-1.5 text-stone-700">
                  <p className="font-medium">{a.componentDisplayName}</p>
                  <p className="text-[11.5px] text-stone-500">{a.componentCode} · {a.category}</p>
                </td>
                <td className="py-1.5 text-right pr-4 tabular-nums text-stone-900">{a.amountDisplay}</td>
                <td className="py-1.5 text-stone-700">{a.reason}</td>
                <td className="py-1.5 pr-6">
                  {canRemove ? (
                    <form action={adjustments!.removeAction}>
                      <input type="hidden" name="payPeriodId" value={payPeriodId} />
                      <input type="hidden" name="snapshotId" value={a.id} />
                      <button type="submit" data-testid={`payroll-admin-adjustment-remove-${a.id}`} className="text-[12.5px] text-[#dc2626] hover:underline">Remove</button>
                    </form>
                  ) : (
                    <span className="text-[12px] text-stone-400">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="border-t border-stone-100" />
      <AdjustmentsSectionHeader
        title="Recurring Components"
        subtitle="Frozen from employee recurring setup at Prepare"
        right={canRecur ? (
          <details className="relative">
            <summary className="list-none cursor-pointer inline-flex items-center gap-1 rounded-md border border-stone-200 bg-white px-3 py-1.5 text-[12.5px] text-stone-700 hover:bg-stone-50" data-testid="payroll-admin-recurring-manage-open">
              <RefreshIcon className="h-3.5 w-3.5" /> Manage Recurring Components
            </summary>
            <ManageRecurringPanel
              createAction={recurring!.createAction}
              payPeriodId={payPeriodId}
              employees={employeePickerRows}
              components={view.componentPicker}
            />
          </details>
        ) : (
          <button disabled className="inline-flex items-center gap-1 rounded-md border border-stone-200 bg-white px-3 py-1.5 text-[12.5px] text-stone-400 cursor-not-allowed" data-testid="payroll-admin-recurring-manage-disabled">
            <RefreshIcon className="h-3.5 w-3.5" /> Manage Recurring Components
          </button>
        )}
      />
      {view.recurringSnapshots.length === 0 ? (
        <p className="px-6 py-4 text-[12.5px] text-stone-500" data-testid="payroll-admin-recurring-none">
          No recurring components on this batch.
        </p>
      ) : (
        <table className="w-full text-[13px]" data-testid="payroll-admin-recurring-table">
          <thead>
            <tr className="text-left text-[12px] text-stone-500 bg-[#fbfaf7]">
              <th className="pl-6 py-2 font-medium">Employee</th>
              <th className="py-2 font-medium">Component</th>
              <th className="py-2 font-medium text-right pr-4">Amount</th>
              <th className="py-2 font-medium pr-6">Warning</th>
            </tr>
          </thead>
          <tbody>
            {view.recurringSnapshots.map((r) => (
              <tr key={r.id} className="border-t border-stone-100" data-testid={`payroll-admin-recurring-row-${r.id}`}>
                <td className="pl-6 py-1.5 text-stone-900">{r.employeeDisplayName}</td>
                <td className="py-1.5 text-stone-700">
                  <p className="font-medium">{r.componentDisplayName}</p>
                  <p className="text-[11.5px] text-stone-500">{r.componentCode} · {r.category}</p>
                </td>
                <td className="py-1.5 text-right pr-4 tabular-nums text-stone-900">{r.amountDisplay}</td>
                <td className="py-1.5 pr-6 text-[12px] text-stone-500">
                  {r.warningMessage ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AdjustmentsSectionHeader({ title, subtitle, right }: { title: string; subtitle: string; right: ReactNode }) {
  return (
    <div className="px-6 py-3 flex items-start justify-between gap-4 bg-white">
      <div>
        <h3 className="text-[14px] font-semibold text-stone-900">{title}</h3>
        <p className="text-[12px] text-stone-500 mt-0.5">{subtitle}</p>
      </div>
      <div className="shrink-0">{right}</div>
    </div>
  );
}

function AddAdjustmentPanel({ action, payPeriodId, batchId, employees, components }: {
  action: (fd: FormData) => Promise<void>;
  payPeriodId: string;
  batchId: string;
  employees: Array<{ batchEmployeeId: string; employeeId: string; displayName: string }>;
  components: PayrollOverviewViewModel["componentPicker"];
}) {
  return (
    <div className="absolute right-0 top-full mt-1 z-10 w-[380px] rounded-md border border-stone-200 bg-white shadow-lg p-4" data-testid="payroll-admin-adjustments-add-panel">
      <form action={action} className="space-y-2.5">
        <input type="hidden" name="payPeriodId" value={payPeriodId} />
        <input type="hidden" name="batchId" value={batchId} />
        <div>
          <label htmlFor="adj-emp" className="text-[11.5px] text-stone-600 font-medium">Employee</label>
          <select id="adj-emp" name="batchEmployeeId" required data-testid="payroll-admin-adjustments-add-employee" className="w-full mt-0.5 h-8 rounded border border-stone-200 text-[12.5px] px-2">
            <option value="">Select employee…</option>
            {employees.map((e) => (
              <option key={e.batchEmployeeId} value={e.batchEmployeeId}>{e.displayName}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="adj-comp" className="text-[11.5px] text-stone-600 font-medium">Payroll component</label>
          <select id="adj-comp" name="componentCode" required data-testid="payroll-admin-adjustments-add-component" className="w-full mt-0.5 h-8 rounded border border-stone-200 text-[12.5px] px-2">
            <option value="">Select component…</option>
            {components
              .filter((c) => c.calculationMethod === "FIXED_AMOUNT")
              .map((c) => (
                <option key={c.id} value={c.code}>{c.displayName} ({c.category})</option>
              ))}
          </select>
          <p className="mt-1 text-[11px] text-stone-400">
            Only FIXED_AMOUNT components accept a one-time adjustment. Manage the catalogue at{" "}
            <Link href="/app/admin/payroll/setup/components" className="text-[#1e40af] hover:underline">Payroll Components</Link>.
          </p>
        </div>
        <div>
          <label htmlFor="adj-amt" className="text-[11.5px] text-stone-600 font-medium">Amount (positive dollars)</label>
          <input id="adj-amt" name="amount" type="number" step="0.01" min="0.01" required data-testid="payroll-admin-adjustments-add-amount" className="w-full mt-0.5 h-8 rounded border border-stone-200 text-[12.5px] px-2" />
        </div>
        <div>
          <label htmlFor="adj-reason" className="text-[11.5px] text-stone-600 font-medium">Reason (required)</label>
          <input id="adj-reason" name="reason" type="text" required maxLength={240} data-testid="payroll-admin-adjustments-add-reason" className="w-full mt-0.5 h-8 rounded border border-stone-200 text-[12.5px] px-2" />
        </div>
        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="submit" data-testid="payroll-admin-adjustments-add-submit" className="inline-flex items-center gap-1 rounded-md bg-[#1e40af] text-white px-3 py-1.5 text-[12.5px] font-medium hover:bg-[#1e3a8a]">Save adjustment</button>
        </div>
      </form>
    </div>
  );
}

function ManageRecurringPanel({ createAction, payPeriodId, employees, components }: {
  createAction: (fd: FormData) => Promise<void>;
  payPeriodId: string;
  employees: Array<{ batchEmployeeId: string; employeeId: string; displayName: string }>;
  components: PayrollOverviewViewModel["componentPicker"];
}) {
  return (
    <div className="absolute right-0 top-full mt-1 z-10 w-[420px] rounded-md border border-stone-200 bg-white shadow-lg p-4" data-testid="payroll-admin-recurring-manage-panel">
      <p className="text-[12px] text-stone-500 mb-2">
        Add a recurring payroll component to an employee. Existing prepared batches are NOT modified — the assignment flows into the next Prepare.
      </p>
      <form action={createAction} className="space-y-2.5">
        <input type="hidden" name="payPeriodId" value={payPeriodId} />
        <div>
          <label htmlFor="rec-emp" className="text-[11.5px] text-stone-600 font-medium">Employee</label>
          <select id="rec-emp" name="employeeId" required data-testid="payroll-admin-recurring-add-employee" className="w-full mt-0.5 h-8 rounded border border-stone-200 text-[12.5px] px-2">
            <option value="">Select employee…</option>
            {employees.map((e) => (
              <option key={e.employeeId} value={e.employeeId}>{e.displayName}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="rec-comp" className="text-[11.5px] text-stone-600 font-medium">Payroll component</label>
          <select id="rec-comp" name="componentId" required data-testid="payroll-admin-recurring-add-component" className="w-full mt-0.5 h-8 rounded border border-stone-200 text-[12.5px] px-2">
            <option value="">Select component…</option>
            {components
              .filter((c) => c.calculationMethod === "FIXED_AMOUNT")
              .map((c) => (
                <option key={c.id} value={c.id}>{c.displayName} ({c.category})</option>
              ))}
          </select>
        </div>
        <div>
          <label htmlFor="rec-amt" className="text-[11.5px] text-stone-600 font-medium">Amount per period (positive dollars)</label>
          <input id="rec-amt" name="amount" type="number" step="0.01" min="0.01" required data-testid="payroll-admin-recurring-add-amount" className="w-full mt-0.5 h-8 rounded border border-stone-200 text-[12.5px] px-2" />
        </div>
        <div>
          <label htmlFor="rec-eff" className="text-[11.5px] text-stone-600 font-medium">Effective from</label>
          <input id="rec-eff" name="effectiveFrom" type="date" required data-testid="payroll-admin-recurring-add-effective-from" className="w-full mt-0.5 h-8 rounded border border-stone-200 text-[12.5px] px-2" />
        </div>
        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="submit" data-testid="payroll-admin-recurring-add-submit" className="inline-flex items-center gap-1 rounded-md bg-[#0f5f3f] text-white px-3 py-1.5 text-[12.5px] font-medium hover:bg-[#0d4f34]">Add assignment</button>
        </div>
      </form>
    </div>
  );
}

function PageSizeControl({ view }: { view: PayrollOverviewViewModel }) {
  const router = useRouter();
  const pathname = usePathname() ?? "/app/admin/payroll";
  const params = useSearchParams();
  const currentSize = view.employeeTable.pageSize;
  const onChange = (raw: string) => {
    const p = new URLSearchParams(params?.toString() ?? "");
    const n = Number.parseInt(raw, 10);
    if (n === 10 || n === 25 || n === 50) p.set("pageSize", String(n));
    else p.delete("pageSize");
    // §8: reset to page 1 on page-size change; preserve search/filter.
    p.set("page", "1");
    router.push(`${pathname}?${p.toString()}`);
  };
  return (
    <div className="inline-flex items-center gap-2">
      <label className="sr-only" htmlFor="payroll-admin-page-size">Rows per page</label>
      <div className="relative">
        <select
          id="payroll-admin-page-size"
          data-testid="payroll-admin-page-size"
          value={String(currentSize)}
          onChange={(e) => onChange(e.target.value)}
          className="appearance-none inline-flex items-center h-8 rounded-md border border-stone-200 bg-white pl-2.5 pr-7 text-[12.5px] text-stone-700 hover:bg-stone-50"
        >
          <option value="10">10 per page</option>
          <option value="25">25 per page</option>
          <option value="50">50 per page</option>
        </select>
        <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-stone-400 pointer-events-none" />
      </div>
    </div>
  );
}
function StatusPill({ status }: { status: string }) {
  const cfg = status === "Ready" ? { bg: "bg-[#dcfce7]", text: "text-[#166534]", dot: "bg-[#16a34a]" }
    : status === "Exception" ? { bg: "bg-[#fee2e2]", text: "text-[#991b1b]", dot: "bg-[#dc2626]" }
    : status === "Excluded" ? { bg: "bg-stone-200", text: "text-stone-600", dot: "bg-stone-500" }
    : { bg: "bg-stone-100", text: "text-stone-600", dot: "bg-stone-400" };
  return (
    <span className={"inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11.5px] " + cfg.bg + " " + cfg.text}>
      <span className={"h-1.5 w-1.5 rounded-full " + cfg.dot} />
      {status}
    </span>
  );
}

/* ============================================================
   Filter bar + pagination — URL-driven state.
   ============================================================ */
function FilterBar({ view }: { view: PayrollOverviewViewModel }) {
  const router = useRouter();
  const pathname = usePathname() ?? "/app/admin/payroll";
  const params = useSearchParams();
  const setParam = (updates: Record<string, string | null>) => {
    const p = new URLSearchParams(params?.toString() ?? "");
    for (const [k, v] of Object.entries(updates)) {
      if (v == null || v === "") p.delete(k); else p.set(k, v);
    }
    p.set("page", "1"); // reset pagination on filter change (§17)
    router.push(`${pathname}?${p.toString()}`);
  };
  return (
    <div className="px-6 py-2 flex items-center gap-2.5" data-testid="payroll-admin-filter-bar">
      <form
        className="relative w-[280px]"
        onSubmit={(e) => {
          e.preventDefault();
          const q = new FormData(e.currentTarget).get("q");
          setParam({ q: typeof q === "string" ? q : null });
        }}
      >
        <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-400" />
        <input
          name="q"
          type="search"
          data-testid="payroll-admin-search"
          defaultValue={view.activeFilter.q}
          placeholder="Search employees..."
          className="w-full h-9 rounded-md border border-stone-200 bg-white pl-9 pr-3 text-[13px] placeholder:text-stone-400"
        />
      </form>
      <select
        data-testid="payroll-admin-filter-department"
        value={view.activeFilter.department ?? ""}
        onChange={(e) => setParam({ department: e.target.value || null })}
        className="inline-flex items-center gap-2 h-9 rounded-md border border-stone-200 bg-white px-3 text-[13px] text-stone-700 min-w-[160px]"
      >
        <option value="">All Departments</option>
        {view.availableDepartments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>
      <select
        data-testid="payroll-admin-filter-employment"
        value={view.activeFilter.employmentType ?? ""}
        onChange={(e) => setParam({ employmentType: e.target.value || null })}
        className="inline-flex items-center gap-2 h-9 rounded-md border border-stone-200 bg-white px-3 text-[13px] text-stone-700 min-w-[160px]"
      >
        <option value="">All Employment Types</option>
        {view.availableEmploymentTypes.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      <select
        data-testid="payroll-admin-filter-status"
        value={view.activeFilter.status ?? ""}
        onChange={(e) => setParam({ status: e.target.value || null })}
        className="inline-flex items-center gap-2 h-9 rounded-md border border-stone-200 bg-white px-3 text-[13px] text-stone-700 min-w-[160px]"
      >
        <option value="">All Statuses</option>
        {view.availableStatuses.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      <div className="flex-1" />
      <button
        disabled
        data-testid="payroll-admin-export"
        title="Payroll export is not yet available."
        className="inline-flex items-center gap-2 h-9 rounded-md border border-stone-200 bg-white px-3 text-[13px] text-stone-400 cursor-not-allowed"
      >
        <DownloadIcon className="h-4 w-4" />
        Export
      </button>
    </div>
  );
}
function Pagination({ view }: { view: PayrollOverviewViewModel }) {
  const router = useRouter();
  const pathname = usePathname() ?? "/app/admin/payroll";
  const params = useSearchParams();
  const pageCount = useMemo(() => Math.max(1, Math.ceil(view.employeeTable.filteredTotal / view.employeeTable.pageSize)), [view.employeeTable.filteredTotal, view.employeeTable.pageSize]);
  const pages = useMemo(() => {
    // Show up to 5 page buttons centered on the current page.
    const window = 2;
    const from = Math.max(1, view.employeeTable.page - window);
    const to = Math.min(pageCount, from + 4);
    const arr = [];
    for (let i = from; i <= to; i++) arr.push(i);
    return arr;
  }, [view.employeeTable.page, pageCount]);
  const setPage = (n: number) => {
    const p = new URLSearchParams(params?.toString() ?? "");
    p.set("page", String(n));
    router.push(`${pathname}?${p.toString()}`);
  };
  return (
    <div className="inline-flex items-center gap-1" data-testid="payroll-admin-pagination">
      <PageBtn onClick={() => setPage(Math.max(1, view.employeeTable.page - 1))} disabled={view.employeeTable.page === 1}>
        <ChevronLeftSmall className="h-3.5 w-3.5" />
      </PageBtn>
      {pages.map((n) => (
        <PageBtn key={n} onClick={() => setPage(n)} active={n === view.employeeTable.page}>{n}</PageBtn>
      ))}
      <PageBtn onClick={() => setPage(Math.min(pageCount, view.employeeTable.page + 1))} disabled={view.employeeTable.page === pageCount}>
        <ChevronRightSmall className="h-3.5 w-3.5" />
      </PageBtn>
    </div>
  );
}
function PageBtn({ children, active, disabled, onClick }: { children: ReactNode; active?: boolean; disabled?: boolean; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className={"h-7 min-w-[28px] px-2 rounded text-[12.5px] " + (active ? "bg-[#e6effe] text-[#1e40af] font-semibold" : "text-stone-500 hover:bg-stone-100") + (disabled ? " opacity-40 cursor-not-allowed" : "")}>
      {children}
    </button>
  );
}

/* ============================================================
   REGION 5 — PAYROLL ACTIONS (visual only in 3A)
   ============================================================ */
function ActionsCard({ view }: { view: PayrollOverviewViewModel }) {
  // Slice 3B: Resolve Exceptions activates the Exceptions tab
  // (in-place navigation via ?tab=exceptions). View Time Approvals
  // activates the Approvals tab. Both are enabled only when a batch
  // exists — before Prepare there's nothing to review.
  const canResolveExceptions = view.hasBatch;
  const canViewApprovals     = view.hasBatch;
  const blockerCount = view.kpi.exceptionsBlockerCount ?? 0;
  return (
    <section className="rounded-lg border border-stone-200 bg-white overflow-hidden" data-testid="payroll-admin-actions">
      <div className="px-5 pt-2.5 pb-1.5">
        <h2 className="font-semibold text-[15px] text-stone-900">Payroll Actions</h2>
      </div>
      <div className="px-4 pb-2.5 space-y-1.5">
        <TabNavigateBtn tone="primary" testId="payroll-admin-actions-resolve-exceptions"
          icon={<AlertTriangleIcon className="h-4 w-4" />}
          label={blockerCount > 0 ? `Resolve Exceptions (${blockerCount})` : "Review Exceptions"}
          disabled={!canResolveExceptions}
          disabledTitle="Prepare a payroll batch to see exceptions"
          targetTab="exceptions" />
        <TabNavigateBtn testId="payroll-admin-actions-add-adjustment"
          icon={<PlusIcon className="h-4 w-4 text-stone-500" />}
          label="Add One-Time Adjustment"
          disabled={!canResolveExceptions}
          disabledTitle="Prepare a payroll batch to add adjustments"
          targetTab="adjustments" />
        <TabNavigateBtn testId="payroll-admin-actions-manage-recurring"
          icon={<RefreshIcon className="h-4 w-4 text-stone-500" />}
          label="Manage Recurring Components"
          disabled={!canResolveExceptions}
          disabledTitle="Prepare a payroll batch to manage recurring components"
          targetTab="adjustments" />
        <TabNavigateBtn testId="payroll-admin-actions-view-approvals"
          icon={<EyeCheckIcon className="h-4 w-4 text-stone-500" />}
          label="View Time Approvals"
          disabled={!canViewApprovals}
          disabledTitle="Prepare a payroll batch to see approvals"
          targetTab="approvals" />
        <DisabledBtn icon={<CalcIcon className="h-4 w-4 text-stone-500" />} label="Calculate Payroll (Preview)" />
      </div>
    </section>
  );
}
function DisabledBtn({ tone, icon, label }: { tone?: "primary"; icon: ReactNode; label: string }) {
  if (tone === "primary") {
    return (
      <button disabled title="Coming in Payroll Admin 3B" className="w-full inline-flex items-center justify-between rounded-md bg-stone-300 text-white px-3.5 py-1.5 text-[13px] font-medium cursor-not-allowed">
        <span className="inline-flex items-center gap-2">{icon} {label}</span>
        <ArrowRight className="h-3.5 w-3.5" />
      </button>
    );
  }
  return (
    <button disabled title="Coming in a future Payroll Admin slice" className="w-full inline-flex items-center gap-2 rounded-md border border-stone-200 bg-white px-3.5 py-1.5 text-[13px] text-stone-400 cursor-not-allowed">
      {icon}
      {label}
    </button>
  );
}

// Slice 3B: right-rail action that switches the workspace tab
// in-place (no route change, no server action). Disabled state is
// styled the same as DisabledBtn so the shell reads consistently
// before Prepare.
function TabNavigateBtn({ tone, icon, label, targetTab, disabled, disabledTitle, testId }: {
  tone?: "primary";
  icon: ReactNode;
  label: string;
  targetTab: "exceptions" | "approvals" | "adjustments";
  disabled: boolean;
  disabledTitle: string;
  testId: string;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? "/app/admin/payroll";
  const params = useSearchParams();
  const onClick = () => {
    const p = new URLSearchParams(params?.toString() ?? "");
    p.set("tab", targetTab);
    p.delete("page");
    router.push(`${pathname}?${p.toString()}`);
  };
  if (disabled) {
    if (tone === "primary") {
      return (
        <button disabled title={disabledTitle} data-testid={testId} className="w-full inline-flex items-center justify-between rounded-md bg-stone-300 text-white px-3.5 py-1.5 text-[13px] font-medium cursor-not-allowed">
          <span className="inline-flex items-center gap-2">{icon} {label}</span>
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      );
    }
    return (
      <button disabled title={disabledTitle} data-testid={testId} className="w-full inline-flex items-center gap-2 rounded-md border border-stone-200 bg-white px-3.5 py-1.5 text-[13px] text-stone-400 cursor-not-allowed">
        {icon}
        {label}
      </button>
    );
  }
  if (tone === "primary") {
    return (
      <button type="button" onClick={onClick} data-testid={testId} className="w-full inline-flex items-center justify-between rounded-md bg-[#dc2626] hover:bg-[#b91c1c] text-white px-3.5 py-1.5 text-[13px] font-medium">
        <span className="inline-flex items-center gap-2">{icon} {label}</span>
        <ArrowRight className="h-3.5 w-3.5" />
      </button>
    );
  }
  return (
    <button type="button" onClick={onClick} data-testid={testId} className="w-full inline-flex items-center gap-2 rounded-md border border-stone-200 bg-white hover:bg-stone-50 px-3.5 py-1.5 text-[13px] text-stone-700">
      {icon}
      {label}
    </button>
  );
}

/* ============================================================
   REGION 6 — PRE-CALCULATION CHECKLIST (real data in 3B)
   ============================================================ */
function ChecklistCard({ view }: { view: PayrollOverviewViewModel }) {
  const items = view.checklist;
  const owned = items.filter((i) => !i.future);
  const doneOwned = owned.filter((i) => i.done).length;
  const progressPct = owned.length === 0 ? 0 : Math.round((doneOwned / owned.length) * 100);
  return (
    <section className="rounded-lg border border-stone-200 bg-white overflow-hidden" data-testid="payroll-admin-checklist">
      <div className="px-5 pt-2.5 pb-1.5">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-[15px] text-stone-900">Pre-Calculation Checklist</h2>
          <p className="text-[12px] text-stone-500 tabular-nums" data-testid="payroll-admin-checklist-progress">
            {doneOwned} of {owned.length} complete
          </p>
        </div>
        <div className="mt-1.5 h-1.5 rounded-full bg-stone-100 overflow-hidden">
          <div className="h-full bg-[#0f5f3f]" style={{ width: `${progressPct}%` }} />
        </div>
      </div>
      <ul className="px-5 pb-2 pt-0.5 space-y-0.5 text-[12.5px] leading-tight" data-testid="payroll-admin-checklist-items">
        {items.map((item) => (
          <ChecklistItem key={item.id} item={item} />
        ))}
      </ul>
    </section>
  );
}
function ChecklistItem({ item }: { item: { id: string; label: string; done: boolean; detail: string | null; future: boolean } }) {
  const state: "done" | "current" | "future" = item.future ? "future" : item.done ? "done" : "current";
  const icon = state === "done"
    ? <CheckCircleIcon className="h-[16px] w-[16px] text-[#0f5f3f] shrink-0 mt-[1px]" />
    : <CircleOutline className="h-[16px] w-[16px] text-stone-300 shrink-0 mt-[1px]" />;
  const textCls = state === "done"
    ? "text-stone-700"
    : state === "current"
      ? "text-stone-800"
      : "text-stone-400";
  return (
    <li className="flex items-start gap-2 leading-snug" data-testid={`payroll-admin-checklist-item-${item.id}`} data-done={item.done ? "true" : "false"} data-future={item.future ? "true" : "false"}>
      {icon}
      <span className={textCls}>
        {item.label}
        {item.detail ? <span className="text-stone-400 ml-1">· {item.detail}</span> : null}
      </span>
    </li>
  );
}

/* ============================================================
   REGION 7 — PAY PERIOD INFORMATION + FOOTER
   ============================================================ */
function PayPeriodInfoCard({ view }: { view: PayrollOverviewViewModel }) {
  const period = view.payPeriod;
  return (
    <section className="rounded-lg border border-stone-200 bg-white overflow-hidden" data-testid="payroll-admin-pay-period">
      <div className="px-5 pt-2.5 pb-1 flex items-center gap-2">
        <CalendarIcon className="h-4 w-4 text-stone-500" />
        <h2 className="font-semibold text-[15px] text-stone-900">Pay Period Information</h2>
      </div>
      <dl className="px-5 py-1 grid grid-cols-[auto_1fr] gap-x-6 gap-y-0.5 text-[12.5px]">
        <dt className="text-stone-500">Pay Period</dt>
        <dd className="text-stone-800 text-right tabular-nums">{period ? periodLongLabel(period) : "—"}</dd>
        <dt className="text-stone-500">Pay Date</dt>
        <dd className="text-stone-800 text-right tabular-nums">{period ? payDateLongLabel(period) : "—"}</dd>
        <dt className="text-stone-500">Frequency</dt>
        <dd className="text-stone-800 text-right">{view.payGroup?.frequencyLabel ?? "—"}</dd>
        <dt className="text-stone-500">Employees in Period</dt>
        <dd className="text-stone-800 text-right tabular-nums">{view.kpi.employeesInRun ?? "—"}</dd>
      </dl>
      <div className="px-5 pb-2 pt-0">
        <Link href="/app/admin/payroll/setup" className="text-[12.5px] text-[#1e40af] inline-flex items-center gap-1" data-testid="payroll-admin-view-calendar">
          View pay period calendar <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
    </section>
  );
}
function Footer() {
  return (
    <footer className="mt-2 mb-1.5 px-8 flex items-center justify-between text-[11.5px] text-stone-500" data-testid="payroll-admin-footer">
      <p>© 2026 Spectre Automation. All rights reserved.</p>
      <div className="inline-flex items-center gap-5">
        <a href="#" className="hover:text-stone-700">Privacy</a>
        <a href="#" className="hover:text-stone-700">Terms</a>
        <a href="#" className="hover:text-stone-700">Support</a>
      </div>
    </footer>
  );
}
