// FPP-1 (2026-09-20) §5 — Employee YTD Detail surface.
//
// Reached from Employee → Payroll → Year-to-Date Summary → View Full
// Details. Exposes PayrollComponent-level YTD (opening + POSTED batch
// contributions unioned exactly once by getEmployeeComponentYtd) grouped
// into human-readable buckets:
//
//   - Recurring earnings
//   - Other earnings
//   - Employee deductions
//   - Employer contributions
//
// The compact YTD Summary card on the Payroll tab is unchanged; this
// page is a companion detail view, not a replacement.

import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { getActiveClubId } from "@/lib/active-club";
import { assertTenantOwned } from "@/lib/services/tenant";
import { prisma } from "@/lib/prisma";
import { getEmployeePayrollYtd } from "@/lib/payroll/ytd";
import { getEmployeeComponentYtd, type ComponentYtdRow } from "@/lib/payroll/component-ytd";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams { params: { id: string } }

function fmtMoney(v: string | number | null | undefined): string {
  if (v == null) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `$${n.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function bucketFor(row: ComponentYtdRow): "recurring" | "other" | "eeDeduction" | "erContribution" {
  if (row.side === "EMPLOYER") return "erContribution";
  if (row.cashEffect === "DECREASES_NET_PAY") return "eeDeduction";
  // EMPLOYEE + INCREASES_NET_PAY|NO_NET_PAY_EFFECT: split recurring vs other by category.
  if (row.category === "REGULAR_EARNING") return "other";
  if (row.category === "ADDITIONAL_EARNING") return "recurring";
  if (row.category === "TAXABLE_BENEFIT") return "recurring";
  return "other";
}

export default async function EmployeeYtdDetailPage({ params }: RouteParams) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, clubId, "payroll:read")) redirect("/app/admin");

  const employee = await prisma.employee.findUnique({
    where: { id: params.id },
    select: { id: true, clubId: true, firstName: true, lastName: true, employeeNumber: true },
  });
  if (!employee) notFound();
  assertTenantOwned(employee, principal);

  const asOf = new Date();
  const [aggregate, componentYtd] = await Promise.all([
    getEmployeePayrollYtd(clubId, employee.id, asOf).catch(() => null),
    getEmployeeComponentYtd(clubId, employee.id, asOf).catch(() => null),
  ]);

  const rows = componentYtd ? Array.from(componentYtd.byKey.values()) : [];
  const groups = {
    recurring: rows.filter((r) => bucketFor(r) === "recurring"),
    other: rows.filter((r) => bucketFor(r) === "other"),
    eeDeduction: rows.filter((r) => bucketFor(r) === "eeDeduction"),
    erContribution: rows.filter((r) => bucketFor(r) === "erContribution"),
  };

  const sumOf = (rs: ComponentYtdRow[]) =>
    rs.reduce((acc, r) => acc + Number(r.ytdAmount ?? 0), 0).toFixed(2);

  return (
    <div className="max-w-[1100px]" data-testid="employee-ytd-detail-page">
      <header className="mb-6">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-stone-500">
          People · Employees · Payroll · Year-to-Date Detail
        </div>
        <h1 className="mt-1 text-2xl font-semibold text-stone-900">
          {employee.firstName} {employee.lastName}{" "}
          <span className="text-sm font-normal text-stone-500">
            ({employee.employeeNumber})
          </span>
        </h1>
        <p className="mt-1 text-sm text-stone-600">
          As of {asOf.toISOString().slice(0, 10)} — includes opening YTD balances
          {" "}(same-employer / adjustment kinds) plus every POSTED Spectre payroll,
          counted exactly once.
        </p>
        <nav className="mt-3 flex gap-3 text-sm">
          <Link
            href={`/app/admin/people/employees/${employee.id}?tab=payroll`}
            className="text-stone-700 hover:underline"
            data-testid="ytd-detail-back"
          >
            ← Back to Payroll tab
          </Link>
        </nav>
      </header>

      <section
        className="mb-6 rounded-lg border border-stone-200 bg-white p-5"
        data-testid="ytd-detail-aggregate"
      >
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-stone-500">
          Aggregate YTD (T4-facing)
        </h2>
        {aggregate ? (
          <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm sm:grid-cols-3">
            <YtdField label="Gross"       value={fmtMoney(aggregate.ytdGrossEarnings)} />
            <YtdField label="Taxable"     value={fmtMoney(aggregate.ytdTaxableEarnings)} />
            <YtdField label="Pensionable" value={fmtMoney(aggregate.ytdPensionableEarnings)} />
            <YtdField label="Insurable"   value={fmtMoney(aggregate.ytdInsurableEarnings)} />
            <YtdField label="CPP EE"      value={fmtMoney(aggregate.ytdCppEE)} />
            <YtdField label="CPP2 EE"     value={fmtMoney(aggregate.ytdCpp2EE)} />
            <YtdField label="EI EE"       value={fmtMoney(aggregate.ytdEiEE)} />
            <YtdField label="Federal tax" value={fmtMoney(aggregate.ytdFederalTax)} />
            <YtdField label="Prov. tax"   value={fmtMoney(aggregate.ytdProvincialTax)} />
            <YtdField label="Employer CPP"  value={fmtMoney(aggregate.ytdCppER)} />
            <YtdField label="Employer CPP2" value={fmtMoney(aggregate.ytdCpp2ER)} />
            <YtdField label="Employer EI"   value={fmtMoney(aggregate.ytdEiER)} />
          </div>
        ) : (
          <p className="text-sm text-stone-500">No aggregate YTD yet.</p>
        )}
      </section>

      <ComponentGroup
        title="Recurring earnings"
        testId="ytd-detail-recurring"
        rows={groups.recurring}
        subtotal={sumOf(groups.recurring)}
        emptyLabel="No recurring earnings recorded."
      />
      <ComponentGroup
        title="Other earnings"
        testId="ytd-detail-other-earnings"
        rows={groups.other}
        subtotal={sumOf(groups.other)}
        emptyLabel="No other earnings recorded."
      />
      <ComponentGroup
        title="Employee deductions"
        testId="ytd-detail-ee-deductions"
        rows={groups.eeDeduction}
        subtotal={sumOf(groups.eeDeduction)}
        emptyLabel="No employee-side deductions recorded."
      />
      <ComponentGroup
        title="Employer contributions"
        testId="ytd-detail-er-contributions"
        rows={groups.erContribution}
        subtotal={sumOf(groups.erContribution)}
        emptyLabel="No employer contributions recorded."
      />
    </div>
  );
}

function YtdField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-xs text-stone-500">{label}</span>
      <span className="font-mono text-sm text-stone-900">{value}</span>
    </div>
  );
}

function ComponentGroup(props: {
  title: string;
  testId: string;
  rows: ComponentYtdRow[];
  subtotal: string;
  emptyLabel: string;
}) {
  return (
    <section
      className="mb-6 rounded-lg border border-stone-200 bg-white p-5"
      data-testid={props.testId}
    >
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
          {props.title}
        </h2>
        <span className="font-mono text-sm text-stone-900" data-testid={`${props.testId}-subtotal`}>
          {fmtMoney(props.subtotal)}
        </span>
      </div>
      {props.rows.length === 0 ? (
        <p className="text-xs text-stone-500 italic">{props.emptyLabel}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-stone-500">
              <th className="pb-1">Component</th>
              <th className="pb-1">Classification</th>
              <th className="pb-1 text-right">YTD</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {props.rows.map((r) => (
              <tr key={`${props.testId}-${r.componentCode}`} data-testid={`${props.testId}-row-${r.componentCode}`}>
                <td className="py-1.5">
                  <div className="text-stone-900">{r.displayName}</div>
                  <div className="font-mono text-[10px] text-stone-500">{r.componentCode}</div>
                </td>
                <td className="py-1.5 text-stone-600">{r.category}</td>
                <td className="py-1.5 text-right font-mono text-stone-900">{fmtMoney(r.ytdAmount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
