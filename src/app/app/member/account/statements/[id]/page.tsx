import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { readStatement } from "@/lib/services/statements";
import { formatCurrency, formatDate } from "@/lib/finance";

export default async function MemberStatementPage({ params }: { params: { id: string } }) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  let statement;
  try {
    statement = await readStatement(p, params.id);
  } catch {
    notFound();
  }
  const lines = JSON.parse(statement.linesJson ?? "[]") as Array<{ date: string; type: string; description: string; amount: number; signedAmount: number; runningBalance: number }>;

  return (
    <div>
      <Link href="/app/member/account" className="text-sm text-stone-500 hover:text-club-ink">← My account</Link>
      <h1 className="page-title mt-3">Statement</h1>
      <p className="mt-1 text-stone-500">{formatDate(statement.periodStart)} – {formatDate(statement.periodEnd)} · issued {formatDate(statement.issuedAt)}</p>

      <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
        <Tile label="Opening" value={formatCurrency(statement.openingBalance)} />
        <Tile label="Closing" value={formatCurrency(statement.closingBalance)} />
        <Tile label="Net activity" value={formatCurrency(statement.totalCharges - statement.totalPayments + statement.totalAdjustments)} />
      </div>

      <div className="mt-6 grid grid-cols-1 md:grid-cols-5 gap-2 text-sm">
        <Aging label="Current" value={statement.agingCurrent} />
        <Aging label="30 days" value={statement.aging30} />
        <Aging label="60 days" value={statement.aging60} />
        <Aging label="90 days" value={statement.aging90} />
        <Aging label="120+ days" value={statement.aging120} />
      </div>

      {statement.messageBody && (
        <div className="mt-6 card card-body">
          <pre className="whitespace-pre-wrap font-sans text-sm">{statement.messageBody}</pre>
        </div>
      )}

      <div className="mt-8 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">Activity</div>
        <table className="table-base">
          <thead><tr><th>Date</th><th>Type</th><th>Description</th><th className="text-right">Amount</th><th className="text-right">Running</th></tr></thead>
          <tbody>
            {lines.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-stone-500">No activity in this period.</td></tr>}
            {lines.map((l, i) => (
              <tr key={i}>
                <td>{l.date}</td>
                <td className="text-xs uppercase tracking-wide text-stone-500">{l.type.replace(/_/g, " ")}</td>
                <td>{l.description}</td>
                <td className={"text-right tabular-nums " + (l.signedAmount < 0 ? "text-club-green-700" : "")}>{formatCurrency(l.signedAmount)}</td>
                <td className="text-right tabular-nums">{formatCurrency(l.runningBalance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="card card-body">
      <div className="card-title">{label}</div>
      <div className="stat-number">{value}</div>
    </div>
  );
}

function Aging({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-stone-50 px-3 py-2">
      <div className="text-xs uppercase tracking-wide text-stone-500">{label}</div>
      <div className="mt-1 font-serif text-base">{formatCurrency(value)}</div>
    </div>
  );
}
