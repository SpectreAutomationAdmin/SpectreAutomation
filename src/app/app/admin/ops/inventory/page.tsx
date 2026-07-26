import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { listItems, lowStockItems, totalInventoryValuation, postReceiving, postAdjustment } from "@/lib/ops/inventory";
import { isAppError } from "@/lib/errors";
import { fmtMoney } from "@/lib/accounting/format";

async function quickReceiveAction(itemId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try {
    await postReceiving(p, clubId, {
      lines: [{ itemId, quantity: Number(formData.get("quantity") ?? 0), unitCost: Number(formData.get("unitCost") ?? 0) }],
    });
  } catch (err) { if (isAppError(err)) redirect(`/app/admin/ops/inventory?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/ops/inventory");
}

async function quickAdjustAction(itemId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try {
    await postAdjustment(p, clubId, {
      itemId,
      quantityChange: Number(formData.get("quantityChange") ?? 0),
      reasonCode: String(formData.get("reasonCode") ?? "RECOUNT"),
      notes: String(formData.get("notes") ?? ""),
    });
  } catch (err) { if (isAppError(err)) redirect(`/app/admin/ops/inventory?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/ops/inventory");
}

export default async function InventoryPage({ searchParams }: { searchParams: { error?: string } }) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "inventory:view")) redirect("/app/admin");
  const canReceive = hasPermission(p, clubId, "inventory:receive");
  const canAdjust = hasPermission(p, clubId, "inventory:adjust");

  const [items, low, value, recentReceivings] = await Promise.all([
    listItems(p, clubId),
    lowStockItems(clubId),
    totalInventoryValuation(clubId),
    prisma.inventoryReceiving.findMany({ where: { clubId }, include: { vendor: true, lines: true }, orderBy: { receivedDate: "desc" }, take: 10 }),
  ]);

  return (
    <div>
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="page-title">Inventory</h1>
          <p className="mt-1 text-stone-500">{items.length} active items · {low.length} low-stock</p>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase tracking-wide text-stone-500">Total valuation (weighted average)</div>
          <div className="font-serif text-2xl">{fmtMoney(value as unknown as number, { showZero: true })}</div>
        </div>
      </div>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <div className="mt-6 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">Items</div>
        <table className="table-base">
          <thead><tr><th>SKU</th><th>Name</th><th>Category</th><th className="text-right">On hand</th><th className="text-right">Avg cost</th><th className="text-right">Retail</th><th>Actions</th></tr></thead>
          <tbody>
            {items.length === 0 && <tr><td colSpan={7} className="px-4 py-6 text-center text-stone-500">No inventory items yet.</td></tr>}
            {items.map((i) => {
              const isLow = Number(i.quantityOnHand.toString()) <= Number(i.reorderPoint.toString());
              return (
                <tr key={i.id} className={isLow ? "bg-amber-50/40" : ""}>
                  <td className="font-mono text-xs">{i.sku}</td>
                  <td>
                    <div className="font-medium">{i.name}</div>
                    {i.brand && <div className="text-xs text-stone-500">{i.brand}</div>}
                  </td>
                  <td className="text-stone-600 text-xs">{i.category?.name ?? "—"}</td>
                  <td className="text-right tabular-nums">{i.quantityOnHand.toString()}</td>
                  <td className="text-right tabular-nums">{fmtMoney(i.averageCost as unknown as number, { showZero: true })}</td>
                  <td className="text-right tabular-nums">{fmtMoney(i.retailPrice as unknown as number, { showZero: true })}</td>
                  <td className="text-right space-x-2 text-xs">
                    {canReceive && (
                      <form action={quickReceiveAction.bind(null, i.id)} className="inline-flex items-center gap-1">
                        <input className="input inline-block w-16 font-mono text-xs" type="number" step="0.01" min="0" name="quantity" placeholder="Qty" />
                        <input className="input inline-block w-20 font-mono text-xs" type="number" step="0.01" min="0" name="unitCost" placeholder="Cost" defaultValue={i.averageCost.toString()} />
                        <button className="text-club-green-700 hover:underline">Receive</button>
                      </form>
                    )}
                    {canAdjust && (
                      <form action={quickAdjustAction.bind(null, i.id)} className="inline-flex items-center gap-1">
                        <input className="input inline-block w-16 font-mono text-xs" type="number" step="0.01" name="quantityChange" placeholder="±" />
                        <select className="select inline-block w-32 text-xs" name="reasonCode">
                          <option>RECOUNT</option><option>SHRINKAGE</option><option>DAMAGE</option><option>WRITE_OFF</option><option>OTHER</option>
                        </select>
                        <button className="text-amber-700 hover:underline">Adjust</button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-8 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">Recent receivings</div>
        <table className="table-base">
          <thead><tr><th>Number</th><th>Vendor</th><th>Date</th><th>Status</th><th>Lines</th><th className="text-right">Total cost</th></tr></thead>
          <tbody>
            {recentReceivings.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-stone-500">No receivings yet.</td></tr>}
            {recentReceivings.map((r) => (
              <tr key={r.id}>
                <td className="font-mono text-xs">{r.receivingNumber}</td>
                <td>{r.vendor?.legalName ?? "—"}</td>
                <td className="text-xs text-stone-500">{new Date(r.receivedDate).toLocaleDateString()}</td>
                <td>{r.status}</td>
                <td>{r.lines.length}</td>
                <td className="text-right tabular-nums">{fmtMoney(r.totalReceivedCost as unknown as number, { showZero: true })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-6 text-xs text-stone-500">
        Items are valued at <em>weighted average cost</em>. A separate posting hits Goods Received Not Invoiced (2050) until the matching AP invoice clears it.
      </div>
    </div>
  );
}
