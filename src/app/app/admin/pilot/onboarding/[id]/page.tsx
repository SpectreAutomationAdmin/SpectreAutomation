import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { isAppError } from "@/lib/errors";
import { getProject, saveStep, addNote, openBlocker, resolveBlocker, recordSignoff, approveGoLive, readinessSummary } from "@/lib/pilot-onboarding";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

async function setStepStatusAction(projectId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try {
    await saveStep(p, {
      projectId,
      stepKey: String(formData.get("stepKey")),
      status: String(formData.get("status")) as "PENDING" | "IN_PROGRESS" | "COMPLETED" | "BLOCKED" | "SKIPPED",
    });
  } catch (err) {
    if (isAppError(err)) cookies().set("spectre_pilot_error", err.safeMessage, { httpOnly: true, sameSite: "strict", maxAge: 30 });
    else throw err;
  }
  revalidatePath(`/app/admin/pilot/onboarding/${projectId}`);
}

async function addNoteAction(projectId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  await addNote(p, projectId, String(formData.get("body") ?? "")).catch(() => undefined);
  revalidatePath(`/app/admin/pilot/onboarding/${projectId}`);
}

async function openBlockerAction(projectId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  await openBlocker(p, {
    projectId,
    title: String(formData.get("title") ?? ""),
    severity: String(formData.get("severity") ?? "MEDIUM") as "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
    description: String(formData.get("description") ?? ""),
  }).catch(() => undefined);
  revalidatePath(`/app/admin/pilot/onboarding/${projectId}`);
}

async function resolveBlockerAction(projectId: string, blockerId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  await resolveBlocker(p, blockerId);
  revalidatePath(`/app/admin/pilot/onboarding/${projectId}`);
}

async function recordSignoffAction(projectId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  await recordSignoff(p, {
    projectId,
    category: String(formData.get("category")),
    status: String(formData.get("status")) as "SIGNED" | "REJECTED",
    notes: String(formData.get("notes") ?? "") || undefined,
  }).catch(() => undefined);
  revalidatePath(`/app/admin/pilot/onboarding/${projectId}`);
}

async function goLiveAction(projectId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await approveGoLive(p, projectId); }
  catch (err) {
    if (isAppError(err)) cookies().set("spectre_pilot_error", err.safeMessage, { httpOnly: true, sameSite: "strict", maxAge: 30 });
    else throw err;
  }
  revalidatePath(`/app/admin/pilot/onboarding/${projectId}`);
}

