// MEM-HIST-2 §18-19 (2026-10-03) — Member Master import API endpoint.
//
// POST — upload the sanitized workbook as multipart/form-data.
//        Field "file" is the XLSX; field "sourceEffectiveDate" is
//        YYYY-MM-DD; field "action" is one of:
//          "preview" — parse + resolve bill-to; do NOT persist
//          "commit"  — parse + persist (MemberExternalIdentity +
//                       MembershipHistoryEntry + MemberBillingRelationship)
// GET  — returns the latest import batch summary + aggregate counts.
//
// Staging-only. Rejected in production (defense-in-depth; the real
// workflow for production will land in the admin UI with proper
// RBAC + audit).

import { NextRequest, NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/services/principal";
import { isSuperAdmin, type Principal } from "@/lib/rbac";
import {
  parseJonasMemberMasterWorkbook,
} from "@/lib/imports/member-master/jonas-parser";
import { commitJonasMemberMasterBatch } from "@/lib/imports/member-master/commit-service";
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
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
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
  const parsed = await parseJonasMemberMasterWorkbook({
    buffer: buf,
    sourceFileName: (file as File).name ?? null,
    sourceEffectiveDate,
  });

  if (action === "preview") {
    return NextResponse.json({
      preview: true,
      sourceFileHash: parsed.sourceFileHash,
      sourceEffectiveDate: parsed.sourceEffectiveDate.toISOString().slice(0, 10),
      rowCount: parsed.rows.length,
      invalidCount: parsed.invalidRows.length,
      warningCount: parsed.warnings.length,
      warnings: parsed.warnings.slice(0, 25),
      invalidSample: parsed.invalidRows.slice(0, 25),
      billToSummary: summarizeBillTo(parsed.billToOutcomes),
      statusDistribution: countBy(parsed.rows, (r) => r.sourceStatus),
      interpretedDistribution: countBy(parsed.rows, (r) => r.interpretedStatus),
      shareholderCount: parsed.rows.filter((r) => r.isShareholder).length,
    });
  }

  if (action === "commit") {
    try {
      const outcome = await commitJonasMemberMasterBatch({
        clubId,
        parsed,
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

  const batches = await prisma.memberMasterImportBatch.findMany({
    where: { clubId },
    orderBy: { uploadedAt: "desc" },
    take: 10,
  });
  const [externalIdCount, memberCount, historyCount, billingCount] = await Promise.all([
    prisma.memberExternalIdentity.count({ where: { clubId } }),
    prisma.member.count({ where: { clubId } }),
    prisma.membershipHistoryEntry.count({ where: { clubId } }),
    prisma.memberBillingRelationship.count({ where: { clubId } }),
  ]);

  return NextResponse.json({
    batches: batches.map((b) => ({
      id: b.id,
      status: b.status,
      sourceSystem: b.sourceSystem,
      sourceFileName: b.sourceFileName,
      sourceEffectiveDate: b.sourceEffectiveDate.toISOString().slice(0, 10),
      sourceFileHash: b.sourceFileHash.slice(0, 16) + "…",
      rowCount: b.rowCount,
      newMemberCount: b.newMemberCount,
      matchedMemberCount: b.matchedMemberCount,
      billToSelfCount: b.billToSelfCount,
      billToResolvedCount: b.billToResolvedCount,
      billToUnresolvedCount: b.billToUnresolvedCount,
      classificationCount: b.classificationCount,
      uploadedAt: b.uploadedAt.toISOString(),
      committedAt: b.committedAt?.toISOString() ?? null,
    })),
    totals: {
      externalIdentities: externalIdCount,
      members: memberCount,
      historyEntries: historyCount,
      billingRelationships: billingCount,
    },
  });
}

function summarizeBillTo(
  outcomes: Array<{ outcome: string; billToMemberNumber: string | null }>,
): { self: number; resolved: number; unresolved: number; invalid: number } {
  let self = 0, resolved = 0, unresolved = 0, invalid = 0;
  for (const o of outcomes) {
    if (o.outcome === "SELF") self++;
    else if (o.outcome === "RESOLVED") resolved++;
    else if (o.outcome === "UNRESOLVED") unresolved++;
    else invalid++;
  }
  return { self, resolved, unresolved, invalid };
}

function countBy<T>(rows: T[], key: (r: T) => string): Record<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = key(r);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return Object.fromEntries(m);
}
