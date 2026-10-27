// SIGNUP-2 M2-SyntheticSandbox (2026-10-27) -- Stripe sandbox return
// handler for the SYNTHETIC_TEST_ONLY mandate flow.
//
// Reachable from Stripe's hosted Checkout `success_url` after a
// synthetic test operator (founder) completes the ACSS mandate.
// Guards + synthetic-only refusal mirror the initiate route.

import { NextResponse, type NextRequest } from "next/server";
import { ForbiddenError, AppError } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";
import {
  persistSyntheticSignedMandate,
  consumeSyntheticReturnNonce,
} from "@/lib/signup/signup-2m2-synthetic-sandbox-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const registrationId = url.searchParams.get("registrationId") ?? "";
  const sessionId = url.searchParams.get("session_id") ?? "";
  const nonce = url.searchParams.get("nonce") ?? "";
  if (!registrationId || !sessionId || !nonce) {
    return NextResponse.json(
      { error: "bad_request", detail: "registrationId + session_id + nonce required" },
      { status: 400 },
    );
  }
  try {
    // Consume the single-use nonce FIRST.  If an attacker reaches this
    // endpoint without the nonce issued at initiate-time, consumption
    // throws + the mandate is never persisted.
    await consumeSyntheticReturnNonce(registrationId, nonce);
    const result = await persistSyntheticSignedMandate({
      registrationId,
      checkoutSessionId: sessionId,
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
      logger.warn("signup.synthetic.return.refused", {
        registrationIdTail: registrationId.slice(-6),
        detail: err.message,
      });
      return NextResponse.json({ error: "forbidden", detail: err.message }, { status: 403 });
    }
    if (err instanceof AppError) {
      return NextResponse.json({ error: err.code, detail: err.message }, { status: err.httpStatus });
    }
    logger.error("signup.synthetic.return.failed", {
      registrationIdTail: registrationId.slice(-6),
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
