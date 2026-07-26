import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { summarize, subscriptionHealth, type PushAnalyticsWindow } from "@/lib/push/analytics";
import { Badge } from "@/components/Badge";

const WINDOWS: PushAnalyticsWindow[] = ["1h", "24h", "7d", "30d"];

export default async function PushAnalyticsPage({ searchParams }: { searchParams: { window?: string } }) {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "notifications:read")) redirect("/app/admin");
  const window = (WINDOWS as string[]).includes(searchParams.window ?? "") ? (searchParams.window as PushAnalyticsWindow) : "24h";

  const [summary, health] = await Promise.all([
    summarize(p, clubId, window),
    subscriptionHealth(p, clubId),
  ]);

  return (
    <div>
      <Link href="/app/admin/notifications" className="text-sm text-stone-500 hover:text-club-ink">← Notifications</Link>
      <h1 className="mt-3 page-title">Push analytics</h1>
      <p className="mt-1 text-stone-500">Web-push delivery health and per-campaign rollup.</p>

      <div className="mt-4 flex items-center gap-2">
        {WINDOWS.map((w) => (
          <Link key={w} href={`/app/admin/notifications/analytics?window=${w}`}
            className={`text-xs px-3 py-1 rounded-full border ${w === window ? "bg-club-ink text-white border-club-ink" : "bg-white text-stone-700 border-stone-200 hover:border-stone-300"}`}>{w}</Link>
        ))}
      </div>

      <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="card card-body"><div className="text-xs uppercase text-stone-500">Sent</div><div className="mt-1 text-2xl font-medium">{summary.sent}</div></div>
        <div className="card card-body"><div className="text-xs uppercase text-stone-500">Failed</div><div className="mt-1 text-2xl font-medium text-red-700">{summary.failed}</div></div>
        <div className="card card-body"><div className="text-xs uppercase text-stone-500">Expired</div><div className="mt-1 text-2xl font-medium">{summary.expired}</div></div>
        <div className="card card-body"><div className="text-xs uppercase text-stone-500">Success rate</div><div className="mt-1 text-2xl font-medium">{(summary.successRate * 100).toFixed(1)}%</div></div>
      </div>

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card card-body">
          <h2 className="section-title text-lg">Latency</h2>
          <div className="mt-2 grid grid-cols-3 gap-2 text-center">
            <div><div className="text-xs uppercase text-stone-500">p50</div><div className="text-xl font-medium">{summary.latency.p50}ms</div></div>
            <div><div className="text-xs uppercase text-stone-500">p95</div><div className="text-xl font-medium">{summary.latency.p95}ms</div></div>
            <div><div className="text-xs uppercase text-stone-500">p99</div><div className="text-xl font-medium">{summary.latency.p99}ms</div></div>
          </div>
        </div>
        <div className="card card-body">
          <h2 className="section-title text-lg">Subscriptions</h2>
          <div className="mt-2 grid grid-cols-3 gap-2 text-center">
            <div><div className="text-xs uppercase text-stone-500">Active</div><div className="text-xl font-medium">{health.active}</div></div>
            <div><div className="text-xs uppercase text-stone-500">Total</div><div className="text-xl font-medium">{health.total}</div></div>
            <div><div className="text-xs uppercase text-stone-500">Inactive</div><div className="text-xl font-medium">{(health.inactiveRate * 100).toFixed(1)}%</div></div>
          </div>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Failure categorization</div>
          <table className="table-base">
            <thead><tr><th>Reason</th><th>Count</th></tr></thead>
            <tbody>
              {Object.entries(summary.failureBuckets).length === 0 && <tr><td colSpan={2} className="px-4 py-6 text-center text-stone-500">No failures.</td></tr>}
              {Object.entries(summary.failureBuckets).map(([reason, count]) => (
                <tr key={reason}><td className="text-xs">{reason}</td><td className="text-xs">{count}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Per-campaign</div>
          <table className="table-base">
            <thead><tr><th>Campaign</th><th>Sent</th><th>Failed</th><th>Total</th></tr></thead>
            <tbody>
              {summary.campaigns.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-stone-500">No campaigns.</td></tr>}
              {summary.campaigns.map((c) => (
                <tr key={c.id}>
                  <td className="text-xs font-mono">{c.id}</td>
                  <td className="text-xs">{c.sent}</td>
                  <td className="text-xs">{c.failed}</td>
                  <td className="text-xs">{c.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
