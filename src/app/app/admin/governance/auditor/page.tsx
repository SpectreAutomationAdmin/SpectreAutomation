import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { isAppError } from "@/lib/errors";
import { auditorService } from "@/lib/enterprise";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

async function inviteAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try {
    await auditorService.inviteAuditor(p, clubId, {
      auditorName: String(formData.get("auditorName") ?? ""),
      auditorEmail: String(formData.get("auditorEmail") ?? ""),
      firmName: String(formData.get("firmName") ?? "") || null,
      expiresInDays: Number(formData.get("expiresInDays") ?? 60),
      notes: String(formData.get("notes") ?? "") || null,
    });
  } catch (err) { if (isAppError(err)) redirect(`/app/admin/governance/auditor?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/governance/auditor");
}

async function revokeAction(grantId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await auditorService.revokeAuditorGrant(p, grantId); }
  catch (err) { if (isAppError(err)) redirect(`/app/admin/governance/auditor?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/governance/auditor");
}

async function createRequestAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try {
    const itemsRaw = String(formData.get("items") ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
    await auditorService.createAuditRequest(p, clubId, {
      grantId: String(formData.get("grantId") ?? "") || null,
      title: String(formData.get("title") ?? ""),
      description: String(formData.get("description") ?? "") || null,
      dueDate: String(formData.get("dueDate") ?? "") || null,
      items: itemsRaw.map((label) => ({ label })),
    });
  } catch (err) { if (isAppError(err)) redirect(`/app/admin/governance/auditor?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/governance/auditor");
}

export default async function AuditorPortalPage({ searchParams }: { searchParams: { error?: string } }) {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "auditor:invite") && !hasPermission(p, clubId, "auditor:respond")) redirect("/app/admin");
  const canInvite = hasPermission(p, clubId, "auditor:invite");
  const canRevoke = hasPermission(p, clubId, "auditor:revoke");
  const canRespond = hasPermission(p, clubId, "auditor:respond");

  const grants = canInvite ? await auditorService.listGrants(p, clubId) : [];
  const requests = canRespond ? await auditorService.listAuditRequests(p, clubId) : [];

  return (
    <div>
      <Link href="/app/admin/governance" className="text-sm text-stone-500 hover:text-club-ink">← Governance</Link>
      <h1 className="mt-3 page-title">Auditor Portal</h1>
      <p className="mt-1 text-stone-500">Time-limited, audited, read-only access for external auditors. All activity is logged.</p>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        {canInvite && (
          <div className="lg:col-span-2 card overflow-hidden">
            <div className="px-6 py-4 border-b border-stone-200 font-medium">Active grants ({grants.length})</div>
            <table className="table-base">
              <thead><tr><th>Auditor</th><th>Firm</th><th>Status</th><th>Expires</th><th>Sessions</th><th></th></tr></thead>
              <tbody>
                {grants.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-stone-500">No auditor grants. Invite one to begin.</td></tr>}
                {grants.map((g) => (
                  <tr key={g.id}>
                    <td>{g.auditorName} <span className="text-xs text-stone-500">· {g.auditorEmail}</span></td>
                    <td className="text-xs">{g.firmName ?? "—"}</td>
                    <td><Badge status={g.status} /></td>
                    <td className="text-xs">{formatDate(g.expiresAt)}</td>
                    <td className="text-xs">{g.sessions.length > 0 ? `last ${formatDate(g.sessions[0].startedAt)}` : "—"}</td>
                    <td className="text-right text-xs">
                      {canRevoke && g.status === "ACTIVE" && (
                        <form action={revokeAction.bind(null, g.id)} className="inline">
                          <button className="text-red-600 hover:underline">Revoke</button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {canInvite && (
          <form action={inviteAction} className="card card-body h-fit space-y-3">
            <h2 className="section-title text-lg">Invite auditor</h2>
            <div><label className="label">Name</label><input className="input" name="auditorName" required /></div>
            <div><label className="label">Email</label><input className="input" type="email" name="auditorEmail" required /></div>
            <div><label className="label">Firm</label><input className="input" name="firmName" /></div>
            <div><label className="label">Access window (days)</label><input className="input" type="number" name="expiresInDays" defaultValue={60} min={1} max={365} /></div>
            <div><label className="label">Notes</label><textarea className="input" name="notes" rows={2} /></div>
            <button className="btn btn-primary">Send invitation</button>
          </form>
        )}
      </div>

      {canRespond && (
        <div className="mt-8">
          <h2 className="section-title text-2xl">PBC (Provided-By-Client) Requests</h2>
          <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 card overflow-hidden">
              <div className="px-6 py-4 border-b border-stone-200 font-medium">Requests ({requests.length})</div>
              <table className="table-base">
                <thead><tr><th>Title</th><th>Due</th><th>Status</th><th>Items</th></tr></thead>
                <tbody>
                  {requests.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-stone-500">No requests.</td></tr>}
                  {requests.map((r) => (
                    <tr key={r.id}>
                      <td>{r.title}</td>
                      <td className="text-xs">{r.dueDate ? formatDate(r.dueDate) : "—"}</td>
                      <td><Badge status={r.status} /></td>
                      <td className="text-xs">{r.items.filter((i) => i.status === "PROVIDED").length} of {r.items.length} provided</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <form action={createRequestAction} className="card card-body h-fit space-y-3">
              <h2 className="section-title text-lg">New request</h2>
              <div><label className="label">Grant</label>
                <select className="select" name="grantId">
                  <option value="">— Unassigned —</option>
                  {grants.filter((g) => g.status === "ACTIVE").map((g) => <option key={g.id} value={g.id}>{g.auditorName}</option>)}
                </select>
              </div>
              <div><label className="label">Title</label><input className="input" name="title" required maxLength={200} placeholder="Q1 supporting documents" /></div>
              <div><label className="label">Description</label><textarea className="input" name="description" rows={2} /></div>
              <div><label className="label">Due date</label><input className="input" type="date" name="dueDate" /></div>
              <div><label className="label">Items (one per line)</label><textarea className="input font-mono text-xs" name="items" rows={5} placeholder={"Q1 trial balance\nMar 31 bank reconciliation\nBoard minutes Q1"} /></div>
              <button className="btn btn-primary">Create request</button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
