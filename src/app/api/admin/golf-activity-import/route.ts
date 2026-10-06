// GOLF-HIST-1 (2026-10-05) — Historical Golf Activity import API.
//
// POST multipart/form-data:
//   file     — the GGGolf monthly Daily Report PDF.
//   clubId   — target club id.
//   action   — "preview" (default) | "commit".
//   batchId  — required for action="commit".
//
// GET (?clubId=...) — returns the most recent 10 batches for a club.
//
// Staging-only. Mirrors the AR-HIST-1 + MEM-HIST-2 pattern.

import { NextRequest, NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/services/principal";
import { isSuperAdmin, type Principal } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { parseGgGolfPdf } from "@/lib/imports/golf-activity/gggolf-pdf-parser";
import {
  previewGolfActivityBatch,
  commitGolfActivityBatch,
  GolfCommitError,
  GolfParseFailedError,
} from "@/lib/imports/golf-activity/commit-service";

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

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isStaging()) return NextResponse.json({ error: "Not available in production." }, { status: 404 });
  const principal = await requirePrincipal();
  const form = await req.formData();
  const clubId = String(form.get("clubId") ?? "").trim();
  if (!clubId) return NextResponse.json({ error: "clubId required" }, { status: 400 });
  if (!hasClubAccess(principal, clubId)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const action = String(form.get("action") ?? "preview").toLowerCase();

  if (action === "commit") {
    const batchId = String(form.get("batchId") ?? "").trim();
    if (!batchId) return NextResponse.json({ error: "batchId required for commit" }, { status: 400 });
    const batch = await prisma.golfActivityImportBatch.findUnique({ where: { id: batchId } });
    if (!batch) return NextResponse.json({ error: "Batch not found" }, { status: 404 });
    if (batch.clubId !== clubId) return NextResponse.json({ error: "Cross-tenant commit refused" }, { status: 403 });
    try {
      const result = await commitGolfActivityBatch({ batchId, committedByUserId: principal.id });
      return NextResponse.json(result);
    } catch (e) {
      if (e instanceof GolfCommitError) {
        return NextResponse.json({ error: e.message, code: e.code }, { status: 409 });
      }
      throw e;
    }
  }

  // Preview path.
  const file = form.get("file");
  if (!file || typeof file === "string") {
    return NextResponse.json({ error: "file field required (multipart)" }, { status: 400 });
  }
  const buf = Buffer.from(await (file as File).arrayBuffer());
  const parse = await parseGgGolfPdf(buf);
  let preview;
  try {
    preview = await previewGolfActivityBatch({
      clubId,
      parse,
      sourceFileName: (file as File).name ?? null,
      uploadedByUserId: principal.id,
    });
  } catch (e) {
    if (e instanceof GolfParseFailedError) {
      // Fail-closed: no batch is persisted, no misleading preview is
      // shown. The client surfaces the message prominently.
      return NextResponse.json(
        {
          error: e.message,
          code: "PARSE_FAILED",
          diagnostics: {
            reportYear: parse.reportYear,
            rowCount: parse.rows.length,
            warnings: parse.warnings.slice(0, 20),
          },
        },
        { status: 422 },
      );
    }
    throw e;
  }
  return NextResponse.json({
    batch: {
      id: preview.batch.id,
      status: preview.batch.status,
      reportingPeriodStart: preview.batch.reportingPeriodStart.toISOString().slice(0, 10),
      reportingPeriodEnd: preview.batch.reportingPeriodEnd.toISOString().slice(0, 10),
      rowCount: preview.batch.rowCount,
      activeDays: preview.batch.activeDays,
      realZeroDays: preview.batch.realZeroDays,
      conflictCount: preview.batch.conflictCount,
      warningCount: preview.batch.warningCount,
      reconciliationStatus: preview.batch.reconciliationStatus,
      sourceTotals: {
        guests: preview.batch.sourceTotalGuests,
        greenFees: preview.batch.sourceTotalGreenFees,
        members: preview.batch.sourceTotalMembers,
        total: preview.batch.sourceTotalRounds,
        juniors: preview.batch.sourceTotalJuniors,
        women: preview.batch.sourceTotalWomen,
      },
      parsedTotals: {
        guests: preview.batch.parsedTotalGuests,
        greenFees: preview.batch.parsedTotalGreenFees,
        members: preview.batch.parsedTotalMembers,
        total: preview.batch.parsedTotalRounds,
        juniors: preview.batch.parsedTotalJuniors,
        women: preview.batch.parsedTotalWomen,
      },
      sourceFileName: preview.batch.sourceFileName,
      sourceFileHash: preview.batch.sourceFileHash,
    },
    rows: preview.rows.map((r) => ({
      rowIndex: r.rowIndex,
      rawDateLabel: r.rawDateLabel,
      dateISO: r.activityDate.toISOString().slice(0, 10),
      rawWeatherCode: r.rawWeatherCode,
      guests: r.guests,
      greenFees: r.greenFees,
      members: r.members,
      totalRounds: r.totalRounds,
      juniors: r.juniors,
      women: r.women,
      conflict: r.conflict,
    })),
    warnings: parse.warnings,
  });
}

/**
 * DELETE a PREVIEW batch. REFUSES to delete COMMITTED batches
 * (those carry authoritative GolfActivityDay rows). Returns 404
 * when the batch does not exist. Used for E2E cleanup AND the
 * GOLF-HIST-1A cleanup of the founder's stale batch.
 */
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  if (!isStaging()) return NextResponse.json({ error: "Not available in production." }, { status: 404 });
  const principal = await requirePrincipal();
  const clubId = req.nextUrl.searchParams.get("clubId") ?? "";
  const batchId = req.nextUrl.searchParams.get("batchId") ?? "";
  if (!clubId || !batchId) {
    return NextResponse.json({ error: "clubId and batchId required" }, { status: 400 });
  }
  if (!hasClubAccess(principal, clubId)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const batch = await prisma.golfActivityImportBatch.findUnique({ where: { id: batchId } });
  if (!batch) return NextResponse.json({ error: "Batch not found" }, { status: 404 });
  if (batch.clubId !== clubId) return NextResponse.json({ error: "Cross-tenant delete refused" }, { status: 403 });
  if (batch.status === "COMMITTED") {
    return NextResponse.json(
      { error: "Refuse to delete a COMMITTED batch (authoritative GolfActivityDay rows exist)." },
      { status: 409 },
    );
  }
  // Preview rows cascade-delete via Prisma onDelete: Cascade.
  await prisma.golfActivityImportBatch.delete({ where: { id: batchId } });
  return NextResponse.json({ deleted: batchId });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isStaging()) return NextResponse.json({ error: "Not available in production." }, { status: 404 });
  const principal = await requirePrincipal();
  const clubId = req.nextUrl.searchParams.get("clubId") ?? "";
  if (!clubId) return NextResponse.json({ error: "clubId required" }, { status: 400 });
  if (!hasClubAccess(principal, clubId)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const batches = await prisma.golfActivityImportBatch.findMany({
    where: { clubId },
    orderBy: { uploadedAt: "desc" },
    take: 10,
    select: {
      id: true,
      status: true,
      sourceSystem: true,
      sourceFileName: true,
      reportingPeriodStart: true,
      reportingPeriodEnd: true,
      rowCount: true,
      activeDays: true,
      realZeroDays: true,
      conflictCount: true,
      warningCount: true,
      sourceTotalRounds: true,
      parsedTotalRounds: true,
      reconciliationStatus: true,
      uploadedAt: true,
      committedAt: true,
    },
  });
  return NextResponse.json({ batches });
}
