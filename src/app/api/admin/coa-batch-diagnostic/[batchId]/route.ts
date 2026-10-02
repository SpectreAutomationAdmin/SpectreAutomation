// COA-UX-2d (2026-09-30) — read-only COA batch hierarchy diagnostic.
//
// Staging-only, authenticated, read-only. Returns a per-batch
// classification-integrity report so the §11 562-row scan can run
// over an authenticated session when Fly SSH is unavailable.
//
// GET /api/admin/coa-batch-diagnostic/[batchId]
//   → counts of hierarchy violations, per-row details for the first
//     20 offenders, and (if ?account=<code>) the exact persisted
//     mapping for the specified account.
//
// Writes NOTHING. No bulk repair. No commit path. Rejected in
// production. Requires an authenticated principal and SUPER_ADMIN /
// FINANCE_ADMIN role.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requirePrincipal } from "@/lib/services/principal";
import { isSuperAdmin, type Principal } from "@/lib/rbac";
import { normaliseCoaRow } from "@/lib/imports/coa-mapping";
import { readReviewState } from "@/lib/imports/coa-review-state";
import {
  checkClassificationCoherence,
  type ClassificationViolationCode,
} from "@/lib/imports/classification-hierarchy";
import { ensureFiscalYear } from "@/lib/accounting/periods";

function hasClubAccess(p: Principal, clubId: string): boolean {
  if (isSuperAdmin(p)) return true;
  return p.memberships.some((m) => m.clubId === clubId);
}

function isStaging(): boolean {
  const env = (process.env.SPECTRE_ENV ?? process.env.NEXT_PUBLIC_ENVIRONMENT ?? "").toLowerCase();
  if (env === "staging") return true;
  return env !== "production" && (process.env.NODE_ENV ?? "") !== "production";
}

type RowReport = {
  rowId: string;
  accountNumber: string;
  name: string;
  type: string | null;
  categoryKey: string | null;
  fsGroupKey: string | null;
  reviewed: boolean;
  violationCode?: ClassificationViolationCode;
  violationReason?: string;
};

