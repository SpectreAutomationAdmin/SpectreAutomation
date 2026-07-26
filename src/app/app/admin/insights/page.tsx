import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { insightService } from "@/lib/enterprise";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

async function acknowledgeAction(insightId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  await insightService.acknowledgeInsight(p, insightId);
  revalidatePath("/app/admin/insights");
}

async function resolveAction(insightId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  await insightService.resolveInsight(p, insightId);
  revalidatePath("/app/admin/insights");
}

async function runAction() {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  await insightService.runInsights(clubId, p);
  revalidatePath("/app/admin/insights");
}

export default async function InsightsPage({ searchParams }: { searchParams: { status?: string } }) {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "insights:read")) redirect("/app/admin");
  const canWrite = hasPermission(p, clubId, "insights:write");

  const status = searchParams.status ?? "OPEN";
  const insights = await insightService.listInsights(p, clubId, { status });

  return (
    <div>
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="page-title">Cross-Module Insights</h1>
          <p className="mt-1 text-stone-500">Rule engine over your data: members, vendors, payroll, inventory, and financing — surfaced in priority order.</p>
        </div>
        {canWrite && (
          <form action={runAction}><button className="btn btn-secondary">Re-run rules</button></form>
        )}
      </div>

      <div className="mt-4 flex gap-2 text-sm">
        {["OPEN", "ACKNOWLEDGED", "RESOLVED", "DISMISSED"].map((s) => (
          <Link key={s} href={`/app/admin/insights?status=${s}`} className={`px-3 py-1 rounded-md ${status === s ? "bg-club-green-50 text-club-green-800 font-medium" : "text-stone-500 hover:bg-stone-50"}`}>
            {s}
          </Link>
        ))}
      </div>

      <div className="mt-6 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">{status} insights ({insights.length})</div>
        <ul className="divide-y divide-stone-200">
          {insights.length === 0 && <li className="px-6 py-6 text-center text-stone-500">No {status.toLowerCase()} insights.</li>}
          {insights.map((i) => (
            <li key={i.id} className="px-6 py-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge status={i.severity} />
                    <div className="font-medium">{i.title}</div>
                  </div>
                  <p className="mt-1 text-sm text-stone-600">{i.body}</p>
                  <div className="mt-2 text-xs text-stone-500">
                    {i.kind} · raised {formatDate(i.raisedAt)}{i.rule ? ` · ${i.rule.name}` : ""}
                  </div>
                </div>
                <div className="text-right text-xs space-x-2 shrink-0">
                  {canWrite && i.status === "OPEN" && (
                    <form action={acknowledgeAction.bind(null, i.id)} className="inline"><button className="text-stone-600 hover:underline">Acknowledge</button></form>
                  )}
                  {canWrite && i.status !== "RESOLVED" && i.status !== "DISMISSED" && (
                    <form action={resolveAction.bind(null, i.id)} className="inline"><button className="text-club-green-700 hover:underline">Resolve</button></form>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
