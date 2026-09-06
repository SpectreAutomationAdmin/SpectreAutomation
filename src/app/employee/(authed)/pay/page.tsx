// Payroll-3C-5 (2026-09-09) — employee portal Pay list.
//
// Lists POSTED pay statements for the signed-in employee. Only
// tenants + own employee are listed (see listEmployeePostedPayStatements).
//
// Employee-facing chrome — no raw internal enums or IDs.

import { redirect } from "next/navigation";
import Link from "next/link";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import { listEmployeePostedPayStatements } from "@/lib/payroll/pay-statement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fmtDate(iso: string): string {
  const d = new Date(iso);
  // Payroll-3C-3E: pin to UTC so calendar dates render on their true
  // civil day regardless of viewer timezone.
  return d.toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

export default async function EmployeePortalPayPage() {
  const principal = await getEmployeePortalPrincipal();
  if (!principal) redirect("/employee/login");

  const statements = await listEmployeePostedPayStatements({
    clubId: principal.clubId, employeeId: principal.employeeId,
  });

  return (
    <div data-testid="portal-pay" className="max-w-3xl">
      <h1 className="font-serif text-3xl text-club-ink">Pay</h1>
      <p className="mt-2 text-sm text-stone-500">
        Your pay statements from each payroll your Club has posted.
      </p>

      {statements.length === 0 ? (
        <div
          className="mt-8 rounded-lg border border-dashed border-stone-300 bg-white px-6 py-10 text-center"
          data-testid="portal-pay-empty"
        >
          <p className="text-sm text-stone-600">
            No pay statements are available yet.
          </p>
          <p className="mt-2 text-xs text-stone-500">
            Once your Club processes your first pay period, your statement will appear here.
          </p>
        </div>
      ) : (
        <ul className="mt-6 space-y-2" data-testid="portal-pay-list">
          {statements.map((s) => (
            <li key={s.batchEmployeeId}>
              <Link
                href={`/employee/pay/${s.batchEmployeeId}`}
                className="flex items-center justify-between rounded-lg border border-stone-200 bg-white px-4 py-3 hover:border-stone-400"
                data-testid={`portal-pay-row:${s.batchEmployeeId}`}
              >
                <div>
                  <div className="text-sm font-medium text-club-ink">{fmtDate(s.payDateIso)}</div>
                  <div className="text-xs text-stone-500">
                    {fmtDate(s.payPeriodStartIso)} – {fmtDate(s.payPeriodEndInclusiveIso)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm tabular-nums text-club-ink">Net ${s.netPay}</div>
                  <div className="text-[10px] text-stone-500 tabular-nums">Gross ${s.grossPay}</div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
