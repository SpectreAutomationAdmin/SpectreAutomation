import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { isAppError } from "@/lib/errors";
import { listRetrospectives, createRetrospective, recentSnapshots, captureMetricSnapshot } from "@/lib/retrospective";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

async function createAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try {
    await createRetrospective(p, {
      clubId,
      timing: String(formData.get("timing") ?? "WEEK_1") as "GO_LIVE_DAY" | "WEEK_1" | "MONTH_1" | "CUSTOM",
      title: String(formData.get("title") ?? "Pilot retrospective"),
    });
  } catch (err) {
    if (isAppError(err)) cookies().set("spectre_retro_error", err.safeMessage, { httpOnly: true, sameSite: "strict", maxAge: 30 });
    else throw err;
  }
  revalidatePath("/app/admin/pilot/retrospective");
}

async function snapshotAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  await captureMetricSnapshot(p, { clubId, label: String(formData.get("label") ?? `Snapshot ${new Date().toISOString().slice(0, 10)}`) }).catch(() => undefined);
  revalidatePath("/app/admin/pilot/retrospective");
}

export default async function RetrospectivePage() {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "settings:write")) redirect("/app/admin");
  const [retros, snapshots] = await Promise.all([
    listRetrospectives(p, clubId),
    recentSnapshots(p, clubId),
  ]);
  const error = cookies().get("spectre_retro_error")?.value;
  if (error) cookies().delete("spectre_retro_error");

  return (
    <div>
      <h1 className="page-title">Pilot retrospective</h1>
      <p className="mt-1 text-stone-500">Capture lessons learned + metric snapshots at Day 1, Week 1, Month 1.</p>
      {error && <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between">
            <div className="font-medium">Retrospectives</div>
            <details>
              <summary className="text-xs text-stone-500 cursor-pointer">+ Create</summary>
              <form action={createAction} className="mt-2 flex flex-col gap-1">
                <select name="timing" className="input text-xs">
                  <option value="GO_LIVE_DAY">GO_LIVE_DAY</option>
                  <option value="WEEK_1">WEEK_1</option>
                  <option value="MONTH_1">MONTH_1</option>
                  <option value="CUSTOM">CUSTOM</option>
                </select>
                <input name="title" required maxLength={200} placeholder="Title" className="input text-xs" />
                <button className="btn btn-primary btn-sm">Create</button>
              </form>
            </details>
          </div>
          <table className="table-base">
            <thead><tr><th>Title</th><th>Timing</th><th>Items</th><th>Actions</th><th>Status</th><th>Conducted</th></tr></thead>
            <tbody>
              {retros.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-stone-500">No retrospectives yet.</td></tr>}
              {retros.map((r) => (
                <tr key={r.id}>
                  <td>{r.title}</td>
                  <td className="text-xs">{r.timing}</td>
                  <td className="text-xs">{r._count?.items ?? 0}</td>
                  <td className="text-xs">{r._count?.actions ?? 0}</td>
                  <td><Badge status={r.status} /></td>
                  <td className="text-xs">{formatDate(r.conductedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between">
            <div className="font-medium">Metric snapshots</div>
            <form action={snapshotAction} className="flex items-center gap-2">
              <input name="label" placeholder="Label" className="input text-xs" />
              <button className="btn btn-secondary btn-sm">Capture now</button>
            </form>
          </div>
          <table className="table-base">
            <thead><tr><th>Label</th><th>Tickets</th><th>Incidents</th><th>Invites %</th><th>Smoke</th><th>Captured</th></tr></thead>
            <tbody>
              {snapshots.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-stone-500">No snapshots captured.</td></tr>}
              {snapshots.map((s) => (
                <tr key={s.id}>
                  <td>{s.label}</td>
                  <td className="text-xs">{s.openTickets}/{s.resolvedTickets}</td>
                  <td className="text-xs">{s.openIncidents}</td>
                  <td className="text-xs">{(s.inviteActivationRate * 100).toFixed(0)}%</td>
                  <td className="text-xs">{s.smokePass}/{s.smokeFail}</td>
                  <td className="text-xs">{formatDate(s.capturedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
