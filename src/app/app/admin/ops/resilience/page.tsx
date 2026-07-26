import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { listBreakers, forceCloseBreaker, forceOpenBreaker } from "@/lib/resilience";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

async function closeAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  await forceCloseBreaker(String(formData.get("resourceKey")));
  revalidatePath("/app/admin/ops/resilience");
}

async function openAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  await forceOpenBreaker(String(formData.get("resourceKey")));
  revalidatePath("/app/admin/ops/resilience");
}

export default async function ResiliencePage() {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "system:audit:read")) redirect("/app/admin");
  const canForce = hasPermission(p, clubId, "settings:write");

  const breakers = await listBreakers();
  const open = breakers.filter((b) => b.state === "OPEN").length;

  return (
    <div>
      <h1 className="page-title">Resilience</h1>
      <p className="mt-1 text-stone-500">Circuit breakers for downstream dependencies. {open > 0 && <span className="text-red-600 font-medium">⚠ {open} open</span>}</p>

      <div className="mt-6 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">Breakers ({breakers.length})</div>
        <table className="table-base">
          <thead><tr><th>Resource</th><th>State</th><th>Failures</th><th>Opened</th><th>Last failure</th><th></th></tr></thead>
          <tbody>
            {breakers.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-stone-500">No breakers tracked yet.</td></tr>}
            {breakers.map((b) => (
              <tr key={b.id}>
                <td className="text-xs font-mono">{b.resourceKey}</td>
                <td><Badge status={b.state} /></td>
                <td className="text-xs">{b.failureCount}</td>
                <td className="text-xs">{b.openedAt ? formatDate(b.openedAt) : "—"}</td>
                <td className="text-xs">{b.lastFailureAt ? formatDate(b.lastFailureAt) : "—"}</td>
                <td className="text-right">
                  {canForce && (
                    <div className="flex justify-end gap-2">
                      <form action={closeAction}>
                        <input type="hidden" name="resourceKey" value={b.resourceKey} />
                        <button className="btn btn-secondary btn-sm">Force close</button>
                      </form>
                      <form action={openAction}>
                        <input type="hidden" name="resourceKey" value={b.resourceKey} />
                        <button className="btn btn-secondary btn-sm">Force open</button>
                      </form>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
