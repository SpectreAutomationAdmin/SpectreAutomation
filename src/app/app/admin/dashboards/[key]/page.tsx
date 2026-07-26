import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { kpiService } from "@/lib/enterprise";

function formatValue(value: number, unit: string | null): string {
  if (unit === "$") return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(value);
  if (unit === "%") return `${value.toFixed(1)}%`;
  return new Intl.NumberFormat("en-CA").format(value);
}

export default async function DashboardDetailPage({ params }: { params: { key: string } }) {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "kpi:read")) redirect("/app/admin");
  const dashboard = await kpiService.getDashboard(p, clubId, params.key);
  if (!dashboard) notFound();

  return (
    <div>
      <Link href="/app/admin/dashboards" className="text-sm text-stone-500 hover:text-club-ink">← Dashboards</Link>
      <h1 className="mt-3 page-title">{dashboard.name}</h1>
      {dashboard.description && <p className="mt-1 text-stone-500">{dashboard.description}</p>}

      <div className="mt-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {dashboard.widgets.map((w) => {
          const kpi = w.kpi;
          const latest = kpi?.values?.[0];
          const value = latest ? Number(latest.value.toString()) : null;
          const trend = kpi?.values?.slice(0, 6).reverse() ?? [];
          return (
            <div key={w.id} className="card card-body">
              <div className="text-xs uppercase tracking-widest text-stone-400">{w.title}</div>
              <div className="mt-2 font-serif text-3xl">{value == null ? "—" : formatValue(value, kpi?.unit ?? null)}</div>
              {latest && <div className="mt-1 text-xs text-stone-500">As of {latest.asOfDate.toISOString().slice(0, 10)}</div>}
              {trend.length > 1 && (
                <div className="mt-3 flex items-end gap-1 h-12">
                  {trend.map((v, i) => {
                    const max = Math.max(...trend.map((x) => Math.abs(Number(x.value.toString())) || 1));
                    const h = (Math.abs(Number(v.value.toString())) / max) * 100;
                    return <div key={i} className="flex-1 bg-club-green-200 rounded-sm" style={{ height: `${Math.max(3, h)}%` }} title={`${v.periodLabel}: ${v.value.toString()}`} />;
                  })}
                </div>
              )}
              {kpi?.thresholds && kpi.thresholds.length > 0 && (
                <div className="mt-2 text-xs text-stone-500">{kpi.thresholds.length} threshold(s)</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
