// Hospitality landing — a module hub that ties the dining workflows
// (reservations, floor map, analytics, feedback) into one entry point
// so a founder / hostess never has to memorise sub-routes.

import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { tenantWhere } from "@/lib/services/tenant";
import { getReservationSettings } from "@/lib/hospitality/reservations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function HospitalityHomePage() {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!hasPermission(principal, clubId, "reservations:read")) redirect("/app/admin");

  // Cheap counters so the cards feel alive rather than static.
  const now = new Date();
  const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart); dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
  const monthStart = new Date(now); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const tenant = tenantWhere(principal, clubId);

  const [todayCount, seatedCount, openFeedbackCount, monthRatingAgg, settings] = await Promise.all([
    prisma.diningReservation.count({
      where: { ...tenant, startTime: { gte: dayStart, lt: dayEnd } },
    }),
    prisma.diningReservation.count({
      where: { ...tenant, status: "SEATED" },
    }),
    prisma.hospitalitySurveyResponse.count({
      where: { clubId, serviceRecoveryStatus: { in: ["NEEDS_REVIEW", "IN_PROGRESS"] } },
    }),
    prisma.hospitalitySurveyResponse.aggregate({
      where: { clubId, submittedAt: { gte: monthStart } },
      _avg: { rating: true },
      _count: { _all: true },
    }),
    getReservationSettings(clubId),
  ]);

  const canSeeFeedback = hasPermission(principal, clubId, "settings:read");

  return (
    <div>
      <h1 className="page-title">Hospitality</h1>
      <p className="mt-1 text-stone-500 max-w-2xl">
        Lounge reservations, walk-ins, floor-level seating control, dining
        analytics, and member feedback — everything the F&amp;B team needs in one place.
      </p>

      {/* At-a-glance counters */}
      <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-3">
        <Counter label="Today's reservations" value={String(todayCount)} />
        <Counter label="Seated right now" value={String(seatedCount)} tone={seatedCount > 0 ? "green" : undefined} />
        <Counter label="Avg rating (MTD)" value={monthRatingAgg._count._all > 0 ? Number(monthRatingAgg._avg.rating ?? 0).toFixed(2) : "—"} sub={monthRatingAgg._count._all > 0 ? `${monthRatingAgg._count._all} responses` : undefined} />
        <Counter label="Open feedback" value={String(openFeedbackCount)} tone={openFeedbackCount > 0 ? "amber" : undefined} sub={openFeedbackCount > 0 ? "needs follow-up" : undefined} />
      </div>

      {/* Module cards — discoverability is the whole point of this page. */}
      <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card
          href="/app/admin/hospitality/reservations"
          title="Reservations"
          body="Today's bookings + walk-ins. Add a reservation, add a walk-in, mark no-shows, change tables."
        />
        <Card
          href="/app/admin/hospitality/reservations/floor"
          title="Floor map"
          body="Visual hostess seating map. Click a table to seat a party, open a POS check, or reset the table."
        />
        <Card
          href="/app/admin/hospitality/reservations/analytics"
          title="Reservation analytics"
          body="Covers, avg duration, avg spend per cover, no-show rate, ratings — trended vs the prior window."
        />
        {canSeeFeedback && (
          <Card
            href="/app/admin/hospitality/feedback"
            title="Member feedback"
            body="Survey responses from receipt emails. Service-recovery queue for anything below 5/5."
          />
        )}
      </div>

      {/* Settings hint */}
      <div className="mt-8 rounded-md border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-stone-700">
        <div className="text-xs uppercase tracking-wide text-stone-500">Reservation settings</div>
        <div className="mt-1">
          No-show fee: <span className="font-medium">{settings.noShowFeeEnabled ? `$${Number(settings.noShowFeeAmount.toString()).toFixed(2)}` : "disabled"}</span>{" · "}
          Online max party: <span className="font-medium">{settings.maxPartySizeOnline}</span>{" · "}
          Advance horizon: <span className="font-medium">{settings.advanceBookingDays} days</span>{" · "}
          Cancellation cutoff: <span className="font-medium">{settings.cancellationCutoffHours} hr</span>
        </div>
      </div>
    </div>
  );
}

function Counter({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "green" | "amber" | "red" }) {
  const toneCls =
    tone === "red" ? "border-red-200 bg-red-50" :
    tone === "amber" ? "border-amber-200 bg-amber-50" :
    tone === "green" ? "border-club-green-300 bg-club-green-50" :
    "border-stone-200 bg-white";
  return (
    <div className={`rounded-md border px-3 py-2 ${toneCls}`}>
      <div className="text-[10px] uppercase tracking-wide text-stone-500">{label}</div>
      <div className="mt-1 font-serif text-xl text-stone-900">{value}</div>
      {sub && <div className="text-[10px] text-stone-500">{sub}</div>}
    </div>
  );
}

function Card({ href, title, body }: { href: string; title: string; body: string }) {
  return (
    <Link href={href} className="card card-body hover:shadow-elevated transition-shadow">
      <div className="font-serif text-xl">{title}</div>
      <p className="mt-2 text-sm text-stone-600">{body}</p>
      <span className="mt-3 text-sm text-club-green-700">Open →</span>
    </Link>
  );
}
