import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { isAppError } from "@/lib/errors";
import { listSales, refundSale } from "@/lib/pos";
import { Badge } from "@/components/Badge";
import { fmtMoney } from "@/lib/accounting/format";
import { formatDate } from "@/lib/finance";

// POS sales history + refund surface.
//
// This page is for managers reviewing what's already been settled —
// every completed POSSale across every POS location (lounge, dining,
// pro shop) shows up here. It is intentionally NOT an entry point
// for ringing up new sales — the lounge POS lives at
// /app/admin/ops/pos/lounge, and pro-shop / dining POS UIs land in
// their own routes when they ship.
//
// The only mutating action on this page is `refundSale`, gated by
// `inventory:write` (matches the existing pattern used by the lounge
// POS settle path).

async function refundAction(saleId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  try {
    await refundSale(p, saleId, { reason: String(formData.get("reason") ?? "") || undefined });
  } catch (err) {
    if (isAppError(err)) {
      redirect(`/app/admin/ops/pos?error=${encodeURIComponent(err.safeMessage)}`);
    }
    throw err;
  }
  revalidatePath("/app/admin/ops/pos");
}

export default async function PosSalesHistoryPage({ searchParams }: { searchParams: { error?: string } }) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "inventory:read")) redirect("/app/admin");
  const canRefund = hasPermission(p, clubId, "inventory:write");

  const sales = await listSales(p, clubId);

  return (
    <div>
      <Link href="/app/admin/ops" className="text-sm text-stone-500 hover:text-club-ink">
        ← Operations
      </Link>
      <div className="mt-3 flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="page-title">POS sales history</h1>
          <p className="mt-1 text-stone-500">
            Every settled sale across the club&rsquo;s POS locations. Use this page to look up a receipt or issue a refund.
          </p>
        </div>
      </div>

      {/* Primary + secondary POS entry points. Floor Map POS is the
          canonical seated-dining workflow (server → floor map → click
          table → seat view). Quick Sale / Bar is the legacy tableless
          ringup, kept for bar / to-go / no-table transactions. */}
      <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Link
          href="/app/admin/hospitality/reservations/floor"
          className="card card-body lg:col-span-2 border-2 border-club-green-600 hover:shadow-elevated transition-shadow"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-widest text-club-green-700 font-semibold">Primary workflow</div>
              <div className="mt-1 font-serif text-xl text-club-ink">Floor Map POS</div>
              <p className="mt-2 text-sm text-stone-600">
                Server logs in here. Pick a table on the floor map, mark it seated with the primary member number, then work the check seat-by-seat with split-bill settlement.
              </p>
            </div>
            <span className="shrink-0 inline-flex items-center rounded-md bg-club-green-600 text-white px-3 py-1.5 text-sm font-medium">Open floor map →</span>
          </div>
        </Link>
        <Link
          href="/app/admin/ops/pos/lounge"
          className="card card-body hover:shadow-elevated transition-shadow"
        >
          <div className="text-[10px] uppercase tracking-widest text-stone-400 font-semibold">Secondary</div>
          <div className="mt-1 font-serif text-lg text-club-ink">Quick Sale / Bar</div>
          <p className="mt-2 text-sm text-stone-600">
            Tableless ringup for bar, to-go, or no-table transactions. Use this when there&rsquo;s no party to seat.
          </p>
          <span className="mt-3 text-sm text-club-green-700">Open quick sale →</span>
        </Link>
      </div>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {searchParams.error}
        </div>
      )}

      <div className="mt-6 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">
          Recent sales ({sales.length})
        </div>
        <table className="table-base">
          <thead>
            <tr>
              <th>#</th>
              <th>Date</th>
              <th>Location</th>
              <th>Member</th>
              <th>Mode</th>
              <th className="text-right">Total</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sales.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-sm text-stone-500">
                  No POS sales yet. Settle a check from the Lounge POS to see it here.
                </td>
              </tr>
            )}
            {sales.map((s) => (
              <tr key={s.id}>
                <td className="font-mono text-xs">{s.saleNumber}</td>
                <td className="text-xs">{formatDate(s.saleDate)}</td>
                <td className="text-xs">{s.location.name}</td>
                <td className="text-xs">{s.member ? `${s.member.firstName} ${s.member.lastName}` : "—"}</td>
                <td className="text-xs">{s.chargeMode}</td>
                <td className="text-right tabular-nums">
                  {fmtMoney(s.grandTotal as unknown as number, { showZero: true })}
                </td>
                <td>
                  <Badge status={s.status} />
                </td>
                <td className="text-right text-xs">
                  {canRefund && s.status === "COMPLETED" && (
                    <form action={refundAction.bind(null, s.id)} className="inline">
                      <input type="hidden" name="reason" value="Manual refund" />
                      <button className="text-red-700 hover:underline">Refund</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
