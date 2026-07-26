// Phase 11E — Member-facing tournament scoring (hole-by-hole).
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { isAppError } from "@/lib/errors";
import { saveDraft, submitDraft, getDraft } from "@/lib/tournament/scoring";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/Badge";

async function saveAction(tournamentId: string, roundId: string, registrationId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const scores: Record<string, number> = {};
  for (let h = 1; h <= 18; h++) {
    const v = formData.get(`hole-${h}`);
    if (v != null && v !== "") scores[h.toString()] = Number(v);
  }
  try { await saveDraft(p, { tournamentId, roundId, registrationId, scores }); }
  catch (err) { if (isAppError(err)) redirect(`/app/member/tournaments/${tournamentId}/score/${roundId}?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath(`/app/member/tournaments/${tournamentId}/score/${roundId}`);
}

async function submitAction(tournamentId: string, roundId: string, registrationId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await submitDraft(p, registrationId, roundId); }
  catch (err) { if (isAppError(err)) redirect(`/app/member/tournaments/${tournamentId}/score/${roundId}?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath(`/app/member/tournaments/${tournamentId}/score/${roundId}`);
}

export default async function MemberScorePage({ params, searchParams }: { params: { id: string; roundId: string }; searchParams: { error?: string } }) {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  if (!p.memberId) redirect("/app/member");
  // Locate the member's registration for this tournament.
  const reg = await prisma.tournamentRegistration.findFirst({
    where: { tournamentId: params.id, memberId: p.memberId, status: { in: ["REGISTERED", "CONFIRMED"] } },
  });
  if (!reg) notFound();
  const round = await prisma.tournamentRound.findUnique({ where: { id: params.roundId } });
  if (!round || round.tournamentId !== params.id) notFound();
  const draft = await getDraft(p, reg.id, round.id);
  const scores = draft ? (JSON.parse(draft.scoresJson) as Record<string, number>) : {};
  const total = Object.values(scores).reduce((s, v) => s + v, 0);
  // Phase 13G — surface any open conflict so the member knows their offline
  // changes haven't been merged yet. Resolution happens admin-side.
  const openConflict = draft ? await prisma.tournamentScoreConflict.findFirst({
    where: { draftId: draft.id, resolution: "PENDING" },
    orderBy: { detectedAt: "desc" },
  }) : null;

  return (
    <div>
      <Link href={`/app/member/tournaments/${params.id}`} className="text-sm text-stone-500 hover:text-club-ink">← Tournament</Link>
      <h1 className="mt-3 page-title">Round {round.roundNumber} — Score Entry</h1>
      {draft && <p className="mt-1 text-stone-500"><Badge status={draft.status} /> · Auto-saves on every change</p>}

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      {openConflict && (
        <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <div className="font-medium">Sync conflict detected</div>
          <p className="mt-1">Your offline device tried to save scores that didn't match the server (your copy was version {openConflict.clientVersion}, server was {openConflict.serverVersion}). A tournament admin will reconcile both sides; the values shown below are the latest server-side scores.</p>
        </div>
      )}

      <form action={saveAction.bind(null, params.id, round.id, reg.id)} className="mt-6 card card-body">
        <h2 className="section-title text-lg">Hole-by-hole</h2>
        <div className="mt-4 grid grid-cols-3 md:grid-cols-6 gap-3">
          {Array.from({ length: 18 }).map((_, idx) => {
            const h = idx + 1;
            return (
              <label key={h} className="text-sm">
                <span className="block text-xs text-stone-500">Hole {h}</span>
                <input
                  type="number" min="1" max="20"
                  name={`hole-${h}`}
                  defaultValue={scores[h.toString()] ?? ""}
                  className="input font-mono text-center text-lg mt-1"
                  disabled={draft?.status === "ACCEPTED"}
                />
              </label>
            );
          })}
        </div>
        <div className="mt-4 flex items-center justify-between text-sm">
          <span className="text-stone-500">Total so far: <span className="font-mono text-lg text-club-ink">{total || "—"}</span></span>
          <button className="btn btn-primary" disabled={draft?.status === "ACCEPTED"}>Save draft</button>
        </div>
      </form>

      {draft?.status === "DRAFT" && (
        <form action={submitAction.bind(null, params.id, round.id, reg.id)} className="mt-6">
          <button className="btn btn-secondary w-full">Submit for review</button>
        </form>
      )}
    </div>
  );
}
