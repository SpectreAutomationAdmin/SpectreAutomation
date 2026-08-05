// Sprint 3 · Checkpoint 16H rejection (2026-08-06) — one-shot
// backfill for the founder-observed Membership Inquiry reply.
//
// The reply was successfully sent through Spectre on 2026-08-04 but
// no canonical outbound row was ever persisted (Graph /reply returns
// 202 with empty body; the pre-fix reply route did not create an
// EmailMessage or ConversationMessage). This endpoint:
//
//   1. Locates the WorkIntakeItem by subject "Membership Inquiry"
//      under Coulee Ridge's clubId.
//   2. Finds the SENT OutlookReplyMutation for that WI.
//   3. Calls the validated Sent-Items lookup and picks the best
//      matching sent message (§10 hierarchy).
//   4. Creates (or updates) the canonical ConversationMessage with
//      the RECOVERED body — never fabricated.
//   5. Attaches the real Graph message id back onto the mutation.
//
// Gated behind a POST + Bearer token check (BACKFILL_TOKEN env). No
// other routes can invoke it; the token is set once via
// `flyctl secrets set BACKFILL_TOKEN=...`, the endpoint is called
// once with that header, and the token is rotated / removed after.
//
// Never logs the message body. Sanitized identifiers only.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability/logger";
import { getFreshDelegatedAccessToken } from "@/lib/mailbox/connect";
import {
  getMicrosoftDelegatedProvider,
  type RawGraphSentMessage,
} from "@/lib/integrations/microsoft-graph-delegated";
import { pickBestSentMatch } from "@/lib/mailbox/conversation-messages";

export const dynamic = "force-dynamic";

const COULEE_RIDGE_CLUB_ID = "cmrvdeny7000144372ktmmg9c";
const TARGET_SUBJECT = "Membership Inquiry";

