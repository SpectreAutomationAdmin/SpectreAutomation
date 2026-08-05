// Sprint 2 B4.1 (2026-07-19) — Work Intake action endpoint.
//
// One POST endpoint fans out to the five orchestration actions in
// src/lib/work-intake/actions.ts. Every action is server-authorized
// via workIntakeReadableByPrincipal, so a client-side hide is not
// the only guard.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { isMailboxIntegrationEnabled } from "@/lib/env";
import {
  resolveIntake,
  reopenIntake,
  markInformational,
  deferIntake,
  assignToSelf,
  markWorkIntakeRead,
  restoreIntake,
  WorkIntakeActionError,
} from "@/lib/work-intake/actions";
import { MAILBOX_ERROR_CODE } from "@/lib/mailbox/errors";

export async function POST(req: NextRequest) {
  if (!isMailboxIntegrationEnabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const principal = await getCurrentPrincipal();
  if (!principal) {
    return NextResponse.json({ error: MAILBOX_ERROR_CODE.UNAUTHENTICATED }, { status: 401 });
  }
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  const body = await safeJson(req);
  const workIntakeItemId = typeof body?.workIntakeItemId === "string" ? body.workIntakeItemId : "";
  const action = typeof body?.action === "string" ? body.action : "";
  if (!workIntakeItemId || !action) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const ctx = { principal, clubId, workIntakeItemId };

  try {
    switch (action) {
      case "resolve":
        await resolveIntake(ctx, typeof body?.note === "string" ? body.note : undefined);
        break;
      case "reopen":
        await reopenIntake(ctx);
        break;
      case "informational":
        await markInformational(ctx);
        break;
      case "defer": {
        const rawUntil = body?.until;
        const until = typeof rawUntil === "string" ? new Date(rawUntil) : null;
        if (!until) return NextResponse.json({ error: "invalid_defer_time" }, { status: 400 });
        await deferIntake(ctx, until);
        break;
      }
      case "assign_self":
        await assignToSelf(ctx);
        break;
      case "mark_read":
        // Sprint 3 Checkpoint 15I — per-user read state. Idempotent.
        await markWorkIntakeRead(ctx);
        break;
      case "restore":
        // Sprint 3 · Checkpoint 16H completion §11-16 — return a
        // completed WI to Active. Preserves ID, provenance,
        // accounting, sent replies, completion history. Never
        // moves archived Outlook mail back to Inbox.
        await restoreIntake(ctx, typeof body?.reason === "string" ? body.reason : undefined);
        break;
      default:
        return NextResponse.json({ error: "unknown_action" }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof WorkIntakeActionError) {
      const status = err.code === "not_visible" ? 404 : 400;
      return NextResponse.json({ error: err.code }, { status });
    }
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

async function safeJson(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const t = await req.text();
    if (!t) return {};
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    return {};
  }
}
