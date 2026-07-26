import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { isSuperAdmin } from "@/lib/rbac";
import { isAppError } from "@/lib/errors";
import { listGrants, listActiveSessions, requestAccess, approveAccess, rejectAccess, startSession, endSession } from "@/lib/support-access";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

async function requestAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try {
    await requestAccess(p, {
      clubId: String(formData.get("clubId")),
      mode: String(formData.get("mode") ?? "READ_ONLY") as "READ_ONLY" | "ELEVATED",
      reason: String(formData.get("reason") ?? ""),
      ttlMinutes: Number(formData.get("ttlMinutes") ?? 60),
    });
  } catch (err) {
    if (isAppError(err)) cookies().set("spectre_support_error", err.safeMessage, { httpOnly: true, sameSite: "strict", maxAge: 30 });
    else throw err;
  }
  revalidatePath("/app/admin/support/access");
}

async function approveAction(grantId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  await approveAccess(p, grantId).catch(() => undefined);
  revalidatePath("/app/admin/support/access");
}
async function rejectAction(grantId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  await rejectAccess(p, grantId).catch(() => undefined);
  revalidatePath("/app/admin/support/access");
}
async function startAction(grantId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  await startSession(p, { grantId }).catch(() => undefined);
  revalidatePath("/app/admin/support/access");
}
async function endAction(sessionId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  await endSession(p, sessionId).catch(() => undefined);
  revalidatePath("/app/admin/support/access");
}

export default async function SupportAccessPage() {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  if (!isSuperAdmin(p)) redirect("/app/admin");
  const [grants, sessions] = await Promise.all([listGrants(p).catch(() => []), listActiveSessions(p).catch(() => [])]);
  const error = cookies().get("spectre_support_error")?.value;
  if (error) cookies().delete("spectre_support_error");

  return (
    <div>
      <Link href="/app/admin/support" className="text-sm text-stone-500 hover:text-club-ink">← Support</Link>
      <h1 className="mt-3 page-title">Support access</h1>
      <p className="mt-1 text-stone-500">SUPER_ADMIN cross-tenant support sessions. All actions are audited; sessions emit a banner across the target club's admin UI.</p>
      {error && <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <div className="mt-4 card card-body">
        <h2 className="section-title text-lg">Request access</h2>
        <form action={requestAction} className="mt-3 grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
          <div>
            <label className="block text-xs uppercase text-stone-500">Club ID</label>
            <input name="clubId" required className="input mt-1 text-sm w-full" />
          </div>
          <div>
            <label className="block text-xs uppercase text-stone-500">Mode</label>
            <select name="mode" className="input mt-1 text-sm w-full">
              <option value="READ_ONLY">READ_ONLY</option>
              <option value="ELEVATED">ELEVATED</option>
            </select>
          </div>
          <div>
            <label className="block text-xs uppercase text-stone-500">TTL (min)</label>
            <input name="ttlMinutes" type="number" min={5} max={480} defaultValue={60} className="input mt-1 text-sm w-full" />
          </div>
          <div className="md:col-span-1">
            <label className="block text-xs uppercase text-stone-500">Reason</label>
            <input name="reason" required minLength={10} maxLength={1000} className="input mt-1 text-sm w-full" />
          </div>
          <button className="btn btn-primary md:col-span-4">Request</button>
        </form>
      </div>

      <div className="mt-6 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">Active sessions ({sessions.length})</div>
        <table className="table-base">
          <thead><tr><th>Club</th><th>Mode</th><th>Started</th><th></th></tr></thead>
          <tbody>
            {sessions.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-stone-500">No active support sessions.</td></tr>}
            {sessions.map((s) => (
              <tr key={s.id}>
                <td className="text-xs font-mono">{s.clubId.slice(0, 8)}</td>
                <td><Badge status={s.mode} /></td>
                <td className="text-xs">{formatDate(s.startedAt)}</td>
                <td className="text-right"><form action={endAction.bind(null, s.id)}><button className="btn btn-secondary btn-sm">End</button></form></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-6 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">Grants ({grants.length})</div>
        <table className="table-base">
          <thead><tr><th>Club</th><th>Mode</th><th>Status</th><th>Expires</th><th>Reason</th><th></th></tr></thead>
          <tbody>
            {grants.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-stone-500">No grants.</td></tr>}
            {grants.map((g) => (
              <tr key={g.id}>
                <td className="text-xs font-mono">{g.clubId.slice(0, 8)}</td>
                <td><Badge status={g.mode} /></td>
                <td><Badge status={g.status} /></td>
                <td className="text-xs">{formatDate(g.expiresAt)}</td>
                <td className="text-xs">{g.reason}</td>
                <td className="text-right">
                  <div className="flex justify-end gap-1">
                    {g.status === "REQUESTED" && <form action={approveAction.bind(null, g.id)}><button className="btn btn-primary btn-sm">Approve</button></form>}
                    {g.status === "REQUESTED" && <form action={rejectAction.bind(null, g.id)}><button className="btn btn-secondary btn-sm">Reject</button></form>}
                    {g.status === "APPROVED" && <form action={startAction.bind(null, g.id)}><button className="btn btn-primary btn-sm">Start session</button></form>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
