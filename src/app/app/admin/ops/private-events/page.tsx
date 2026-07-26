import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { privateEventService } from "@/lib/ops";
import { isAppError } from "@/lib/errors";
import { Badge } from "@/components/Badge";
import { fmtMoney } from "@/lib/accounting/format";
import { formatDate } from "@/lib/finance";

async function bookingAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try {
    await privateEventService.createBooking(p, clubId, {
      customerName: String(formData.get("customerName") ?? ""),
      customerEmail: String(formData.get("customerEmail") ?? ""),
      eventName: String(formData.get("eventName") ?? ""),
      eventStart: String(formData.get("eventStart") ?? ""),
      eventEnd: String(formData.get("eventEnd") ?? ""),
      headCount: Number(formData.get("headCount") ?? 0),
      depositAmount: Number(formData.get("depositAmount") ?? 0),
      totalAmount: Number(formData.get("totalAmount") ?? 0),
    });
  } catch (err) { if (isAppError(err)) redirect(`/app/admin/ops/private-events?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/ops/private-events");
}

async function depositAction(bookingId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try {
    await privateEventService.postDeposit(p, bookingId, {
      amount: Number(formData.get("amount") ?? 0),
      method: String(formData.get("method") ?? "EFT") as "EFT" | "CC" | "CHEQUE" | "CASH" | "OTHER",
    });
  } catch (err) { if (isAppError(err)) redirect(`/app/admin/ops/private-events?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/ops/private-events");
}

async function billAction(bookingId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await privateEventService.postFinalBilling(p, bookingId); }
  catch (err) { if (isAppError(err)) redirect(`/app/admin/ops/private-events?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/ops/private-events");
}

async function confirmAction(bookingId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await privateEventService.confirmBooking(p, bookingId); }
  catch (err) { if (isAppError(err)) redirect(`/app/admin/ops/private-events?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/ops/private-events");
}

export default async function PrivateEventsPage({ searchParams }: { searchParams: { error?: string } }) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "events:private:read") && !hasPermission(p, clubId, "events:private:manage")) redirect("/app/admin");
  const canManage = hasPermission(p, clubId, "events:private:manage");

  const [bookings, inquiries] = await Promise.all([
    prisma.privateEventBooking.findMany({ where: { clubId }, include: { deposits: true }, orderBy: { eventStart: "desc" }, take: 50 }),
    prisma.privateEventInquiry.findMany({ where: { clubId, status: { in: ["NEW", "REVIEWED"] } }, orderBy: { createdAt: "desc" }, take: 20 }),
  ]);

  return (
    <div>
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="page-title">Private Events</h1>
          <p className="mt-1 text-stone-500">Inquiries, bookings, deposits, and final billing.</p>
        </div>
      </div>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      {inquiries.length > 0 && (
        <div className="mt-6 card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Open inquiries ({inquiries.length})</div>
          <table className="table-base">
            <thead><tr><th>From</th><th>Preferred date</th><th>Headcount</th><th>Status</th></tr></thead>
            <tbody>
              {inquiries.map((i) => (
                <tr key={i.id}>
                  <td>{i.inquirerName}<div className="text-xs text-stone-500">{i.inquirerEmail}</div></td>
                  <td>{i.preferredDate ? formatDate(i.preferredDate) : "—"}</td>
                  <td>{i.headCount ?? "—"}</td>
                  <td><Badge status={i.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Bookings</div>
          <table className="table-base">
            <thead><tr><th>Number</th><th>Event</th><th>Date</th><th>Customer</th><th className="text-right">Total</th><th className="text-right">Deposit</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {bookings.length === 0 && <tr><td colSpan={8} className="px-4 py-6 text-center text-stone-500">No bookings yet.</td></tr>}
              {bookings.map((b) => {
                const depositPaid = Number(b.depositPaidAmount.toString());
                return (
                  <tr key={b.id}>
                    <td className="font-mono text-xs">{b.bookingNumber}</td>
                    <td>{b.eventName}</td>
                    <td>{formatDate(b.eventStart)}</td>
                    <td>{b.customerName}</td>
                    <td className="text-right tabular-nums">{fmtMoney(b.totalAmount as unknown as number)}</td>
                    <td className="text-right tabular-nums">{fmtMoney(depositPaid)}</td>
                    <td><Badge status={b.status} /></td>
                    <td className="text-right space-x-1 text-xs">
                      {canManage && b.status === "DRAFT" && (
                        <form action={confirmAction.bind(null, b.id)} className="inline">
                          <button className="text-club-green-700 hover:underline">Confirm</button>
                        </form>
                      )}
                      {canManage && b.status !== "COMPLETED" && b.status !== "CANCELLED" && (
                        <>
                          <form action={depositAction.bind(null, b.id)} className="inline-flex items-center gap-1">
                            <input className="input inline-block w-20 font-mono text-xs" type="number" step="0.01" min="0" name="amount" placeholder="Deposit" />
                            <button className="text-blue-700 hover:underline">+Deposit</button>
                          </form>
                          {b.status === "CONFIRMED" && (
                            <form action={billAction.bind(null, b.id)} className="inline">
                              <button className="text-club-green-700 hover:underline">Bill</button>
                            </form>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {canManage && (
          <form action={bookingAction} className="card card-body h-fit space-y-3">
            <h2 className="section-title text-lg">New booking</h2>
            <div>
              <label className="label">Customer name</label>
              <input className="input" name="customerName" required maxLength={200} />
            </div>
            <div>
              <label className="label">Customer email</label>
              <input className="input" type="email" name="customerEmail" maxLength={254} />
            </div>
            <div>
              <label className="label">Event name</label>
              <input className="input" name="eventName" required maxLength={200} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div><label className="label">Start</label><input className="input" type="datetime-local" name="eventStart" required /></div>
              <div><label className="label">End</label><input className="input" type="datetime-local" name="eventEnd" required /></div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div><label className="label">Heads</label><input className="input" type="number" min="0" name="headCount" defaultValue={50} /></div>
              <div><label className="label">Deposit</label><input className="input font-mono" type="number" step="0.01" min="0" name="depositAmount" /></div>
              <div><label className="label">Total</label><input className="input font-mono" type="number" step="0.01" min="0" name="totalAmount" /></div>
            </div>
            <button className="btn btn-primary">Create booking</button>
          </form>
        )}
      </div>

      <div className="mt-6 text-xs text-stone-500">
        Deposits land in <span className="font-mono">2230 Private Event Deposits</span> (liability). Final billing recognises revenue and clears that liability — any remainder is charged to the member AR control (1110).
      </div>
    </div>
  );
}
