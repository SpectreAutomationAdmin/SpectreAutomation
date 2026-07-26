import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { reportingService } from "@/lib/enterprise";
import { prisma } from "@/lib/prisma";
import { formatDate } from "@/lib/finance";

const REPORTS = [
  { href: "/app/admin/reporting/monthly",         title: "Monthly Board Package", body: "Polished single-page board package: executive summary, stewardship KPIs, financial statements, payroll and F&B." },
  { href: "/app/admin/reports/trial-balance",     title: "Trial Balance",        body: "All active accounts with debit/credit totals at a point in time." },
  { href: "/app/admin/reports/balance-sheet",     title: "Balance Sheet",        body: "Assets, liabilities, equity — at a date." },
  { href: "/app/admin/reports/income-statement",  title: "Income Statement",     body: "Revenue, gross margin, and net income for a period." },
  { href: "/app/admin/reports/department-pnl",    title: "Income by Department", body: "Department contribution analysis for a period." },
];

export default async function ReportsPage() {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "reports:financial")) redirect("/app/admin");

  const canReadSaved = hasPermission(p, clubId, "reports:read");
  const [savedReports, recentRuns] = canReadSaved ? await Promise.all([
    reportingService.listSavedReports(p, clubId),
    reportingService.listReportRuns(p, clubId, { limit: 10 }),
  ]) : [[], []];
  const definitions = canReadSaved ? await prisma.reportDefinition.findMany({ where: { clubId, isActive: true }, orderBy: { name: "asc" } }) : [];

  return (
    <div>
      <h1 className="page-title">Reports</h1>
      <p className="mt-1 text-stone-500">Run financial statements, snapshot results for governance packages, and export to CSV / PDF.</p>

      <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-5">
        {REPORTS.map((r) => (
          <Link key={r.href} href={r.href} className="card card-body hover:shadow-elevated transition-shadow">
            <div className="font-serif text-xl">{r.title}</div>
            <p className="mt-2 text-sm text-stone-600">{r.body}</p>
            <span className="mt-3 text-sm text-club-green-700">Open →</span>
          </Link>
        ))}
      </div>

      {canReadSaved && (
        <div className="mt-10 grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="card overflow-hidden">
            <div className="px-6 py-4 border-b border-stone-200 font-medium">Report definitions ({definitions.length})</div>
            <ul className="divide-y divide-stone-200">
              {definitions.map((d) => (
                <li key={d.id} className="px-6 py-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{d.name}</span>
                    <span className="text-xs text-stone-500">{d.category} · {d.key}</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div className="card overflow-hidden">
            <div className="px-6 py-4 border-b border-stone-200 font-medium">Recent runs</div>
            <ul className="divide-y divide-stone-200">
              {recentRuns.length === 0 && <li className="px-6 py-6 text-center text-stone-500">No runs yet.</li>}
              {recentRuns.map((r) => (
                <li key={r.id} className="px-6 py-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{r.definition.name}</span>
                    <span className="text-xs text-stone-500">{r.status} · {r.rowCount} rows</span>
                  </div>
                  <div className="mt-1 text-xs text-stone-500">{formatDate(r.startedAt)}</div>
                </li>
              ))}
              {savedReports.length > 0 && <li className="px-6 py-3 text-xs text-stone-500">{savedReports.length} saved report configuration(s) on file.</li>}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
