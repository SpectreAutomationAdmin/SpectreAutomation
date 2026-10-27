// SIGNUP-2 M2-SyntheticSandbox (2026-10-27) -- SUPER_ADMIN-gated
// recovery endpoint for a return-handler failure.
//
// When persistSyntheticSignedMandate throws AFTER consumeSynthetic-
// ReturnNonce succeeds (e.g. Stripe refuses subscription creation
// due to ACSS per-transaction amount limit), the normal return
// handler cannot be re-driven by the signatory because the nonce
// is already consumed.  This operator-authenticated recovery route
// retries persistence using the already-collected Stripe state
// (checkoutSessionId -> SetupIntent -> mandate + paymentMethod).
//
// Auth:  SUPER_ADMIN session cookie (same gate as the initiate
// route).
//
// Idempotency: if a SubscriptionPaymentMandate already exists for
// this registration, returns noop.  Otherwise re-runs the persist
// chain with the same deterministic Stripe idempotency keys so
// Stripe either returns the existing subscription or re-attempts
// create.

import { NextResponse, type NextRequest } from "next/server";
import { ForbiddenError, AppError } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { isSuperAdmin } from "@/lib/rbac";
import { recoverSyntheticSignedMandate } from "@/lib/signup/signup-2m2-synthetic-sandbox-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(req: NextRequest): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const principal = await getCurrentPrincipal();
  if (!principal || !isSuperAdmin(principal)) {
    return NextResponse.json({ error: "forbidden", detail: "SUPER_ADMIN role required" }, { status: 403 });
  }
  const url = new URL(req.url);
  const registrationId = url.searchParams.get("registrationId") ?? "";
  const sessionId = url.searchParams.get("session_id") ?? "";
  if (!registrationId || !sessionId) {
    return NextResponse.json(
      { error: "bad_request", detail: "registrationId + session_id required" },
      { status: 400 },
    );
  }
  try {
    const result = await recoverSyntheticSignedMandate(registrationId, sessionId);
    logger.info("signup.synthetic.recover.ok", {
      registrationIdTail: registrationId.slice(-6),
      operatorUserIdTail: user.id.slice(-6),
      noop: result.noop,
    });
    return NextResponse.json({
      ok: true,
      syntheticTestOnly: true,
      noop: result.noop,
      mandateIdTail: result.mandateId?.slice(-8) ?? null,
      billingCycleIdTail: result.billingCycleId?.slice(-6) ?? null,
    });
  } catch (err) {
    if (err instanceof ForbiddenError) {
      logger.warn("signup.synthetic.recover.refused", {
        registrationIdTail: registrationId.slice(-6),
        detail: err.message,
      });
      return NextResponse.json({ error: "forbidden", detail: err.message }, { status: 403 });
    }
    if (err instanceof AppError) {
      return NextResponse.json({ error: err.code, detail: err.message }, { status: err.httpStatus });
    }
    logger.error("signup.synthetic.recover.failed", {
      registrationIdTail: registrationId.slice(-6),
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
