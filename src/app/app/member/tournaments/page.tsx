// Phase 10F — Member-facing tournament index. Mobile-friendly.
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/Badge";
import { fmtMoney } from "@/lib/accounting/format";
import { formatDate } from "@/lib/finance";

export default async function MemberTournamentsPage() {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = p.activeClubId;
  if (!clubId) redirect("/app/member");

  const tournaments = await prisma.tournament.findMany({
    where: { clubId, status: { in: ["OPEN", "LOCKED", "IN_PROGRESS"] } },
    orderBy: { startDate: "asc" },
    include: { _count: { select: { registrations: true } } },
  });

  const myRegs = p.memberId ? await prisma.tournamentRegistration.findMany({
    where: { memberId: p.memberId, status: { in: ["REGISTERED", "CONFIRMED"] } },
    include: { tournament: true },
  }) : [];

  return (
    <div>
      <h1 className="page-title">Tournaments</h1>
      <p className="mt-1 text-stone-500">Upcoming events at your club.</p>

      {myRegs.length > 0 && (
        <div className="mt-6 card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Your registrations</div>
          <ul className="divide-y divide-stone-200">
            {myRegs.map((r) => (
              <li key={r.id} className="px-6 py-4 text-sm flex items-center justify-between">
                <div>
                  <Link href={`/app/member/tournaments/${r.tournamentId}`} className="font-medium hover:text-club-green-700">{r.tournament.name}</Link>
                  <div className="mt-1 text-xs text-stone-500">{formatDate(r.tournament.startDate)} · {r.tournament.format}</div>
                </div>
                <Badge status={r.status} />
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-5">
        {tournaments.length === 0 && (
          <div className="card card-body text-stone-500">No open tournaments at the moment.</div>
        )}
        {tournaments.map((t) => (
          <Link key={t.id} href={`/app/member/tournaments/${t.id}`} className="card card-body hover:shadow-elevated transition-shadow">
            <div className="flex items-center justify-between">
              <div className="font-serif text-xl">{t.name}</div>
              <Badge status={t.status} />
            </div>
            <div className="mt-2 text-xs text-stone-500">{t.format} · {formatDate(t.startDate)} – {formatDate(t.endDate)}</div>
            <div className="mt-3 flex items-center justify-between text-sm">
              <span className="text-stone-600">Entry {fmtMoney(t.entryFee as unknown as number, { showZero: true })}</span>
              <span className="text-stone-500">{t._count.registrations} registered{t.maxParticipants ? ` / ${t.maxParticipants}` : ""}</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
