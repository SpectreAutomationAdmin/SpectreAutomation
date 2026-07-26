import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { kpiService } from "@/lib/enterprise";
import { prisma } from "@/lib/prisma";

export default async function DashboardsPage() {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "kpi:read")) redirect("/app/admin");

  const [dashboards, openAlerts] = await Promise.all([
    kpiService.listDashboards(p, clubId),
    kpiService.listAlerts(p, clubId),
  ]);
  const recentInsights = await prisma.insight.findMany({ where: { clubId, status: "OPEN" }, take: 5, orderBy: { raisedAt: "desc" } });

  return (
    <div>
      <h1 className="page-title">Executive Dashboards</h1>
      <p className="mt-1 text-stone-500">Role-tuned KPI dashboards. Values are computed monthly and stored as immutable observations; thresholds raise alerts.</p>

      <div className="mt-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {dashboards.map((d) => (
          <Link key={d.id} href={`/app/admin/dashboards/${d.key}`} className="card card-body hover:shadow-elevated transition-shadow">
            <div className="text-xs uppercase tracking-widest text-stone-400">{d.audience}</div>
            <div className="mt-1 font-serif text-xl">{d.name}</div>
            {d.description && <p className="mt-2 text-sm text-stone-600">{d.description}</p>}
            <span className="mt-3 text-sm text-club-green-700">Open →</span>
          </Link>
        ))}
      </div>

      {(openAlerts.length > 0 || recentInsights.length > 0) && (
        <div className="mt-8 grid grid-cols-1 lg:grid-cols-2 gap-6">
          {openAlerts.length > 0 && (
            <div className="card overflow-hidden">
              <div className="px-6 py-4 border-b border-stone-200 font-medium">Open KPI alerts ({openAlerts.length})</div>
              <ul className="divide-y divide-stone-200">
                {openAlerts.slice(0, 10).map((a) => (
                  <li key={a.id} className="px-6 py-3 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{a.kpi.name}</span>
                      <span className="text-xs text-stone-500">{a.observedValue.toString()} {a.kpi.unit ?? ""}</span>
                    </div>
                    <div className="mt-1 text-xs text-stone-500">Threshold {a.threshold?.kind ?? ""} · {a.threshold?.op ?? ""} {a.threshold?.threshold.toString() ?? ""}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {recentInsights.length > 0 && (
            <div className="card overflow-hidden">
              <div className="px-6 py-4 border-b border-stone-200 font-medium">Recent insights</div>
              <ul className="divide-y divide-stone-200">
                {recentInsights.map((i) => (
                  <li key={i.id} className="px-6 py-3 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{i.title}</span>
                      <span className="text-xs uppercase text-stone-500">{i.severity}</span>
                    </div>
                    <p className="mt-1 text-xs text-stone-600">{i.body}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
