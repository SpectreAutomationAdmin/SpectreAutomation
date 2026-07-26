// Member booking flow. No payment at booking; the member acknowledges
// the dress-code and no-show policy before submit, and the
// confirmation email reminds them again.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveMember } from "@/lib/active-member";
import {
  getReservationSettings,
  createMemberReservation,
} from "@/lib/hospitality/reservations";
import { prisma } from "@/lib/prisma";
import { isAppError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function bookAction(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const member = await getActiveMember(user);
  if (!member) redirect("/login");

  const date = String(formData.get("date") ?? "");
  const time = String(formData.get("time") ?? "");
  const startIso = `${date}T${time}:00`;
  try {
    const r = await createMemberReservation(principal, member.clubId, {
      memberId: member.id,
      reservationType: "MEMBER",
      startTime: startIso,
      partySize: Number(formData.get("partySize") ?? 2),
      diningAreaId: String(formData.get("diningAreaId") ?? ""),
      tableId: null,
      specialRequests: String(formData.get("specialRequests") ?? ""),
      occasion: String(formData.get("occasion") ?? ""),
      dressCodeAcknowledged: formData.get("ackDressCode") === "on",
      noShowFeeAcknowledged: formData.get("ackNoShow") === "on",
    });
    revalidatePath("/app/member/reservations");
    if (r) redirect(`/app/member/reservations/${r.id}?booked=1`);
  } catch (err) {
    if (isAppError(err)) {
      redirect(`/app/member/reservations/new?error=${encodeURIComponent(err.safeMessage)}`);
    }
    throw err;
  }
}

export default async function NewReservationPage({ searchParams }: { searchParams: { error?: string } }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const member = await getActiveMember(user);
  if (!member) redirect("/login");

  const [settings, areas] = await Promise.all([
    getReservationSettings(member.clubId),
    prisma.diningArea.findMany({
      where: { clubId: member.clubId, active: true },
      orderBy: { sortOrder: "asc" },
    }),
  ]);

  // Earliest bookable date is today; latest is settings.advanceBookingDays out.
  const today = new Date().toISOString().slice(0, 10);
  const maxDate = new Date(Date.now() + settings.advanceBookingDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  return (
    <div className="max-w-2xl">
      <h1 className="page-title">Book a reservation</h1>
      <p className="mt-1 text-sm text-stone-500">
        Reservations can be made up to {settings.advanceBookingDays} days in advance.
        Parties larger than {settings.maxPartySizeOnline} guests must call the club.
      </p>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <form action={bookAction} className="mt-6 card card-body space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="label">Date</label>
            <input type="date" name="date" min={today} max={maxDate} required className="input text-sm" defaultValue={today} />
          </div>
          <div>
            <label className="label">Time</label>
            <input type="time" name="time" required className="input text-sm" defaultValue="18:00" />
          </div>
          <div>
            <label className="label">Party size</label>
            <input type="number" name="partySize" min={1} max={settings.maxPartySizeOnline} required defaultValue={2} className="input text-sm" />
          </div>
          <div>
            <label className="label">Dining area</label>
            <select name="diningAreaId" required defaultValue={areas[0]?.id ?? ""} className="select text-sm">
              {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label className="label">Occasion (optional)</label>
          <input name="occasion" maxLength={120} className="input text-sm" placeholder="Birthday, anniversary, business…" />
        </div>
        <div>
          <label className="label">Special requests (optional)</label>
          <textarea name="specialRequests" rows={3} maxLength={2000} className="input text-sm" placeholder="Allergies, seating preferences, etc." />
        </div>

        <div className="space-y-3 pt-3 border-t border-stone-100 text-sm">
          <h2 className="section-title text-base">Before you book</h2>

          <div className="rounded-md bg-stone-50 px-3 py-2">
            <div className="text-xs font-medium uppercase tracking-wide text-stone-600">Clubhouse dress code</div>
            <p className="mt-1 text-xs text-stone-700">{settings.dressCodeText}</p>
            <label className="mt-2 flex items-start gap-2 text-xs">
              <input type="checkbox" name="ackDressCode" required className="mt-0.5" />
              <span>I have read and will observe the Clubhouse dress code.</span>
            </label>
          </div>

          <div className="rounded-md bg-stone-50 px-3 py-2">
            <div className="text-xs font-medium uppercase tracking-wide text-stone-600">Cancellation policy</div>
            <p className="mt-1 text-xs text-stone-700">{settings.noShowPolicyText}</p>
            {settings.noShowFeeEnabled && (
              <p className="mt-1 text-xs text-stone-700">
                Missed reservations may be charged a no-show fee to my member account.
              </p>
            )}
            <label className="mt-2 flex items-start gap-2 text-xs">
              <input type="checkbox" name="ackNoShow" required className="mt-0.5" />
              <span>I understand the cancellation policy.</span>
            </label>
          </div>
        </div>

        <div className="flex justify-end pt-3 border-t border-stone-100">
          <button type="submit" className="btn btn-primary">Book reservation</button>
        </div>
      </form>
    </div>
  );
}
