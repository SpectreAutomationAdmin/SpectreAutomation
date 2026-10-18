// WI-SYNC-1a (2026-10-18) — POST /api/admin/mailbox/reconcile
//
// One-shot mailbox reconciliation endpoint.  Classifies every
// active EmailMessage in the caller's active-club mailbox and
// (if `?apply=1`) tombstones + suppresses the ones Microsoft
// Graph confirms are gone from the Inbox.
//
// Contract:
//   POST ?dryRun=1 (default) → classifies rows, writes nothing.
//   POST ?apply=1            → applies the proposed changes.
//                              Idempotent; safe to re-run.
//
// Auth:
//   - 401 if no session.
//   - 400 if no active club.
//   - 403 if the caller doesn't own the mailbox and isn't a
//     SUPER_ADMIN.  Tenant-scope guard is enforced BEFORE any
//     Graph call.
//
// Response: ReconciliationReport (see
//   src/lib/mailbox/reconciliation.ts).  200 OK on success;
//   422 if the mailbox is not CONNECTED; 500 on unexpected error.

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { isMailboxIntegrationEnabled } from "@/lib/env";
import { reconcileMailbox } from "@/lib/mailbox/reconciliation";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!isMailboxIntegrationEnabled()) {
    return NextResponse.json({ error: "mailbox_integration_disabled" }, { status: 404 });
  }
  const principal = await getCurrentPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
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

  const url = new URL(req.url);
  // Default to dry-run — the founder authorization explicitly
  // requires dry-run first.  `?apply=1` is the only way to run
  // with writes enabled.
  const dryRun = url.searchParams.get("apply") !== "1";
  const mailboxConnectionIdParam = url.searchParams.get("mailboxConnectionId");

  // Resolve the mailbox.  If none specified, pick the caller's
  // single connected mailbox for the active club.
  let mailbox:
    | { id: string; clubId: string; userId: string; status: string }
    | null = null;
  if (mailboxConnectionIdParam) {
    mailbox = await prisma.mailboxConnection.findUnique({
      where: { id: mailboxConnectionIdParam },
      select: { id: true, clubId: true, userId: true, status: true },
    });
    if (!mailbox) {
      return NextResponse.json({ error: "mailbox_not_found" }, { status: 404 });
    }
    if (mailbox.clubId !== clubId) {
      return NextResponse.json({ error: "mailbox_wrong_tenant" }, { status: 403 });
    }
    // Ownership guard: caller must own the mailbox UNLESS they're
    // a super admin.  Keeps a Club Admin from reconciling another
    // user's personal inbox without an explicit access row.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const role = (principal as any).role ?? "";
    const isOwner = mailbox.userId === principal.id;
    const isSuper = role === "SUPER_ADMIN";
    if (!isOwner && !isSuper) {
      return NextResponse.json({ error: "mailbox_not_owned" }, { status: 403 });
    }
  } else {
    mailbox = await prisma.mailboxConnection.findFirst({
      where: { clubId, userId: principal.id, status: "CONNECTED" },
      select: { id: true, clubId: true, userId: true, status: true },
    });
    if (!mailbox) {
      return NextResponse.json({ error: "no_connected_mailbox" }, { status: 404 });
    }
  }
  if (mailbox.status !== "CONNECTED") {
    return NextResponse.json(
      { error: "mailbox_not_connected", status: mailbox.status },
      { status: 422 },
    );
  }

  try {
    const report = await reconcileMailbox({
      clubId,
      mailboxConnectionId: mailbox.id,
      callerUserId: principal.id,
      dryRun,
    });

    // Audit — EVERY reconcile call, dry-run or apply.  Captures the
    // final totals so a founder review of audit history can see
    // what the operator actually ran against which mailbox.
    await audit(principal, {
      action: dryRun
        ? "mailbox.reconcile.dry-run"
        : "mailbox.reconcile.apply",
      entityType: "MailboxConnection",
      entityId: mailbox.id,
      clubId,
      meta: {
        mode: report.mode,
        totals: report.totals,
      },
    });

    return NextResponse.json(report, { status: 200 });
  } catch (e) {
    const msg = (e as Error).message;
    return NextResponse.json(
      { error: "reconcile_failed", detail: msg },
      { status: 500 },
    );
  }
}
