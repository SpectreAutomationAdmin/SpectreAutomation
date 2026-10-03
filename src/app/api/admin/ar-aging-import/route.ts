// AR-HIST-1 §22 (2026-10-03) — AR Aging import API endpoint.
//
// POST multipart/form-data:
//   file                  — the sanitized Jonas AR workbook (XLSX)
//   clubId                — target club
//   sourceEffectiveDate   — YYYY-MM-DD
//   action                — "preview" | "commit"
//
// GET  — returns the latest batch summary + resolver outcome totals.

import { NextRequest, NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/services/principal";
import { isSuperAdmin, type Principal } from "@/lib/rbac";
import { loadJonasArAgingWorkbook } from "@/lib/imports/ar-aging/jonas-xlsx-loader";
import {
  previewArAgingBatch,
  commitArAgingBatch,
} from "@/lib/imports/ar-aging/commit-service";
import { prisma } from "@/lib/prisma";

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
function parseIsoDate(s: string | null): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999));
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isStaging()) return NextResponse.json({ error: "Not available in production." }, { status: 404 });
  const principal = await requirePrincipal();
  const form = await req.formData();
  const clubId = String(form.get("clubId") ?? "").trim();
  if (!clubId) return NextResponse.json({ error: "clubId required" }, { status: 400 });
  if (!hasClubAccess(principal, clubId)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const action = String(form.get("action") ?? "preview").toLowerCase();
  const file = form.get("file");
  if (!file || typeof file === "string") {
    return NextResponse.json({ error: "file field required (multipart)" }, { status: 400 });
  }
  const sourceEffectiveDate = parseIsoDate(String(form.get("sourceEffectiveDate") ?? ""));
  if (!sourceEffectiveDate) {
    return NextResponse.json({ error: "sourceEffectiveDate (YYYY-MM-DD) required" }, { status: 400 });
  }
  const buf = Buffer.from(await (file as File).arrayBuffer());
  const { rows, sourceFileHash } = await loadJonasArAgingWorkbook(buf);

  if (action === "preview") {
    const preview = await previewArAgingBatch({
      clubId, rows,
      sourceFileName: (file as File).name ?? null,
      sourceFileHash, sourceEffectiveDate,
    });
    return NextResponse.json({
      sourceFileHash: preview.sourceFileHash,
      sourceEffectiveDate: preview.sourceEffectiveDate.toISOString().slice(0, 10),
      rowCount: preview.parse.rows.length,
      invalidCount: 0,
      warningCount: preview.parse.warnings.length,
      warnings: preview.parse.warnings.slice(0, 25),
      aggregateReconcilesPerRow: preview.parse.aggregateReconcilesPerRow,
      rowsFailingReconciliation: preview.parse.rowsFailingReconciliation.length,
      totals: {
        totalAR: preview.parse.totals.totalAR.toString(),
        current: preview.parse.totals.current.toString(),
        oneMonth: preview.parse.totals.oneMonth.toString(),
        twoMonths: preview.parse.totals.twoMonths.toString(),
        threeMonths: preview.parse.totals.threeMonths.toString(),
        overFourMonths: preview.parse.totals.overFourMonths.toString(),
        currentPct: preview.parse.totals.currentPct,
        nonCurrentPct: preview.parse.totals.nonCurrentPct,
        accountCount: preview.parse.totals.accountCount,
        nonCurrentAccountCount: preview.parse.totals.nonCurrentAccountCount,
      },
      resolutionSummary: preview.resolutionSummary,
      nameConsistency: preview.nameConsistency,
      gl: {
        accountNumber: preview.gl.accountNumber,
        accountName: preview.gl.accountName,
        fsGroupsUsed: preview.gl.fsGroupsUsed,
        naturalBalance: preview.gl.naturalBalance?.toString() ?? null,
        subledgerTotal: preview.gl.subledgerTotal.toString(),
        difference: preview.gl.difference?.toString() ?? null,
        status: preview.gl.status,
        accountsIncluded: preview.gl.accountsIncluded,
      },
      commitEligible: preview.commitEligible,
    });
  }

  if (action === "commit") {
    try {
      const outcome = await commitArAgingBatch({
        clubId, rows,
        sourceFileName: (file as File).name ?? null,
        sourceFileHash, sourceEffectiveDate,
        uploadedByUserId: principal.id,
      });
      return NextResponse.json({ committed: true, ...outcome });
    } catch (e) {
      return NextResponse.json({ committed: false, error: (e as Error).message }, { status: 409 });
    }
  }

  return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isStaging()) return NextResponse.json({ error: "Not available in production." }, { status: 404 });
  const principal = await requirePrincipal();
  const clubId = (req.nextUrl.searchParams.get("clubId") ?? "").trim();
  if (!clubId) return NextResponse.json({ error: "clubId required" }, { status: 400 });
  if (!hasClubAccess(principal, clubId)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const batches = await prisma.arAgingImportBatch.findMany({
    where: { clubId },
    orderBy: { uploadedAt: "desc" },
    take: 10,
  });
  const [memberAccountCount, snapshotRowCount] = await Promise.all([
    prisma.memberAccount.count({ where: { clubId } }),
    prisma.arAgingSnapshotRow.count({ where: { clubId } }),
  ]);
  return NextResponse.json({
    batches: batches.map((b) => ({
      id: b.id,
      status: b.status,
      sourceFileHash: b.sourceFileHash.slice(0, 16) + "…",
      sourceEffectiveDate: b.sourceEffectiveDate.toISOString().slice(0, 10),
      rowCount: b.rowCount,
      totalNet: b.totalNet.toString(),
      totalCurrent: b.totalCurrent.toString(),
      matchedMembers: b.matchedMembers,
      unmatchedMembers: b.unmatchedMembers,
      glControlAccountNumber: b.glControlAccountNumber,
      glControlAccountName: b.glControlAccountName,
      glControlBalance: b.glControlBalance?.toString() ?? null,
      reconciliationDifference: b.reconciliationDifference?.toString() ?? null,
      reconciliationStatus: b.reconciliationStatus,
      uploadedAt: b.uploadedAt.toISOString(),
      committedAt: b.committedAt?.toISOString() ?? null,
    })),
    totals: { memberAccountCount, snapshotRowCount },
  });
}
