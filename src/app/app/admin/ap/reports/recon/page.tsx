import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { reconcileApToGl } from "@/lib/ap/reports";
import { fmtMoney } from "@/lib/accounting/format";

export default async function ReconciliationPage() {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "ap:report:view")) redirect("/app/admin");

  const r = await reconcileApToGl(clubId);

  return (
    <div>
      <Link href="/app/admin/ap" className="text-sm text-stone-500 hover:text-club-ink">← AP</Link>
      <h1 className="page-title mt-3">AP-to-GL reconciliation</h1>
      <p className="mt-1 text-stone-500">Subledger sum of outstanding AP invoices vs the GL AP Control account (2010).</p>

      <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="card card-body">
          <div className="card-title">AP subledger</div>
          <div className="stat-number">{fmtMoney(r.subledgerTotal as unknown as number, { showZero: true })}</div>
        </div>
        <div className="card card-body">
          <div className="card-title">GL 2010 (natural)</div>
          <div className="stat-number">{fmtMoney(r.glControlNatural as unknown as number, { showZero: true })}</div>
        </div>
        <div className={"card card-body " + (r.isBalanced ? "border-l-4 border-l-club-green-500" : "border-l-4 border-l-red-500")}>
          <div className="card-title">Difference</div>
          <div className="stat-number">{fmtMoney(r.diff as unknown as number, { showZero: true })}</div>
        </div>
      </div>

      <div className={"mt-6 rounded-md border px-4 py-3 text-sm " + (r.isBalanced ? "border-club-green-200 bg-club-green-50 text-club-green-800" : "border-red-200 bg-red-50 text-red-700")}>
        {r.isBalanced
          ? "AP subledger ties to the GL control account."
          : "Subledger and GL disagree. Investigate unposted invoices, manual JE adjustments to 2010, or out-of-band payments."}
      </div>
    </div>
  );
}
