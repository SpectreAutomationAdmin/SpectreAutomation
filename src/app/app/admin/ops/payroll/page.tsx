import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { payrollService } from "@/lib/ops";
import { isAppError } from "@/lib/errors";
import { Badge } from "@/components/Badge";
import { fmtMoney } from "@/lib/accounting/format";
import { formatDate } from "@/lib/finance";

async function createPeriodAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try {
    await payrollService.createPeriod(p, clubId, {
      label: String(formData.get("label") ?? ""),
      startDate: String(formData.get("startDate") ?? ""),
      endDate: String(formData.get("endDate") ?? ""),
      payDate: String(formData.get("payDate") ?? ""),
    });
  } catch (err) { if (isAppError(err)) redirect(`/app/admin/ops/payroll?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/ops/payroll");
}

async function lockPeriodAction(periodId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await payrollService.lockPeriod(p, periodId); }
  catch (err) { if (isAppError(err)) redirect(`/app/admin/ops/payroll?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/ops/payroll");
}

async function buildRunAction(periodId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try { await payrollService.buildRun(p, clubId, periodId); }
  catch (err) { if (isAppError(err)) redirect(`/app/admin/ops/payroll?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/ops/payroll");
}

async function postRunAction(runId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await payrollService.postRun(p, runId); }
  catch (err) { if (isAppError(err)) redirect(`/app/admin/ops/payroll?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/ops/payroll");
}

export default async function PayrollPage({ searchParams }: { searchParams: { error?: string } }) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "payroll:read")) redirect("/app/admin");
  const canRun = hasPermission(p, clubId, "payroll:run");

  const [employees, periods, runs] = await Promise.all([
    payrollService.listEmployees(p, clubId),
    payrollService.listPeriods(p, clubId),
    prisma.payrollRun.findMany({ where: { clubId }, include: { period: true, lines: true }, orderBy: { createdAt: "desc" }, take: 10 }),
  ]);

  return (
    <div>
      <h1 className="page-title">Payroll</h1>
      <p className="mt-1 text-stone-500">
        Employees, pay periods, runs, and GL posting. Tax calculation is a configurable placeholder (currently a flat {Math.round(0.22 * 100)}% withholding) — production deployments must wire a payroll-provider adapter.
      </p>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between">
            <div className="font-medium">Employees ({employees.length})</div>
            <Link href="/app/admin/ops/payroll/employees" className="text-xs text-club-green-700 hover:underline">Manage →</Link>
          </div>
          <table className="table-base">
            <thead><tr><th>#</th><th>Name</th><th>Department</th><th>Position</th><th>Type</th><th className="text-right">Pay rate</th></tr></thead>
            <tbody>
              {employees.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-stone-500">No employees yet.</td></tr>}
              {employees.slice(0, 12).map((e) => (
                <tr key={e.id}>
                  <td className="font-mono text-xs">{e.employeeNumber}</td>
                  <td>{e.firstName} {e.lastName}</td>
                  <td className="text-stone-600 text-xs">{e.department?.name ?? "—"}</td>
                  <td className="text-stone-600 text-xs">{e.position?.name ?? "—"}</td>
                  <td className="text-xs">{e.compensationType}</td>
                  <td className="text-right tabular-nums">{fmtMoney(e.payRate as unknown as number, { showZero: true })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {canRun && (
          <form action={createPeriodAction} className="card card-body h-fit space-y-3">
            <h2 className="section-title text-lg">New pay period</h2>
            <div>
              <label className="label">Label</label>
              <input className="input" name="label" placeholder="2026-PP05" required maxLength={40} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div><label className="label">Start</label><input className="input" type="date" name="startDate" required /></div>
              <div><label className="label">End</label><input className="input" type="date" name="endDate" required /></div>
            </div>
            <div>
              <label className="label">Pay date</label>
              <input className="input" type="date" name="payDate" required />
            </div>
            <button className="btn btn-primary">Create period</button>
          </form>
        )}
      </div>

      <div className="mt-8 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">Pay periods</div>
        <table className="table-base">
          <thead><tr><th>Label</th><th>Range</th><th>Pay date</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {periods.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-stone-500">No periods configured.</td></tr>}
            {periods.map((per) => (
              <tr key={per.id}>
                <td className="font-mono text-xs">{per.label}</td>
                <td>{formatDate(per.startDate)} – {formatDate(per.endDate)}</td>
                <td>{formatDate(per.payDate)}</td>
                <td><Badge status={per.status} /></td>
                <td className="text-right space-x-2 text-xs">
                  {canRun && per.status === "OPEN" && (
                    <form action={lockPeriodAction.bind(null, per.id)} className="inline">
                      <button className="text-amber-700 hover:underline">Lock</button>
                    </form>
                  )}
                  {canRun && (per.status === "LOCKED" || per.status === "OPEN") && (
                    <form action={buildRunAction.bind(null, per.id)} className="inline">
                      <button className="text-club-green-700 hover:underline">Build run</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-8 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">Recent runs</div>
        <table className="table-base">
          <thead><tr><th>Run #</th><th>Period</th><th>Status</th><th className="text-right">Gross</th><th className="text-right">Taxes</th><th className="text-right">Net</th><th>Lines</th><th></th></tr></thead>
          <tbody>
            {runs.length === 0 && <tr><td colSpan={8} className="px-4 py-6 text-center text-stone-500">No runs yet.</td></tr>}
            {runs.map((r) => (
              <tr key={r.id}>
                <td className="font-mono text-xs">{r.runNumber}</td>
                <td>{r.period.label}</td>
                <td><Badge status={r.status} /></td>
                <td className="text-right tabular-nums">{fmtMoney(r.totalGross as unknown as number, { showZero: true })}</td>
                <td className="text-right tabular-nums">{fmtMoney(r.totalTaxes as unknown as number, { showZero: true })}</td>
                <td className="text-right tabular-nums">{fmtMoney(r.totalNet as unknown as number, { showZero: true })}</td>
                <td>{r.lines.length}</td>
                <td className="text-right text-xs">
                  {canRun && (r.status === "DRAFT" || r.status === "APPROVED") && (
                    <form action={postRunAction.bind(null, r.id)} className="inline">
                      <button className="text-club-green-700 hover:underline">Post to GL</button>
                    </form>
                  )}
                  {r.postedJournalEntryId && (
                    <Link href={`/app/admin/gl/${r.postedJournalEntryId}`} className="text-club-green-700 hover:underline ml-2">JE →</Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-6 text-xs text-stone-500">
        Posting: DR wage expense (per dept) → CR Accrued Source Deductions (2040) + Accrued Payroll (2030). Remittances are settled through the AP module (DR accrual / CR AP control on invoice post).
      </div>
    </div>
  );
}
