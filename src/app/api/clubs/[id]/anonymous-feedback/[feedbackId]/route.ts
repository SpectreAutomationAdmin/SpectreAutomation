// HR-2C Anonymous Feedback — admin status endpoint (2026-08-27).
// Admin-only, tenant-scoped. PATCH mutates status; DELETE is not
// exposed (admins archive instead — the row remains for audit).

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { setFeedbackStatus, type FeedbackStatus } from "@/lib/anonymous-feedback";

const NOT_FOUND = NextResponse.json({ error: "Not found" }, { status: 404 });

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; feedbackId: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, params.id, "settings:write")) return NOT_FOUND;
  let body: { status?: FeedbackStatus };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.status) return NextResponse.json({ error: "status required" }, { status: 400 });
  try {
    const feedback = await setFeedbackStatus(principal, params.id, params.feedbackId, body.status);
    return NextResponse.json({ feedback });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
