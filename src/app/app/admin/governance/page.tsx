import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";

export default async function GovernanceHubPage() {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });

  const [pkgCount, grantCount, openWfCount, openInsights] = await Promise.all([
    prisma.reportingPackage.count({ where: { clubId } }),
    prisma.auditorAccessGrant.count({ where: { clubId, status: "ACTIVE" } }),
    prisma.workflow.count({ where: { clubId, status: "ACTIVE" } }),
    prisma.insight.count({ where: { clubId, status: "OPEN" } }),
  ]);

  const tiles: Array<{ href: string; title: string; body: string; permission: string; count?: number }> = [
    { href: "/app/admin/governance/board-committees", title: "Board & Committees", body: "Assign Board roles and committee memberships to members. Active terms automatically grant board-dashboard access.", permission: "packages:read" },
    { href: "/app/admin/governance/packages", title: "Board & finance packages", body: "Curate monthly board reporting packages with commentary, distribution, and approval.", permission: "packages:read", count: pkgCount },
    { href: "/app/admin/governance/auditor", title: "Auditor portal", body: "Time-limited, audited, read-only access for external auditors and PBC requests.", permission: "auditor:invite", count: grantCount },
    { href: "/app/admin/governance/workflows", title: "Workflows", body: "Multi-step approvals for budgets, capital projects, banking changes, and policy.", permission: "workflow:read", count: openWfCount },
    { href: "/app/admin/insights", title: "Cross-module insights", body: "AI-ready rule engine surfacing the things you should be looking at.", permission: "insights:read", count: openInsights },
    { href: "/app/admin/documents", title: "Document library", body: "Versioned documents, retention policies, signed-URL sharing, full audit trail.", permission: "documents:read" },
    { href: "/app/admin/notifications", title: "Notifications", body: "Templates, preferences, communication log, in-app and email delivery.", permission: "notifications:read" },
  ];

  return (
    <div>
      <h1 className="page-title">Governance & Reporting</h1>
      <p className="mt-1 text-stone-500">The board-room view of Spectre — reporting packages, auditor access, governance workflows, and enterprise insights.</p>
      <div className="mt-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {tiles.filter((t) => hasPermission(p, clubId, t.permission as never)).map((t) => (
          <Link key={t.href} href={t.href} className="card card-body hover:shadow-elevated transition-shadow">
            <div className="flex items-center justify-between">
              <div className="font-serif text-xl">{t.title}</div>
              {typeof t.count === "number" && <div className="text-xs font-mono text-stone-500">{t.count}</div>}
            </div>
            <p className="mt-2 text-sm text-stone-600">{t.body}</p>
            <span className="mt-3 text-sm text-club-green-700">Open →</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
