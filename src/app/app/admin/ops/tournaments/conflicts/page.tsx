import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { isAppError } from "@/lib/errors";
import { listOpenConflicts, resolveConflict } from "@/lib/tournament/conflict";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

async function resolveAction(conflictId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try {
    await resolveConflict(p, { conflictId, decision: String(formData.get("decision")) as "KEPT_SERVER" | "KEPT_CLIENT" | "MERGED" | "DISMISSED" });
  } catch (err) {
    if (isAppError(err)) cookies().set("spectre_conflict_error", err.safeMessage, { httpOnly: true, sameSite: "strict", maxAge: 30 });
    else throw err;
  }
  revalidatePath("/app/admin/ops/tournaments/conflicts");
}

export default async function ConflictsPage() {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "lessons:view")) redirect("/app/admin");
  const conflicts = await listOpenConflicts(p, clubId);
  const error = cookies().get("spectre_conflict_error")?.value;
  if (error) cookies().delete("spectre_conflict_error");

  return (
    <div>
      <Link href="/app/admin/ops/tournaments" className="text-sm text-stone-500 hover:text-club-ink">← Tournaments</Link>
      <h1 className="mt-3 page-title">Score conflicts</h1>
      <p className="mt-1 text-stone-500">When a member's offline device tries to save a stale version of a score draft, the server records a conflict here for staff to resolve.</p>
      {error && <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <div className="mt-6 space-y-4">
        {conflicts.length === 0 && <div className="card card-body text-center text-stone-500">No open conflicts.</div>}
        {conflicts.map((c) => {
          const clientScores: Record<string, number> = JSON.parse(c.clientScoresJson);
          const serverScores: Record<string, number> = JSON.parse(c.serverScoresJson);
          const holes = Array.from(new Set([...Object.keys(clientScores), ...Object.keys(serverScores)])).sort((a, b) => Number(a) - Number(b));
          return (
            <div key={c.id} className="card overflow-hidden">
              <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between">
                <div>
                  <div className="font-medium">Draft {c.draftId.slice(0, 8)}</div>
                  <div className="text-xs text-stone-500">Detected {formatDate(c.detectedAt)} · server v{c.serverVersion} ↔ client v{c.clientVersion}</div>
                </div>
                <Badge status={c.resolution} />
              </div>
              <div className="px-6 py-3 overflow-x-auto">
                <table className="table-base text-xs">
                  <thead><tr><th>Hole</th>{holes.map((h) => <th key={h}>{h}</th>)}</tr></thead>
                  <tbody>
                    <tr><td className="font-medium">Server</td>{holes.map((h) => <td key={h} className={clientScores[h] !== serverScores[h] ? "bg-amber-50 font-medium" : ""}>{serverScores[h] ?? "—"}</td>)}</tr>
                    <tr><td className="font-medium">Client</td>{holes.map((h) => <td key={h} className={clientScores[h] !== serverScores[h] ? "bg-amber-50 font-medium" : ""}>{clientScores[h] ?? "—"}</td>)}</tr>
                  </tbody>
                </table>
              </div>
              <div className="px-6 py-3 border-t border-stone-200 flex gap-2 flex-wrap">
                <form action={resolveAction.bind(null, c.id)} className="inline-flex"><input type="hidden" name="decision" value="KEPT_SERVER" /><button className="btn btn-secondary btn-sm">Keep server</button></form>
                <form action={resolveAction.bind(null, c.id)} className="inline-flex"><input type="hidden" name="decision" value="KEPT_CLIENT" /><button className="btn btn-secondary btn-sm">Keep client</button></form>
                <form action={resolveAction.bind(null, c.id)} className="inline-flex"><input type="hidden" name="decision" value="DISMISSED" /><button className="btn btn-secondary btn-sm">Dismiss</button></form>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
