import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import {
  getInvoice, submitInvoiceForApproval, postInvoice, reverseInvoice, disputeInvoice,
} from "@/lib/ap/invoices";
import { getRequestForEntity, decide } from "@/lib/ap/approvals";
import { payInvoice } from "@/lib/ap/payments";
import { prisma } from "@/lib/prisma";
import { isAppError } from "@/lib/errors";
import { Badge } from "@/components/Badge";
import { fmtMoney } from "@/lib/accounting/format";
import { formatDate } from "@/lib/finance";

function bounce(id: string, err: unknown): never {
  if (isAppError(err)) redirect(`/app/admin/ap/invoices/${id}?error=${encodeURIComponent(err.safeMessage)}`);
  throw err;
}

async function submitAction(id: string) {
  "use server"; const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await submitInvoiceForApproval(p, id); } catch (err) { bounce(id, err); }
  revalidatePath(`/app/admin/ap/invoices/${id}`);
}
async function postAction(id: string) {
  "use server"; const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await postInvoice(p, id); } catch (err) { bounce(id, err); }
  revalidatePath(`/app/admin/ap/invoices/${id}`);
}
async function reverseAction(id: string, formData: FormData) {
  "use server"; const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await reverseInvoice(p, id, String(formData.get("reason") ?? "")); } catch (err) { bounce(id, err); }
  revalidatePath(`/app/admin/ap/invoices/${id}`);
}
async function disputeAction(id: string, formData: FormData) {
  "use server"; const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await disputeInvoice(p, id, String(formData.get("note") ?? "")); } catch (err) { bounce(id, err); }
  revalidatePath(`/app/admin/ap/invoices/${id}`);
}
async function approveDecision(id: string, requestId: string, decision: "APPROVE" | "REJECT", formData: FormData) {
  "use server"; const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await decide(p, requestId, { decision, comment: String(formData.get("comment") ?? "") }); } catch (err) { bounce(id, err); }
  revalidatePath(`/app/admin/ap/invoices/${id}`);
}
async function payAction(id: string, formData: FormData) {
  "use server"; const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try {
    await payInvoice(p, {
      invoiceId: id,
      amount: Number(formData.get("amount") ?? 0),
      method: String(formData.get("method") ?? "EFT") as "EFT" | "CHEQUE" | "CC" | "CASH" | "OTHER",
    });
  } catch (err) { bounce(id, err); }
  revalidatePath(`/app/admin/ap/invoices/${id}`);
}

