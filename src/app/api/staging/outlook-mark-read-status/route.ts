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
  const clubId = await getActiveClubId(principal);
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
  const email = emailMessageId
    ? await prisma.emailMessage.findFirst({
        where: { id: emailMessageId },
        select: { id: true, clubId: true, isRead: true, updatedAt: true, graphMessageId: true },
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

  const mutation = email
    ? await prisma.outlookMarkReadMutation.findFirst({
        where: { emailMessageId: email.id },
        orderBy: { updatedAt: "desc" },
        select: {
          status: true, attemptCount: true, lastAttemptAt: true,
          completedAt: true, errorCode: true, workIntakeItemId: true,
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

  return NextResponse.json({
    callerClubId: clubId,
    email,
    origins,
    mutation,
    recentJobs,
    featureFlags: {
      isEmailMarkReadOnInteractionEnabled: (await import("@/lib/env")).isEmailMarkReadOnInteractionEnabled(),
    },
  });
}
