// Payroll-3C-5 (2026-09-09) — admin Payroll History landing page.
//
// Lists POSTED payroll batches for the current Club with pay date,
// period, pay group, employee count, gross/net totals. Click into
// batch review or straight to pay statements.

import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { getActiveClubId } from "@/lib/active-club";
import { listPostedPayrollHistory } from "@/lib/payroll/pay-statement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fmtDate(iso: string): string {
  const d = new Date(iso);
  // Payroll-3C-3E: pin to UTC so calendar dates render on their true civil day.
  return d.toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

export default async function PayrollHistoryPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId    = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, clubId, "payroll:read")) redirect("/app/admin");

  const history = await listPostedPayrollHistory(principal, clubId);

  return (
    <div className="max-w-[1200px]" data-testid="payroll-history-page">
      <header className="mb-spectre-6">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em]"
             style={{ color: "var(--spectre-text-muted)" }}>
          Operations · Payroll · History
        </div>
        <h1 className="mt-1 text-spectre-h1 font-semibold"
            style={{ color: "var(--spectre-text-primary)" }}>
          Payroll history
        </h1>
        <p className="mt-2 text-spectre-body"
           style={{ color: "var(--spectre-text-secondary)" }}>
          Every payroll POSTED to accounting. Click a row to open pay statements.
        </p>
        <nav className="mt-4 flex gap-3 text-sm">
          <Link href="/app/admin/payroll/process"
                className="underline"
                style={{ color: "var(--spectre-text-secondary)" }}>
            ← Payroll processing
          </Link>
        </nav>
      </header>

      {history.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm"
             style={{ borderColor: "var(--spectre-border-muted)", color: "var(--spectre-text-secondary)" }}
             data-testid="payroll-history-empty">
          No POSTED payroll batches yet. Prepare, calculate, approve, and post a batch to see it here.
        </div>
      ) : (
        <section
          className="overflow-hidden rounded-lg border"
          style={{ borderColor: "var(--spectre-border-muted)", background: "var(--spectre-surface)" }}
          data-testid="payroll-history-list"
        >
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] font-semibold uppercase tracking-[0.06em]"
                  style={{ color: "var(--spectre-text-muted)" }}>
                <th className="px-4 py-2">Pay date</th>
                <th className="px-4 py-2">Period</th>
                <th className="px-4 py-2">Pay group</th>
                <th className="px-4 py-2 text-right">Employees</th>
                <th className="px-4 py-2 text-right">Gross</th>
                <th className="px-4 py-2 text-right">Net</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.batchId} className="border-t"
                    style={{ borderColor: "var(--spectre-border-muted)" }}
                    data-testid={`payroll-history-row:${h.batchId}`}>
                  <td className="px-4 py-2 tabular-nums">{fmtDate(h.payDateIso)}</td>
                  <td className="px-4 py-2 tabular-nums">
                    {fmtDate(h.payPeriodStartIso)} – {fmtDate(h.payPeriodEndInclusiveIso)}
                  </td>
                  <td className="px-4 py-2">{h.payGroupName}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{h.employeeCount}</td>
                  <td className="px-4 py-2 text-right tabular-nums">${h.grossPayrollTotal}</td>
                  <td className="px-4 py-2 text-right tabular-nums">${h.netPayrollTotal}</td>
                  <td className="px-4 py-2 text-right">
                    <Link href={`/app/admin/payroll/batches/${h.batchId}/paystubs`}
                          className="underline"
                          style={{ color: "var(--spectre-text-secondary)" }}
                          data-testid={`payroll-history-open:${h.batchId}`}>
                      Statements →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
