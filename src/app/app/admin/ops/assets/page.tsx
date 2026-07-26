import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { assetService } from "@/lib/ops";
import { isAppError } from "@/lib/errors";
import { Badge } from "@/components/Badge";
import { fmtMoney } from "@/lib/accounting/format";
import { formatDate } from "@/lib/finance";

async function createAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try {
    await assetService.createAsset(p, clubId, {
      name: String(formData.get("name") ?? ""),
      categoryKey: String(formData.get("categoryKey") ?? "") || null,
      departmentCode: String(formData.get("departmentCode") ?? "") || null,
      acquisitionDate: String(formData.get("acquisitionDate") ?? ""),
      acquisitionCost: Number(formData.get("acquisitionCost") ?? 0),
      usefulLifeMonths: Number(formData.get("usefulLifeMonths") ?? 60),
      depreciationMethod: String(formData.get("depreciationMethod") ?? "STRAIGHT_LINE") as "STRAIGHT_LINE" | "DECLINING_BALANCE",
    });
  } catch (err) { if (isAppError(err)) redirect(`/app/admin/ops/assets?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/ops/assets");
}

async function runDepreciationAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  const periodLabel = String(formData.get("periodLabel") ?? "");
  try { await assetService.runDepreciation(p, clubId, periodLabel); }
  catch (err) { if (isAppError(err)) redirect(`/app/admin/ops/assets?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/ops/assets");
}

async function disposeAction(assetId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try {
    await assetService.disposeAsset(p, assetId, {
      disposalDate: String(formData.get("disposalDate") ?? new Date().toISOString().slice(0, 10)),
      method: String(formData.get("method") ?? "SALE") as "SALE" | "SCRAP" | "DONATION",
      proceeds: Number(formData.get("proceeds") ?? 0),
    });
  } catch (err) { if (isAppError(err)) redirect(`/app/admin/ops/assets?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/ops/assets");
}

export default async function AssetsPage({ searchParams }: { searchParams: { error?: string } }) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "assets:read")) redirect("/app/admin");
  const canManage = hasPermission(p, clubId, "assets:manage");
  const canDepreciate = hasPermission(p, clubId, "assets:depreciate");
  const canDispose = hasPermission(p, clubId, "assets:dispose");

  const [assets, categories, departments, recentDepreciation, openPeriod] = await Promise.all([
    assetService.listAssets(p, clubId),
    prisma.assetCategory.findMany({ where: { clubId, isActive: true } }),
    prisma.department.findMany({ where: { clubId, isActive: true } }),
    prisma.assetDepreciationEntry.findMany({ where: { clubId }, orderBy: { postedAt: "desc" }, take: 10, include: { asset: true } }),
    prisma.fiscalPeriod.findFirst({ where: { clubId, status: "OPEN", endDate: { lte: new Date() } }, orderBy: { startDate: "desc" } }),
  ]);

  return (
    <div>
      <h1 className="page-title">Capital Assets</h1>
      <p className="mt-1 text-stone-500">Asset register, depreciation engine, and disposals.</p>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Assets ({assets.length})</div>
          <table className="table-base">
            <thead><tr><th>#</th><th>Name</th><th>Category</th><th>Dept</th><th className="text-right">Cost</th><th className="text-right">Accum. Depr</th><th className="text-right">NBV</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {assets.length === 0 && <tr><td colSpan={9} className="px-4 py-6 text-center text-stone-500">No assets in the register yet.</td></tr>}
              {assets.map((a) => (
                <tr key={a.id}>
                  <td className="font-mono text-xs">{a.assetNumber}</td>
                  <td>{a.name}</td>
                  <td className="text-xs text-stone-500">{a.category?.name ?? "—"}</td>
                  <td className="text-xs text-stone-500">{a.department?.name ?? "—"}</td>
                  <td className="text-right tabular-nums">{fmtMoney(a.acquisitionCost as unknown as number)}</td>
                  <td className="text-right tabular-nums">{fmtMoney(a.accumulatedDepreciation as unknown as number)}</td>
                  <td className="text-right tabular-nums">{fmtMoney(a.netBookValue as unknown as number)}</td>
                  <td><Badge status={a.status} /></td>
                  <td className="text-right text-xs">
                    {canDispose && a.status === "ACTIVE" && (
                      <form action={disposeAction.bind(null, a.id)} className="inline-flex items-center gap-1">
                        <input className="input inline-block w-24 font-mono text-xs" type="number" step="0.01" min="0" name="proceeds" placeholder="Proceeds" />
                        <input type="hidden" name="disposalDate" value={new Date().toISOString().slice(0, 10)} />
                        <button className="text-red-600 hover:underline">Dispose</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="space-y-4">
          {canManage && (
            <form action={createAction} className="card card-body space-y-3">
              <h2 className="section-title text-lg">Add asset</h2>
              <div><label className="label">Name</label><input className="input" name="name" required maxLength={200} /></div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="label">Category</label>
                  <select className="select" name="categoryKey">
                    <option value="">— None —</option>
                    {categories.map((c) => <option key={c.id} value={c.key}>{c.name}</option>)}
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
              <div className="grid grid-cols-2 gap-2">
                <div><label className="label">Acq date</label><input className="input" type="date" name="acquisitionDate" required /></div>
                <div><label className="label">Cost</label><input className="input font-mono" type="number" step="0.01" min="0" name="acquisitionCost" required /></div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div><label className="label">Useful life (mo)</label><input className="input" type="number" min="1" name="usefulLifeMonths" defaultValue={60} /></div>
                <div>
                  <label className="label">Method</label>
                  <select className="select" name="depreciationMethod">
                    <option value="STRAIGHT_LINE">Straight line</option>
                    <option value="DECLINING_BALANCE">Declining balance</option>
                  </select>
                </div>
              </div>
              <button className="btn btn-primary">Create</button>
            </form>
          )}

          {canDepreciate && openPeriod && (
            <form action={runDepreciationAction} className="card card-body">
              <h2 className="section-title text-lg">Run monthly depreciation</h2>
              <p className="mt-1 text-sm text-stone-500">Idempotent on (asset, period). Skipped if already posted for the period.</p>
              <select className="select mt-3" name="periodLabel" defaultValue={openPeriod.label}>
                <option value={openPeriod.label}>{openPeriod.label}</option>
              </select>
              <button className="btn btn-primary mt-3 w-full">Run depreciation</button>
            </form>
          )}
        </div>
      </div>

      <div className="mt-8 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">Recent depreciation entries</div>
        <table className="table-base">
          <thead><tr><th>Posted</th><th>Asset</th><th>Period</th><th className="text-right">Amount</th><th className="text-right">Accumulated</th></tr></thead>
          <tbody>
            {recentDepreciation.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-stone-500">None yet.</td></tr>}
            {recentDepreciation.map((d) => (
              <tr key={d.id}>
                <td>{formatDate(d.postedAt)}</td>
                <td>{d.asset.assetNumber} · {d.asset.name}</td>
                <td className="font-mono text-xs">{d.periodLabel}</td>
                <td className="text-right tabular-nums">{fmtMoney(d.amount as unknown as number)}</td>
                <td className="text-right tabular-nums">{fmtMoney(d.accumulatedAfter as unknown as number)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
