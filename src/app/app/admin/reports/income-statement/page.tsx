import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { incomeStatement, type FSGroupNode } from "@/lib/accounting/reports";
import { fmtMoney } from "@/lib/accounting/format";

export default async function IncomeStatementPage({ searchParams }: { searchParams: { from?: string; to?: string } }) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "reports:financial")) redirect("/app/admin");

  const now = new Date();
  const fromDefault = new Date(now.getFullYear(), 0, 1);
  const from = searchParams.from ? new Date(searchParams.from) : fromDefault;
  const to = searchParams.to ? new Date(searchParams.to) : now;
  const is = await incomeStatement(clubId, from, to);

  return (
    <div>
      <Link href="/app/admin/reports" className="text-sm text-stone-500 hover:text-club-ink">← Reports</Link>
      <div className="mt-3 flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="page-title">Income Statement</h1>
          <p className="mt-1 text-stone-500">{from.toISOString().slice(0, 10)} – {to.toISOString().slice(0, 10)}</p>
        </div>
        <form className="flex items-end gap-2 text-sm">
          <div><label className="label">From</label><input className="input" type="date" name="from" defaultValue={from.toISOString().slice(0, 10)} /></div>
          <div><label className="label">To</label><input className="input" type="date" name="to" defaultValue={to.toISOString().slice(0, 10)} /></div>
          <button className="btn btn-secondary">Update</button>
        </form>
      </div>

      <div className="mt-6 grid grid-cols-1 md:grid-cols-4 gap-4">
        <Stat label="Revenue" value={fmtMoney(is.totalRevenue as unknown as number, { showZero: true })} />
        <Stat label="Cost of sales" value={fmtMoney(is.totalCogs as unknown as number, { showZero: true })} />
        <Stat label="Gross margin" value={fmtMoney(is.grossMargin as unknown as number, { showZero: true })} />
        <Stat label="Net income" value={fmtMoney(is.netIncome as unknown as number, { showZero: true })} accent={(is.netIncome as unknown as number) >= 0 ? "success" : "danger"} />
      </div>

      <div className="mt-6 card overflow-hidden">
        <table className="table-base">
          <tbody>
            <SectionHeader label="Revenue" total={is.totalRevenue as unknown as number} />
            {is.revenue.map((n) => <GroupRows key={n.id} node={n} depth={0} />)}
            <SectionHeader label="Cost of sales" total={is.totalCogs as unknown as number} />
            {is.cogs.map((n) => <GroupRows key={n.id} node={n} depth={0} />)}
            <tr className="font-medium bg-stone-50">
              <td colSpan={2} className="px-4 py-3">Gross margin</td>
              <td className="text-right tabular-nums">{fmtMoney(is.grossMargin as unknown as number, { showZero: true })}</td>
            </tr>
            <SectionHeader label="Operating expenses" total={is.totalOpex as unknown as number} />
            {is.opex.map((n) => <GroupRows key={n.id} node={n} depth={0} />)}
            <tr className="font-semibold bg-stone-100">
              <td colSpan={2} className="px-4 py-3">Net income</td>
              <td className="text-right tabular-nums">{fmtMoney(is.netIncome as unknown as number, { showZero: true })}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SectionHeader({ label, total }: { label: string; total: number }) {
  return (
    <tr className="font-medium bg-stone-50">
      <td colSpan={2} className="px-4 py-3">{label}</td>
      <td className="text-right tabular-nums">{fmtMoney(total, { showZero: true })}</td>
    </tr>
  );
}

function GroupRows({ node, depth }: { node: FSGroupNode; depth: number }) {
  const indent = { paddingLeft: `${(depth + 1) * 16 + 16}px` };
  return (
    <>
      <tr>
        <td style={indent} colSpan={2} className="text-stone-700">{node.name}</td>
        <td className="text-right tabular-nums">{fmtMoney(node.amount as unknown as number, { showZero: true })}</td>
      </tr>
      {node.subgroups.length === 0 && node.accounts.map((a) => (
        <tr key={a.accountId}>
          <td style={{ paddingLeft: `${(depth + 2) * 16 + 16}px` }} className="text-stone-500 text-xs font-mono">{a.accountNumber}</td>
          <td className="text-stone-600 text-xs">{a.accountName}</td>
          <td className="text-right tabular-nums text-xs">{fmtMoney(a.naturalBalance as unknown as number)}</td>
        </tr>
      ))}
      {node.subgroups.map((s) => <GroupRows key={s.id} node={s} depth={depth + 1} />)}
    </>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: "success" | "danger" }) {
  const cls = accent === "success" ? "border-l-club-green-500" : accent === "danger" ? "border-l-red-500" : "border-l-stone-300";
  return (
    <div className={`card card-body border-l-4 ${cls}`}>
      <div className="card-title">{label}</div>
      <div className="stat-number">{value}</div>
    </div>
  );
}
