// Phase 10F — Member-facing tournament detail (register, view pairings + leaderboard).
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { isAppError } from "@/lib/errors";
import { registerForTournament, cancelRegistration, getTournament } from "@/lib/tournament";
import { Badge } from "@/components/Badge";
import { fmtMoney } from "@/lib/accounting/format";
import { formatDate } from "@/lib/finance";
import { prisma } from "@/lib/prisma";

async function registerAction(tournamentId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  if (!p.memberId) redirect(`/app/member/tournaments/${tournamentId}?error=Members+only`);
  try { await registerForTournament(p, tournamentId, { memberId: p.memberId }); }
  catch (err) { if (isAppError(err)) redirect(`/app/member/tournaments/${tournamentId}?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath(`/app/member/tournaments/${tournamentId}`);
}

async function withdrawAction(registrationId: string, tournamentId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  await cancelRegistration(p, registrationId, "Member self-withdrawal");
  revalidatePath(`/app/member/tournaments/${tournamentId}`);
}

export default async function MemberTournamentDetail({ params, searchParams }: { params: { id: string }; searchParams: { error?: string } }) {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  let t;
  try { t = await getTournament(p, params.id); } catch { notFound(); }
  const myReg = p.memberId
    ? t.registrations.find((r) => r.memberId === p.memberId && r.status !== "CANCELLED")
    : null;
  const pairings = await prisma.tournamentPairing.findMany({
    where: { tournamentId: t.id },
    orderBy: [{ roundId: "asc" }, { groupNumber: "asc" }],
  });

  return (
    <div>
      <Link href="/app/member/tournaments" className="text-sm text-stone-500 hover:text-club-ink">← Tournaments</Link>
      <h1 className="mt-3 page-title">{t.name}</h1>
      <div className="mt-2 flex items-center gap-2 text-sm flex-wrap">
        <Badge status={t.status} />
        <span>{t.format}</span>
        <span className="text-stone-400">·</span>
        <span>{formatDate(t.startDate)} – {formatDate(t.endDate)}</span>
        <span className="text-stone-400">·</span>
        <span>Entry {fmtMoney(t.entryFee as unknown as number, { showZero: true })}</span>
      </div>
      {t.description && <p className="mt-4 text-sm text-stone-700">{t.description}</p>}

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <div className="mt-6 card card-body">
        <h2 className="section-title text-lg">Your registration</h2>
        {myReg ? (
          <div className="mt-3 flex items-center justify-between text-sm">
            <div>
              <Badge status={myReg.status} />
              <span className="ml-2 text-stone-600">Registered {formatDate(myReg.registeredAt)}</span>
              {myReg.feeChargeId && <span className="ml-3 text-xs text-stone-500">Entry fee posted to your account</span>}
            </div>
            <form action={withdrawAction.bind(null, myReg.id, t.id)}>
              <button className="text-red-600 text-sm hover:underline">Withdraw</button>
            </form>
          </div>
        ) : t.status === "OPEN" ? (
          <form action={registerAction.bind(null, t.id)} className="mt-3">
            <button className="btn btn-primary">Register me ({fmtMoney(t.entryFee as unknown as number, { showZero: true })})</button>
          </form>
        ) : (
          <p className="mt-2 text-sm text-stone-500">Registration is not open.</p>
        )}
      </div>

      {pairings.length > 0 && (
        <div className="mt-8 card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Pairings</div>
          <ul className="divide-y divide-stone-200">
            {pairings.map((p) => (
              <li key={p.id} className="px-6 py-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium">Group {p.groupNumber}</span>
                  <span className="text-xs text-stone-500">Round {p.roundId.slice(-6)}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {t.leaderboards.length > 0 && (
        <div className="mt-8 card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Leaderboard</div>
          <table className="table-base">
            <thead><tr><th>Rank</th><th>Player</th><th className="text-right">Total</th></tr></thead>
            <tbody>
              {t.leaderboards.slice(0, 50).map((row) => {
                const reg = t.registrations.find((r) => r.id === row.registrationId);
                return (
                  <tr key={row.id}>
                    <td className="text-xs">{row.positionRank}</td>
                    <td>{reg?.member ? `${reg.member.firstName} ${reg.member.lastName}` : (reg?.guestFirstName ? `${reg.guestFirstName} ${reg.guestLastName}` : "—")}</td>
                    <td className="text-right tabular-nums">{row.totalStrokes}</td>
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
