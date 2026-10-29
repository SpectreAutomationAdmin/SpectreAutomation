// SIGNUP-2 M4-INT-B §3 (2026-10-29) -- Operator API for renewal
// preflight review.
//
// GET                        list preflights awaiting review (non-
//                            READY, un-reviewed).
// GET  ?id=...               read one preflight + its cycle linkage.
// POST { action: "review", id, outcome, notes }
//                            record operator decision (APPROVED /
//                            REJECTED / RETURN_FOR_CORRECTION).
//                            Routine READY preflights do NOT need
//                            this call -- the scheduler advances
//                            them automatically.
//
// Access: SUPER_ADMIN only via `platform:signups:release`.

import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { isAppError } from "@/lib/errors";
import {
  listPreflightsAwaitingReview,
  recordRenewalReview,
  RENEWAL_REVIEW_OUTCOMES,
  type RenewalReviewOutcome,
} from "@/lib/billing/signup-2m4-renewal-review";

async function requireOperator(): Promise<
  { ok: true; principalId: string } | { ok: false; status: number; body: unknown }
> {
  const principal = await getCurrentPrincipal().catch(() => null);
  if (!principal) {
    return { ok: false, status: 401, body: { ok: false, error: "unauthenticated" } };
  }
  if (!hasPermission(principal, null, "platform:signups:release")) {
    return { ok: false, status: 403, body: { ok: false, error: "forbidden" } };
  }
  return { ok: true, principalId: principal.id };
}

export async function GET(req: Request): Promise<Response> {
  const auth = await requireOperator();
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (id) {
    const row = await prisma.billingRenewalPreflight.findUnique({
      where: { id },
      select: {
        id: true, billingCycleId: true, checkpointLabel: true,
        scheduledFor: true, executedAt: true, outcome: true, outcomeNotes: true,
        mandateStillValid: true, renewalPricingDriftDetected: true,
        renewalPriceId: true, renewalAmountMinorUnits: true, renewalCurrency: true,
        renewalTaxTreatment: true, renewalGstPercentBps: true,
        operatorReviewedByUserId: true, operatorReviewedAt: true,
        operatorReviewOutcome: true, operatorReviewNotes: true,
        syntheticTestOnly: true, createdAt: true,
        billingCycle: {
          select: { clubId: true, subscriptionStatus: true, stripeSubscriptionId: true },
        },
      },
    });
    if (!row) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    return NextResponse.json({
      ok: true,
      preflight: {
        ...row,
        renewalAmountMinorUnits: row.renewalAmountMinorUnits
          ? row.renewalAmountMinorUnits.toString()
          : null,
      },
    }, { status: 200 });
  }
  const rows = await listPreflightsAwaitingReview(50);
  return NextResponse.json({ ok: true, rows }, { status: 200 });
}

export async function POST(req: Request): Promise<Response> {
  const auth = await requireOperator();
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });

  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const action = String(body.action ?? "");
  if (action !== "review") {
    return NextResponse.json({ ok: false, error: `unknown action '${action}'` }, { status: 400 });
  }
  const outcome = String(body.outcome ?? "") as RenewalReviewOutcome;
  if (!RENEWAL_REVIEW_OUTCOMES.includes(outcome)) {
    return NextResponse.json({ ok: false, error: "invalid_outcome" }, { status: 400 });
  }
  try {
    const result = await recordRenewalReview({
      preflightId: String(body.id ?? ""),
      reviewedByUserId: auth.principalId,
      outcome,
      reviewNotes: String(body.notes ?? ""),
    });
    return NextResponse.json({ ok: true, ...result }, { status: 200 });
  } catch (err) {
    if (isAppError(err)) {
      return NextResponse.json(
        { ok: false, error: err.code, message: err.safeMessage },
        { status: err.status },
      );
    }
    const msg = err instanceof Error ? err.message : "unknown_error";
    return NextResponse.json({ ok: false, error: "service_error", message: msg }, { status: 500 });
  }
}
