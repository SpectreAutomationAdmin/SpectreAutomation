import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { isAppError } from "@/lib/errors";
import { listTournaments, createTournament, openRegistration } from "@/lib/tournament";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/Badge";
import { fmtMoney } from "@/lib/accounting/format";
import { formatDate } from "@/lib/finance";

async function createTournamentAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try {
    await createTournament(p, clubId, {
      name: String(formData.get("name") ?? ""),
      format: formData.get("format") as "STROKE" | "MATCH" | "SCRAMBLE" | "STABLEFORD" | "LADDER",
      startDate: String(formData.get("startDate") ?? ""),
      endDate: String(formData.get("endDate") ?? ""),
      entryFee: Number(formData.get("entryFee") ?? 0),
      guestFee: Number(formData.get("guestFee") ?? 0),
      maxParticipants: formData.get("maxParticipants") ? Number(formData.get("maxParticipants")) : null,
      courseCode: String(formData.get("courseCode") ?? "") || null,
    });
  } catch (err) { if (isAppError(err)) redirect(`/app/admin/ops/tournaments?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/ops/tournaments");
}

async function openRegistrationAction(tournamentId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await openRegistration(p, tournamentId); }
  catch (err) { if (isAppError(err)) redirect(`/app/admin/ops/tournaments?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/ops/tournaments");
}

export default async function TournamentsPage({ searchParams }: { searchParams: { error?: string } }) {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "lessons:view")) redirect("/app/admin");
  const canManage = hasPermission(p, clubId, "lessons:manage");

  const [tournaments, courses] = await Promise.all([
    listTournaments(p, clubId),
    prisma.course.findMany({ where: { clubId, isActive: true }, orderBy: { name: "asc" } }),
  ]);

  return (
    <div>
      <Link href="/app/admin/ops" className="text-sm text-stone-500 hover:text-club-ink">← Operations</Link>
      <h1 className="mt-3 page-title">Tournaments</h1>
      <p className="mt-1 text-stone-500">Stroke / match / scramble / stableford / ladder formats. Registration creates an AR charge through the existing financial flow.</p>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Tournaments ({tournaments.length})</div>
          <table className="table-base">
            <thead><tr><th>Name</th><th>Format</th><th>Dates</th><th className="text-right">Entry</th><th>Registered</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {tournaments.length === 0 && <tr><td colSpan={7} className="px-4 py-6 text-center text-stone-500">No tournaments yet.</td></tr>}
              {tournaments.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td className="text-xs">{t.format}</td>
                  <td className="text-xs">{formatDate(t.startDate)} – {formatDate(t.endDate)}</td>
                  <td className="text-right tabular-nums">{fmtMoney(t.entryFee as unknown as number, { showZero: true })}</td>
                  <td className="text-xs">{t.registrations.filter((r) => r.status !== "CANCELLED").length}{t.maxParticipants ? ` / ${t.maxParticipants}` : ""}</td>
                  <td><Badge status={t.status} /></td>
                  <td className="text-right text-xs">
                    {canManage && t.status === "DRAFT" && (
                      <form action={openRegistrationAction.bind(null, t.id)} className="inline"><button className="text-club-green-700 hover:underline">Open registration</button></form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {canManage && (
          <form action={createTournamentAction} className="card card-body h-fit space-y-3">
            <h2 className="section-title text-lg">New tournament</h2>
            <div><label className="label">Name</label><input className="input" name="name" required maxLength={160} /></div>
            <div>
              <label className="label">Format</label>
              <select className="select" name="format">
                <option value="STROKE">Stroke play</option>
                <option value="MATCH">Match play</option>
                <option value="SCRAMBLE">Scramble</option>
                <option value="STABLEFORD">Stableford</option>
                <option value="LADDER">Ladder</option>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div><label className="label">Start</label><input className="input" type="date" name="startDate" required /></div>
              <div><label className="label">End</label><input className="input" type="date" name="endDate" required /></div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div><label className="label">Entry fee</label><input className="input font-mono" type="number" step="0.01" min="0" name="entryFee" defaultValue={0} /></div>
              <div><label className="label">Guest fee</label><input className="input font-mono" type="number" step="0.01" min="0" name="guestFee" defaultValue={0} /></div>
            </div>
            <div><label className="label">Max participants</label><input className="input" type="number" min="1" name="maxParticipants" /></div>
            <div>
              <label className="label">Course</label>
              <select className="select" name="courseCode">
                <option value="">— Any —</option>
                {courses.map((c) => <option key={c.id} value={c.code}>{c.name}</option>)}
              </select>
            </div>
            <button className="btn btn-primary">Create</button>
          </form>
        )}
      </div>
    </div>
  );
}
