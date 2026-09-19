// Slice E (2026-09-19) — Payroll Register admin surface.
// Read-only per §2. Consumes the canonical PayrollRegisterV1 DTO.
// Available at CALCULATED / SUBMITTED / APPROVED / POSTED.

import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { getActiveClubId } from "@/lib/active-club";
import { buildPayrollRegister } from "@/lib/payroll/payroll-register";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function usd(n: string): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("en-CA", { style: "currency", currency: "CAD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

interface Props { params: { batchId: string } }

export default async function PayrollRegisterPage({ params }: Props) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, clubId, "payroll:read")) redirect("/app/admin");

  const reg = await buildPayrollRegister(principal, clubId, params.batchId);

  const stateLabel = reg.statePosted
    ? "POSTED — IMMUTABLE"
    : `Under review · ${reg.state}`;
  const stateTone = reg.statePosted
    ? { background: "#dcfce7", color: "#166534" }
    : { background: "#fef3c7", color: "#92400e" };
  const reconcilerOk = reg.reconciliation.differenceCents === 0
    && Number(reg.reconciliation.grossPayroll) - Number(reg.reconciliation.netPayroll) - Number(reg.reconciliation.employeeDeductions) === 0;

  return (
    <div className="max-w-[1400px]" data-testid="payroll-register-page">
      <header className="mb-spectre-6">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em]" style={{ color: "var(--spectre-text-muted)" }}>
          Finance · Payroll · Register
        </div>
        <div className="mt-1 flex items-center gap-3">
          <h1 className="text-spectre-h1 font-semibold" style={{ color: "var(--spectre-text-primary)" }}>
            Payroll Register
          </h1>
          <span
            className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold tracking-wide uppercase"
            style={stateTone}
            data-testid="payroll-register-state"
          >
            {stateLabel}
          </span>
        </div>
        <p className="mt-2 text-spectre-body" style={{ color: "var(--spectre-text-secondary)" }}>
          Pay date <strong>{fmtDate(reg.payPeriod.payDateIso)}</strong> · period {fmtDate(reg.payPeriod.startIso)} – {fmtDate(reg.payPeriod.endIso)}
          {reg.posted.journalEntryId ? <> · JE <span className="font-mono">{reg.posted.journalEntryId.slice(0, 12)}…</span></> : null}
        </p>
        <nav className="mt-4 flex gap-3 text-sm">
          <Link href={`/app/admin/payroll/batches/${params.batchId}`} className="underline" style={{ color: "var(--spectre-text-secondary)" }}>← Payroll review</Link>
          <a href={`/api/pay/register/pdf/${params.batchId}`} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm" data-testid="register-pdf-link">Download PDF</a>
          <a href={`/api/pay/register/csv/${params.batchId}`} className="btn btn-secondary btn-sm" data-testid="register-csv-link">Download CSV</a>
        </nav>
      </header>

      {/* Employees table */}
      <div className="overflow-x-auto rounded-lg border" style={{ borderColor: "var(--spectre-border-muted)" }}>
        <table className="w-full text-xs" data-testid="payroll-register-table">
          <thead className="bg-stone-50">
            <tr className="border-b" style={{ borderColor: "var(--spectre-border-muted)" }}>
              {["Employee", "Dept", "Type", "Regular", "Other", "Taxable Benefits", "Gross",
                "CPP", "CPP2", "EI", "Fed Tax", "Prov Tax", "Other Ded", "RRSP EE", "Net Pay",
                "ER CPP", "ER CPP2", "ER EI", "ER Benefits", "RRSP ER", "Total ER Cost"]
                .map((h) => <th key={h} className="text-right px-2 py-2 text-[10px] font-semibold uppercase tracking-[0.04em] text-stone-600">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {reg.employees.map((r) => (
              <tr key={r.batchEmployeeId} data-testid={`register-row-${r.batchEmployeeId}`} className="border-b" style={{ borderColor: "var(--spectre-border-muted)" }}>
                <td className="text-left px-2 py-1.5">
                  <Link href={`/app/admin/payroll/batches/${params.batchId}/paystubs`} className="underline">{r.employeeName}</Link>
                  {r.employeeNumber && <div className="text-[10px] text-stone-500">{r.employeeNumber}</div>}
                </td>
                <td className="text-left px-2 py-1.5">{r.departmentCode}</td>
                <td className="text-left px-2 py-1.5">{r.payTypeLabel}</td>
                <td className="text-right px-2 py-1.5 font-mono">{usd(r.regularEarnings)}</td>
                <td className="text-right px-2 py-1.5 font-mono">{usd(r.otherEarnings)}</td>
                <td className="text-right px-2 py-1.5 font-mono">{usd(r.taxableBenefits)}</td>
                <td className="text-right px-2 py-1.5 font-mono font-semibold">{usd(r.grossCashEarnings)}</td>
                <td className="text-right px-2 py-1.5 font-mono">{usd(r.cpp)}</td>
                <td className="text-right px-2 py-1.5 font-mono">{usd(r.cpp2)}</td>
                <td className="text-right px-2 py-1.5 font-mono">{usd(r.ei)}</td>
                <td className="text-right px-2 py-1.5 font-mono">{usd(r.federalTax)}</td>
                <td className="text-right px-2 py-1.5 font-mono">{usd(r.provincialTax)}</td>
                <td className="text-right px-2 py-1.5 font-mono">{usd(r.otherDeductions)}</td>
                <td className="text-right px-2 py-1.5 font-mono">{usd(r.rrspEmployeeContribution)}</td>
                <td className="text-right px-2 py-1.5 font-mono font-semibold">{usd(r.netPay)}</td>
                <td className="text-right px-2 py-1.5 font-mono">{usd(r.employerCpp)}</td>
                <td className="text-right px-2 py-1.5 font-mono">{usd(r.employerCpp2)}</td>
                <td className="text-right px-2 py-1.5 font-mono">{usd(r.employerEi)}</td>
                <td className="text-right px-2 py-1.5 font-mono">{usd(r.employerBenefits)}</td>
                <td className="text-right px-2 py-1.5 font-mono">{usd(r.rrspEmployerContribution)}</td>
                <td className="text-right px-2 py-1.5 font-mono font-semibold">{usd(r.totalEmployerCost)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-stone-100 font-semibold" data-testid="payroll-register-totals">
            <tr>
              <td className="text-left px-2 py-2" colSpan={3}>TOTALS · {reg.employees.length} employee{reg.employees.length === 1 ? "" : "s"}</td>
              <td className="text-right px-2 py-2 font-mono">{usd(reg.totals.regularEarnings)}</td>
              <td className="text-right px-2 py-2 font-mono">{usd(reg.totals.otherEarnings)}</td>
              <td className="text-right px-2 py-2 font-mono">{usd(reg.totals.taxableBenefits)}</td>
              <td className="text-right px-2 py-2 font-mono">{usd(reg.totals.grossCashEarnings)}</td>
              <td className="text-right px-2 py-2 font-mono">{usd(reg.totals.cpp)}</td>
              <td className="text-right px-2 py-2 font-mono">{usd(reg.totals.cpp2)}</td>
              <td className="text-right px-2 py-2 font-mono">{usd(reg.totals.ei)}</td>
              <td className="text-right px-2 py-2 font-mono">{usd(reg.totals.federalTax)}</td>
              <td className="text-right px-2 py-2 font-mono">{usd(reg.totals.provincialTax)}</td>
              <td className="text-right px-2 py-2 font-mono">{usd(reg.totals.otherDeductions)}</td>
              <td className="text-right px-2 py-2 font-mono">{usd(reg.totals.rrspEmployeeContribution)}</td>
              <td className="text-right px-2 py-2 font-mono">{usd(reg.totals.netPay)}</td>
              <td className="text-right px-2 py-2 font-mono">{usd(reg.totals.employerCpp)}</td>
              <td className="text-right px-2 py-2 font-mono">{usd(reg.totals.employerCpp2)}</td>
              <td className="text-right px-2 py-2 font-mono">{usd(reg.totals.employerEi)}</td>
              <td className="text-right px-2 py-2 font-mono">{usd(reg.totals.employerBenefits)}</td>
              <td className="text-right px-2 py-2 font-mono">{usd(reg.totals.rrspEmployerContribution)}</td>
              <td className="text-right px-2 py-2 font-mono">{usd(reg.totals.totalEmployerCost)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* GL Reconciliation */}
      <section className="mt-6" data-testid="payroll-register-reconciliation">
        <h2 className="text-spectre-h3 font-semibold mb-2" style={{ color: "var(--spectre-text-primary)" }}>GL Reconciliation</h2>
        <div className="rounded border p-3 bg-white" style={{ borderColor: "var(--spectre-border-muted)" }}>
          <dl className="grid grid-cols-[max-content_1fr] md:grid-cols-[max-content_1fr_max-content_1fr] gap-x-6 gap-y-1 text-sm">
            <dt className="text-stone-500">Gross payroll</dt><dd className="font-mono text-stone-900">{usd(reg.reconciliation.grossPayroll)}</dd>
            <dt className="text-stone-500">Employee deductions</dt><dd className="font-mono text-stone-900">{usd(reg.reconciliation.employeeDeductions)}</dd>
            <dt className="text-stone-500">Net payroll</dt><dd className="font-mono text-stone-900">{usd(reg.reconciliation.netPayroll)}</dd>
            <dt className="text-stone-500">Employer payroll costs</dt><dd className="font-mono text-stone-900">{usd(reg.reconciliation.employerPayrollCosts)}</dd>
            <dt className="text-stone-500">GL debits</dt><dd className="font-mono text-stone-900">{usd(reg.reconciliation.glDebits)}</dd>
            <dt className="text-stone-500">GL credits</dt><dd className="font-mono text-stone-900">{usd(reg.reconciliation.glCredits)}</dd>
            <dt className="text-stone-500">Difference</dt>
            <dd className="font-mono" style={{ color: reg.reconciliation.differenceCents === 0 ? "#166534" : "#991b1b" }}>
              {(reg.reconciliation.differenceCents / 100).toFixed(2)} {reg.reconciliation.differenceCents === 0 ? " ✓" : " ⚠"}
            </dd>
          </dl>
          {reconcilerOk ? null : (
            <p className="mt-2 text-xs" style={{ color: "#991b1b" }}>
              Reconciliation difference is non-zero. The Preview journal does not equal the calculated payroll totals.
              A batch in this state MUST NOT post.
            </p>
          )}
        </div>
      </section>

      {/* Exception summary */}
      <section className="mt-6" data-testid="payroll-register-exceptions">
        <h2 className="text-spectre-h3 font-semibold mb-2" style={{ color: "var(--spectre-text-primary)" }}>Exception summary</h2>
        <div className="rounded border p-3 bg-white" style={{ borderColor: "var(--spectre-border-muted)" }}>
          <p className="text-sm">
            <span className="font-semibold text-red-800">{reg.exceptionSummary.blockerCount}</span> blocker{reg.exceptionSummary.blockerCount === 1 ? "" : "s"}
            {" · "}
            <span className="font-semibold text-amber-800">{reg.exceptionSummary.warningCount}</span> warning{reg.exceptionSummary.warningCount === 1 ? "" : "s"}
            {" · "}
            <span className="font-semibold text-stone-600">{reg.exceptionSummary.infoCount}</span> info
          </p>
          {reg.exceptionSummary.unresolvedBlockers.length > 0 && (
            <ul className="mt-2 text-xs space-y-1">
              {reg.exceptionSummary.unresolvedBlockers.map((b, i) => (
                <li key={i} className="text-red-800"><strong>{b.code}</strong>: {b.message}{b.employeeName ? ` — ${b.employeeName}` : ""}</li>
              ))}
            </ul>
          )}
          {reg.exceptionSummary.warnings.length > 0 && (
            <ul className="mt-2 text-xs space-y-1">
              {reg.exceptionSummary.warnings.map((w, i) => (
                <li key={i} className="text-amber-800"><strong>{w.code}</strong>: {w.message}{w.employeeName ? ` — ${w.employeeName}` : ""}</li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
