// SIGNUP-2 M2-SyntheticSandbox (2026-10-27) -- initiate the Stripe
// sandbox mandate flow for a SYNTHETIC_TEST_ONLY registration.
//
// Reachable ONLY when ALL of:
//   - caller is authenticated SUPER_ADMIN (session cookie)
//   - FLY_APP_NAME === "spectre-staging"
//   - SPECTRE_SIGNUP_2M2_SYNTHETIC_SANDBOX === "1"
//   - stripeSdkMode() === "test"
//   - the registrationId query param points at a row with
//     syntheticTestOnly=true
//
// Any failure returns HTTP 401/403 and never touches Stripe.

import { NextResponse, type NextRequest } from "next/server";
import { ForbiddenError, AppError } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { isSuperAdmin } from "@/lib/rbac";
import {
  initiateSyntheticMandateCollection,
  issueSyntheticReturnNonce,
} from "@/lib/signup/signup-2m2-synthetic-sandbox-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(req: NextRequest): Promise<Response> {
  // Auth gate FIRST — environment flags are NOT sufficient on their own.
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const principal = await getCurrentPrincipal();
  if (!principal || !isSuperAdmin(principal)) {
    logger.warn("signup.synthetic.initiate.unauthorised", {
      userIdTail: user.id.slice(-6),
    });
    return NextResponse.json({ error: "forbidden", detail: "SUPER_ADMIN role required" }, { status: 403 });
  }
  const url = new URL(req.url);
  const registrationId = url.searchParams.get("registrationId") ?? "";
  if (!registrationId) {
    return NextResponse.json({ error: "bad_request", detail: "registrationId required" }, { status: 400 });
  }
  try {
    // Issue a single-use nonce before kicking off Checkout.  The return
    // handler validates the matching nonce on the signatory's redirect
    // back from Stripe.
    const nonce = await issueSyntheticReturnNonce(registrationId, user.id);
    const { checkoutUrl, checkoutSessionId } = await initiateSyntheticMandateCollection(
      registrationId,
      { operatorUserId: user.id, returnNonce: nonce },
    );
    logger.info("signup.synthetic.initiate.ok", {
      registrationIdTail: registrationId.slice(-6),
      operatorUserIdTail: user.id.slice(-6),
      checkoutSessionIdTail: checkoutSessionId.slice(-8),
    });
    return NextResponse.redirect(checkoutUrl, { status: 303 });
  } catch (err) {
    if (err instanceof ForbiddenError) {
      logger.warn("signup.synthetic.initiate.refused", {
        registrationIdTail: registrationId.slice(-6),
        detail: err.message,
      });
      return NextResponse.json({ error: "forbidden", detail: err.message }, { status: 403 });
    }
    if (err instanceof AppError) {
      return NextResponse.json({ error: err.code, detail: err.message }, { status: err.httpStatus });
    }
    logger.error("signup.synthetic.initiate.failed", {
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
