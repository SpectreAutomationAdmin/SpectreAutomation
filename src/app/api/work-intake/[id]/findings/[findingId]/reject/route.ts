// Sprint 3 Checkpoint 15B (2026-07-24) — Finding override endpoint.
//
// POST /api/work-intake/[id]/findings/[findingId]/reject
//
// Marks a specific finding as USER_REJECTED. Deterministic: never
// deletes; the row remains for audit. Persistence's regeneration
// logic will not silently re-emit an identical finding under a
// different id.
//
// Authorization contract:
//   - session required (401 otherwise)
//   - intake must belong to active club (404 otherwise — never leak)
//   - finding must belong to intake + club
//   - body must include a non-empty `reason` (400 otherwise)
//   - idempotency: rejecting an already-rejected finding is a no-op
//     that returns 200 with the current state

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { rejectFinding } from "@/lib/intelligence/persistence";
import { IntelligenceError } from "@/lib/intelligence/types";
import { logger } from "@/lib/observability/logger";

export const dynamic = "force-dynamic";

const MAX_REASON_CHARS = 500;

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; findingId: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
  });

  const workIntakeItemId = params.id;
  const findingId = params.findingId;
  if (!workIntakeItemId || !findingId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let payload: { reason?: unknown };
  try {
    payload = (await req.json()) as { reason?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const rawReason = typeof payload?.reason === "string" ? payload.reason : "";
  const reason = rawReason.trim().slice(0, MAX_REASON_CHARS);
  if (reason.length === 0) {
    return NextResponse.json(
      { error: "reason_required", message: "A brief reason is required." },
      { status: 400 },
    );
  }

  try {
    const updated = await rejectFinding({
      clubId,
      workIntakeItemId,
      findingId,
      userId: principal.id,
      reason,
    });
    logger.info("intelligence.finding.rejected", {
      workIntakeItemId,
      findingId,
      actorUserId: principal.id,
      ruleKey: updated.ruleKey,
    });
    return NextResponse.json({
      id: updated.id,
      state: updated.state,
      overriddenAt: updated.overriddenAt,
    });
  } catch (err) {
    if (err instanceof IntelligenceError) {
      const status =
        err.category === "DATA_MISSING"
          ? 404
          : err.category === "TENANT_MISMATCH" || err.category === "UNAUTHORIZED"
            ? 404 // deliberately 404 to avoid existence leaks
            : 400;
      return NextResponse.json(
        { error: err.category.toLowerCase() },
        { status },
      );
    }
    logger.warn("intelligence.finding.reject_failed", {
      workIntakeItemId,
      findingId,
    });
    return NextResponse.json({ error: "unexpected" }, { status: 500 });
  }
}