export async function POST(req: NextRequest) {
  const token = process.env.BACKFILL_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "backfill_disabled" }, { status: 404 });
  }
  const auth = req.headers.get("authorization") || "";
  const expected = `Bearer ${token}`;
  if (auth !== expected) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const wi = await prisma.workIntakeItem.findFirst({
    where: {
      clubId: COULEE_RIDGE_CLUB_ID,
      displaySubject: TARGET_SUBJECT,
    },
    select: { id: true, clubId: true },
  });
  if (!wi) {
    return NextResponse.json({ error: "wi_not_found" }, { status: 404 });
  }
  const origin = await prisma.emailWorkIntakeOrigin.findFirst({
    where: { workIntakeItemId: wi.id, role: "PRIMARY" },
    include: {
      emailMessage: {
        select: {
          id: true, graphMessageId: true, conversationId: true,
          mailboxConnectionId: true, subject: true, recipientsJson: true,
        },
      },
    },
  });
  if (!origin) {
    return NextResponse.json({ error: "wi_not_found" }, { status: 404 });
  }
  const sourceEmail = origin.emailMessage;
  if (!sourceEmail.conversationId) {
    return NextResponse.json({ error: "no_conversation_id" }, { status: 422 });
  }

  const mutation = await prisma.outlookReplyMutation.findFirst({
    where: { workIntakeId: wi.id, status: "SENT" },
    orderBy: { createdAt: "desc" },
    select: { id: true, sentAt: true, graphMessageId: true },
  });
  if (!mutation || !mutation.sentAt) {
    return NextResponse.json({ error: "no_sent_mutation" }, { status: 422 });
  }

  const conn = await prisma.mailboxConnection.findUnique({
    where: { id: sourceEmail.mailboxConnectionId },
    select: { id: true, connectedEmail: true, clubId: true, userId: true, status: true },
  });
  if (!conn) {
    return NextResponse.json({ error: "connection_missing" }, { status: 422 });
  }
  if (conn.status === "DISCONNECTED" || conn.status === "REAUTH_REQUIRED") {
    return NextResponse.json({ error: "mailbox_status_blocks", status: conn.status }, { status: 422 });
  }

  let accessToken: string;
  try {
    const t = await getFreshDelegatedAccessToken({
      mailboxConnectionId: conn.id,
      callerClubId: conn.clubId,
      callerUserId: conn.userId,
    });
    accessToken = t.accessToken;
  } catch (e) {
    logger.warn("backfill.membership.token_failed", { reason: (e as Error).message?.slice(0, 60) });
    return NextResponse.json({ error: "token_failed" }, { status: 502 });
  }

  const provider = getMicrosoftDelegatedProvider();
  const lo = new Date(mutation.sentAt.getTime() - 60_000);
  const hi = new Date(mutation.sentAt.getTime() + 60 * 60_000);
  let candidates: RawGraphSentMessage[];
  try {
    const res = await provider.lookupSentMessagesInConversation({
      accessToken,
      conversationId: sourceEmail.conversationId,
      sentAfterIso: lo.toISOString(),
      sentBeforeIso: hi.toISOString(),
      top: 25,
    });
    candidates = res.messages;
  } catch (e) {
    logger.warn("backfill.membership.graph_failed", { reason: (e as Error).message?.slice(0, 60) });
    return NextResponse.json({ error: "graph_lookup_failed" }, { status: 502 });
  }

  const match = pickBestSentMatch(candidates, {
    ownerAddressLower: conn.connectedEmail.toLowerCase(),
    anchorSentAt: mutation.sentAt,
    conversationId: sourceEmail.conversationId,
    knownInternetMessageId: null,
  });
  if (!match) {
    logger.info("backfill.membership.no_match", {
      candidateCount: candidates.length,
      wiIdShort: wi.id.slice(-8),
    });
    return NextResponse.json({
      error: "no_match",
      candidateCount: candidates.length,
      hint: "Sent Items indexing lag — retry in 5 minutes.",
    }, { status: 409 });
  }

  const bodyHtml = match.body?.contentType === "html" ? (match.body.content ?? null) : null;
  const rawText = match.body?.contentType === "text" ? (match.body.content ?? null) : (match.bodyPreview ?? null);
  const preview = (rawText ?? "").slice(0, 240).replace(/\s+/g, " ").trim();
  const recipientsJson = JSON.stringify({
    to: match.toRecipients ?? [],
    cc: match.ccRecipients ?? [],
  });
  const canonicalSentAt = match.sentDateTime ? new Date(match.sentDateTime) : mutation.sentAt;

  const existing = await prisma.conversationMessage.findUnique({
    where: { replyMutationId: mutation.id },
    select: { id: true },
  });

  let resultId: string;
  if (existing) {
    await prisma.$transaction([
      prisma.conversationMessage.update({
        where: { id: existing.id },
        data: {
          providerMessageId: match.id,
          internetMessageId: match.internetMessageId,
          providerReconciledAt: new Date(),
          reconciliationStatus: "RECONCILED",
          bodyHtmlSanitized: bodyHtml,
          bodyTextExtract: preview,
          recipientsJson,
        },
      }),
      prisma.outlookReplyMutation.update({
        where: { id: mutation.id },
        data: { graphMessageId: match.id },
      }),
    ]);
    resultId = existing.id;
  } else {
    const created = await prisma.conversationMessage.create({
      data: {
        clubId: wi.clubId,
        mailboxConnectionId: conn.id,
        workIntakeItemId: wi.id,
        conversationId: sourceEmail.conversationId,
        direction: "OUTBOUND",
        source: "SPECTRE_REPLY",
        providerMessageId: match.id,
        internetMessageId: match.internetMessageId,
        replyMutationId: mutation.id,
        senderName: conn.connectedEmail,
        senderAddress: conn.connectedEmail,
        recipientsJson,
        subject: match.subject ?? sourceEmail.subject,
        bodyHtmlSanitized: bodyHtml,
        bodyTextExtract: preview,
        sentAt: canonicalSentAt,
        receivedAt: null,
        providerReconciledAt: new Date(),
        reconciliationStatus: "RECONCILED",
      },
      select: { id: true },
    });
    await prisma.outlookReplyMutation.update({
      where: { id: mutation.id },
      data: { graphMessageId: match.id },
    });
    resultId = created.id;
  }

  logger.info("backfill.membership.completed", {
    wiIdShort: wi.id.slice(-8),
    conversationMessageIdShort: resultId.slice(-8),
    matchedGraphMessageIdSuffix: match.id.slice(-12),
    wasExisting: !!existing,
  });

  return NextResponse.json({
    ok: true,
    workIntakeItemIdSuffix: wi.id.slice(-8),
    conversationMessageIdSuffix: resultId.slice(-8),
    matchedGraphMessageIdSuffix: match.id.slice(-12),
    wasExisting: !!existing,
  });
}
