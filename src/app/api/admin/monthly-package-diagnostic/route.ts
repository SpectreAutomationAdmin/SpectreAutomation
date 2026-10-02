// TB-HIST-9 (2026-10-02) — staging-only MonthlyPackage read-only
// diagnostic. Answers "did <period> publish for <club>" without
// requiring SSH access to the Fly staging DB.
//
// GET /api/admin/monthly-package-diagnostic?clubId=<id>&reportingYear=<y>&reportingMonth=<m>
//
// Returns the one MonthlyPackage row (if any) for the specified
// (clubId, reportingYear, reportingMonth) tuple. Includes:
//   • status (DRAFT|PUBLISHED|SENT|ARCHIVED)
//   • publishedAt / sentAt / generatedAt
//   • publishedByUserId / sentByUserId
//   • publishedPayloadHash
//   • packagePayloadJson_bytes (length only — the full payload is
//     too large to return in a diagnostic response)
//   • executiveOpeningSnapshotJson_present (boolean)
//   • atAGlanceKpisJson_present (boolean)
//
// Rejected in production. Requires authenticated principal + tenant
// membership on the club (or SUPER_ADMIN). Pure read.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requirePrincipal } from "@/lib/services/principal";
import { isSuperAdmin, type Principal } from "@/lib/rbac";

// TB-HIST-9 — force this route to be dynamic. Next.js's build pass
// otherwise pre-renders routes it can't statically prove are
// request-dependent, and `requirePrincipal()` + `req.nextUrl.
// searchParams` evaluated at build time produce a prerendered 404.
// Our sibling diagnostic routes under /api/admin/ include this
// marker for the same reason.
export const dynamic = "force-dynamic";

function isStaging(): boolean {
  const env = (process.env.SPECTRE_ENV ?? process.env.NEXT_PUBLIC_ENVIRONMENT ?? "").toLowerCase();
  if (env === "staging") return true;
  return env !== "production" && (process.env.NODE_ENV ?? "") !== "production";
}

function hasClubAccess(p: Principal, clubId: string): boolean {
  if (isSuperAdmin(p)) return true;
  return p.memberships.some((m) => m.clubId === clubId);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isStaging()) {
    return NextResponse.json({ error: "Not available in production." }, { status: 404 });
  }
  const principal = await requirePrincipal();
  const clubId = (req.nextUrl.searchParams.get("clubId") ?? "").trim();
  const year = Number(req.nextUrl.searchParams.get("reportingYear"));
  const month = Number(req.nextUrl.searchParams.get("reportingMonth"));
  if (!clubId) return NextResponse.json({ error: "clubId is required." }, { status: 400 });
  if (!hasClubAccess(principal, clubId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // When reportingYear + reportingMonth are supplied, return the one
  // targeted row. Otherwise return the full list for the club so the
  // operator can see every published / draft row at a glance.
  if (Number.isFinite(year) && Number.isFinite(month)) {
    const row = await prisma.monthlyPackage.findUnique({
      where: { clubId_reportingYear_reportingMonth: { clubId, reportingYear: year, reportingMonth: month } },
      select: {
        id: true,
        clubId: true,
        reportingYear: true,
        reportingMonth: true,
        periodEndDate: true,
        status: true,
        title: true,
        generatedAt: true,
        publishedAt: true,
        publishedByUserId: true,
        sentAt: true,
        sentByUserId: true,
        publishedPayloadHash: true,
        executiveOpeningSnapshotJson: true,
        atAGlanceKpisJson: true,
        packagePayloadJson: true,
      },
    });
    if (!row) return NextResponse.json({ found: false, clubId, reportingYear: year, reportingMonth: month });
    return NextResponse.json({
      found: true,
      row: {
        id: row.id,
        clubId: row.clubId,
        reportingYear: row.reportingYear,
        reportingMonth: row.reportingMonth,
        periodEndDate: row.periodEndDate,
        status: row.status,
        title: row.title,
        generatedAt: row.generatedAt,
        publishedAt: row.publishedAt,
        publishedByUserId: row.publishedByUserId,
        sentAt: row.sentAt,
        sentByUserId: row.sentByUserId,
        publishedPayloadHash: row.publishedPayloadHash,
        executiveOpeningSnapshotJson_present: row.executiveOpeningSnapshotJson != null,
        atAGlanceKpisJson_present: row.atAGlanceKpisJson != null,
        packagePayloadJson_bytes: row.packagePayloadJson ? row.packagePayloadJson.length : 0,
      },
    });
  }

  // No year/month → list all rows for the club.
  const rows = await prisma.monthlyPackage.findMany({
    where: { clubId },
    orderBy: [{ reportingYear: "desc" }, { reportingMonth: "desc" }],
    select: {
      id: true,
      reportingYear: true,
      reportingMonth: true,
      status: true,
      generatedAt: true,
      publishedAt: true,
      sentAt: true,
      publishedPayloadHash: true,
      packagePayloadJson: true,
    },
  });
  return NextResponse.json({
    found: rows.length > 0,
    clubId,
    count: rows.length,
    rows: rows.map((r) => ({
      id: r.id,
      reportingYear: r.reportingYear,
      reportingMonth: r.reportingMonth,
      status: r.status,
      generatedAt: r.generatedAt,
      publishedAt: r.publishedAt,
      sentAt: r.sentAt,
      publishedPayloadHash: r.publishedPayloadHash,
      packagePayloadJson_bytes: r.packagePayloadJson ? r.packagePayloadJson.length : 0,
    })),
  });
}
