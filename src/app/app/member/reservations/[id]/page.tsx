// Member view of a single reservation. The member can cancel up to
// the cutoff defined in ReservationSettings; everything else is host
// territory.

import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveMember } from "@/lib/active-member";
import {
  getReservation,
  cancelReservation,
  getReservationSettings,
} from "@/lib/hospitality/reservations";
import { formatCurrency, formatDateTime } from "@/lib/finance";
import { isAppError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function cancelAction(id: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try {
    await cancelReservation(p, id, String(formData.get("reason") ?? ""));
  } catch (err) {
    if (isAppError(err)) {
      redirect(`/app/member/reservations/${id}?error=${encodeURIComponent(err.safeMessage)}`);
    }
    throw err;
  }
  revalidatePath(`/app/member/reservations/${id}`);
  revalidatePath(`/app/member/reservations`);
  redirect(`/app/member/reservations?cancelled=1`);
}

export default async function MemberReservationDetailPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { booked?: string; error?: string };
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const member = await getActiveMember(user);
  if (!member) redirect("/login");
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");

  let r: Awaited<ReturnType<typeof getReservation>>;
  try { r = await getReservation(principal, params.id); }
  catch { notFound(); }
  if (!r || r.memberId !== member.id) notFound();

  const settings = await getReservationSettings(member.clubId);
  const cutoffMs = r.startTime.getTime() - settings.cancellationCutoffHours * 60 * 60 * 1000;
  const canCancel =
    (r.status === "CONFIRMED" || r.status === "REQUESTED") &&
    Date.now() < cutoffMs;

  const cancel = cancelAction.bind(null, r.id);

  const linkedSpend = r.checkLinks.reduce(
    (sum, l) => sum + (l.posSale?.grandTotal ? Number(l.posSale.grandTotal.toString()) : 0),
    0,
  );

  return (
    <div className="max-w-2xl">
      <Link href="/app/member/reservations" className="text-sm text-stone-500 hover:text-club-ink">← My reservations</Link>

      {searchParams.booked === "1" && (
        <div className="mt-4 rounded-md border border-club-green-300 bg-club-green-50 px-3 py-2 text-sm text-club-green-800">
          Your reservation is confirmed. We&rsquo;ve emailed you the details.
        </div>
      )}
      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <h1 className="mt-3 page-title">{formatDateTime(r.startTime)}</h1>
      <p className="mt-1 text-sm text-stone-500">{r.diningArea.name} · party of {r.partySize}</p>

      <dl className="mt-6 card card-body grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
        <DT label="Status">
          <span className={`inline-flex rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wide ${badgeTone(r.status)}`}>
            {r.status.replace("_", " ")}
          </span>
        </DT>
        <DT label="Occasion">{r.occasion ?? "—"}</DT>
        <DT label="Special requests">{r.specialRequests ?? "—"}</DT>
        <DT label="Confirmation email">
          {r.confirmationEmailStatus
            ? `${r.confirmationEmailStatus}${r.confirmationEmailAddress ? ` → ${r.confirmationEmailAddress}` : ""}`
            : settings.confirmationEmailEnabled ? "Pending" : "Disabled at club level"}
        </DT>
        {(r.status === "COMPLETED" || r.status === "SEATED") && r.actualSeatedAt && (
          <>
            <DT label="Seated">{formatDateTime(r.actualSeatedAt)}</DT>
            <DT label="Departed">{r.actualDepartedAt ? formatDateTime(r.actualDepartedAt) : "In progress"}</DT>
            <DT label="Spend on this visit">{linkedSpend > 0 ? formatCurrency(linkedSpend) : "—"}</DT>
          </>
        )}
      </dl>

      <div className="mt-6 card card-body space-y-3 text-sm">
        <h2 className="section-title text-base">Reminders</h2>
        <div>
          <div className="text-xs uppercase tracking-wide text-stone-500">Dress code</div>
          <p className="mt-1 text-stone-700">{settings.dressCodeText}</p>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-stone-500">Cancellation policy</div>
          <p className="mt-1 text-stone-700">{settings.noShowPolicyText}</p>
        </div>
      </div>

      {canCancel ? (
        <form action={cancel} className="mt-6 card card-body space-y-3 text-sm">
          <h2 className="section-title text-base">Need to cancel?</h2>
          <p className="text-xs text-stone-500">
            Cancellations close {settings.cancellationCutoffHours} hour(s) before the
            reservation. After that, please call the Clubhouse.
          </p>
          <textarea name="reason" rows={2} maxLength={500} placeholder="Reason (optional)" className="input text-sm" />
          <div className="flex justify-end">
            <button className="btn btn-secondary btn-sm">Cancel my reservation</button>
          </div>
        </form>
      ) : (
        (r.status === "CONFIRMED" || r.status === "REQUESTED") && (
          <p className="mt-4 text-xs text-stone-500">
            Cancellation window has closed. Please call the Clubhouse for changes.
          </p>
        )
      )}
    </div>
  );
}

function DT({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-stone-500">{label}</dt>
      <dd className="mt-1 text-club-ink">{children}</dd>
    </div>
  );
}
function badgeTone(status: string): string {
  const m: Record<string, string> = {
    REQUESTED: "bg-stone-100 text-stone-700 border-stone-300",
    CONFIRMED: "bg-blue-50 text-blue-800 border-blue-300",
    SEATED: "bg-club-green-50 text-club-green-800 border-club-green-300",
    COMPLETED: "bg-stone-100 text-stone-600 border-stone-300",
    CANCELLED: "bg-stone-100 text-stone-500 border-stone-300",
    NO_SHOW: "bg-red-50 text-red-800 border-red-300",
  };
  return m[status] ?? "bg-stone-100 text-stone-700 border-stone-300";
}
