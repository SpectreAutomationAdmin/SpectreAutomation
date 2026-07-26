import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { incomeStatementByDepartment } from "@/lib/accounting/reports";
import { fmtMoney } from "@/lib/accounting/format";

export default async function DepartmentPLPage({ searchParams }: { searchParams: { from?: string; to?: string } }) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "reports:financial")) redirect("/app/admin");

  const now = new Date();
  const fromDefault = new Date(now.getFullYear(), 0, 1);
  const from = searchParams.from ? new Date(searchParams.from) : fromDefault;
  const to = searchParams.to ? new Date(searchParams.to) : now;
  const r = await incomeStatementByDepartment(clubId, from, to);

  return (
    <div>
      <Link href="/app/admin/reports" className="text-sm text-stone-500 hover:text-club-ink">← Reports</Link>
      <div className="mt-3 flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="page-title">Income by Department</h1>
          <p className="mt-1 text-stone-500">{from.toISOString().slice(0, 10)} – {to.toISOString().slice(0, 10)}</p>
        </div>
        <form className="flex items-end gap-2 text-sm">
          <div><label className="label">From</label><input className="input" type="date" name="from" defaultValue={from.toISOString().slice(0, 10)} /></div>
          <div><label className="label">To</label><input className="input" type="date" name="to" defaultValue={to.toISOString().slice(0, 10)} /></div>
          <button className="btn btn-secondary">Update</button>
        </form>
      </div>

      <div className="mt-6 card overflow-hidden">
        <table className="table-base">
          <thead>
            <tr>
              <th>Department</th>
              <th className="text-right">Revenue</th>
              <th className="text-right">Cost of sales</th>
              <th className="text-right">Operating expenses</th>
              <th className="text-right">Contribution</th>
            </tr>
          </thead>
          <tbody>
            {r.rows.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-stone-500">No activity.</td></tr>}
            {r.rows.map((row) => (
              <tr key={row.departmentId ?? "_none_"}>
                <td>{row.departmentName}</td>
                <td className="text-right tabular-nums">{fmtMoney(row.revenue as unknown as number)}</td>
                <td className="text-right tabular-nums">{fmtMoney(row.cogs as unknown as number)}</td>
                <td className="text-right tabular-nums">{fmtMoney(row.opex as unknown as number)}</td>
                <td className={"text-right tabular-nums " + ((row.contribution as unknown as number) >= 0 ? "" : "text-red-700")}>
                  {fmtMoney(row.contribution as unknown as number, { showZero: true })}
                </td>
              </tr>
            ))}
            <tr className="font-medium bg-stone-50">
              <td>Consolidated</td>
              <td className="text-right tabular-nums">{fmtMoney(r.totalRevenue as unknown as number, { showZero: true })}</td>
              <td className="text-right tabular-nums">{fmtMoney(r.totalCogs as unknown as number, { showZero: true })}</td>
              <td className="text-right tabular-nums">{fmtMoney(r.totalOpex as unknown as number, { showZero: true })}</td>
              <td className="text-right tabular-nums">{fmtMoney(r.totalContribution as unknown as number, { showZero: true })}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
