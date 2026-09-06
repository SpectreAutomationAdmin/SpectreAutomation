// Payroll-3C-5 (2026-09-09) — employee portal single pay-statement view.
//
// Employee-facing render of the canonical PayStatementV2 DTO. Only
// POSTED statements are reachable; another employee's URL is refused
// via `buildEmployeePortalPayStatement`.
//
// Renders each of the six sections; hides sections with zero lines.
// Never surfaces raw enums, snapshot IDs, or CUSTOM_TEST codes.

import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import {
  buildEmployeePortalPayStatement,
  type PayStatementV2, type StatementSection,
} from "@/lib/payroll/pay-statement";
import { NotFoundError, ForbiddenError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fmtDate(iso: string): string {
  const d = new Date(iso);
  // Payroll-3C-3E: pin to UTC so calendar dates render on their true civil day.
  return d.toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

interface Props { params: { batchEmployeeId: string } }

export default async function EmployeePortalPayStatement({ params }: Props) {
  const principal = await getEmployeePortalPrincipal();
  if (!principal) redirect("/employee/login");

  let statement: PayStatementV2;
  try {
    statement = await buildEmployeePortalPayStatement({
      clubId: principal.clubId,
      employeeId: principal.employeeId,
      batchEmployeeId: params.batchEmployeeId,
    });
  } catch (err) {
    if (err instanceof NotFoundError || err instanceof ForbiddenError) notFound();
    throw err;
  }

  return (
    <div className="max-w-3xl" data-testid="portal-pay-statement">
      <nav className="mb-4 flex items-center justify-between text-xs">
        <Link href="/employee/pay" className="text-stone-500 underline">← All pay statements</Link>
        <a
          href={`/api/pay/pdf/${params.batchEmployeeId}`}
          className="rounded-sm border border-stone-300 px-3 py-1 text-[11px] font-semibold text-stone-700 hover:bg-stone-50"
          data-testid="portal-pay-pdf"
        >
          Download PDF
        </a>
      </nav>

      <header className="mb-6 border-b border-stone-200 pb-4">
        <h1 className="font-serif text-3xl text-club-ink">Pay statement</h1>
        <p className="mt-1 text-sm text-stone-500">
          {fmtDate(statement.header.payDateIso)} · period {fmtDate(statement.header.payPeriodStartIso)} – {fmtDate(statement.header.payPeriodEndInclusiveIso)}
        </p>
        <p className="mt-1 text-xs text-stone-500">
          {statement.header.clubName} · {statement.header.payGroupName}
        </p>
      </header>

      {statement.sections.map((sec) => sec.lines.length > 0 ? (
        <PortalSection key={sec.kind} section={sec} />
      ) : null)}

      <PortalBases bases={statement.statutoryBases} />

      <section className="mt-6 rounded-lg border border-stone-200 bg-white px-5 py-4">
        <PortalTotal label="Gross cash earnings" current={statement.totals.grossCashCurrent}      ytd={statement.totals.grossCashYtd} />
        <PortalTotal label="Employee deductions" current={statement.totals.employeeDeductionsCurrent} ytd={statement.totals.employeeDeductionsYtd} />
        <div className="mt-3 flex items-baseline justify-between border-t border-stone-200 pt-3">
          <span className="text-xs font-semibold uppercase tracking-wide text-stone-500">Net pay</span>
          <span className="text-2xl font-semibold tabular-nums text-club-ink" data-testid="portal-pay-net">
            ${statement.totals.netPayCurrent}
          </span>
        </div>
      </section>

      <footer className="mt-4 text-[11px] text-stone-500">
        {statement.disbursement.method}. Payment transmission not yet enabled.
      </footer>
    </div>
  );
}

function PortalSection({ section }: { section: StatementSection }) {
  return (
    <section className="mb-6" data-testid={`portal-section:${section.kind}`}>
      <div className="mb-1 flex items-baseline justify-between text-[11px] font-semibold uppercase tracking-[0.06em] text-stone-500">
        <span>{section.title}</span>
        <span className="tabular-nums">Current · YTD</span>
      </div>
      <table className="w-full text-sm">
        <tbody>
          {section.lines.map((l) => (
            <tr key={l.key}>
              <td className="py-1 text-stone-700">
                {l.label}
                {l.isOneTime ? (
                  <span className="ml-1 inline-block rounded-sm bg-amber-100 px-1 text-[9px] font-semibold uppercase text-amber-900">
                    One-time
                  </span>
                ) : null}
              </td>
              <td className="py-1 pr-3 text-right tabular-nums text-club-ink">${l.current}</td>
              <td className="py-1 text-right tabular-nums text-stone-500">${l.ytd}</td>
            </tr>
          ))}
          <tr className="border-t border-stone-200">
            <td className="pt-1 font-semibold text-stone-700">Section total</td>
            <td className="pt-1 pr-3 text-right font-semibold tabular-nums text-club-ink">${section.currentTotal}</td>
            <td className="pt-1 text-right font-semibold tabular-nums text-stone-500">${section.ytdTotal}</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

function PortalBases({ bases }: { bases: PayStatementV2["statutoryBases"] }) {
  return (
    <details className="mb-6 text-sm" data-testid="portal-bases">
      <summary className="cursor-pointer text-stone-500">Statutory bases</summary>
      <table className="mt-2 w-full text-sm">
        <tbody>
          <BaseRow label="Cash remuneration"     current={bases.cashCurrent}       ytd={bases.cashYtd} />
          <BaseRow label="Taxable remuneration"  current={bases.taxableCurrent}    ytd={bases.taxableYtd} />
          <BaseRow label="CPP pensionable"       current={bases.pensionableCurrent} ytd={bases.pensionableYtd} />
          <BaseRow label="EI insurable"          current={bases.insurableCurrent}  ytd={bases.insurableYtd} />
        </tbody>
      </table>
    </details>
  );
}

function BaseRow({ label, current, ytd }: { label: string; current: string; ytd: string }) {
  return (
    <tr>
      <td className="py-0.5 text-stone-700">{label}</td>
      <td className="py-0.5 pr-3 text-right tabular-nums">${current}</td>
      <td className="py-0.5 text-right tabular-nums text-stone-500">${ytd}</td>
    </tr>
  );
}

function PortalTotal({ label, current, ytd }: { label: string; current: string; ytd: string }) {
  return (
    <div className="flex items-baseline justify-between text-sm">
      <span className="text-stone-600">{label}</span>
      <span className="tabular-nums text-club-ink">
        ${current} <span className="ml-3 text-xs text-stone-500">${ytd} YTD</span>
      </span>
    </div>
  );
}
