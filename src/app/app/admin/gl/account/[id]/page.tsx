import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { accountActivity } from "@/lib/accounting/balance";
import { fmtMoney } from "@/lib/accounting/format";
import { formatDate } from "@/lib/finance";

export default async function GLAccountDetailPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { from?: string; to?: string };
}) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "gl:read")) redirect("/app/admin");

  const from = searchParams.from ? new Date(searchParams.from) : new Date(new Date().getFullYear(), 0, 1);
  const to = searchParams.to ? new Date(searchParams.to) : new Date();

  let result;
  try { result = await accountActivity(clubId, params.id, { from, to }); }
  catch { notFound(); }

  return (
    <div>
      <Link href="/app/admin/coa" className="text-sm text-stone-500 hover:text-club-ink">← Chart of Accounts</Link>
      <div className="mt-3 flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="page-title">
            <span className="font-mono">{result.account.accountNumber}</span> · {result.account.name}
          </h1>
          <p className="mt-1 text-stone-500">{result.account.type} · {result.account.normalBalance} normal</p>
        </div>
        <form className="flex items-end gap-2 text-sm">
          <div><label className="label">From</label><input className="input" type="date" name="from" defaultValue={from.toISOString().slice(0, 10)} /></div>
          <div><label className="label">To</label><input className="input" type="date" name="to" defaultValue={to.toISOString().slice(0, 10)} /></div>
          <button className="btn btn-secondary">Apply</button>
        </form>
      </div>

      <div className="mt-6 grid grid-cols-1 md:grid-cols-4 gap-4">
        <Stat label="Opening" value={fmtMoney(result.openingSigned as unknown as number, { showZero: true })} />
        <Stat label="Period debits" value={fmtMoney(result.totalDebit as unknown as number, { showZero: true })} />
        <Stat label="Period credits" value={fmtMoney(result.totalCredit as unknown as number, { showZero: true })} />
        <Stat label="Closing" value={fmtMoney(result.closingSigned as unknown as number, { showZero: true })} />
      </div>

      <div className="mt-6 card overflow-hidden">
        <table className="table-base">
          <thead>
            <tr>
              <th>Date</th>
              <th>Entry</th>
              <th>Description</th>
              <th>Dept</th>
              <th className="text-right">Debit</th>
              <th className="text-right">Credit</th>
              <th className="text-right">Running</th>
            </tr>
          </thead>
          <tbody>
            {result.activity.length === 0 && <tr><td colSpan={7} className="px-4 py-6 text-center text-stone-500">No activity in this window.</td></tr>}
            {result.activity.map((r) => (
              <tr key={r.lineId}>
                <td>{formatDate(r.entryDate)}</td>
                <td className="font-mono text-xs"><Link href={`/app/admin/gl/${r.entryId}`} className="hover:text-club-green-700">{r.entryNumber}</Link></td>
                <td className="text-stone-600">{r.description}</td>
                <td className="text-xs text-stone-500">{r.department ?? "—"}</td>
                <td className="text-right tabular-nums">{fmtMoney(r.debit as unknown as number)}</td>
                <td className="text-right tabular-nums">{fmtMoney(r.credit as unknown as number)}</td>
                <td className="text-right tabular-nums">{fmtMoney(r.runningSigned as unknown as number, { showZero: true })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card card-body">
      <div className="card-title">{label}</div>
      <div className="stat-number">{value}</div>
    </div>
  );
}
