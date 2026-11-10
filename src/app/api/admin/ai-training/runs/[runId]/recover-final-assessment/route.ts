// EP-TRAIN-4Y-AF §5 + §7 — targeted Final Assessment recovery endpoint.
//
//   POST /api/admin/ai-training/runs/[runId]/recover-final-assessment
//
// Two-step contract (preflight + authorised execution):
//
//   Step 1 (dry run):  POST with body `{ preflight: true }` or no
//                      `confirm` key. Returns the recovery plan +
//                      cost projection. **No** generation run is
//                      created, no queue job is enqueued, no Modal
//                      call is possible. Idempotent, free.
//
//   Step 2 (execute):  POST with body `{ confirm: "AF-GPU-AUTHORIZED-<yyyy-mm-dd>" }`
//                      where the date matches today's UTC date OR
//                      yesterday's (small clock skew window). Creates
//                      the recovery run + enqueues the worker job at
//                      maxAttempts: 1.
//
// Both steps require authentication + `hr:training:write`.
//
// Response shape (both steps):
//   200 — { ok: true, preflight?: true, state?, recoveryRunId?, …chunks[] }
//   400 — bad input (invalid runId, invalid JSON, etc.)
//   401 — unauthenticated
//   403 — authenticated but lacks hr:training:write
//   404 — original run not found (or cross-tenant)
//   409 — original not COMPLETED, FA target already satisfied, no coverage, …
//   412 — step-2 missing / malformed `confirm` token

import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import {
  requestFinalAssessmentRecovery,
  preflightFinalAssessmentRecovery,
  FinalAssessmentRecoveryRejectedError,
} from "@/lib/hr/training/generation/final-assessment-recovery";
import { AppError, ForbiddenError, NotFoundError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RawRequestBody {
  readonly preflight?: unknown;
  readonly confirm?: unknown;
  readonly targetTotal?: unknown;
  readonly maxPerChunk?: unknown;
}

const CONFIRM_PREFIX = "AF-GPU-AUTHORIZED-";
function isValidConfirmToken(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  if (!raw.startsWith(CONFIRM_PREFIX)) return false;
  const date = raw.slice(CONFIRM_PREFIX.length);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) return false;
  const nowUtcMidnight = Date.parse(
    `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`,
  );
  // Accept today or yesterday in UTC.
  const diffDays = Math.round((nowUtcMidnight - parsed) / 86_400_000);
  return diffDays >= 0 && diffDays <= 1;
}

export async function POST(
  req: Request,
  context: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  const { runId } = await context.params;
  if (!runId || typeof runId !== "string") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
    id: principal.id,
  });

  let body: RawRequestBody;
  try {
    const raw = (await req.text()).trim();
    body = raw.length === 0 ? {} : (JSON.parse(raw) as RawRequestBody);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const targetTotal =
    typeof body.targetTotal === "number" && Number.isFinite(body.targetTotal) && body.targetTotal > 0
      ? Math.floor(body.targetTotal)
      : undefined;
  const maxPerChunk =
    typeof body.maxPerChunk === "number" && Number.isFinite(body.maxPerChunk) && body.maxPerChunk > 0
      ? Math.floor(body.maxPerChunk)
      : undefined;

  // Preflight path (default). No `confirm` or `preflight: true` or
  // `confirm` absent — always returns a dry report.
  const isPreflight = body.preflight === true || body.confirm === undefined || body.confirm === null;

  try {
    if (isPreflight) {
      const report = await preflightFinalAssessmentRecovery(
        principal, clubId,
        { originalRunId: runId, targetTotal, maxPerChunk },
      );
      return NextResponse.json({ ...report, ok: true });
    }

    if (!isValidConfirmToken(body.confirm)) {
      return NextResponse.json(
        {
          error: "confirm_required",
          message: `Pass body.confirm="${CONFIRM_PREFIX}<today-UTC>" to authorise live GPU execution.`,
          sample: `${CONFIRM_PREFIX}${new Date().toISOString().slice(0, 10)}`,
        },
        { status: 412 },
      );
    }

    const result = await requestFinalAssessmentRecovery(
      principal, clubId,
      { originalRunId: runId, targetTotal, maxPerChunk },
    );
    return NextResponse.json({ ...result, ok: true });
  } catch (err) {
    if (err instanceof FinalAssessmentRecoveryRejectedError) {
      return NextResponse.json(
        { error: err.rejectionCode, message: err.safeMessage, detail: err.detail },
        { status: err.httpStatus },
      );
    }
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
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
