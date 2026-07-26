import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { listJournals } from "@/lib/accounting/journal";
import { hasPermission } from "@/lib/rbac";
import { Badge } from "@/components/Badge";
import { fmtMoney } from "@/lib/accounting/format";
import { formatDate } from "@/lib/finance";

export default async function GLPage({ searchParams }: { searchParams: { status?: string } }) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "gl:read")) redirect("/app/admin");

  const status = searchParams.status?.toUpperCase();
  const journals = await listJournals(p, clubId, { status, limit: 200 });
  const canPost = hasPermission(p, clubId, "gl:post");

  return (
    <div>
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="page-title">General Ledger</h1>
          <p className="mt-1 text-stone-500">All journal entries — manual and adapter-generated.</p>
        </div>
        {canPost && (
          <Link href="/app/admin/gl/new" className="btn btn-primary">+ New journal entry</Link>
        )}
      </div>

      <div className="mt-6 flex items-center gap-2 flex-wrap">
        {[
          { v: "", l: "All" },
          { v: "DRAFT", l: "Draft" },
          { v: "APPROVED", l: "Approved" },
          { v: "POSTED", l: "Posted" },
          { v: "VOIDED", l: "Voided" },
          { v: "REVERSED", l: "Reversed" },
        ].map((f) => {
          const active = (status ?? "") === f.v;
          return (
            <Link
              key={f.v}
              href={f.v ? `/app/admin/gl?status=${f.v}` : "/app/admin/gl"}
              className={
                "rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset " +
                (active ? "bg-club-green-700 text-white ring-club-green-700" : "bg-white text-stone-600 ring-stone-200 hover:bg-stone-50")
              }
            >
              {f.l}
            </Link>
          );
        })}
      </div>

      <div className="mt-6 card overflow-hidden">
        <table className="table-base">
          <thead>
            <tr>
              <th className="font-mono w-44">Entry #</th>
              <th>Date</th>
              <th>Description</th>
              <th>Source</th>
              <th>Period</th>
              <th>Status</th>
              <th className="text-right">Debit</th>
              <th className="text-right">Credit</th>
            </tr>
          </thead>
          <tbody>
            {journals.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-stone-500">No journal entries.</td></tr>
            )}
            {journals.map((j) => (
              <tr key={j.id}>
                <td className="font-mono text-xs">
                  <Link href={`/app/admin/gl/${j.id}`} className="hover:text-club-green-700">{j.entryNumber}</Link>
                </td>
                <td>{formatDate(j.entryDate)}</td>
                <td className="max-w-md truncate">{j.description}</td>
                <td className="text-xs text-stone-500">{j.source}</td>
                <td className="font-mono text-xs">{j.period?.label ?? "—"}</td>
                <td><Badge status={j.status} /></td>
                <td className="text-right tabular-nums">{fmtMoney(j.totalDebits)}</td>
                <td className="text-right tabular-nums">{fmtMoney(j.totalCredits)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