export default async function InvoiceDetailPage({ params, searchParams }: { params: { id: string }; searchParams: { error?: string } }) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  let inv;
  try { inv = await getInvoice(p, params.id); }
  catch { notFound(); }
  if (!inv) notFound();

  const canApprove = hasPermission(p, inv.clubId, "ap:invoice:approve");
  const canPost = hasPermission(p, inv.clubId, "ap:invoice:post");
  const canVoid = hasPermission(p, inv.clubId, "ap:invoice:void");
  const canPay = hasPermission(p, inv.clubId, "ap:payment:process");

  const approvalReq = await getRequestForEntity(inv.clubId, "AP_INVOICE", inv.id);
  const exceptions = await prisma.aPException.findMany({
    where: { clubId: inv.clubId, invoiceId: inv.id, status: "OPEN" },
    orderBy: { severity: "desc" },
  });
  const outstanding = Number(inv.total.toString()) - Number(inv.amountPaid.toString());

  return (
    <div>
      <Link href="/app/admin/ap/invoices" className="text-sm text-stone-500 hover:text-club-ink">← AP Invoices</Link>

      <div className="mt-3 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="page-title font-mono">{inv.invoiceNumber}</h1>
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <Badge status={inv.status} />
            <span className="text-sm text-stone-500">
              <Link href={`/app/admin/ap/vendors/${inv.vendorId}`} className="hover:text-club-green-700">{inv.vendor.legalName}</Link>
              {inv.vendorReference && ` · ${inv.vendorReference}`} · {formatDate(inv.invoiceDate)}
              {inv.dueDate && ` · due ${formatDate(inv.dueDate)}`}
            </span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase tracking-wide text-stone-500">Outstanding</div>
          <div className="font-serif text-2xl">{fmtMoney(outstanding, { showZero: true })}</div>
        </div>
      </div>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      {exceptions.length > 0 && (
        <div className="mt-4 card overflow-hidden border-l-4 border-amber-400">
          <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between">
            <div className="font-medium">Exceptions ({exceptions.length})</div>
            <Link href={`/app/admin/ap/exceptions`} className="text-xs text-club-green-700 hover:underline">View all →</Link>
          </div>
          <ul className="px-6 py-3 text-sm space-y-1">
            {exceptions.map((e) => (
              <li key={e.id} className="flex items-center justify-between">
                <span>
                  <Badge status={e.severity === "HIGH" ? "FAILED" : e.severity === "MEDIUM" ? "PENDING" : "DRAFT"} label={e.severity} />
                  <span className="ml-2 text-stone-700">{e.kind.replace(/_/g, " ")}</span>
                  <span className="ml-2 text-stone-500 text-xs">{e.description}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 card overflow-hidden">
          <div className="card-body">
            <div className="text-sm text-stone-500">Description</div>
            <div className="mt-1 font-serif text-lg">{inv.description ?? "—"}</div>
          </div>
          <table className="table-base">
            <thead>
              <tr><th className="w-8">#</th><th>Account</th><th>Dept</th><th>Description</th><th className="text-right">Amount</th><th>Tax</th><th className="text-right">Tax</th></tr>
            </thead>
            <tbody>
              {inv.lines.map((l) => (
                <tr key={l.id}>
                  <td className="text-stone-500">{l.lineNumber}</td>
                  <td><Link href={`/app/admin/gl/account/${l.expenseAccountId}`} className="hover:text-club-green-700"><span className="font-mono">{l.expenseAccount.accountNumber}</span> · {l.expenseAccount.name}</Link></td>
                  <td className="text-xs text-stone-500">{l.department?.name ?? "—"}</td>
                  <td className="text-stone-600 text-xs">{l.description ?? "—"}</td>
                  <td className="text-right tabular-nums">{fmtMoney(l.amount as unknown as number)}</td>
                  <td className="text-xs text-stone-500">{l.taxCode?.key ?? "—"}</td>
                  <td className="text-right tabular-nums">{fmtMoney(l.taxAmount as unknown as number)}</td>
                </tr>
              ))}
              <tr className="bg-stone-50"><td colSpan={4} className="text-right font-medium">Subtotal</td><td className="text-right tabular-nums font-mono">{fmtMoney(inv.subtotal as unknown as number)}</td><td></td><td className="text-right tabular-nums font-mono">{fmtMoney(inv.taxTotal as unknown as number)}</td></tr>
              <tr className="bg-stone-100 font-semibold"><td colSpan={6} className="text-right">Total</td><td className="text-right tabular-nums font-mono">{fmtMoney(inv.total as unknown as number)}</td></tr>
            </tbody>
          </table>
          {inv.postedJournalEntry && (
            <div className="px-6 py-3 border-t border-stone-200 text-xs text-stone-500">
              Posted journal entry: <Link className="text-club-green-700 hover:underline font-mono" href={`/app/admin/gl/${inv.postedJournalEntryId}`}>{inv.postedJournalEntry.entryNumber}</Link>
              {inv.reversingJournalEntry && (
                <> · Reversed by: <Link className="text-club-green-700 hover:underline font-mono" href={`/app/admin/gl/${inv.reversingJournalEntryId}`}>{inv.reversingJournalEntry.entryNumber}</Link></>
              )}
            </div>
          )}
        </div>

        <div className="space-y-4">
          {approvalReq && (
            <div className="card card-body">
              <h3 className="font-medium">Approval</h3>
              <div className="mt-2 text-sm">
                <Badge status={approvalReq.status} /> · {approvalReq.decisions.length}/{approvalReq.requiredApprovals} approvals
              </div>
              <div className="text-xs text-stone-500 mt-1">Eligible: {approvalReq.eligibleRoleKeys}</div>
              {approvalReq.status === "PENDING" && (
                <form action={approveDecision.bind(null, inv.id, approvalReq.id, "APPROVE")} className="mt-3 space-y-2">
                  <input className="input text-xs" name="comment" placeholder="Comment (optional)" />
                  <div className="flex gap-2">
                    <button className="btn btn-primary text-sm flex-1">Approve</button>
                    <button formAction={approveDecision.bind(null, inv.id, approvalReq.id, "REJECT")} className="btn btn-danger text-sm flex-1">Reject</button>
                  </div>
                </form>
              )}
            </div>
          )}

          {inv.status === "DRAFT" && (
            <form action={submitAction.bind(null, inv.id)} className="card card-body">
              <h3 className="font-medium">Submit for approval</h3>
              <button className="btn btn-primary mt-3 w-full">Submit</button>
            </form>
          )}

          {(inv.status === "APPROVED" || (inv.status === "PENDING_APPROVAL" && approvalReq?.status === "APPROVED")) && canPost && (
            <form action={postAction.bind(null, inv.id)} className="card card-body">
              <h3 className="font-medium">Post to GL</h3>
              <p className="mt-1 text-sm text-stone-500">Generates the balanced journal entry.</p>
              <button className="btn btn-primary mt-3 w-full">Post</button>
            </form>
          )}

          {(inv.status === "POSTED" || inv.status === "PARTIALLY_PAID") && canPay && (
            <form action={payAction.bind(null, inv.id)} className="card card-body">
              <h3 className="font-medium">Make payment</h3>
              <div className="mt-3 space-y-2">
                <div>
                  <label className="label">Amount</label>
                  <input className="input font-mono" type="number" step="0.01" min="0" name="amount" defaultValue={outstanding.toFixed(2)} max={outstanding} />
                </div>
                <div>
                  <label className="label">Method</label>
                  <select className="select" name="method" defaultValue={inv.vendor.paymentMethod}>
                    <option value="EFT">EFT</option>
                    <option value="CHEQUE">Cheque</option>
                    <option value="CC">Credit card</option>
                    <option value="CASH">Cash</option>
                  </select>
                </div>
              </div>
              <button className="btn btn-primary mt-3 w-full">Process payment</button>
            </form>
          )}

          {(inv.status === "POSTED" || inv.status === "PARTIALLY_PAID") && canVoid && (
            <form action={reverseAction.bind(null, inv.id)} className="card card-body">
              <h3 className="font-medium">Reverse / void</h3>
              <textarea className="textarea mt-2" name="reason" rows={2} placeholder="Reason" required />
              <button className="btn btn-danger mt-3 w-full">Reverse invoice</button>
            </form>
          )}

          {inv.status !== "VOIDED" && canVoid && (
            <form action={disputeAction.bind(null, inv.id)} className="card card-body">
              <h3 className="font-medium">Dispute</h3>
              <textarea className="textarea mt-2" name="note" rows={2} placeholder="Dispute note" required />
              <button className="btn btn-secondary mt-3 w-full">Mark disputed</button>
            </form>
          )}
        </div>
      </div>

      <div className="mt-8 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">Payments</div>
        <table className="table-base">
          <thead><tr><th>Payment #</th><th>Date</th><th>Method</th><th>Status</th><th className="text-right">Amount</th></tr></thead>
          <tbody>
            {inv.payments.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-stone-500">No payments.</td></tr>}
            {inv.payments.map((pay) => (
              <tr key={pay.id}>
                <td className="font-mono text-xs">{pay.paymentNumber}</td>
                <td>{formatDate(pay.paymentDate)}</td>
                <td>{pay.method}</td>
                <td><Badge status={pay.status} /></td>
                <td className="text-right tabular-nums">{fmtMoney(pay.amount as unknown as number)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
