// Phase 4R rev-13 (2026-08-16) — POST /api/mission-control/refresh-mailbox.
//
// Founder-initiated manual mailbox sync barrier for the Feed Synced
// pill. The client's `refreshManually()` handler POSTs here, receives
// the enqueued job's id(s), then polls
// GET /api/mission-control/refresh-mailbox/status?jobId=... until the
// job(s) reach a terminal state before flipping the pill back to
// FEED SYNCED.
//
// This closes rev-12 Defect A ("FEED SYNCED restored without any
// mailbox sync actually running"). Prior to rev-13 the pill's click
// only hit /api/mission-control/snapshot-summary (a pure Prisma
// read) and never enqueued a delta sync.
//
// Contract:
//   POST — no body. Enumerates the caller's tenant-scoped connected
//          mailboxes and enqueues MAILBOX_DELTA_SYNC for each (or
//          MAILBOX_INITIAL_SYNC if the connection has no deltaLink
//          yet). Returns the queued job ids.
//   Response: 202 Accepted, { jobIds: string[], mailboxConnectionIds: string[], enqueuedAt: string }
//   401 unauthenticated / 400 no active club / 404 feature off / 409 no eligible mailbox.
//
// The endpoint intentionally does NOT await job execution — the
// client polls status. This keeps the request short and cancellable.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { isMailboxIntegrationEnabled } from "@/lib/env";
import { MAILBOX_ERROR_CODE } from "@/lib/mailbox/errors";
import { MAILBOX_STATUS, isTerminalStatus } from "@/lib/mailbox/status";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  if (!isMailboxIntegrationEnabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const principal = await getCurrentPrincipal();
  if (!principal) {
    return NextResponse.json({ error: MAILBOX_ERROR_CODE.UNAUTHENTICATED }, { status: 401 });
  }
  const clubId = await getActiveClubId({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clubId: (principal as any).activeClubId ?? null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    role: (principal as any).role ?? "",
  });
  if (!clubId) {
    return NextResponse.json({ error: "no_active_club" }, { status: 400 });
  }

  // Enumerate every non-terminal mailbox this founder can see for
  // the active club. The refresh acts across the whole feed, so a
  // founder with multiple linked mailboxes gets all of them synced
  // in parallel. If none exist / all are terminal, return 409 so
  // the client's failure state can render.
  const mailboxes = await prisma.mailboxConnection.findMany({
    where: {
      clubId,
      status: {
        in: [
          MAILBOX_STATUS.CONNECTED,
          MAILBOX_STATUS.DELAYED,
          MAILBOX_STATUS.CONNECTED_PENDING_SYNC,
        ],
      },
      refreshTokenSecretRef: { not: null },
      accesses: {
        some: {
          userId: principal.id,
          revokedAt: null,
        },
      },
    },
    select: {
      id: true, deltaLink: true, status: true,
    },
    take: 20,
  });

  if (mailboxes.length === 0) {
    return NextResponse.json({ error: "no_eligible_mailbox" }, { status: 409 });
  }
  const nonTerminalMailboxes = mailboxes.filter((m) => !isTerminalStatus(m.status));
  if (nonTerminalMailboxes.length === 0) {
    return NextResponse.json({ error: "no_eligible_mailbox" }, { status: 409 });
  }

  const { enqueue } = await import("@/lib/queue");
  const enqueuedAt = new Date();
  const jobIds: string[] = [];
  const mailboxConnectionIds: string[] = [];
  for (const mb of nonTerminalMailboxes) {
    // Rev-13 (2026-08-16) — always MAILBOX_INITIAL_SYNC on manual
    // refresh, not MAILBOX_DELTA_SYNC. Rationale:
    //
    // Microsoft Graph's inbox delta stream does NOT reliably surface
    // isRead-flag flips made by Outlook clients. The rev-13 first
    // acceptance run proved this on staging: after the founder
    // marked #221007 unread in Outlook, three separate delta polls
    // completed with `messagesExamined: 0` while a direct Graph
    // query confirmed `isRead: false`. Because manual refresh's
    // whole purpose is to make the mirror agree with Graph RIGHT
    // NOW, we must use the full-inbox path that re-fetches current
    // values for every message in the recent window. Cost: one
    // extra Graph request bounded to SYNC_SCOPE.pageSize per page;
    // the founder is manually asking for a barrier, so the cost is
    // acceptable. Automatic background sync remains DELTA-only
    // (auto-sync-scheduler) — this override applies only to the
    // manual refresh code path.
    const kind = "MAILBOX_INITIAL_SYNC";
    // Rev-13 — idempotencyKey includes a timestamp bucket so rapid
    // repeat clicks collapse (the queue's QUEUED/RUNNING guard) but a
    // new founder-initiated refresh after a sync completes always
    // enqueues a fresh job.
    const bucket = Math.floor(enqueuedAt.getTime() / 5_000); // 5-s bucket
    const idempotencyKey = `mailbox:manual-refresh:${mb.id}:${bucket}`;
    try {
      const job = await enqueue({
        kind,
        payload: { mailboxConnectionId: mb.id },
        clubId,
        idempotencyKey,
        correlationId: `mailbox:${mb.id}`,
        createdByUserId: principal.id,
      });
      const jobId = (job as { id?: string })?.id ?? null;
      if (jobId) {
        jobIds.push(jobId);
        mailboxConnectionIds.push(mb.id);
      }
    } catch {
      // Skip this mailbox and continue with others; the client will
      // still see a job id for whatever succeeded.
    }
  }

  // Phase 4R rev-13 SECOND FINDING (2026-08-16) — MAILBOX_INITIAL_SYNC
  // scopes to the inbox folder, but a Work Intake card's linked email
  // can be OUT of the inbox (e.g. archived by the rev-16H
  // post-completion archive worker, moved to another folder in Outlook,
  // etc.). Live evidence on staging: #221007 has
  // `parentFolderId != inbox`, so inbox delta AND inbox list both
  // return zero rows for that message, and its DB mirror sits at a
  // stale `isRead=true` forever regardless of how many syncs run.
  //
  // The founder-facing contract is "manual refresh must make the
  // mirror agree with Graph for every currently-visible Work Intake
  // card." So we ALSO re-verify each visible email-backed intake by
  // calling Graph directly per-message. Bounded: caller's own club,
  // up to 50 open items, each ~200-500ms → typically ≤10s inline.
  // Runs BEFORE the response so the client's snapshot-summary poll
  // sees the updated mirror as soon as the POST returns.
  let reverifiedCount = 0;
  let reverifyErrors = 0;
  try {
    const { getFreshDelegatedAccessToken } = await import("@/lib/mailbox/connect");
    // Open Work Intake items in this club that have a PRIMARY email
    // origin. Skip RESOLVED / SUPPRESSED to bound the work.
    const openIntakes = await prisma.workIntakeItem.findMany({
      where: {
        clubId,
        status: { in: ["OPEN", "IN_PROGRESS", "DEFERRED", "INFORMATIONAL"] },
        emailOrigins: { some: { role: "PRIMARY" } },
      },
      select: {
        id: true,
        emailOrigins: {
          where: { role: "PRIMARY" },
          take: 1,
          select: {
            emailMessage: {
              select: {
                id: true, graphMessageId: true, mailboxConnectionId: true,
                isRead: true,
              },
            },
          },
        },
      },
      take: 50,
      orderBy: { createdAt: "desc" },
    });
    // Group by mailbox so we can amortise one token per connection.
    const byMailbox = new Map<string, Array<{ emailId: string; graphMessageId: string; currentIsRead: boolean }>>();
    for (const it of openIntakes) {
      const em = it.emailOrigins[0]?.emailMessage;
      if (!em) continue;
      if (!byMailbox.has(em.mailboxConnectionId)) byMailbox.set(em.mailboxConnectionId, []);
      byMailbox.get(em.mailboxConnectionId)!.push({
        emailId: em.id, graphMessageId: em.graphMessageId, currentIsRead: em.isRead,
      });
    }
    for (const [mailboxId, emails] of byMailbox.entries()) {
      try {
        const tok = await getFreshDelegatedAccessToken({
          mailboxConnectionId: mailboxId,
          callerClubId: clubId,
          callerUserId: principal.id,
        });
        for (const e of emails) {
          try {
            const url =
              `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(e.graphMessageId)}` +
              `?$select=isRead`;
            const res = await fetch(url, {
              headers: { Authorization: `Bearer ${tok.accessToken}` },
            });
            if (!res.ok) {
              reverifyErrors += 1;
              continue;
            }
            const body = (await res.json()) as { isRead?: boolean };
            if (typeof body.isRead !== "boolean") continue;
            if (body.isRead === e.currentIsRead) {
              // Mirror already agrees; skip DB write.
              continue;
            }
            // Rev-13 tri-state write — this is the whole point of the
            // manual refresh barrier: bring the mirror in agreement
            // with the current Graph state, regardless of folder.
            await prisma.emailMessage.update({
              where: { id: e.emailId },
              data: { isRead: body.isRead, lastSyncedAt: new Date() },
            });
            reverifiedCount += 1;
          } catch {
            reverifyErrors += 1;
          }
        }
      } catch {
        reverifyErrors += emails.length;
      }
    }
  } catch (e) {
    // Re-verify is a best-effort augmentation on top of the queued
    // sync. Failure here does not fail the whole refresh — the client
    // will still get the sync job's result. Log for observability.
    const { logger } = await import("@/lib/observability/logger");
    logger.warn("mission-control.refresh-mailbox.reverify-failed", {
      clubIdTail: clubId.slice(-6),
      error: (e as Error).message,
    });
  }

  return NextResponse.json(
    {
      jobIds,
      mailboxConnectionIds,
      enqueuedAt: enqueuedAt.toISOString(),
      reverifiedCount,
      reverifyErrors,
    },
    { status: 202 },
  );
}
