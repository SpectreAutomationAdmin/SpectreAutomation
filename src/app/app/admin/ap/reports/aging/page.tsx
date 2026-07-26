import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { apAging } from "@/lib/ap/reports";
import { fmtMoney } from "@/lib/accounting/format";

export default async function APAgingPage({ searchParams }: { searchParams: { asOf?: string } }) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "ap:report:view")) redirect("/app/admin");

  const asOf = searchParams.asOf ? new Date(searchParams.asOf) : new Date();
  const r = await apAging(clubId, asOf);

  return (
    <div>
      <Link href="/app/admin/ap" className="text-sm text-stone-500 hover:text-club-ink">← AP</Link>
      <div className="mt-3 flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="page-title">AP Aging</h1>
          <p className="mt-1 text-stone-500">As of {asOf.toISOString().slice(0, 10)}</p>
        </div>
        <form className="flex items-end gap-2 text-sm">
          <div><label className="label">As of</label><input className="input" type="date" name="asOf" defaultValue={asOf.toISOString().slice(0, 10)} /></div>
          <button className="btn btn-secondary">Update</button>
        </form>
      </div>

      <div className="mt-6 card overflow-hidden">
        <table className="table-base">
          <thead><tr><th>Vendor</th><th className="text-right">Current</th><th className="text-right">30+</th><th className="text-right">60+</th><th className="text-right">90+</th><th className="text-right">120+</th><th className="text-right">Total</th></tr></thead>
          <tbody>
            {r.rows.length === 0 && <tr><td colSpan={7} className="px-4 py-6 text-center text-stone-500">No outstanding AP.</td></tr>}
            {r.rows.map((row) => (
              <tr key={row.vendorId}>
                <td><Link href={`/app/admin/ap/vendors/${row.vendorId}`} className="hover:text-club-green-700">{row.vendorName}</Link></td>
                <td className="text-right tabular-nums">{fmtMoney(row.current as unknown as number)}</td>
                <td className="text-right tabular-nums">{fmtMoney(row.d30 as unknown as number)}</td>
                <td className="text-right tabular-nums">{fmtMoney(row.d60 as unknown as number)}</td>
                <td className="text-right tabular-nums">{fmtMoney(row.d90 as unknown as number)}</td>
                <td className="text-right tabular-nums">{fmtMoney(row.d120 as unknown as number)}</td>
                <td className="text-right tabular-nums font-medium">{fmtMoney(row.total as unknown as number)}</td>
              </tr>
            ))}
            <tr className="font-semibold bg-stone-100">
              <td>Total</td>
              <td className="text-right tabular-nums">{fmtMoney(r.totals.current as unknown as number, { showZero: true })}</td>
              <td className="text-right tabular-nums">{fmtMoney(r.totals.d30 as unknown as number, { showZero: true })}</td>
              <td className="text-right tabular-nums">{fmtMoney(r.totals.d60 as unknown as number, { showZero: true })}</td>
              <td className="text-right tabular-nums">{fmtMoney(r.totals.d90 as unknown as number, { showZero: true })}</td>
              <td className="text-right tabular-nums">{fmtMoney(r.totals.d120 as unknown as number, { showZero: true })}</td>
              <td className="text-right tabular-nums">{fmtMoney(r.totals.total as unknown as number, { showZero: true })}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
