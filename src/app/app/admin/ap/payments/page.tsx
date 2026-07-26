import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { listBatches } from "@/lib/ap/payment-batches";
import { Badge } from "@/components/Badge";
import { fmtMoney } from "@/lib/accounting/format";
import { formatDate } from "@/lib/finance";

export default async function BatchesPage({ searchParams }: { searchParams: { status?: string } }) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "ap:invoice:view")) redirect("/app/admin");
  const canCreate = hasPermission(p, clubId, "ap:payment:create");

  const batches = await listBatches(p, clubId, searchParams.status ? { status: searchParams.status } : undefined);

  return (
    <div>
      <div className="flex items-end justify-between">
        <div>
          <h1 className="page-title">Payment Batches</h1>
          <p className="mt-1 text-stone-500">Group approved invoices for EFT or cheque processing.</p>
        </div>
        {canCreate && <Link href="/app/admin/ap/payments/new" className="btn btn-primary">+ New batch</Link>}
      </div>

      <div className="mt-6 card overflow-hidden">
        <table className="table-base">
          <thead><tr><th>Batch #</th><th>Description</th><th>Method</th><th>Bank</th><th>Payment date</th><th>Status</th><th>Items</th><th className="text-right">Total</th></tr></thead>
          <tbody>
            {batches.length === 0 && <tr><td colSpan={8} className="px-4 py-6 text-center text-stone-500">No batches yet.</td></tr>}
            {batches.map((b) => (
              <tr key={b.id}>
                <td className="font-mono text-xs"><Link href={`/app/admin/ap/payments/${b.id}`} className="hover:text-club-green-700">{b.batchNumber}</Link></td>
                <td>{b.description}</td>
                <td>{b.paymentMethod}</td>
                <td className="text-xs text-stone-500">{b.bankAccount?.accountNumber} · {b.bankAccount?.name}</td>
                <td>{formatDate(b.paymentDate)}</td>
                <td><Badge status={b.status} /></td>
                <td>{b.items.length}</td>
                <td className="text-right tabular-nums">{fmtMoney(b.totalAmount as unknown as number)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
