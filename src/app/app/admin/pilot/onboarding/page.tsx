import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission, isSuperAdmin } from "@/lib/rbac";
import { isAppError } from "@/lib/errors";
import { listProjects, createProject } from "@/lib/pilot-onboarding";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

async function createAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = String(formData.get("clubId") ?? (await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" })));
  const name = String(formData.get("name") ?? "");
  try {
    await createProject(p, { clubId, name, targetGoLiveAt: String(formData.get("targetGoLiveAt") ?? "") || undefined });
  } catch (err) {
    if (isAppError(err)) cookies().set("spectre_pilot_error", err.safeMessage, { httpOnly: true, sameSite: "strict", maxAge: 30 });
    else throw err;
  }
  revalidatePath("/app/admin/pilot/onboarding");
}

export default async function OnboardingProjectsPage() {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  const isSuper = isSuperAdmin(p);
  if (!isSuper && !hasPermission(p, clubId, "settings:write")) redirect("/app/admin");
  const projects = await listProjects(p, isSuper ? undefined : clubId);
  const error = cookies().get("spectre_pilot_error")?.value;
  if (error) cookies().delete("spectre_pilot_error");

  return (
    <div>
      <h1 className="page-title">Pilot onboarding</h1>
      <p className="mt-1 text-stone-500">Configure a new pilot club end-to-end. Each project tracks 15 implementation steps, blockers, signoffs, and target go-live date.</p>
      {error && <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <div className="mt-6 card card-body">
        <form action={createAction} className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
          {isSuper && (
            <div>
              <label className="block text-xs uppercase text-stone-500">Club ID</label>
              <input name="clubId" required className="input mt-1 text-sm w-full" placeholder="cl..." />
            </div>
          )}
          <div className={isSuper ? "md:col-span-1" : "md:col-span-2"}>
            <label className="block text-xs uppercase text-stone-500">Project name</label>
            <input name="name" required minLength={1} maxLength={160} className="input mt-1 text-sm w-full" placeholder="Pilot — Silver Springs" />
          </div>
          <div>
            <label className="block text-xs uppercase text-stone-500">Target go-live</label>
            <input name="targetGoLiveAt" type="datetime-local" className="input mt-1 text-sm w-full" />
          </div>
          <button className="btn btn-primary">Create project</button>
        </form>
      </div>

      <div className="mt-6 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">Projects ({projects.length})</div>
        <table className="table-base">
          <thead><tr><th>Name</th><th>Status</th><th>Steps</th><th>Blockers</th><th>Tasks</th><th>Target</th><th></th></tr></thead>
          <tbody>
            {projects.length === 0 && <tr><td colSpan={7} className="px-4 py-6 text-center text-stone-500">No projects yet.</td></tr>}
            {projects.map((proj) => {
              const completed = proj.steps.filter((s) => s.status === "COMPLETED").length;
              return (
                <tr key={proj.id}>
                  <td>{proj.name}</td>
                  <td><Badge status={proj.status} /></td>
                  <td className="text-xs">{completed} / {proj.steps.length}</td>
                  <td className="text-xs">{proj._count?.blockers ?? 0}</td>
                  <td className="text-xs">{proj._count?.tasks ?? 0}</td>
                  <td className="text-xs">{proj.targetGoLiveAt ? formatDate(proj.targetGoLiveAt) : "—"}</td>
                  <td className="text-right">
                    <Link href={`/app/admin/pilot/onboarding/${proj.id}`} className="text-xs text-club-ink hover:underline">Open</Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
