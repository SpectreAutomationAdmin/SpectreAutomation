import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { listPendingForUser, decide } from "@/lib/ap/approvals";
import { isAppError } from "@/lib/errors";
import { fmtMoney } from "@/lib/accounting/format";
import { formatDate } from "@/lib/finance";

async function decideAction(requestId: string, decision: "APPROVE" | "REJECT", formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await decide(p, requestId, { decision, comment: String(formData.get("comment") ?? "") }); }
  catch (err) { if (isAppError(err)) redirect(`/app/admin/ap/approvals?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/ap/approvals");
}

function linkFor(entityType: string, entityId: string): string {
  if (entityType === "AP_INVOICE") return `/app/admin/ap/invoices/${entityId}`;
  if (entityType === "VENDOR") return `/app/admin/ap/vendors/${entityId}`;
  if (entityType === "PAYMENT_BATCH") return `/app/admin/ap/payments/${entityId}`;
  if (entityType === "VENDOR_BANKING") return `/app/admin/ap/vendors`;
  return "/app/admin/ap";
}

export default async function ApprovalsPage({ searchParams }: { searchParams: { error?: string } }) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  const pending = await listPendingForUser(p, clubId);

  return (
    <div>
      <h1 className="page-title">My Approvals</h1>
      <p className="mt-1 text-stone-500">Requests awaiting your decision.</p>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <div className="mt-6 card overflow-hidden">
        <table className="table-base">
          <thead><tr><th>Type</th><th>Entity</th><th className="text-right">Amount</th><th>Progress</th><th>Requested</th><th></th></tr></thead>
          <tbody>
            {pending.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-stone-500">Nothing awaiting your decision.</td></tr>}
            {pending.map((r) => (
              <tr key={r.id}>
                <td className="text-xs text-stone-500">{r.entityType.replace(/_/g, " ")}</td>
                <td><Link href={linkFor(r.entityType, r.entityId)} className="font-mono text-xs hover:text-club-green-700">{r.entityId}</Link></td>
                <td className="text-right tabular-nums">{fmtMoney(r.amount as unknown as number, { showZero: true })}</td>
                <td>{r.decisions.filter((d) => d.decision === "APPROVE").length}/{r.requiredApprovals}</td>
                <td>{formatDate(r.createdAt)}</td>
                <td className="text-right">
                  <form action={decideAction.bind(null, r.id, "APPROVE")} className="inline-flex items-center gap-1">
                    <input className="input inline-block w-32" name="comment" placeholder="Comment" />
                    <button className="text-xs text-club-green-700 hover:underline">Approve</button>
                    <button formAction={decideAction.bind(null, r.id, "REJECT")} className="text-xs text-red-600 hover:underline">Reject</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
