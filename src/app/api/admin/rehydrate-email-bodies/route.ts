// Sprint 3 · Checkpoint 16H rejection #3 (2026-08-06) — GENERAL
// ops endpoint for re-fetching + re-sanitizing stored EmailMessage
// HTML bodies whenever the sanitizer contract changes.
//
// NOT item-specific. Iterates every EmailMessage in the active club
// whose stored bodyHtmlSanitized looks pre-allowlist (heuristic:
// contains no `style="…"` occurrences — every real HTML newsletter
// does, so a body missing them all must have been sanitized under
// the old strip-all-styles rules). Re-fetches the raw body via the
// same delegated-Graph provider the sync loop uses. Updates the
// row via the canonical sanitizer.
//
// Gated:
//   - Requires `BACKFILL_TOKEN` env secret to be set.
//   - Requires an `Authorization: Bearer <token>` header match.
//   - Returns 404 (never 401) so the endpoint is not discoverable.
//
// Idempotent: rows that already carry safe inline styles are
// skipped; a rerun updates nothing.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability/logger";
import { getFreshDelegatedAccessToken } from "@/lib/mailbox/connect";
import { sanitizeEmailHtml, htmlToText } from "@/lib/mailbox/sanitize";

export const dynamic = "force-dynamic";

const COULEE_RIDGE_CLUB_ID = "cmrvdeny7000144372ktmmg9c";

interface RehydrateReport {
  ok: boolean;
  scanned: number;
  needRehydrate: number;
  updated: number;
  skipped: number;
  perRow: Array<{
    idSuffix: string;
    subjectHead: string;
    outcome: "updated" | "skipped_not_html" | "skipped_conn_status" | "skipped_graph_error";
    htmlLenAfter?: number;
    styleAttrCount?: number;
    reason?: string;
  }>;
}

export async function POST(req: NextRequest) {
  const token = process.env.BACKFILL_TOKEN;
  if (!token) return NextResponse.json({ error: "backfill_disabled" }, { status: 404 });
  const auth = req.headers.get("authorization") || "";
  if (auth !== `Bearer ${token}`) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const rows = await prisma.emailMessage.findMany({
    where: {
      clubId: COULEE_RIDGE_CLUB_ID,
      softDeletedAt: null,
      bodyHtmlSanitized: { not: null },
    },
    select: {
      id: true, graphMessageId: true, mailboxConnectionId: true,
      subject: true, bodyHtmlSanitized: true,
    },
  });
  const targets = rows.filter((r) => !(r.bodyHtmlSanitized || "").includes(" style="));

  const perRow: RehydrateReport["perRow"] = [];
  let updated = 0, skipped = 0;

  // Group by mailbox connection to minimise token refreshes.
  const byConn = new Map<string, typeof targets>();
  for (const t of targets) {
    if (!byConn.has(t.mailboxConnectionId)) byConn.set(t.mailboxConnectionId, [] as typeof targets);
    byConn.get(t.mailboxConnectionId)!.push(t);
  }

  for (const [connId, list] of byConn) {
    const conn = await prisma.mailboxConnection.findUnique({
      where: { id: connId },
      select: { status: true, userId: true, clubId: true },
    });
    if (!conn || conn.status !== "CONNECTED") {
      for (const t of list) {
        perRow.push({
          idSuffix: t.id.slice(-8),
          subjectHead: (t.subject || "").slice(0, 60),
          outcome: "skipped_conn_status",
          reason: conn?.status ?? "missing",
        });
        skipped++;
      }
      continue;
    }
    let accessToken: string;
    try {
      const t = await getFreshDelegatedAccessToken({
        mailboxConnectionId: connId,
        callerClubId: conn.clubId,
        callerUserId: conn.userId,
      });
      accessToken = t.accessToken;
    } catch (e) {
      for (const t of list) {
        perRow.push({
          idSuffix: t.id.slice(-8),
          subjectHead: (t.subject || "").slice(0, 60),
          outcome: "skipped_conn_status",
          reason: `token_failed: ${(e as Error).message?.slice(0, 40)}`,
        });
        skipped++;
      }
      continue;
    }

    for (const row of list) {
      try {
        const url = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(row.graphMessageId)}?$select=id,body,bodyPreview`;
        const res = await fetch(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok) {
          perRow.push({
            idSuffix: row.id.slice(-8),
            subjectHead: (row.subject || "").slice(0, 60),
            outcome: "skipped_graph_error",
            reason: `status_${res.status}`,
          });
          skipped++;
          continue;
        }
        const body = await res.json() as { body?: { contentType?: string; content?: string } };
        if (body.body?.contentType !== "html") {
          perRow.push({
            idSuffix: row.id.slice(-8),
            subjectHead: (row.subject || "").slice(0, 60),
            outcome: "skipped_not_html",
          });
          skipped++;
          continue;
        }
        const rawHtml = body.body.content ?? "";
        const resanitized = sanitizeEmailHtml(rawHtml, { maxBytes: 200_000 });
        const retextracted = htmlToText(rawHtml, { maxBytes: 8000 });
        await prisma.emailMessage.update({
          where: { id: row.id },
          data: {
            bodyHtmlSanitized: resanitized,
            bodyTextExtract: retextracted,
            lastSyncedAt: new Date(),
          },
        });
        perRow.push({
          idSuffix: row.id.slice(-8),
          subjectHead: (row.subject || "").slice(0, 60),
          outcome: "updated",
          htmlLenAfter: resanitized.length,
          styleAttrCount: (resanitized.match(/ style="/g) || []).length,
        });
        updated++;
      } catch (e) {
        perRow.push({
          idSuffix: row.id.slice(-8),
          subjectHead: (row.subject || "").slice(0, 60),
          outcome: "skipped_graph_error",
          reason: (e as Error).message?.slice(0, 40),
        });
        skipped++;
      }
    }
  }

  const report: RehydrateReport = {
    ok: true, scanned: rows.length, needRehydrate: targets.length,
    updated, skipped, perRow,
  };
  logger.info("admin.rehydrate.completed", {
    scanned: rows.length, needRehydrate: targets.length, updated, skipped,
  });
  return NextResponse.json(report);
}
