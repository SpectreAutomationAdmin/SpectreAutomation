import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { budgetService } from "@/lib/ops";
import { isAppError } from "@/lib/errors";
import { Badge } from "@/components/Badge";
import { fmtMoney } from "@/lib/accounting/format";

async function createBudgetAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try {
    await budgetService.createBudget(p, clubId, {
      fiscalYearId: String(formData.get("fiscalYearId") ?? ""),
      name: String(formData.get("name") ?? ""),
      version: Number(formData.get("version") ?? 1),
    });
  } catch (err) { if (isAppError(err)) redirect(`/app/admin/ops/budgets?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/ops/budgets");
}

async function approveAction(budgetId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await budgetService.approveBudget(p, budgetId); }
  catch (err) { if (isAppError(err)) redirect(`/app/admin/ops/budgets?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/ops/budgets");
}

async function activateAction(budgetId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await budgetService.activateBudget(p, budgetId); }
  catch (err) { if (isAppError(err)) redirect(`/app/admin/ops/budgets?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/ops/budgets");
}

export default async function BudgetsPage({ searchParams }: { searchParams: { error?: string } }) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "budget:read")) redirect("/app/admin");
  const canEdit = hasPermission(p, clubId, "budget:edit");
  const canApprove = hasPermission(p, clubId, "budget:approve");

  const [budgets, fiscalYears] = await Promise.all([
    budgetService.listBudgets(p, clubId),
    prisma.fiscalYear.findMany({ where: { clubId }, orderBy: { startDate: "desc" } }),
  ]);

  return (
    <div>
      <h1 className="page-title">Budgets &amp; Forecasts</h1>
      <p className="mt-1 text-stone-500">Annual budgets with department + account granularity. Variance compares to live GL activity.</p>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Budgets ({budgets.length})</div>
          <table className="table-base">
            <thead><tr><th>Name</th><th>Fiscal year</th><th>Version</th><th>Status</th><th>Lines</th><th></th></tr></thead>
            <tbody>
              {budgets.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-stone-500">No budgets yet.</td></tr>}
              {budgets.map((b) => (
                <tr key={b.id}>
                  <td><Link href={`/app/admin/ops/budgets/${b.id}`} className="hover:text-club-green-700">{b.name}</Link></td>
                  <td className="font-mono text-xs">{b.fiscalYear.label}</td>
                  <td>v{b.version}</td>
                  <td><Badge status={b.status} /></td>
                  <td>{b.lines.length}</td>
                  <td className="text-right text-xs space-x-2">
                    {canApprove && (b.status === "DRAFT" || b.status === "UNDER_REVIEW") && (
                      <form action={approveAction.bind(null, b.id)} className="inline"><button className="text-club-green-700 hover:underline">Approve</button></form>
                    )}
                    {canApprove && b.status === "APPROVED" && (
                      <form action={activateAction.bind(null, b.id)} className="inline"><button className="text-club-green-700 hover:underline">Activate</button></form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {canEdit && (
          <form action={createBudgetAction} className="card card-body h-fit space-y-3">
            <h2 className="section-title text-lg">New budget</h2>
            <div>
              <label className="label">Fiscal year</label>
              <select className="select" name="fiscalYearId" required>
                <option value="">— Select —</option>
                {fiscalYears.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Name</label>
              <input className="input" name="name" required placeholder="Operating Budget" />
            </div>
            <div>
              <label className="label">Version</label>
              <input className="input" type="number" name="version" defaultValue={1} min="1" />
            </div>
            <button className="btn btn-primary">Create budget</button>
          </form>
        )}
      </div>
    </div>
  );
}