export default async function ProjectDetailPage({ params }: { params: { id: string } }) {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  let project;
  try { project = await getProject(p, params.id); }
  catch { notFound(); }
  if (!project) notFound();
  const summary = await readinessSummary(p, params.id);
  const error = cookies().get("spectre_pilot_error")?.value;
  if (error) cookies().delete("spectre_pilot_error");

  return (
    <div>
      <Link href="/app/admin/pilot/onboarding" className="text-sm text-stone-500 hover:text-club-ink">← Pilot onboarding</Link>
      <h1 className="mt-3 page-title">{project.name}</h1>
      <p className="mt-1 text-stone-500">Status <Badge status={project.status} /> · Target {project.targetGoLiveAt ? formatDate(project.targetGoLiveAt) : "TBD"}</p>
      {error && <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <div className="mt-4 card card-body">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-xs uppercase text-stone-500">Readiness</div>
            <div className="mt-1 font-medium">{summary.canGoLive ? <span className="text-emerald-700">Ready for go-live</span> : <span className="text-amber-700">{summary.hardBlocks.length} hard block(s)</span>}</div>
          </div>
          {summary.canGoLive && project.status !== "GO_LIVE" && (
            <form action={goLiveAction.bind(null, project.id)}><button className="btn btn-primary">Approve go-live</button></form>
          )}
        </div>
        {!summary.canGoLive && (
          <ul className="mt-3 text-sm space-y-1 text-stone-600">
            {summary.hardBlocks.map((b, i) => (<li key={i}>• {b.kind}: {b.label}</li>))}
          </ul>
        )}
      </div>

      <div className="mt-6 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">Steps</div>
        <table className="table-base">
          <thead><tr><th>#</th><th>Step</th><th>Status</th><th>Completed</th><th></th></tr></thead>
          <tbody>
            {project.steps.map((s, i) => (
              <tr key={s.id}>
                <td className="text-xs">{i + 1}</td>
                <td>{s.label}</td>
                <td><Badge status={s.status} /></td>
                <td className="text-xs">{s.completedAt ? formatDate(s.completedAt) : "—"}</td>
                <td className="text-right">
                  <form action={setStepStatusAction.bind(null, project.id)} className="inline-flex gap-1">
                    <input type="hidden" name="stepKey" value={s.stepKey} />
                    <select name="status" defaultValue={s.status} className="input text-xs">
                      <option value="PENDING">Pending</option>
                      <option value="IN_PROGRESS">In progress</option>
                      <option value="COMPLETED">Completed</option>
                      <option value="BLOCKED">Blocked</option>
                      <option value="SKIPPED">Skipped</option>
                    </select>
                    <button className="btn btn-secondary btn-sm">Save</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between">
            <div className="font-medium">Blockers</div>
            <details>
              <summary className="text-xs text-stone-500 cursor-pointer">+ Add</summary>
              <form action={openBlockerAction.bind(null, project.id)} className="mt-2 flex flex-col gap-1">
                <input name="title" required maxLength={200} placeholder="Title" className="input text-xs" />
                <select name="severity" className="input text-xs">
                  <option>LOW</option><option>MEDIUM</option><option>HIGH</option><option>CRITICAL</option>
                </select>
                <textarea name="description" maxLength={4000} placeholder="Description" className="input text-xs" rows={2} />
                <button className="btn btn-primary btn-sm">Open blocker</button>
              </form>
            </details>
          </div>
          <table className="table-base">
            <thead><tr><th>Title</th><th>Severity</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {project.blockers.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-stone-500">No blockers.</td></tr>}
              {project.blockers.map((b) => (
                <tr key={b.id}>
                  <td>{b.title}</td>
                  <td><Badge status={b.severity} /></td>
                  <td><Badge status={b.status} /></td>
                  <td className="text-right">
                    {b.status === "OPEN" && (
                      <form action={resolveBlockerAction.bind(null, project.id, b.id)}>
                        <button className="btn btn-secondary btn-sm">Resolve</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Go-live signoffs</div>
          <table className="table-base">
            <thead><tr><th>Category</th><th>Status</th><th>Signed</th><th></th></tr></thead>
            <tbody>
              {project.signoffs.map((s) => (
                <tr key={s.id}>
                  <td>{s.category}</td>
                  <td><Badge status={s.status} /></td>
                  <td className="text-xs">{s.signedAt ? formatDate(s.signedAt) : "—"}</td>
                  <td className="text-right">
                    {s.status !== "SIGNED" && (
                      <form action={recordSignoffAction.bind(null, project.id)} className="inline-flex gap-1">
                        <input type="hidden" name="category" value={s.category} />
                        <input type="hidden" name="status" value="SIGNED" />
                        <button className="btn btn-primary btn-sm">Sign off</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-6 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between">
          <div className="font-medium">Notes</div>
          <details>
            <summary className="text-xs text-stone-500 cursor-pointer">+ Note</summary>
            <form action={addNoteAction.bind(null, project.id)} className="mt-2 flex gap-1">
              <input name="body" required maxLength={4000} placeholder="Add a note" className="input text-xs flex-1" />
              <button className="btn btn-primary btn-sm">Add</button>
            </form>
          </details>
        </div>
        <table className="table-base">
          <thead><tr><th>When</th><th>Body</th></tr></thead>
          <tbody>
            {project.notes.length === 0 && <tr><td colSpan={2} className="px-4 py-6 text-center text-stone-500">No notes.</td></tr>}
            {project.notes.map((n) => (
              <tr key={n.id}>
                <td className="text-xs whitespace-nowrap">{formatDate(n.createdAt)}</td>
                <td>{n.body}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
