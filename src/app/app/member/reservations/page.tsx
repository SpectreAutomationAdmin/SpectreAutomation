// Member-side reservation hub: upcoming reservations, recent dining
// history, and a quick "book a new reservation" entry point.

import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { getActiveMember } from "@/lib/active-member";
import {
  listUpcomingReservationsForMember,
  listPastReservationsForMember,
} from "@/lib/hospitality/reservations";
import { formatCurrency, formatDateTime } from "@/lib/finance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function MemberReservationsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const member = await getActiveMember(user);
  if (!member) redirect(user.role === "MEMBER" ? "/login" : "/app/admin");

  const [upcoming, past] = await Promise.all([
    listUpcomingReservationsForMember(member.id, 10),
    listPastReservationsForMember(member.id, 25),
  ]);

  return (
    <div className="max-w-4xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">Dining reservations</h1>
          <p className="mt-1 text-sm text-stone-500">Lounge bookings and your recent dining history.</p>
        </div>
        <Link href="/app/member/reservations/new" className="btn btn-primary btn-sm">Book a reservation</Link>
      </div>

      <section className="mt-6">
        <h2 className="section-title text-lg">Upcoming</h2>
        {upcoming.length === 0 ? (
          <div className="mt-3 card card-body text-sm text-stone-500">
            No upcoming reservations. Tap <span className="font-medium">Book a reservation</span> to plan a visit.
          </div>
        ) : (
          <div className="mt-3 grid grid-cols-1 gap-3">
            {upcoming.map((r) => (
              <Link
                key={r.id}
                href={`/app/member/reservations/${r.id}`}
                className="card card-body flex items-center justify-between gap-4 hover:border-stone-400"
              >
                <div>
                  <div className="font-medium">{formatDateTime(r.startTime)}</div>
                  <div className="text-xs text-stone-500">
                    {r.diningArea.name} · party of {r.partySize}
                    {r.occasion ? ` · ${r.occasion}` : ""}
                  </div>
                </div>
                <span className={`inline-flex rounded-md border px-2 py-1 text-[10px] uppercase tracking-wide ${badgeTone(r.status)}`}>
                  {r.status.replace("_", " ")}
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="mt-8">
        <h2 className="section-title text-lg">Recent visits</h2>
        {past.length === 0 ? (
          <div className="mt-3 card card-body text-sm text-stone-500">
            No previous dining visits on record yet.
          </div>
        ) : (
          <div className="mt-3 card overflow-hidden">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Area</th>
                  <th>Party</th>
                  <th>Status</th>
                  <th className="text-right">Spend</th>
                </tr>
              </thead>
              <tbody>
                {past.map((r) => {
                  const spend = r.checkLinks.reduce(
                    (sum, l) => sum + (l.posSale?.grandTotal ? Number(l.posSale.grandTotal.toString()) : 0),
                    0,
                  );
                  return (
                    <tr key={r.id}>
                      <td className="text-xs">{formatDateTime(r.startTime)}</td>
                      <td className="text-xs">{r.diningArea.name}</td>
                      <td className="text-sm">{r.partySize}</td>
                      <td className="text-xs">
                        <span className={`inline-flex rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wide ${badgeTone(r.status)}`}>
                          {r.status.replace("_", " ")}
                        </span>
                      </td>
                      <td className="text-xs text-right tabular-nums">{spend > 0 ? formatCurrency(spend) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
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
