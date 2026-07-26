import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { budgetService } from "@/lib/ops";
import { isAppError } from "@/lib/errors";
import { Badge } from "@/components/Badge";
import { fmtMoney } from "@/lib/accounting/format";

async function upsertLineAction(budgetId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const accountNumber = String(formData.get("accountNumber") ?? "");
  const departmentCode = String(formData.get("departmentCode") ?? "");
  const monthlyAmounts = Array.from({ length: 12 }).map((_, i) => Number(formData.get(`m${i}`) ?? 0));
  try {
    await budgetService.upsertBudgetLine(p, budgetId, {
      accountNumber,
      departmentCode: departmentCode || null,
      monthlyAmounts,
    });
  } catch (err) { if (isAppError(err)) redirect(`/app/admin/ops/budgets/${budgetId}?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath(`/app/admin/ops/budgets/${budgetId}`);
}

const MONTHS = ["M01","M02","M03","M04","M05","M06","M07","M08","M09","M10","M11","M12"];

export default async function BudgetDetailPage({ params, searchParams }: { params: { id: string }; searchParams: { error?: string } }) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  let budget;
  try { budget = await budgetService.getBudget(p, params.id); }
  catch { notFound(); }
  if (!budget) notFound();

  const canEdit = hasPermission(p, budget.clubId, "budget:edit") && budget.status === "DRAFT";
  const [accounts, departments, variance] = await Promise.all([
    prisma.account.findMany({ where: { clubId: budget.clubId, isHeader: false, isActive: true }, orderBy: { accountNumber: "asc" } }),
    prisma.department.findMany({ where: { clubId: budget.clubId, isActive: true } }),
    budgetService.budgetVsActual(budget.clubId, budget.id),
  ]);

  return (
    <div>
      <Link href="/app/admin/ops/budgets" className="text-sm text-stone-500 hover:text-club-ink">← Budgets</Link>
      <div className="mt-3 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="page-title">{budget.name}</h1>
          <div className="mt-2 flex items-center gap-2">
            <Badge status={budget.status} /> · {budget.fiscalYear.label} · v{budget.version} · {budget.lines.length} lines
          </div>
        </div>
        <div className="text-right text-sm">
          <div>Budget YTD: <span className="font-medium">{fmtMoney(variance.totalBudget as unknown as number, { showZero: true })}</span></div>
          <div>Actual YTD: <span className="font-medium">{fmtMoney(variance.totalActual as unknown as number, { showZero: true })}</span></div>
          <div>Variance: <span className="font-medium">{fmtMoney(variance.totalVariance as unknown as number, { showZero: true })}</span></div>
        </div>
      </div>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <div className="mt-6 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">Variance — Budget vs Actual (YTD)</div>
        <table className="table-base">
          <thead><tr><th>Account</th><th>Dept</th><th className="text-right">Budget YTD</th><th className="text-right">Actual YTD</th><th className="text-right">Variance</th><th className="text-right">Var %</th></tr></thead>
          <tbody>
            {variance.rows.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-stone-500">No budget lines yet.</td></tr>}
            {variance.rows.map((r) => (
              <tr key={`${r.accountNumber}|${r.departmentName ?? "_"}`}>
                <td><span className="font-mono">{r.accountNumber}</span> · {r.accountName}</td>
                <td className="text-stone-600 text-xs">{r.departmentName ?? "—"}</td>
                <td className="text-right tabular-nums">{fmtMoney(r.budget as unknown as number, { showZero: true })}</td>
                <td className="text-right tabular-nums">{fmtMoney(r.actual as unknown as number, { showZero: true })}</td>
                <td className={"text-right tabular-nums " + ((r.variance as unknown as number) < 0 ? "text-red-700" : "")}>
                  {fmtMoney(r.variance as unknown as number, { showZero: true })}
                </td>
                <td className={"text-right text-xs " + (Math.abs(r.variancePct) > 10 ? "text-amber-700" : "text-stone-500")}>
                  {r.variancePct.toFixed(1)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canEdit && (
        <form action={upsertLineAction.bind(null, budget.id)} className="mt-6 card card-body space-y-3">
          <h2 className="section-title text-lg">Add / update budget line</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="label">Account</label>
              <select className="select" name="accountNumber" required>
                <option value="">— Select —</option>
                {accounts.map((a) => <option key={a.id} value={a.accountNumber}>{a.accountNumber} · {a.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Department</label>
              <select className="select" name="departmentCode">
                <option value="">— None —</option>
                {departments.map((d) => <option key={d.id} value={d.code}>{d.name}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-3 md:grid-cols-6 lg:grid-cols-12 gap-2">
            {MONTHS.map((m, i) => (
              <div key={m}>
                <label className="label text-xs">{m}</label>
                <input className="input font-mono text-xs" type="number" step="0.01" name={`m${i}`} defaultValue={0} />
              </div>
            ))}
          </div>
          <div className="flex justify-end"><button className="btn btn-primary">Save line</button></div>
        </form>
      )}
    </div>
  );
}
