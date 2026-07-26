// Analytics index. Today this is just a launchpad for the hospitality
// slice; future analytics areas (financial KPIs, member churn, etc.)
// will join the same grid.

import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";

export default async function AnalyticsIndex() {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = principal.activeClubId;
  if (!clubId || !hasPermission(principal, clubId, "kpi:read")) {
    redirect("/app/admin");
  }
  return (
    <div>
      <h1 className="page-title">Analytics</h1>
      <p className="mt-1 text-sm text-stone-500">
        Operational performance across the club. Choose an area below.
      </p>
      <div className="mt-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <Link
          href="/app/admin/analytics/hospitality"
          className="card card-body hover:border-club-green-400 transition-colors"
        >
          <div className="text-xs uppercase tracking-wide text-stone-500">Hospitality</div>
          <div className="mt-1 font-serif text-xl text-club-ink">Prep-time performance</div>
          <div className="mt-2 text-sm text-stone-600">
            Kitchen, bar, and dessert prep times from the lounge POS check workflow. Service-period heatmap, late-chit volume, and trend comparison.
          </div>
        </Link>
      </div>
    </div>
  );
}
