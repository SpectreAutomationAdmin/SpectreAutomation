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
    // Fresh connections without a deltaLink need MAILBOX_INITIAL_SYNC;
    // established connections use MAILBOX_DELTA_SYNC (much cheaper).
    const kind = mb.deltaLink ? "MAILBOX_DELTA_SYNC" : "MAILBOX_INITIAL_SYNC";
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

  return NextResponse.json(
    { jobIds, mailboxConnectionIds, enqueuedAt: enqueuedAt.toISOString() },
    { status: 202 },
  );
}
