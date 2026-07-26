import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { runLaunchChecks, type LaunchCheck } from "@/lib/launch";
import { Badge } from "@/components/Badge";

async function runAction() {
  "use server";
  revalidatePath("/app/admin/launch");
}

export default async function LaunchPage() {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "settings:read")) redirect("/app/admin");

  const checks = await runLaunchChecks(p, clubId);
  const byCategory = new Map<string, LaunchCheck[]>();
  for (const c of checks) {
    if (!byCategory.has(c.category)) byCategory.set(c.category, []);
    byCategory.get(c.category)!.push(c);
  }
  const hardFailures = checks.filter((c) => c.severity === "HARD_BLOCK" && c.status === "FAIL");
  const warnings = checks.filter((c) => c.severity === "WARNING" && c.status === "FAIL");
  const passes = checks.filter((c) => c.status === "PASS");
  const notApplicable = checks.filter((c) => c.status === "NOT_APPLICABLE");

  return (
    <div>
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="page-title">Launch Readiness</h1>
          <p className="mt-1 text-stone-500">Production-grade go/no-go checklist. HARD_BLOCK failures prevent production startup.</p>
        </div>
        <form action={runAction}><button className="btn btn-secondary">Re-run checks</button></form>
      </div>

      <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <div className="card card-body"><div className="text-xs uppercase text-stone-400">Hard-block fails</div><div className={`mt-1 font-serif text-3xl ${hardFailures.length > 0 ? "text-red-700" : "text-club-green-700"}`}>{hardFailures.length}</div></div>
        <div className="card card-body"><div className="text-xs uppercase text-stone-400">Warnings</div><div className={`mt-1 font-serif text-3xl ${warnings.length > 0 ? "text-amber-700" : "text-club-green-700"}`}>{warnings.length}</div></div>
        <div className="card card-body"><div className="text-xs uppercase text-stone-400">Passing</div><div className="mt-1 font-serif text-3xl text-club-green-700">{passes.length}</div></div>
        <div className="card card-body"><div className="text-xs uppercase text-stone-400">N/A</div><div className="mt-1 font-serif text-3xl text-stone-500">{notApplicable.length}</div></div>
      </div>

      <div className="mt-8 space-y-6">
        {Array.from(byCategory.entries()).map(([category, rows]) => (
          <div key={category} className="card overflow-hidden">
            <div className="px-6 py-4 border-b border-stone-200 font-medium text-sm uppercase tracking-widest text-stone-600">{category}</div>
            <ul className="divide-y divide-stone-200">
              {rows.map((r) => (
                <li key={r.key} className="px-6 py-3 text-sm">
                  <div className="flex items-center gap-2">
                    <Badge status={r.status} />
                    <span className={`text-xs font-mono ${r.severity === "HARD_BLOCK" ? "text-red-700" : "text-amber-700"}`}>{r.severity}</span>
                    <span className="font-medium">{r.label}</span>
                  </div>
                  {r.detail && <p className="mt-1 text-xs text-stone-500">{r.detail}</p>}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
