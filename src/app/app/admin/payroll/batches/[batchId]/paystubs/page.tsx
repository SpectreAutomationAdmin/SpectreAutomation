// Payroll-3C-5 (2026-09-09) — pay-statement viewer refactored onto
// the canonical PayStatementV2 DTO.
//
// One card per employee in the batch. Each card renders six sections
// (Earnings / Reimbursements / Taxable benefits / Statutory
// deductions / Other deductions / Employer benefits & contributions),
// Current + YTD, statutory bases, and net pay. Sections with zero
// lines are omitted so simple salary-only stubs stay clean.
//
// Reads only frozen batch facts + coarse YTD + component YTD.

import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { getActiveClubId } from "@/lib/active-club";
import { prisma } from "@/lib/prisma";
import { buildPayStatement, type PayStatementV2, type StatementSection } from "@/lib/payroll/pay-statement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Props { params: { batchId: string } }

function fmtDate(iso: string): string {
  const d = new Date(iso);
  // Payroll-3C-3E: pin to UTC so a UTC-midnight-stored calendar date
  // (e.g. periodEnd = 2026-09-01T00:00:00Z) does not display as the
  // previous day in negative-UTC viewers (Mountain, Pacific, etc.).
  return d.toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

export default async function PayStatementsPage({ params }: Props) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId    = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, clubId, "payroll:read")) redirect("/app/admin");

  const batchEmployees = await prisma.payrollBatchEmployee.findMany({
    where: { clubId, batchId: params.batchId },
    include: { employee: { select: { lastName: true, firstName: true } } },
    orderBy: [{ employee: { lastName: "asc" } }, { employee: { firstName: "asc" } }],
  });
  const statements: PayStatementV2[] = [];
  for (const be of batchEmployees) {
    statements.push(await buildPayStatement(principal, clubId, be.id));
  }
  const first = statements[0];

  return (
    <div className="max-w-[1200px]" data-testid="paystubs-page">
      <header className="mb-spectre-6">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em]"
             style={{ color: "var(--spectre-text-muted)" }}>
          Operations · Payroll · Pay statements
        </div>
        <h1 className="mt-1 text-spectre-h1 font-semibold"
            style={{ color: "var(--spectre-text-primary)" }}>
          Pay statements · {statements.length} employee{statements.length === 1 ? "" : "s"}
        </h1>
        {first ? (
          <p className="mt-2 text-spectre-body"
             style={{ color: "var(--spectre-text-secondary)" }}>
            Pay date {fmtDate(first.header.payDateIso)} · period {fmtDate(first.header.payPeriodStartIso)} – {fmtDate(first.header.payPeriodEndInclusiveIso)}
            {first.isPosted ? " · Posted" : ` · Batch status ${first.status}`}
          </p>
        ) : null}
        <nav className="mt-4 flex gap-3 text-sm">
          <Link href={`/app/admin/payroll/batches/${params.batchId}`}
                className="underline"
                style={{ color: "var(--spectre-text-secondary)" }}>
            ← Payroll review
          </Link>
          <Link href="/app/admin/payroll/history"
                className="underline"
                style={{ color: "var(--spectre-text-secondary)" }}>
            Payroll history
          </Link>
        </nav>
      </header>

      {statements.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm"
             style={{ borderColor: "var(--spectre-border-muted)", color: "var(--spectre-text-secondary)" }}>
          No pay statements exist for this batch yet.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          {statements.map((s) => <PayStatementCard key={s.batchEmployeeId} s={s} />)}
        </div>
      )}
    </div>
  );
}

