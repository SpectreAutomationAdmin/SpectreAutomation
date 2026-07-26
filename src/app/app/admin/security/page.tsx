import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { listAccountLocks, listSuspiciousActivity, releaseLock } from "@/lib/security/auth-guard";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

async function releaseLockAction(lockId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  await releaseLock({ lockId, actorUserId: p.id });
  revalidatePath("/app/admin/security");
}

export default async function SecurityPage() {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "users:read")) redirect("/app/admin");
  const canUnlock = hasPermission(p, clubId, "users:roles:write");

  const [locks, suspicious] = await Promise.all([
    listAccountLocks({ clubId, activeOnly: true }),
    listSuspiciousActivity({ clubId }),
  ]);

  return (
    <div>
      <h1 className="page-title">Security</h1>
      <p className="mt-1 text-stone-500">Account locks, suspicious activity, and brute-force detection events.</p>

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Active account locks ({locks.length})</div>
          <table className="table-base">
            <thead><tr><th>Email (hashed)</th><th>Kind</th><th>Reason</th><th>Until</th><th></th></tr></thead>
            <tbody>
              {locks.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-stone-500">No active locks.</td></tr>}
              {locks.map((l) => (
                <tr key={l.id}>
                  <td className="text-xs font-mono">{l.emailHash.slice(0, 12)}…</td>
                  <td className="text-xs">{l.kind}</td>
                  <td className="text-xs">{l.reason ?? "—"}</td>
                  <td className="text-xs">{l.expiresAt ? formatDate(l.expiresAt) : "—"}</td>
                  <td className="text-right text-xs">
                    {canUnlock && (
                      <form action={releaseLockAction.bind(null, l.id)} className="inline"><button className="text-club-green-700 hover:underline">Release</button></form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Suspicious activity (recent)</div>
          <table className="table-base">
            <thead><tr><th>When</th><th>Kind</th><th>Severity</th><th>IP</th></tr></thead>
            <tbody>
              {suspicious.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-stone-500">No events.</td></tr>}
              {suspicious.map((s) => (
                <tr key={s.id}>
                  <td className="text-xs">{formatDate(s.occurredAt)}</td>
                  <td className="text-xs">{s.kind}</td>
                  <td><Badge status={s.severity} /></td>
                  <td className="text-xs font-mono">{s.ip ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

void Link;
