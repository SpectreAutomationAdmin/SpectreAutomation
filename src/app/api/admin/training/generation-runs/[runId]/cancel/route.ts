// EP-TRAIN-4Y-W §6 (2026-11-09) — supported founder STOP mechanism.
//
// Thin HTTP wrapper around the existing `cancelGenerationRun` service.
// Permission: hr:training:write. Tenant-scoped at the service.
//
// Used by:
//   - the founder to STOP a runaway or wedged generation run (per
//     the directive: "A founder STOP instruction can be respected
//     through a supported lifecycle mechanism").
//   - a future AiSuggestionsPanel cancel button on the Manager Review
//     surface.
//
// Does NOT re-enqueue the BackgroundJob. The underlying
// cancelGenerationRun service sets executionStatus=CANCELLED and
// clears the lease. Any already-in-flight Modal call will complete
// on its own, but the handler's between-group lease-renew check
// (renewGenerationLease) will see the cancelled state and bail
// before issuing additional Modal calls.
//
// Idempotent: calling cancel on a run that is already CANCELLED
// returns `{state: "CANCELLED"}` without an audit. Calling cancel
// on a terminal (COMPLETED/FAILED) run returns the terminal state
// with HTTP 409.

import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { cancelGenerationRun, GenerationRejectedError } from "@/lib/hr/training/generation/generation-service";
import { AppError, UnauthenticatedError, NotFoundError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function same404() {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

export async function POST(
  _req: Request,
  context: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  const { runId } = await context.params;
  if (!runId) return same404();

  const principal = await getCurrentPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
    id: principal.id,
  });
  if (!hasPermission(principal, clubId, "hr:training:write")) {
    return same404();
  }

  try {
    const result = await cancelGenerationRun(principal, clubId, runId);
    return NextResponse.json({
      ok: true,
      runId,
      state: result.state,
    });
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    if (err instanceof NotFoundError) return same404();
    if (err instanceof GenerationRejectedError) {
      return NextResponse.json(
        {
          error: "cancel_rejected",
          rejectionCode: err.rejectionCode,
          message: err.safeMessage,
          detail: err.detail,
        },
        { status: err.httpStatus },
      );
    }
    if (err instanceof AppError) {
      return NextResponse.json(
        { error: err.code, message: err.safeMessage },
        { status: err.httpStatus },
      );
    }
    throw err;
  }
}
