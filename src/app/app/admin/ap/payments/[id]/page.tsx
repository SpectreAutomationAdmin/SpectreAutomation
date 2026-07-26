import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import {
  getBatch, addItem, removeItem, submitBatchForApproval, processBatch, suggestInvoicesForBatch,
} from "@/lib/ap/payment-batches";
import { getRequestForEntity } from "@/lib/ap/approvals";
import { isAppError } from "@/lib/errors";
import { Badge } from "@/components/Badge";
import { fmtMoney } from "@/lib/accounting/format";
import { formatDate } from "@/lib/finance";

function bounce(id: string, err: unknown): never {
  if (isAppError(err)) redirect(`/app/admin/ap/payments/${id}?error=${encodeURIComponent(err.safeMessage)}`);
  throw err;
}

async function addAction(id: string, formData: FormData) {
  "use server"; const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await addItem(p, id, { invoiceId: String(formData.get("invoiceId")), amount: Number(formData.get("amount") ?? 0) }); } catch (err) { bounce(id, err); }
  revalidatePath(`/app/admin/ap/payments/${id}`);
}
async function removeAction(id: string, itemId: string) {
  "use server"; const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await removeItem(p, itemId); } catch (err) { bounce(id, err); }
  revalidatePath(`/app/admin/ap/payments/${id}`);
}
async function submitAction(id: string) {
  "use server"; const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await submitBatchForApproval(p, id); } catch (err) { bounce(id, err); }
  revalidatePath(`/app/admin/ap/payments/${id}`);
}
async function processAction(id: string) {
  "use server"; const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await processBatch(p, id); } catch (err) { bounce(id, err); }
  revalidatePath(`/app/admin/ap/payments/${id}`);
}

export default async function BatchDetailPage({ params, searchParams }: { params: { id: string }; searchParams: { error?: string } }) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  let batch;
  try { batch = await getBatch(p, params.id); }
  catch { notFound(); }
  if (!batch) notFound();

  const canCreate = hasPermission(p, batch.clubId, "ap:payment:create");
  const canProcess = hasPermission(p, batch.clubId, "ap:payment:process");
  const approvalReq = await getRequestForEntity(batch.clubId, "PAYMENT_BATCH", batch.id);
  const suggested = batch.status === "DRAFT"
    ? await suggestInvoicesForBatch(batch.clubId, { paymentMethod: batch.paymentMethod as "EFT" | "CHEQUE" })
    : [];

  // Exclude invoices already in this batch from the suggestion list.
  const alreadyInBatch = new Set(batch.items.map((i) => i.invoiceId));
  const remainingSuggested = suggested.filter((s) => !alreadyInBatch.has(s.id));

  return (
    <div>
      <Link href="/app/admin/ap/payments" className="text-sm text-stone-500 hover:text-club-ink">← Payment batches</Link>
      <div className="mt-3 flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="page-title font-mono">{batch.batchNumber}</h1>
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <Badge status={batch.status} />
            <span className="text-sm text-stone-500">{batch.paymentMethod} · {formatDate(batch.paymentDate)} · {batch.bankAccount?.accountNumber} {batch.bankAccount?.name}</span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase tracking-wide text-stone-500">Total</div>
          <div className="font-serif text-2xl">{fmtMoney(batch.totalAmount as unknown as number, { showZero: true })}</div>
        </div>
      </div>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Items ({batch.items.length})</div>
          <table className="table-base">
            <thead><tr><th>Invoice</th><th>Vendor</th><th className="text-right">Amount</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {batch.items.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-stone-500">No items yet.</td></tr>}
              {batch.items.map((item) => (
                <tr key={item.id}>
                  <td className="font-mono text-xs"><Link href={`/app/admin/ap/invoices/${item.invoiceId}`} className="hover:text-club-green-700">{item.invoice.invoiceNumber}</Link></td>
                  <td>{item.invoice.vendor.legalName}</td>
                  <td className="text-right tabular-nums">{fmtMoney(item.amount as unknown as number)}</td>
                  <td><Badge status={item.status} /></td>
                  <td className="text-right">
                    {batch.status === "DRAFT" && canCreate && (
                      <form action={removeAction.bind(null, batch.id, item.id)} className="inline">
                        <button className="text-xs text-red-600 hover:underline">Remove</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="space-y-4">
          {approvalReq && (
            <div className="card card-body">
              <h3 className="font-medium">Approval</h3>
              <div className="mt-2 text-sm">
                <Badge status={approvalReq.status} /> · {approvalReq.decisions.length}/{approvalReq.requiredApprovals} approvals
              </div>
            </div>
          )}
          {batch.status === "DRAFT" && canCreate && (
            <form action={submitAction.bind(null, batch.id)} className="card card-body">
              <h3 className="font-medium">Submit for approval</h3>
              <button className="btn btn-primary mt-3 w-full" disabled={batch.items.length === 0}>Submit</button>
            </form>
          )}
          {(batch.status === "APPROVED" || (batch.status === "PENDING_APPROVAL" && approvalReq?.status === "APPROVED")) && canProcess && (
            <form action={processAction.bind(null, batch.id)} className="card card-body">
              <h3 className="font-medium">Process batch</h3>
              <p className="mt-1 text-sm text-stone-500">Creates a payment per item and posts to the GL.</p>
              <button className="btn btn-primary mt-3 w-full">Process now</button>
            </form>
          )}
        </div>
      </div>

      {batch.status === "DRAFT" && canCreate && remainingSuggested.length > 0 && (
        <div className="mt-8 card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Suggested invoices ({batch.paymentMethod === "EFT" ? "with verified banking only" : "any"})</div>
          <table className="table-base">
            <thead><tr><th>Invoice</th><th>Vendor</th><th>Due</th><th className="text-right">Outstanding</th><th></th></tr></thead>
            <tbody>
              {remainingSuggested.map((inv) => {
                const outstanding = Number(inv.total.toString()) - Number(inv.amountPaid.toString());
                return (
                  <tr key={inv.id}>
                    <td className="font-mono text-xs">{inv.invoiceNumber}</td>
                    <td>{inv.vendor.legalName}</td>
                    <td>{formatDate(inv.dueDate)}</td>
                    <td className="text-right tabular-nums">{fmtMoney(outstanding)}</td>
                    <td>
                      <form action={addAction.bind(null, batch.id)} className="inline flex items-center gap-1">
                        <input type="hidden" name="invoiceId" value={inv.id} />
                        <input className="input inline-block w-24 font-mono" type="number" step="0.01" min="0" name="amount" defaultValue={outstanding.toFixed(2)} max={outstanding} />
                        <button className="text-xs text-club-green-700 hover:underline">Add</button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
