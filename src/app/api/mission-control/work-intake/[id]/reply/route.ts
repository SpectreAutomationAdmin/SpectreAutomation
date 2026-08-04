// Sprint 2 Checkpoint 14C-B (2026-07-23) — Delegated reply endpoint.
//
// POST /api/mission-control/work-intake/[id]/reply
//
// Sends a plain-text delegated reply as the connected mailbox user.
// The reply target (graphMessageId, recipients, subject) is derived
// SERVER-SIDE from the authorised WorkIntakeItem's PRIMARY origin —
// the caller cannot supply an arbitrary target.
//
// Fail-closed policy:
//   - 401 if principal missing
//   - 404 if WorkIntakeItem, mailbox, or source email cannot be
//         resolved under the current principal's visibility
//   - 400 for empty / oversized body
//   - 403 if the source mailbox has not consented to Mail.Send
//   - 409 if an identical idempotency key already sent (duplicate
//         submit prevention)
//   - 429/5xx for retryable Microsoft errors
//   - 400 for terminal Microsoft errors (invalid_grant etc.) — the
//         client re-authenticates
//
// On success:
//   - Records a "REPLY_SENT" WorkIntakeActivity row
//   - Does NOT auto-resolve the Work Intake item
//   - Does NOT fabricate an EmailMessage row for the sent reply
//   - Returns a truthful confirmation payload

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { mailboxVisibilityFilter } from "@/lib/work-intake/tenant";
import { MAILBOX_ERROR_CODE, classifyMsalError } from "@/lib/mailbox/errors";
import { getFreshDelegatedAccessToken } from "@/lib/mailbox/connect";
import {
  getMicrosoftDelegatedProvider,
  APPROVED_DELEGATED_SCOPES,
} from "@/lib/integrations/microsoft-graph-delegated";
import { logger } from "@/lib/observability/logger";

export const dynamic = "force-dynamic";

const MAX_BODY_CHARS = 20_000;

