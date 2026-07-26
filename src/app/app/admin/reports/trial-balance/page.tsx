import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { trialBalance } from "@/lib/accounting/reports";
import { fmtMoney } from "@/lib/accounting/format";

export default async function TrialBalancePage({ searchParams }: { searchParams: { asOf?: string } }) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "reports:financial")) redirect("/app/admin");

  const asOf = searchParams.asOf ? new Date(searchParams.asOf) : new Date();
  const tb = await trialBalance(clubId, asOf);

  return (
    <div>
      <Link href="/app/admin/reports" className="text-sm text-stone-500 hover:text-club-ink">← Reports</Link>
      <div className="mt-3 flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="page-title">Trial Balance</h1>
          <p className="mt-1 text-stone-500">As of {asOf.toISOString().slice(0, 10)}</p>
        </div>
        <form className="flex items-end gap-2 text-sm">
          <div><label className="label">As of</label><input className="input" type="date" name="asOf" defaultValue={asOf.toISOString().slice(0, 10)} /></div>
          <button className="btn btn-secondary">Update</button>
        </form>
      </div>

      <div className="mt-6 card overflow-hidden">
        <table className="table-base">
          <thead><tr><th className="w-24">Number</th><th>Account</th><th>Type</th><th className="text-right">Debit</th><th className="text-right">Credit</th></tr></thead>
          <tbody>
            {tb.rows.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-stone-500">No activity yet.</td></tr>}
            {tb.rows.map((r) => (
              <tr key={r.accountNumber}>
                <td className="font-mono">{r.accountNumber}</td>
                <td>{r.name}</td>
                <td className="text-xs text-stone-500">{r.type}</td>
                <td className="text-right tabular-nums">{fmtMoney(r.debit as unknown as number)}</td>
                <td className="text-right tabular-nums">{fmtMoney(r.credit as unknown as number)}</td>
              </tr>
            ))}
            <tr className={"font-medium " + (tb.isBalanced ? "bg-club-green-50" : "bg-red-50")}>
              <td colSpan={3} className="text-right">Totals</td>
              <td className="text-right tabular-nums">{fmtMoney(tb.totalDebit as unknown as number, { showZero: true })}</td>
              <td className="text-right tabular-nums">{fmtMoney(tb.totalCredit as unknown as number, { showZero: true })}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Founder rule 2026-06-30 v14.6 — a positive balanced
          status reassures the user that no manual investigation
          is required. The out-of-balance banner only fires when
          |debit - credit| > $0.01 after rounding to cents. */}
      {tb.isBalanced ? (
        <div
          className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
          role="status"
          data-testid="tb-report-balanced-banner"
        >
          Trial balance is balanced.
        </div>
      ) : (
        <div
          className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          role="alert"
          data-testid="tb-report-imbalance-banner"
        >
          Trial balance is out of balance. Investigate before issuing financial statements.
        </div>
      )}
    </div>
  );
}
