// Phase 4R rev-10 (2026-08-15) — staging-only debug endpoint used
// by the Playwright rev-10 acceptance spec to verify that the
// Spectre → Outlook mark-read Graph PATCH has landed.
//
// Returns:
//   {
//     mutation: { status, attemptCount, lastAttemptAt, completedAt, errorCode }
//     email:    { id, isRead, updatedAt }
//   }
//
// Hard-gated:
//   * OFF in production (`spectre` app) — the route responds 404
//     unless STAGING_DEBUG_ENDPOINTS_ENABLED === "true", which is
//     set only on the `spectre-staging` app's fly.web.toml.
//   * Requires an authenticated founder principal.
//   * Tenant-scoped: the returned rows must belong to the caller's
//     active club — a founder on club A cannot inspect club B.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { prisma } from "@/lib/prisma";

// Next.js 14 dynamic mode — never pre-render this route.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isStagingDebugEnabled(): boolean {
  // Read via bracket syntax so Next.js can't statically inline the
  // value at build time (dot syntax on process.env is sometimes
  // subject to constant folding in the compiler).
  const raw = process.env["STAGING_DEBUG_ENDPOINTS_ENABLED"];
  return raw === "true";
}

export async function GET(req: NextRequest) {
  if (!isStagingDebugEnabled()) {
    return NextResponse.json(
      { error: "not_found", flag: process.env["STAGING_DEBUG_ENDPOINTS_ENABLED"] ?? null },
      { status: 404 },
    );
  }
  const principal = await getCurrentPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = principal as unknown as { activeClubId?: string | null; role?: string };
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: p.role ?? "" });
  if (!clubId) {
    return NextResponse.json({ error: "no_active_club" }, { status: 400 });
  }

  const emailMessageId = req.nextUrl.searchParams.get("emailMessageId");
  const workIntakeItemId = req.nextUrl.searchParams.get("workIntakeItemId");
  if (!emailMessageId && !workIntakeItemId) {
    return NextResponse.json({ error: "missing_emailMessageId_or_workIntakeItemId" }, { status: 400 });
  }

  // Loosen the tenant scoping to make diagnosis easier — this is a
  // staging-only endpoint. Report what actually exists.
  // Rev-12 verification (2026-08-16) — return the timestamps needed
  // to reconstruct the sync ordering: EmailMessage.lastSyncedAt,
  // EmailMessage.updatedAt, and (if the email is found) the
  // MailboxConnection's lastSuccessfulSyncAt + lastAttemptedSyncAt.
  const email = emailMessageId
    ? await prisma.emailMessage.findFirst({
        where: { id: emailMessageId },
        select: {
          id: true, clubId: true, isRead: true,
          updatedAt: true, lastSyncedAt: true, receivedAt: true,
          graphMessageId: true, mailboxConnectionId: true,
        },
      })
    : null;

  const origins = workIntakeItemId
    ? await prisma.emailWorkIntakeOrigin.findMany({
        where: { workIntakeItemId },
        select: { id: true, workIntakeItemId: true, emailMessageId: true, role: true },
      })
    : email
      ? await prisma.emailWorkIntakeOrigin.findMany({
          where: { emailMessageId: email.id },
          select: { id: true, workIntakeItemId: true, emailMessageId: true, role: true },
        })
      : [];

  // Rev-12 — return the FULL mutation history (up to 5) so the
  // #221007 verification can see every attempt + any SUPERSEDED
  // status the worker recorded.
  const mutationHistory = email
    ? await prisma.outlookMarkReadMutation.findMany({
        where: { emailMessageId: email.id },
        orderBy: { updatedAt: "desc" },
        take: 5,
        select: {
          id: true, status: true, attemptCount: true,
          createdAt: true, updatedAt: true,
          lastAttemptAt: true, completedAt: true,
          errorCode: true, workIntakeItemId: true,
          triggeredByUserId: true,
        },
      })
    : [];
  const mutation = mutationHistory[0] ?? null;

  // Rev-12 — mailbox sync timestamps for the connection that owns
  // this email. Lets the verification confirm whether a sync ran
  // AFTER a founder Outlook-side change.
  const mailboxSync = email
    ? await prisma.mailboxConnection.findUnique({
        where: { id: email.mailboxConnectionId },
        select: {
          id: true, status: true,
          lastSuccessfulSyncAt: true,
          lastAttemptedSyncAt: true,
          deltaLink: true,
        },
      })
    : null;

  // Recent MAILBOX_MARK_READ background-job rows for this club so we
  // can see whether enqueue fired at all, whether the worker picked
  // it up, and any failure code.
  const recentJobs = await prisma.backgroundJob.findMany({
    where: {
      kind: "MAILBOX_MARK_READ",
      clubId,
    },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      id: true, status: true, attempts: true, createdAt: true,
      scheduledFor: true, payloadJson: true, idempotencyKey: true,
    },
  });

  // Rev-12 live-Graph probe (2026-08-16, DIAGNOSTIC ONLY) — when
  // `probeGraph=1` is set, fetch the message DIRECTLY from Microsoft
  // Graph so we can compare live Graph state against the local
  // mirror. Requires a valid delegated token for the connection.
  const shouldProbeGraph = req.nextUrl.searchParams.get("probeGraph") === "1";
  type GraphProbe = {
    isRead?: boolean | null;
    subject?: string | null;
    receivedDateTime?: string | null;
    lastModifiedDateTime?: string | null;
    conversationId?: string | null;
    parentFolderId?: string | null;
    error?: string;
  } | null;
  let graphProbe: GraphProbe = null;
  if (shouldProbeGraph && email && mailboxSync) {
    try {
      const { getFreshDelegatedAccessToken } = await import("@/lib/mailbox/connect");
      const conn = await prisma.mailboxConnection.findUnique({
        where: { id: email.mailboxConnectionId },
        select: { userId: true, clubId: true },
      });
      if (conn) {
        const tok = await getFreshDelegatedAccessToken({
          mailboxConnectionId: email.mailboxConnectionId,
          callerClubId: conn.clubId,
          callerUserId: conn.userId,
        });
        const url =
          `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(email.graphMessageId)}` +
          `?$select=id,subject,isRead,receivedDateTime,lastModifiedDateTime,conversationId,parentFolderId`;
        const res = await fetch(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${tok.accessToken}` },
        });
        if (res.ok) {
          const body = await res.json() as {
            isRead?: boolean;
            subject?: string;
            receivedDateTime?: string;
            lastModifiedDateTime?: string;
            conversationId?: string;
            parentFolderId?: string;
          };
          graphProbe = {
            isRead: typeof body.isRead === "boolean" ? body.isRead : null,
            subject: body.subject ?? null,
            receivedDateTime: body.receivedDateTime ?? null,
            lastModifiedDateTime: body.lastModifiedDateTime ?? null,
            conversationId: body.conversationId ?? null,
            parentFolderId: body.parentFolderId ?? null,
          };
        } else {
          graphProbe = { error: `graph_http_${res.status}` };
        }
      } else {
        graphProbe = { error: "connection_not_found" };
      }
    } catch (e) {
      graphProbe = { error: `probe_failed: ${(e as Error).message}` };
    }
  }

  return NextResponse.json({
    callerClubId: clubId,
    serverTimestamp: new Date().toISOString(),
    email,
    origins,
    mutation,
    mutationHistory,
    mailboxSync: mailboxSync
      ? {
          id: mailboxSync.id,
          status: mailboxSync.status,
          lastSuccessfulSyncAt: mailboxSync.lastSuccessfulSyncAt,
          lastAttemptedSyncAt: mailboxSync.lastAttemptedSyncAt,
          hasDeltaLink: !!mailboxSync.deltaLink,
        }
      : null,
    recentJobs,
    graphProbe,
    featureFlags: {
      isEmailMarkReadOnInteractionEnabled: (await import("@/lib/env")).isEmailMarkReadOnInteractionEnabled(),
    },
  });
}
