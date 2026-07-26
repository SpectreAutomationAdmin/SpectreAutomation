import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission, isSuperAdmin } from "@/lib/rbac";
import { isAppError } from "@/lib/errors";
import { getPlaybook, cloneIntoProject } from "@/lib/playbook";
import { prisma } from "@/lib/prisma";

async function cloneAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try {
    await cloneIntoProject(p, String(formData.get("projectId") ?? ""));
  } catch (err) {
    if (isAppError(err)) cookies().set("spectre_playbook_error", err.safeMessage, { httpOnly: true, sameSite: "strict", maxAge: 30 });
    else throw err;
  }
  revalidatePath("/app/admin/pilot/playbook");
}

export default async function PlaybookPage() {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "settings:write") && !isSuperAdmin(p)) redirect("/app/admin");
  const playbook = getPlaybook();
  const projects = await prisma.pilotOnboardingProject.findMany({
    where: isSuperAdmin(p) ? {} : { clubId },
    orderBy: { createdAt: "desc" },
    take: 25,
    select: { id: true, name: true, status: true, clubId: true },
  });
  const error = cookies().get("spectre_playbook_error")?.value;
  if (error) cookies().delete("spectre_playbook_error");

  return (
    <div>
      <h1 className="page-title">Implementation playbook</h1>
      <p className="mt-1 text-stone-500">Cross-club playbook for onboarding a new pilot. Clone these entries into any onboarding project to seed the task list.</p>
      {error && <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <div className="mt-4 card card-body">
        <form action={cloneAction} className="flex items-end gap-3">
          <div className="flex-1">
            <label className="block text-xs uppercase text-stone-500">Clone into project</label>
            <select name="projectId" required className="input mt-1 text-sm w-full">
              <option value="">Choose a project…</option>
              {projects.map((proj) => (
                <option key={proj.id} value={proj.id}>{proj.name} ({proj.status})</option>
              ))}
            </select>
          </div>
          <button className="btn btn-primary">Clone playbook</button>
        </form>
        <p className="mt-2 text-xs text-stone-500">Idempotent — re-clicking won't duplicate tasks already on the project.</p>
      </div>

      <h2 className="section-title text-lg mt-8">Playbook entries ({playbook.length})</h2>
      <div className="mt-2 card overflow-hidden">
        <table className="table-base">
          <thead><tr><th>#</th><th>Step</th><th>Title</th><th>Owner</th><th>Estimate</th></tr></thead>
          <tbody>
            {playbook.map((entry, i) => (
              <tr key={entry.title}>
                <td className="text-xs">{i + 1}</td>
                <td className="text-xs font-mono">{entry.stepKey}</td>
                <td>
                  <div>{entry.title}</div>
                  <div className="text-xs text-stone-500 mt-0.5">{entry.description}</div>
                </td>
                <td className="text-xs">{entry.ownerRole}</td>
                <td className="text-xs">{entry.estimateDays}d</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-6 text-xs text-stone-500">
        For a printable version see <code className="font-mono">src/lib/playbook/index.ts:exportMarkdown()</code>.
      </p>
    </div>
  );
}