export async function GET(
  req: NextRequest,
  context: { params: { batchId: string } },
): Promise<NextResponse> {
  if (!isStaging()) {
    return NextResponse.json({ error: "Not available in production." }, { status: 404 });
  }
  const principal = await requirePrincipal();

  const { batchId } = context.params;
  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    select: { id: true, clubId: true, domain: true, status: true },
  });
  if (!batch) return NextResponse.json({ error: "Batch not found." }, { status: 404 });
  if (batch.domain !== "COA") {
    return NextResponse.json({ error: "Batch is not a COA import." }, { status: 400 });
  }
  // Tenant scoping — SUPER_ADMIN gets through; otherwise the principal
  // must have a membership on the batch's club.
  if (!hasClubAccess(principal, batch.clubId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [rows, categories, clubAccountCount, clubJournalEntryCount, clubReportingLedgerBatchCount, clubReportingLedgerSnapshotCount, fiscalYears] = await Promise.all([
    prisma.importRow.findMany({
      where: { batchId },
      select: { id: true, rawJson: true },
    }),
    prisma.accountCategory.findMany({
      where: { clubId: batch.clubId },
      select: { key: true, type: true },
    }),
    // COA-UX-3 (2026-09-30) — §19 data-invariant surface. SSH is
    // unavailable from the operator's machine; this read-only count
    // lets authenticated Playwright assert Coulee's post-import
    // state without reaching the DB directly.
    prisma.account.count({ where: { clubId: batch.clubId } }),
    prisma.journalEntry.count({ where: { clubId: batch.clubId } }),
    prisma.reportingLedgerBatch.count({ where: { clubId: batch.clubId } }),
    prisma.reportingLedgerSnapshot.count({ where: { clubId: batch.clubId } }),
    // TB-HIST-2b (2026-10-01) §5 — fiscal calendar state. Required
    // before the founder's first historical TB commit.
    prisma.fiscalYear.findMany({
      where: { clubId: batch.clubId },
      select: { label: true, startDate: true, endDate: true, _count: { select: { periods: true } } },
      orderBy: { startDate: "asc" },
    }),
  ]);
  const catalog = categories.map((c) => ({ key: c.key, accountType: c.type }));

  const specificAccountFilter = (req.nextUrl.searchParams.get("account") ?? "").trim();

  let total = 0;
  let reviewed = 0;
  const violationCounts: Record<ClassificationViolationCode, number> = {
    TYPE_CATEGORY_MISMATCH: 0,
    CATEGORY_FS_GROUP_MISMATCH: 0,
    FS_GROUP_WITHOUT_CATEGORY: 0,
    FS_GROUP_WITHOUT_TYPE: 0,
  };
  const offenders: RowReport[] = [];
  let specificAccount: RowReport | null = null;

  for (const r of rows) {
    total++;
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(r.rawJson || "{}") as Record<string, unknown>; } catch { raw = {}; }
    const normalised = normaliseCoaRow(raw);
    const isReviewed = readReviewState(raw).reviewed === true;
    if (isReviewed) reviewed++;

    const type = normalised.type ?? null;
    const categoryKey = normalised.categoryKey ?? null;
    const fsGroupKey = normalised.fsGroupKey ?? null;
    const coherence = checkClassificationCoherence({ type, categoryKey, fsGroupKey }, catalog);

    const report: RowReport = {
      rowId: r.id,
      accountNumber: normalised.number,
      name: normalised.name,
      type,
      categoryKey,
      fsGroupKey,
      reviewed: isReviewed,
    };
    if (!coherence.coherent) {
      report.violationCode = coherence.code;
      report.violationReason = coherence.reason;
      violationCounts[coherence.code] = (violationCounts[coherence.code] ?? 0) + 1;
      if (offenders.length < 20) offenders.push(report);
    }
    if (specificAccountFilter && normalised.number === specificAccountFilter) {
      specificAccount = report;
    }
  }

  return NextResponse.json({
    batchId,
    // TB-HIST-6 — expose the tenant clubId so the departmental
    // bootstrap acceptance can call /api/admin/jonas-departments-
    // bootstrap without hardcoding Coulee's STAGING id.
    clubId: batch.clubId,
    status: batch.status,
    total,
    reviewed,
    notReviewed: total - reviewed,
    violations: violationCounts,
    totalViolations: Object.values(violationCounts).reduce((a, b) => a + b, 0),
    offenders,
    specificAccount,
    club: {
      account: clubAccountCount,
      journalEntry: clubJournalEntryCount,
      reportingLedgerBatch: clubReportingLedgerBatchCount,
      reportingLedgerSnapshot: clubReportingLedgerSnapshotCount,
    },
    fiscalCalendar: {
      years: fiscalYears.map((fy) => ({
        label: fy.label,
        startDate: fy.startDate.toISOString().slice(0, 10),
        endDate: fy.endDate.toISOString().slice(0, 10),
        periodCount: fy._count.periods,
      })),
    },
  });
}

// TB-HIST-2b (2026-10-01) §5 — fiscal-calendar bootstrap. POST idempotently
// creates FY2025 + FY2026 + 12 FiscalPeriod records each via the normal
// `ensureFiscalYear` helper. No balances, no transactions, no snapshots
// are created. Rejected in production + requires SUPER_ADMIN.
export async function POST(req: NextRequest, context: { params: { batchId: string } }): Promise<NextResponse> {
  if (!isStaging()) {
    return NextResponse.json({ error: "Not available in production." }, { status: 404 });
  }
  const principal = await requirePrincipal();
  const { batchId } = context.params;
  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    select: { clubId: true },
  });
  if (!batch) return NextResponse.json({ error: "Batch not found." }, { status: 404 });
  // TB-HIST-2b (2026-10-01) — tenant scoping: super-admin OR a
  // membership on the batch's club. This is a non-destructive
  // calendar bootstrap (no balances / no transactions / no snapshots),
  // and the GET on the same route uses the same gate.
  if (!hasClubAccess(principal, batch.clubId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({})) as { action?: string; years?: number[] };
  if (body.action !== "ensureFiscalYears") {
    return NextResponse.json({ error: `Unsupported action '${body.action ?? ""}'. Expected 'ensureFiscalYears'.` }, { status: 400 });
  }
  const years = Array.isArray(body.years) && body.years.every((y) => Number.isInteger(y))
    ? body.years
    : [2025, 2026];

  const created: Array<{ year: number; label: string; periods: number }> = [];
  for (const year of years) {
    const fy = await ensureFiscalYear(batch.clubId, { startYear: year, startMonth: 1, label: `FY${year}` });
    const periods = await prisma.fiscalPeriod.count({ where: { clubId: batch.clubId, fiscalYearId: fy.id } });
    created.push({ year, label: fy.label, periods });
  }
  return NextResponse.json({ ok: true, created });
}
