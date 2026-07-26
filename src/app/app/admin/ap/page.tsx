import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { apDashboardStats, reconcileApToGl, apAging } from "@/lib/ap/reports";
import { fmtMoney } from "@/lib/accounting/format";
import { StatCard } from "@/components/StatCard";

export default async function APDashboardPage() {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "ap:read")) redirect("/app/admin");

  const [stats, recon, aging] = await Promise.all([
    apDashboardStats(clubId),
    reconcileApToGl(clubId),
    apAging(clubId),
  ]);

  return (
    <div>
      <div className="flex items-end justify-between">
        <div>
          <h1 className="page-title">Accounts Payable</h1>
          <p className="mt-1 text-stone-500">Vendors, invoices, approvals, payments, and reconciliation.</p>
        </div>
        <div className="flex gap-2">
          <Link href="/app/admin/ap/invoices/new" className="btn btn-primary">+ New invoice</Link>
          <Link href="/app/admin/ap/payments/new" className="btn btn-secondary">+ Payment batch</Link>
        </div>
      </div>

      <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        <StatCard title="Total AP outstanding" value={fmtMoney(stats.outstandingTotal as unknown as number, { showZero: true })} href="/app/admin/ap/invoices" />
        <StatCard title="Awaiting approval" value={stats.awaitingApproval} tone={stats.awaitingApproval > 0 ? "warning" : "default"} href="/app/admin/ap/invoices?status=PENDING_APPROVAL" />
        <StatCard title="Due this week" value={stats.dueThisWeek} href="/app/admin/ap/invoices?status=POSTED" />
        <StatCard title="Overdue" value={stats.overdue} tone={stats.overdue > 0 ? "danger" : "default"} href="/app/admin/ap/reports/aging" />
        <StatCard title="Batches pending approval" value={stats.batchesAwaiting} tone={stats.batchesAwaiting > 0 ? "warning" : "default"} href="/app/admin/ap/payments?status=PENDING_APPROVAL" />
        <StatCard title="Vendors pending approval" value={stats.vendorsAwaiting} tone={stats.vendorsAwaiting > 0 ? "warning" : "default"} href="/app/admin/ap/vendors?status=PENDING_APPROVAL" />
        <StatCard title="Capture inbox" value={stats.openCaptures} href="/app/admin/ap/capture" />
        <StatCard title="Open exceptions" value={stats.openExceptions} tone={stats.openExceptions > 0 ? "warning" : "default"} href="/app/admin/ap/exceptions" />
      </div>

      <div className="mt-10 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between">
            <div className="font-medium">AP-to-GL reconciliation</div>
            <Link href="/app/admin/ap/reports/recon" className="text-xs text-club-green-700 hover:underline">Open →</Link>
          </div>
          <div className="card-body grid grid-cols-3 gap-4 text-sm">
            <div>
              <div className="text-stone-500 text-xs uppercase tracking-wide">AP subledger</div>
              <div className="mt-1 font-serif text-xl">{fmtMoney(recon.subledgerTotal as unknown as number, { showZero: true })}</div>
            </div>
            <div>
              <div className="text-stone-500 text-xs uppercase tracking-wide">GL 2010 balance</div>
              <div className="mt-1 font-serif text-xl">{fmtMoney(recon.glControlNatural as unknown as number, { showZero: true })}</div>
            </div>
            <div>
              <div className="text-stone-500 text-xs uppercase tracking-wide">Difference</div>
              <div className={"mt-1 font-serif text-xl " + (recon.isBalanced ? "text-club-green-700" : "text-red-700")}>
                {fmtMoney(recon.diff as unknown as number, { showZero: true })}
              </div>
            </div>
          </div>
        </div>

        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between">
            <div className="font-medium">AP aging</div>
            <Link href="/app/admin/ap/reports/aging" className="text-xs text-club-green-700 hover:underline">Open →</Link>
          </div>
          <div className="card-body grid grid-cols-5 gap-2 text-sm">
            {(["current", "d30", "d60", "d90", "d120"] as const).map((k) => (
              <div key={k} className="rounded-md bg-stone-50 px-3 py-2">
                <div className="text-stone-500 text-xs uppercase tracking-wide">
                  {k === "current" ? "Current" : k === "d30" ? "30+" : k === "d60" ? "60+" : k === "d90" ? "90+" : "120+"}
                </div>
                <div className="mt-1 font-serif text-base">{fmtMoney(aging.totals[k] as unknown as number)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