function PayStatementCard({ s }: { s: PayStatementV2 }) {
  return (
    <article
      className="rounded-lg border p-5 print:break-inside-avoid"
      style={{ borderColor: "var(--spectre-border-muted)", background: "var(--spectre-surface)" }}
      data-testid="paystub-card"
      data-employee-id={s.header.employeeId}
      data-employee-name={s.header.employeeName}
    >
      <header className="mb-3 border-b pb-2" style={{ borderColor: "var(--spectre-border-muted)" }}>
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em]"
             style={{ color: "var(--spectre-text-muted)" }}>
          {s.header.clubName}
        </div>
        <div className="flex items-baseline justify-between">
          <div className="text-base font-semibold" style={{ color: "var(--spectre-text-primary)" }}>
            {s.header.employeeName}
          </div>
          <a
            href={`/api/pay/pdf/${s.batchEmployeeId}`}
            className="text-[10px] font-semibold uppercase tracking-wide underline"
            style={{ color: "var(--spectre-text-secondary)" }}
            data-testid={`paystub-pdf:${s.batchEmployeeId}`}
          >
            PDF
          </a>
        </div>
        <div className="text-xs" style={{ color: "var(--spectre-text-secondary)" }}>
          {s.header.employeeNumber ?? "—"} · {s.header.payGroupName}
        </div>
      </header>

      <dl className="mb-3 grid grid-cols-2 gap-y-1 text-xs">
        <dt className="text-[color:var(--spectre-text-secondary)]">Pay date</dt>
        <dd className="text-right tabular-nums">{fmtDate(s.header.payDateIso)}</dd>
        <dt className="text-[color:var(--spectre-text-secondary)]">Period</dt>
        <dd className="text-right tabular-nums">
          {fmtDate(s.header.payPeriodStartIso)} – {fmtDate(s.header.payPeriodEndInclusiveIso)}
        </dd>
      </dl>

      {s.sections.map((sec) => sec.lines.length > 0 ? (
        <StatementSectionBlock key={sec.kind} section={sec} />
      ) : null)}

      <StatementBases bases={s.statutoryBases} />

      <div className="mt-4 border-t pt-3" style={{ borderColor: "var(--spectre-border-muted)" }}>
        <TotalRow label="Gross cash earnings" current={s.totals.grossCashCurrent} ytd={s.totals.grossCashYtd} />
        <TotalRow label="Employee deductions" current={s.totals.employeeDeductionsCurrent} ytd={s.totals.employeeDeductionsYtd} />
        <div className="mt-2 flex items-baseline justify-between border-t pt-2"
             style={{ borderColor: "var(--spectre-border-muted)" }}>
          <span className="text-xs font-semibold uppercase tracking-wide"
                style={{ color: "var(--spectre-text-muted)" }}>Net pay</span>
          <span className="text-lg font-semibold tabular-nums"
                style={{ color: "var(--spectre-text-primary)" }}
                data-testid="paystub-net-pay">${s.totals.netPayCurrent}</span>
        </div>
      </div>

      <footer className="mt-3 border-t pt-2 text-[10px]"
              style={{ borderColor: "var(--spectre-border-muted)", color: "var(--spectre-text-muted)" }}>
        {s.disbursement.method}. Payment transmission not yet enabled.
        {s.posted.postedAtIso ? ` · Posted ${new Date(s.posted.postedAtIso).toLocaleString("en-CA")}` : ` · ${s.status}`}
      </footer>
    </article>
  );
}

function StatementSectionBlock({ section }: { section: StatementSection }) {
  return (
    <section className="mt-3" data-testid={`paystub-section:${section.kind}`}>
      <div className="mb-1 flex items-baseline justify-between text-[10px] font-semibold uppercase tracking-[0.06em]"
           style={{ color: "var(--spectre-text-muted)" }}>
        <span>{section.title}</span>
        <span className="tabular-nums">Current · YTD</span>
      </div>
      <table className="w-full text-xs">
        <tbody>
          {section.lines.map((l) => (
            <tr key={l.key}>
              <td className="py-0.5 text-[color:var(--spectre-text-secondary)]">
                {l.label}
                {l.isOneTime ? (
                  <span className="ml-1 inline-block rounded-sm px-1 text-[9px] font-semibold uppercase"
                        style={{ background: "#fef3c7", color: "#78350f" }}>
                    One-time
                  </span>
                ) : null}
              </td>
              <td className="py-0.5 pr-2 text-right tabular-nums"
                  style={{ color: "var(--spectre-text-primary)" }}>${l.current}</td>
              <td className="py-0.5 text-right tabular-nums"
                  style={{ color: "var(--spectre-text-secondary)" }}>${l.ytd}</td>
            </tr>
          ))}
          <tr className="border-t" style={{ borderColor: "var(--spectre-border-muted)" }}>
            <td className="pt-1 text-[color:var(--spectre-text-secondary)] font-semibold">Section total</td>
            <td className="pt-1 pr-2 text-right font-semibold tabular-nums"
                style={{ color: "var(--spectre-text-primary)" }}>${section.currentTotal}</td>
            <td className="pt-1 text-right font-semibold tabular-nums"
                style={{ color: "var(--spectre-text-secondary)" }}>${section.ytdTotal}</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

function StatementBases({ bases }: { bases: PayStatementV2["statutoryBases"] }) {
  return (
    <details className="mt-3 text-xs" data-testid="paystub-bases">
      <summary className="cursor-pointer" style={{ color: "var(--spectre-text-secondary)" }}>
        Statutory bases
      </summary>
      <table className="mt-1 w-full text-xs">
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
      <td className="py-0.5 text-[color:var(--spectre-text-secondary)]">{label}</td>
      <td className="py-0.5 pr-2 text-right tabular-nums">${current}</td>
      <td className="py-0.5 text-right tabular-nums" style={{ color: "var(--spectre-text-secondary)" }}>${ytd}</td>
    </tr>
  );
}

function TotalRow({ label, current, ytd }: { label: string; current: string; ytd: string }) {
  return (
    <div className="flex items-baseline justify-between text-xs">
      <span style={{ color: "var(--spectre-text-secondary)" }}>{label}</span>
      <span className="tabular-nums" style={{ color: "var(--spectre-text-primary)" }}>
        ${current} <span className="ml-2" style={{ color: "var(--spectre-text-secondary)" }}>${ytd} YTD</span>
      </span>
    </div>
  );
}
