import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { getActiveMember } from "@/lib/active-member";
import { listDiningForMember } from "@/lib/pos/lounge";
import { formatCurrency, formatDateTime } from "@/lib/finance";

// Member-side dining list. Reads real POS sales for this member from
// the Clubhouse Lounge. Each row links to an itemized receipt at
// /app/member/dining/[id].
//
// Tenant safety is rooted in `getActiveMember(user)` — that returns the
// member record the principal is allowed to act as. We pass only the
// resolved memberId into the POS read, so cross-tenant lookups can't
// happen by URL manipulation.
export default async function MemberDiningPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const member = await getActiveMember(user);
  if (!member) redirect(user.role === "MEMBER" ? "/login" : "/app/admin");

  const sales = await listDiningForMember(member.id, { limit: 50 });

  return (
    <div>
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="page-title">Dining</h1>
          <p className="mt-1 text-sm text-stone-500">
            Charges from the Clubhouse Lounge, most recent first.
          </p>
        </div>
        <Link href="/app/member" className="btn btn-secondary btn-sm">Back to hub</Link>
      </div>

      <div className="mt-6 card overflow-hidden">
        <table className="table-base">
          <thead>
            <tr>
              <th>Date</th>
              <th>Location</th>
              <th>Items</th>
              <th className="text-right">Total</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sales.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-stone-500 text-sm">
                  No dining charges yet. Visit the Clubhouse Lounge and your receipts will appear here.
                </td>
              </tr>
            )}
            {sales.map((s) => {
              const total = Number(s.grandTotal.toString());
              const summary = s.lines.length === 0
                ? "—"
                : s.lines.length === 1
                  ? `${s.lines[0].quantity} × ${s.lines[0].description}`
                  : `${s.lines[0].description} +${s.lines.length - 1} more`;
              return (
                <tr key={s.id}>
                  <td className="text-xs whitespace-nowrap">{formatDateTime(s.saleDate)}</td>
                  <td className="text-sm">{s.location.name}</td>
                  <td className="text-sm text-stone-700 truncate max-w-md">{summary}</td>
                  <td className="text-sm text-right tabular-nums">{formatCurrency(total)}</td>
                  <td className="text-right">
                    <Link href={`/app/member/dining/${s.id}`} className="text-sm text-club-green-700 hover:underline">
                      View receipt →
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
