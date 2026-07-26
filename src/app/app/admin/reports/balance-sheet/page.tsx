import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { balanceSheet, type FSGroupNode } from "@/lib/accounting/reports";
import { fmtMoney } from "@/lib/accounting/format";

export default async function BalanceSheetPage({ searchParams }: { searchParams: { asOf?: string } }) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "reports:financial")) redirect("/app/admin");

  const asOf = searchParams.asOf ? new Date(searchParams.asOf) : new Date();
  const bs = await balanceSheet(clubId, asOf);

  return (
    <div>
      <Link href="/app/admin/reports" className="text-sm text-stone-500 hover:text-club-ink">← Reports</Link>
      <div className="mt-3 flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="page-title">Balance Sheet</h1>
          <p className="mt-1 text-stone-500">As of {asOf.toISOString().slice(0, 10)}</p>
        </div>
        <form className="flex items-end gap-2 text-sm">
          <div><label className="label">As of</label><input className="input" type="date" name="asOf" defaultValue={asOf.toISOString().slice(0, 10)} /></div>
          <button className="btn btn-secondary">Update</button>
        </form>
      </div>

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Pane title="Assets" total={bs.totalAssets as unknown as number} nodes={bs.assets} />
        <div className="space-y-6">
          <Pane title="Liabilities" total={bs.totalLiabilities as unknown as number} nodes={bs.liabilities} />
          <Pane title="Equity" total={bs.totalEquity as unknown as number} nodes={bs.equity} suffix={
            <tr className="text-sm">
              <td colSpan={2} className="px-4 py-2 text-stone-500">Current-year earnings</td>
              <td className="px-4 py-2 text-right tabular-nums">{fmtMoney(bs.currentYearEarnings as unknown as number, { showZero: true })}</td>
            </tr>
          } />
        </div>
      </div>

      <div className={"mt-6 rounded-md border px-4 py-3 text-sm " + (bs.isBalanced ? "border-club-green-200 bg-club-green-50 text-club-green-800" : "border-red-200 bg-red-50 text-red-700")}>
        {bs.isBalanced
          ? `Balanced: Assets ${fmtMoney(bs.totalAssets as unknown as number, { showZero: true })} = Liabilities + Equity ${fmtMoney(bs.totalLiabilities.plus(bs.totalEquity) as unknown as number, { showZero: true })}`
          : `Out of balance. Investigate before issuing.`}
      </div>
    </div>
  );
}

function Pane({ title, total, nodes, suffix }: { title: string; total: number; nodes: FSGroupNode[]; suffix?: React.ReactNode }) {
  return (
    <div className="card overflow-hidden">
      <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between">
        <div className="font-serif text-lg">{title}</div>
        <div className="font-mono tabular-nums font-semibold">{fmtMoney(total, { showZero: true })}</div>
      </div>
      <table className="table-base">
        <tbody>
          {nodes.map((n) => <GroupRows key={n.id} node={n} depth={0} />)}
          {suffix}
        </tbody>
      </table>
    </div>
  );
}

function GroupRows({ node, depth }: { node: FSGroupNode; depth: number }) {
  const indent = { paddingLeft: `${depth * 16 + 16}px` };
  const isLeafGroup = node.subgroups.length === 0;
  return (
    <>
      <tr className={depth === 0 ? "font-medium bg-stone-50" : ""}>
        <td style={indent} colSpan={2}>{node.name}</td>
        <td className="text-right tabular-nums">{fmtMoney(node.amount as unknown as number, { showZero: true })}</td>
      </tr>
      {isLeafGroup && node.accounts.map((a) => (
        <tr key={a.accountId}>
          <td style={{ paddingLeft: `${(depth + 1) * 16 + 16}px` }} className="text-stone-500 text-xs font-mono">{a.accountNumber}</td>
          <td className="text-stone-600 text-xs">{a.accountName}</td>
          <td className="text-right tabular-nums text-xs">{fmtMoney(a.naturalBalance as unknown as number)}</td>
        </tr>
      ))}
      {node.subgroups.map((s) => <GroupRows key={s.id} node={s} depth={depth + 1} />)}
    </>
  );
}