interface ReplyResponsePayload {
  workIntakeItemId: string;
  sentAt: string;
  sendingMailbox: string;
  replyToSubject: string;
  // Sprint 3 · Checkpoint 16H additions.
  replyMutationId?: string;
  andClose?: boolean;
  completionEventId?: string;
  archiveJobsEnqueued?: number;
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const principal = await getCurrentPrincipal();
  if (!principal) {
    return NextResponse.json({ error: MAILBOX_ERROR_CODE.UNAUTHENTICATED }, { status: 401 });
  }
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });

  const workIntakeItemId = params.id;
  if (!workIntakeItemId || typeof workIntakeItemId !== "string") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Parse + validate body FIRST — cheapest failure path.
  let payload: { body?: unknown };
  try {
    payload = (await req.json()) as { body?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const rawBody = typeof payload?.body === "string" ? payload.body : "";
  const bodyText = rawBody.trim();
  // Sprint 3 · Checkpoint 16H — "Send reply & close" toggle. When
  // true, a successful send triggers resolveIntake({ completionType:
  // "REPLIED_AND_CLOSED" }) which fires the canonical completion
  // event → enqueues the Outlook archive job.
  const andClose = typeof (payload as { andClose?: unknown }).andClose === "boolean"
    ? Boolean((payload as { andClose: boolean }).andClose)
    : false;
  const mode: "REPLY" | "REPLY_ALL" =
    (payload as { mode?: unknown }).mode === "REPLY_ALL" ? "REPLY_ALL" : "REPLY";
  if (bodyText.length === 0) {
    return NextResponse.json({ error: "empty_body", reason: "The reply body is empty." }, { status: 400 });
  }
  if (bodyText.length > MAX_BODY_CHARS) {
    return NextResponse.json({ error: "body_too_long", reason: `The reply body exceeds ${MAX_BODY_CHARS} characters.` }, { status: 400 });
  }

  // Load the intake + PRIMARY origins with mailbox connections. This
  // is the ONLY source of the graphMessageId used in the Graph call;
  // no client-supplied override is honoured.
  const intake = await prisma.workIntakeItem.findFirst({
    where: { id: workIntakeItemId, clubId },
    include: {
      emailOrigins: {
        where: { role: "PRIMARY" },
        include: {
          emailMessage: {
            include: {
              mailboxConnection: {
                select: { id: true, connectedEmail: true, mailboxType: true, userId: true, grantedScopes: true, status: true },
              },
            },
          },
        },
      },
    },
  });
  if (!intake || intake.emailOrigins.length === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Enforce mailbox-visibility filter defence-in-depth.
  const authorisedOrigins = [];
  for (const origin of intake.emailOrigins) {
    const conn = origin.emailMessage.mailboxConnection;
    if (conn.mailboxType === "PERSONAL" && conn.userId !== principal.id) continue;
    if (conn.mailboxType === "SHARED") {
      const access = await prisma.mailboxAccess.count({
        where: { mailboxConnectionId: conn.id, userId: principal.id, revokedAt: null },
      });
      if (access === 0) continue;
    }
    authorisedOrigins.push(origin);
  }
  if (authorisedOrigins.length === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Reply target = the NEWEST authorised message. Microsoft threads
  // the reply into the conversation automatically.
  const newestOrigin = [...authorisedOrigins].sort(
    (a, b) => b.emailMessage.receivedAt.getTime() - a.emailMessage.receivedAt.getTime(),
  )[0]!;
  const targetEmail = newestOrigin.emailMessage;
  const conn = targetEmail.mailboxConnection;

  // Soft-deleted source — cannot reply.
  if (targetEmail.softDeletedAt) {
    return NextResponse.json({
      error: "source_removed",
      reason: "The source email has been removed from the mailbox. Reply is not possible.",
    }, { status: 404 });
  }

  // Mailbox status — reply requires an active connection.
  if (conn.status === "DISCONNECTED" || conn.status === "REAUTH_REQUIRED") {
    return NextResponse.json({
      error: "mailbox_disconnected",
      reason: `The source mailbox is ${conn.status}. Reconnect to reply.`,
    }, { status: 403 });
  }

  // Consent check — grantedScopes on the connection must include
  // Mail.Send. This runs BEFORE the token fetch so a missing-scope
  // mailbox never consumes a Microsoft round-trip.
  const grantedScopes = (conn.grantedScopes || "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  if (!APPROVED_DELEGATED_SCOPES.includes("Mail.Send" as never)) {
    // Belt-and-suspenders — if the scope list ever regressed, refuse.
    return NextResponse.json({
      error: "scope_unavailable",
      reason: "Reply sending is not enabled in this release.",
    }, { status: 403 });
  }
  if (!grantedScopes.includes("Mail.Send")) {
    return NextResponse.json({
      error: "consent_missing",
      reason: "The source mailbox has not consented to Mail.Send. Reconnect the mailbox to approve the updated scope.",
      requiredScopes: ["Mail.Send"],
    }, { status: 403 });
  }

  // Idempotency: the client MAY supply x-idempotency-key. If a prior
  // send used the same key on the same intake within the last 24h,
  // return the prior result rather than re-sending.
  const idempotencyKey = req.headers.get("x-idempotency-key") || undefined;
  if (idempotencyKey) {
    const prior = await prisma.workIntakeActivity.findFirst({
      where: {
        workIntakeItemId: intake.id,
        action: "REPLY_SENT",
        note: { contains: `idempotency:${idempotencyKey}` },
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    });
    if (prior) {
      return NextResponse.json({
        workIntakeItemId: intake.id,
        sentAt: prior.createdAt.toISOString(),
        sendingMailbox: conn.connectedEmail,
        replyToSubject: targetEmail.subject,
      } satisfies ReplyResponsePayload, { status: 409 });
    }
  }

  // Access token — reuses the same refresh path proven in C13E.
  let accessToken: string;
  try {
    const t = await getFreshDelegatedAccessToken({
      mailboxConnectionId: conn.id,
      callerClubId: clubId,
      callerUserId: principal.id,
    });
    accessToken = t.accessToken;
  } catch (err) {
    const classification = classifyMsalError(err);
    logger.warn("mailbox.reply.token_failed", { classification, workIntakeItemId: intake.id });
    if (classification === "terminal") {
      return NextResponse.json({
        error: "reauth_required",
        reason: "The mailbox needs to be reconnected before replies can be sent.",
      }, { status: 403 });
    }
    return NextResponse.json({
      error: "retryable",
      reason: "Temporary error while acquiring credentials. Try again shortly.",
    }, { status: 429 });
  }

  // Send.
  const provider = getMicrosoftDelegatedProvider();
  logger.info("mailbox.reply.attempt", {
    workIntakeItemId: intake.id,
    mailboxConnectionId: conn.id,
    bodyLength: bodyText.length,
    idempotencyKeyPresent: !!idempotencyKey,
  });
  let sentAt: Date;
  try {
    const result = await provider.replyToMessage({
      accessToken,
      graphMessageId: targetEmail.graphMessageId,
      body: bodyText,
    });
    sentAt = result.sentAt;
  } catch (err) {
    const classification = classifyMsalError(err);
    logger.warn("mailbox.reply.failed", {
      workIntakeItemId: intake.id,
      classification,
    });
    if (classification === "terminal") {
      const errObj = err as { errorCode?: string; response?: { status?: number } };
      if (errObj?.errorCode === "insufficient_scope" || errObj?.response?.status === 403) {
        return NextResponse.json({
          error: "consent_missing",
          reason: "Microsoft rejected the reply for missing scope. Reconnect the mailbox.",
          requiredScopes: ["Mail.Send"],
        }, { status: 403 });
      }
      return NextResponse.json({
        error: "reauth_required",
        reason: "The mailbox needs to be reconnected before replies can be sent.",
      }, { status: 403 });
    }
    return NextResponse.json({
      error: "retryable",
      reason: "Microsoft is temporarily rejecting the send. Try again shortly.",
    }, { status: 429 });
  }

  // Audit — record who sent it, when, and (safely) that a reply
  // was sent. NEVER writes the body content into the activity note.
  await prisma.workIntakeActivity.create({
    data: {
      workIntakeItemId: intake.id,
      actorUserId: principal.id,
      action: "REPLY_SENT",
      note: idempotencyKey
        ? `Reply sent from ${conn.connectedEmail}. idempotency:${idempotencyKey}`
        : `Reply sent from ${conn.connectedEmail}.`,
    },
  });

  logger.info("mailbox.reply.success", {
    workIntakeItemId: intake.id,
    mailboxConnectionId: conn.id,
    sentAtIso: sentAt.toISOString(),
  });

  // Sprint 3 · Checkpoint 16H — persist OutlookReplyMutation.
  // Idempotency key is the header if supplied, else a synthetic key
  // derived from the source message + timestamp so a rapid double
  // POST without a client key still doesn't duplicate.
  const persistedKey = idempotencyKey ?? `wi:${intake.id}:msg:${targetEmail.graphMessageId}:${Math.floor(sentAt.getTime() / 1000)}`;
  const mutation = await prisma.outlookReplyMutation.upsert({
    where: { idempotencyKey: persistedKey },
    create: {
      clubId, workIntakeId: intake.id,
      mailboxConnectionId: conn.id,
      sourceEmailMessageId: targetEmail.id,
      initiatedByUserId: principal.id,
      mode,
      status: "SENT",
      graphConversationId: targetEmail.conversationId ?? null,
      sentAt,
      attemptCount: 1,
      idempotencyKey: persistedKey,
    },
    update: { status: "SENT", sentAt, attemptCount: { increment: 1 } },
    select: { id: true },
  }).catch(() => null);

  // Sprint 3 · Checkpoint 16H — "Send reply & close" completion path.
  let completionEventId: string | undefined;
  let archiveJobsEnqueued = 0;
  if (andClose) {
    try {
      const { emitWorkCompletionEvent } = await import("@/lib/work-intake/completion");
      // Flip the WI to RESOLVED (with completion type = REPLIED_AND_CLOSED).
      await prisma.workIntakeItem.update({
        where: { id: intake.id },
        data: { status: "RESOLVED", resolvedAt: new Date(), resolvedByUserId: principal.id },
      });
      await prisma.workIntakeActivity.create({
        data: {
          workIntakeItemId: intake.id, actorUserId: principal.id,
          action: "RESOLVED", fromValue: intake.status, toValue: "RESOLVED",
          note: `Send reply & close from ${conn.connectedEmail}.`,
        },
      });
      const evt = await emitWorkCompletionEvent({
        workIntakeItemId: intake.id, clubId,
        completedByUserId: principal.id,
        completionType: "REPLIED_AND_CLOSED",
        metadata: { replyMutationId: mutation?.id, sendingMailbox: conn.connectedEmail },
      });
      completionEventId = evt.eventId;
      archiveJobsEnqueued = evt.archiveJobsEnqueued;
    } catch (e) {
      logger.warn("mailbox.reply.and_close.failed", { workIntakeItemId: intake.id, reason: (e as Error).message?.slice(0, 80) });
      // The reply already succeeded — do NOT roll back. The user
      // sees a truthful "reply sent" but the close-and-archive did
      // not fire. Response payload signals andClose=false.
    }
  }

  const response: ReplyResponsePayload = {
    workIntakeItemId: intake.id,
    sentAt: sentAt.toISOString(),
    sendingMailbox: conn.connectedEmail,
    replyToSubject: targetEmail.subject,
    replyMutationId: mutation?.id,
    andClose: andClose && !!completionEventId,
    completionEventId,
    archiveJobsEnqueued,
  };
  return NextResponse.json(response, { status: 200 });
}
