// SIGNUP-2 M2-SyntheticSandbox (2026-10-27) + M3C (2026-10-28) -- Stripe
// sandbox return handler for the SYNTHETIC_TEST_ONLY mandate flow.
//
// Reachable from Stripe's hosted Checkout `success_url` after a
// synthetic test operator (founder) completes the ACSS mandate.
// Guards + synthetic-only refusal mirror the initiate route.
//
// M3C: on success, 303-redirect to the branded registration status
// page.  Since the synthetic driver's createOne does not expose a
// plaintext resumeToken to the signatory, we fresh-mint one here --
// safe for a synthetic row that has already consumed its single-use
// nonce and will not accept a second return.  Only applicable when
// syntheticTestOnly=true.

import { NextResponse, type NextRequest } from "next/server";
import { ForbiddenError, AppError } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { randomBytes, createHash } from "node:crypto";
import {
  persistSyntheticSignedMandate,
  consumeSyntheticReturnNonce,
} from "@/lib/signup/signup-2m2-synthetic-sandbox-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function redirectTo(path: string): NextResponse {
  return NextResponse.redirect(new URL(path, env.APP_URL), { status: 303 });
}

async function mintFreshResumeToken(registrationId: string): Promise<string | null> {
  // Only applicable for synthetic rows.  Rotates resumeTokenHash so the
  // signatory can navigate to the branded status page.  Safe because
  // the nonce for the signatory return has already been consumed.
  const reg = await prisma.signupRegistration.findUnique({
    where: { id: registrationId },
    select: { id: true, syntheticTestOnly: true },
  });
  if (!reg || reg.syntheticTestOnly !== true) return null;
  const plaintext = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(plaintext).digest("hex");
  await prisma.signupRegistration.update({
    where: { id: registrationId },
    data: { resumeTokenHash: hash },
  });
  return plaintext;
}

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
    logger.info("signup.synthetic.return.ok", {
      registrationIdTail: registrationId.slice(-6),
      billingCycleIdTail: result.billingCycleId?.slice(-6) ?? null,
      initialSubscriptionStatus: result.initialSubscriptionStatus ?? null,
      paymentInitiated: result.paymentInitiated ?? false,
    });
    // M3C: redirect to the branded signup status page.  Mint a fresh
    // resumeToken for the synthetic row so the page's token-based
    // resolver works.  The status page's DB-derived banner then shows
    // BANK_VERIFIED / BANK_VERIFICATION_PENDING authoritatively.
    const freshToken = await mintFreshResumeToken(registrationId);
    if (freshToken) {
      return redirectTo(`/signup/t/${freshToken}/status?mandate_signed=1`);
    }
    // Fallback (should not happen for synthetic rows): keep JSON shape.
    return NextResponse.json({
      ok: true,
      syntheticTestOnly: true,
      noop: result.noop,
      mandateIdTail: result.mandateId?.slice(-8) ?? null,
      billingCycleIdTail: result.billingCycleId?.slice(-6) ?? null,
      initialSubscriptionStatus: result.initialSubscriptionStatus ?? null,
      paymentInitiated: result.paymentInitiated ?? false,
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
