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
  if (!emailMessageId) {
    return NextResponse.json({ error: "missing_emailMessageId" }, { status: 400 });
  }

  // Tenant-scoped read: the email row itself must belong to this club.
  const email = await prisma.emailMessage.findFirst({
    where: { id: emailMessageId, clubId },
    select: { id: true, isRead: true, updatedAt: true },
  });
  if (!email) {
    return NextResponse.json({ error: "email_not_found" }, { status: 404 });
  }

  const mutation = await prisma.outlookMarkReadMutation.findFirst({
    where: { emailMessageId: email.id, clubId },
    orderBy: { updatedAt: "desc" },
    select: {
      status: true,
      attemptCount: true,
      lastAttemptAt: true,
      completedAt: true,
      errorCode: true,
    },
  });

  return NextResponse.json({ email, mutation });
}
