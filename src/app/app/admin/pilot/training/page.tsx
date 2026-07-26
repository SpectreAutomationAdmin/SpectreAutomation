import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { isAppError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { enableTrainingMode, disableTrainingMode, listScenarios, markScenarioComplete, resetScenarios } from "@/lib/training";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

async function enableAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try { await enableTrainingMode(p, { clubId, ttlHours: Number(formData.get("ttlHours") ?? 8) }); }
  catch (err) { if (isAppError(err)) cookies().set("spectre_training_error", err.safeMessage, { httpOnly: true, sameSite: "strict", maxAge: 30 }); else throw err; }
  revalidatePath("/app/admin/pilot/training");
}
async function disableAction() {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  await disableTrainingMode(p, clubId).catch(() => undefined);
  revalidatePath("/app/admin/pilot/training");
}
async function completeAction(scenarioId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  await markScenarioComplete(p, scenarioId).catch(() => undefined);
  revalidatePath("/app/admin/pilot/training");
}
async function resetAction() {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  await resetScenarios(p, clubId).catch(() => undefined);
  revalidatePath("/app/admin/pilot/training");
}

export default async function TrainingPage() {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "settings:write")) redirect("/app/admin");
  const mode = await prisma.clubTrainingMode.findUnique({ where: { clubId } });
  const scenarios = await listScenarios(p, clubId);
  const grouped = scenarios.reduce((acc, s) => { (acc[s.roleKey] = acc[s.roleKey] ?? []).push(s); return acc; }, {} as Record<string, typeof scenarios>);
  const error = cookies().get("spectre_training_error")?.value;
  if (error) cookies().delete("spectre_training_error");

  return (
    <div>
      <h1 className="page-title">Staff training</h1>
      <p className="mt-1 text-stone-500">Practice mode + role-specific training checklists. When training mode is on, financial postings are blocked.</p>
      {error && <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <div className={`mt-4 card card-body ${mode?.enabled ? "bg-amber-50 border-amber-200" : ""}`}>
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-xs uppercase text-stone-500">Training mode</div>
            <div className="mt-1 text-2xl font-medium">{mode?.enabled ? <span className="text-amber-800">ON</span> : <span className="text-stone-600">Off</span>}</div>
            {mode?.expiresAt && <div className="text-xs text-stone-500">Auto-disables at {formatDate(mode.expiresAt)}</div>}
          </div>
          {mode?.enabled
            ? <form action={disableAction}><button className="btn btn-secondary">Disable</button></form>
            : (
              <form action={enableAction} className="flex items-center gap-2">
                <label className="text-xs">TTL (hrs) <input name="ttlHours" type="number" min={1} max={168} defaultValue={8} className="input text-xs w-20" /></label>
                <button className="btn btn-primary">Enable training</button>
              </form>
            )}
        </div>
      </div>

      <div className="mt-6 flex items-center justify-between">
        <h2 className="section-title text-lg">Scenarios</h2>
        <form action={resetAction}><button className="btn btn-secondary btn-sm">Reset all</button></form>
      </div>
      <div className="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-4">
        {Object.entries(grouped).map(([role, items]) => (
          <div key={role} className="card overflow-hidden">
            <div className="px-6 py-3 border-b border-stone-200 font-medium text-sm">{role}</div>
            <ul className="divide-y divide-stone-200">
              {items.map((s) => (
                <li key={s.id} className="px-4 py-2 flex items-center justify-between">
                  <div>
                    <div className="text-sm">{s.title}</div>
                    <div className="text-xs text-stone-500"><Badge status={s.status} /> {s.completedAt && `· ${formatDate(s.completedAt)}`}</div>
                  </div>
                  {s.status !== "COMPLETED" && (
                    <form action={completeAction.bind(null, s.id)}><button className="btn btn-secondary btn-sm">Mark done</button></form>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
