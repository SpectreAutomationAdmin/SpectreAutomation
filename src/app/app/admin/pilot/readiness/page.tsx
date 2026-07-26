import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { getReadinessSnapshot, markItemComplete, type ReadinessStatus } from "@/lib/pilot";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

async function markCompleteAction(itemId: string, status: ReadinessStatus) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  await markItemComplete(p, itemId, status);
  revalidatePath("/app/admin/pilot/readiness");
}

export default async function ReadinessPage() {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "settings:read")) redirect("/app/admin");
  const canWrite = hasPermission(p, clubId, "settings:write");
  const items = await getReadinessSnapshot(p, clubId);

  const byCategory = new Map<string, typeof items>();
  for (const i of items) {
    if (!byCategory.has(i.category)) byCategory.set(i.category, []);
    byCategory.get(i.category)!.push(i);
  }

  const totals = {
    complete: items.filter((i) => i.status === "COMPLETE").length,
    pending: items.filter((i) => i.status === "PENDING").length,
    inProgress: items.filter((i) => i.status === "IN_PROGRESS").length,
    notApplicable: items.filter((i) => i.status === "NOT_APPLICABLE").length,
  };

  return (
    <div>
      <Link href="/app/admin/pilot" className="text-sm text-stone-500 hover:text-club-ink">← Pilot</Link>
      <h1 className="mt-3 page-title">Pilot readiness</h1>
      <p className="mt-1 text-stone-500">Runtime probes + manual checklist items required before a club can go live.</p>

      <div className="mt-6 grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="card card-body"><div className="text-xs uppercase text-stone-400">Complete</div><div className="mt-1 font-serif text-3xl text-club-green-700">{totals.complete}</div></div>
        <div className="card card-body"><div className="text-xs uppercase text-stone-400">In progress</div><div className="mt-1 font-serif text-3xl text-amber-700">{totals.inProgress}</div></div>
        <div className="card card-body"><div className="text-xs uppercase text-stone-400">Pending</div><div className="mt-1 font-serif text-3xl text-red-700">{totals.pending}</div></div>
        <div className="card card-body"><div className="text-xs uppercase text-stone-400">N/A</div><div className="mt-1 font-serif text-3xl text-stone-500">{totals.notApplicable}</div></div>
      </div>

      <div className="mt-8 space-y-6">
        {Array.from(byCategory.entries()).map(([category, rows]) => (
          <div key={category} className="card overflow-hidden">
            <div className="px-6 py-4 border-b border-stone-200 font-medium text-sm uppercase tracking-widest text-stone-600">{category}</div>
            <ul className="divide-y divide-stone-200">
              {rows.map((r) => (
                <li key={r.id} className="px-6 py-3 text-sm flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge status={r.status} />
                      <span className="font-medium">{r.label}</span>
                      <span className="text-xs font-mono text-stone-400">{r.kind}</span>
                    </div>
                    {r.description && <p className="mt-1 text-xs text-stone-500">{r.description}</p>}
                    {r.details && <p className="mt-1 text-xs font-mono text-stone-500">{r.details}</p>}
                    {r.completedAt && <p className="mt-1 text-xs text-club-green-700">Completed {formatDate(r.completedAt)}</p>}
                  </div>
                  {canWrite && r.kind === "MANUAL" && r.status !== "COMPLETE" && (
                    <form action={markCompleteAction.bind(null, r.id, "COMPLETE")} className="shrink-0">
                      <button className="text-club-green-700 text-xs hover:underline">Mark complete</button>
                    </form>
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
