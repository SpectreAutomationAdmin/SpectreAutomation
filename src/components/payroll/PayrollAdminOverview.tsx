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
}

export default function PayrollAdminOverview({ view, prepare = null }: PayrollAdminOverviewProps) {
  return (
    <div className="w-full" data-testid="payroll-admin-surface">
      <Header view={view} prepare={prepare} />
      <KpiStrip view={view} />
      <div className="px-8 mt-1 grid grid-cols-[minmax(0,1fr)_320px] gap-3">
        <Workspace view={view} prepare={prepare} />
        <div className="space-y-2">
          <ActionsCard />
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
  const workflow = deriveWorkflow(view.batch?.status);
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
              <button
                type="submit"
                data-testid="payroll-admin-prepare"
                className="inline-flex items-center gap-2 rounded-md bg-[#1e40af] text-white px-3.5 py-2 text-[13px] font-medium hover:bg-[#1e3a8a]"
              >
                <PlusIcon className="h-4 w-4" />
                Prepare Payroll
              </button>
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
            : <span className="text-[#dc2626] text-[11.5px]">Unresolved</span>}
        testId="payroll-admin-kpi-exceptions" />
    </section>
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

function Workspace({ view, prepare }: { view: PayrollOverviewViewModel; prepare: PrepareControls | null }) {
  const totalCount = view.employeeTable.filteredTotal;
  const start = totalCount === 0 ? 0 : (view.employeeTable.page - 1) * view.employeeTable.pageSize + 1;
  const end = Math.min(view.employeeTable.page * view.employeeTable.pageSize, totalCount);
  return (
    <section className="rounded-lg border border-stone-200 bg-white overflow-hidden" data-testid="payroll-admin-workspace">
      <div className="px-6 pt-3 border-b border-stone-100">
        <nav className="flex items-end gap-8 text-[13.5px]">
          <span className="pb-2.5 text-[#1e40af] font-semibold border-b-2 border-[#1e40af]">Employees</span>
          <span className="pb-2.5 text-stone-500">Exceptions {view.kpi.exceptionsCount == null ? "" : `(${view.kpi.exceptionsCount})`}</span>
          <span className="pb-2.5 text-stone-500">Adjustments {view.kpi.adjustmentsCount == null ? "" : `(${view.kpi.adjustmentsCount})`}</span>
          <span className="pb-2.5 text-stone-500">Approvals</span>
          <span className="pb-2.5 text-stone-500">Summary</span>
        </nav>
      </div>
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
        <div className="inline-flex items-center gap-2">
          <button disabled className="inline-flex items-center gap-1.5 h-8 rounded-md border border-stone-200 bg-white px-2.5 text-[12.5px] text-stone-500 cursor-not-allowed">
            10 per page <ChevronDown className="h-3 w-3 text-stone-400" />
          </button>
        </div>
      </div>
    </section>
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
function ActionsCard() {
  return (
    <section className="rounded-lg border border-stone-200 bg-white overflow-hidden" data-testid="payroll-admin-actions">
      <div className="px-5 pt-2.5 pb-1.5">
        <h2 className="font-semibold text-[15px] text-stone-900">Payroll Actions</h2>
      </div>
      <div className="px-4 pb-2.5 space-y-1.5">
        <DisabledBtn tone="primary" icon={<AlertTriangleIcon className="h-4 w-4" />} label="Resolve Exceptions" />
        <DisabledBtn icon={<PlusIcon className="h-4 w-4 text-stone-500" />} label="Add One-Time Adjustment" />
        <DisabledBtn icon={<RefreshIcon className="h-4 w-4 text-stone-500" />} label="Manage Recurring Components" />
        <DisabledBtn icon={<EyeCheckIcon className="h-4 w-4 text-stone-500" />} label="View Time Approvals" />
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

/* ============================================================
   REGION 6 — PRE-CALCULATION CHECKLIST (neutral state in 3A)
   ============================================================ */
function ChecklistCard({ view }: { view: PayrollOverviewViewModel }) {
  const hasBatch = view.hasBatch;
  return (
    <section className="rounded-lg border border-stone-200 bg-white overflow-hidden" data-testid="payroll-admin-checklist">
      <div className="px-5 pt-2.5 pb-1.5">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-[15px] text-stone-900">Pre-Calculation Checklist</h2>
          <p className="text-[12px] text-stone-500 tabular-nums" data-testid="payroll-admin-checklist-progress">
            {hasBatch ? "State pending Payroll Admin 3B" : "No batch"}
          </p>
        </div>
        <div className="mt-1.5 h-1.5 rounded-full bg-stone-100 overflow-hidden">
          <div className="h-full bg-stone-300" style={{ width: hasBatch ? "0%" : "0%" }} />
        </div>
      </div>
      <ul className="px-5 pb-2 pt-0.5 space-y-0.5 text-[12.5px] leading-tight">
        <ChecklistItem>All time entries imported</ChecklistItem>
        <ChecklistItem>Department head approvals</ChecklistItem>
        <ChecklistItem>Resolve payroll exceptions</ChecklistItem>
        <ChecklistItem>Review one-time adjustments</ChecklistItem>
        <ChecklistItem>Review recurring components</ChecklistItem>
        <ChecklistItem>Verify employee data</ChecklistItem>
      </ul>
    </section>
  );
}
function ChecklistItem({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-start gap-2 leading-snug">
      <CircleOutline className="h-[16px] w-[16px] text-stone-300 shrink-0 mt-[1px]" />
      <span className="text-stone-500">{children}</span>
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
