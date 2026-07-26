// Monthly Board Reporting Package page.
//
// Executive-reporting deliverable at /app/admin/reporting/monthly.
// Reads a structured MonthlyReportingPackage from the reporting
// service and renders the document: cover + ten chapters, framed
// by the Executive Reporting Theme (deep green / ivory / muted
// gold), under the dedicated ReportingShell that strips the
// operational admin chrome.

import { Fragment } from "react";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import {
  getMonthlyReportingPackage,
  type KpiTone,
  type StatementLine,
  type BoardConsideration,
  type BoardRisk,
  type BoardRiskSeverity,
  type BoardRiskTrend,
  type BoardDecision,
  type DecisionAction,
} from "@/lib/reporting/monthly-package";
import {
  evaluateMetric,
  rollupChapter,
  countFlagged,
  labelFor,
  kpiToneFor,
  type Attention,
  type PillarKey,
} from "@/lib/reporting/attention";

// Publish lifecycle — the founder collapsed the prior PublishBar
// (separate white header) + the "Publish and send to Board" button
// into a single "Publish" affordance that lives INSIDE the dark
// green ReportingShell header. `PublishHeaderButton` renders nothing
// at its natural DOM position; it portals a button into a stable
// slot in the shell header. Visible only for DRAFT packages.
import { AtAGlanceBlock } from "@/components/reporting/AtAGlanceBlock";
import { prisma as prismaImport } from "@/lib/prisma";
import { computePublishedPayloadHash } from "@/lib/reporting/monthly-package-lifecycle";
import { PublishHeaderButton } from "./PublishHeaderButton";
import { MonthlyReportingPackageBody } from "./MonthlyReportingPackageBody";

// Step / board-package shell — the page no longer owns its own
// sidebar / chapter rail. The dedicated reporting layout
// (src/app/app/admin/reporting/layout.tsx) provides the chapter rail
// + back-to-admin chrome. This page renders only the report body.
// Card-level redesign comes in a later step.

type MonthlyReportingPageProps = {
  searchParams?: { period?: string };
};

/**
 * Parse a YYYY-MM period query param into the {periodStart, periodEnd}
 * shape `getMonthlyReportingPackage` consumes. Returns `null` for
 * missing / malformed values so the service falls back to its
 * built-in default (May 2026 baseline demo).
 */
function parsePeriodQuery(
  period: string | undefined,
): { start: Date; end: Date } | null {
  if (!period) return null;
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]); // 1..12
  const start = new Date(Date.UTC(year, month - 1, 1));
  // Last day of the month: day=0 of next month.
  const end = new Date(Date.UTC(year, month, 0));
  return { start, end };
}

export default async function MonthlyReportingPage({
  searchParams,
}: MonthlyReportingPageProps) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!hasPermission(principal, clubId, "reports:board")) redirect("/app/admin");

  // Founder rule 2026-07-13 v15.14 — the SOFP builder can attach
  // underlying account detail to each FS-Group summary row and
  // surface a per-account unmapped band, but ONLY when the viewer
  // holds `coa:read`. Board / Auditor / non-finance admins fall
  // back to the collapsed summarised statement. The permission
  // check runs here at the route layer (the entry that also gates
  // the whole reporting-board rail), never inside the reporting
  // service — the service accepts a serialisable boolean so no
  // principal object crosses the RSC boundary.
  const viewerCanDrillDown = hasPermission(principal, clubId, "coa:read");

  // The launcher at /app/admin/governance/monthly-package routes
  // here with `?period=YYYY-MM`. Without the param the service
  // returns its built-in May 31, 2026 baseline (back-compat: the
  // legacy direct URL still loads the same package).
  const period = parsePeriodQuery(searchParams?.period);
  const pkg = period
    ? await getMonthlyReportingPackage(clubId, { period, viewerCanDrillDown })
    : await getMonthlyReportingPackage(clubId, { viewerCanDrillDown });

  // Look up the matching MonthlyPackage archive row for this
  // period — if the launcher generated a DRAFT (or the operator
  // previously published/sent it), surface the publish/send action
  // bar at the top of the document for review-then-act flow.
  const periodKeyForBar =
    searchParams?.period ??
    `${pkg.period.endISO.slice(0, 4)}-${pkg.period.endISO.slice(5, 7)}`;
  const reportingYear = Number(periodKeyForBar.slice(0, 4));
  const reportingMonth = Number(periodKeyForBar.slice(5, 7));
  // Under the new publication model, the unique constraint on
  // (clubId, reportingYear, reportingMonth) guarantees AT MOST ONE
  // row per period. No more two-row "live vs archived for the same
  // period" reconciliation — one findUnique resolves it.
  const monthlyPackageRow =
    Number.isFinite(reportingYear) && Number.isFinite(reportingMonth)
      ? await prismaImport.monthlyPackage.findUnique({
          where: {
            clubId_reportingYear_reportingMonth: {
              clubId,
              reportingYear,
              reportingMonth,
            },
          },
          select: {
            id: true,
            status: true,
            title: true,
            publishedPayloadHash: true,
            reportingYear: true,
            reportingMonth: true,
          },
        })
      : null;
  const headerRow = monthlyPackageRow;

  // Resolve the club's current Live Package = the newest reporting
  // period at PUBLISHED status (SENT counts as a legacy alias). The
  // PublishHeaderButton uses this to vary its messaging — when the
  // row being edited IS the Live one, the overwrite dialog says
  // "this will change what the Board reads"; when it's an older
  // archived period, the dialog says "this will NOT change what the
  // Board reads".
  const currentLiveRow = await prismaImport.monthlyPackage.findFirst({
    where: { clubId, status: { in: ["PUBLISHED", "SENT"] } },
    orderBy: [
      { reportingYear: "desc" },
      { reportingMonth: "desc" },
      { publishedAt: "desc" },
    ],
    select: { id: true, reportingYear: true, reportingMonth: true },
  });
  const isCurrentLive =
    !!headerRow && !!currentLiveRow && currentLiveRow.id === headerRow.id;

  // Compute the current at-a-glance KPI hash from the LIVE payload
  // and compare to the stored snapshot hash. Match → header reads
  // "Published" (informational, only meaningful when the row IS
  // PUBLISHED). Mismatch on a PUBLISHED row → "Overwrite Package"
  // (clickable, re-snapshot in place). DRAFT rows have null hash
  // → button reads "Publish". ARCHIVED rows always offer
  // "Overwrite Package" so the controller can correct history.
  const liveAtAGlanceKpis = [
    "ytd-revenue",
    "noi",
    "capital-income",
    "reserve-coverage",
  ]
    .map((key) => pkg.executiveSummary.kpis.find((k) => k.key === key))
    .filter(Boolean);
  const liveHash = computePublishedPayloadHash(liveAtAGlanceKpis);
  const hasUnpublishedEdits =
    !!headerRow &&
    headerRow.status === "PUBLISHED" &&
    headerRow.publishedPayloadHash !== null &&
    headerRow.publishedPayloadHash !== liveHash;

  // Human-readable period label for the overwrite dialog ("May 2026").
  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const periodLabel = headerRow
    ? `${monthNames[headerRow.reportingMonth - 1]} ${headerRow.reportingYear}`
    : "";

  return (
    <MonthlyReportingPackageBody
      pkg={pkg}
      adminHeader={
        headerRow ? (
          <PublishHeaderButton
            packageId={headerRow.id}
            period={periodKeyForBar}
            status={headerRow.status}
            title={headerRow.title}
            periodLabel={periodLabel}
            hasUnpublishedEdits={hasUnpublishedEdits}
            isCurrentLive={isCurrentLive}
          />
        ) : null
      }
    />
  );
}
