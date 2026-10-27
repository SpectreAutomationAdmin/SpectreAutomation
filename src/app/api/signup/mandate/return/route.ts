// SIGNUP-2 Phase 2E (2026-10-26) -- GET /api/signup/mandate/return
//
// Stripe Checkout redirects here after the applicant signs the
// mandate.  Query params:  session_id, token.
//
// This handler fetches the Checkout session, persists the signed
// mandate + first BillingCycle (idempotent on registration id), and
// redirects the applicant to the status page.

import { NextResponse, type NextRequest } from "next/server";
import { ForbiddenError, AppError } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { resolveRegistrationByToken } from "@/lib/signup/registration";
import { persistSignedMandate } from "@/lib/billing/signup-2e-mandate-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function redirectTo(path: string): NextResponse {
  return NextResponse.redirect(new URL(path, env.APP_URL), { status: 303 });
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const sessionId = req.nextUrl.searchParams.get("session_id") ?? "";
  if (!token) return redirectTo("/signup?error=session_expired");
  if (!sessionId) return redirectTo("/signup?error=session_expired");

  const reg = await resolveRegistrationByToken(token);
  if (!reg) return redirectTo("/signup?error=session_expired");

  try {
    await persistSignedMandate({ registrationId: reg.id, checkoutSessionId: sessionId });
    // SIGNUP-2 M3 (2026-10-27, founder §3): club-facing status reflects
    // the actual bank-verification state, not just "signed".  Read the
    // first cycle we just persisted + surface its subscriptionStatus.
    const cycle = await prisma.billingCycle.findFirst({
      where: { clubId: reg.id, source: "STRIPE_ACSS" },
      orderBy: { createdAt: "desc" },
      select: { subscriptionStatus: true, bankVerificationHostedUrl: true },
    });
    const state = cycle?.subscriptionStatus ?? "AUTHORISED";
    const bankVerificationState =
      state === "BANK_VERIFIED" ? "verified" :
      state === "BANK_VERIFICATION_PENDING" ? "pending" :
      state === "BANK_VERIFICATION_FAILED" ? "failed" :
      "signed";
    return redirectTo(
      `/signup/t/${encodeURIComponent(token)}/status?mandate_signed=1&bank_verification=${bankVerificationState}`,
    );
  } catch (err) {
    if (err instanceof ForbiddenError) {
      logger.warn("signup.mandate.return.refused", {
        registrationIdTail: reg.id.slice(-6),
        detail: err.message,
      });
      return redirectTo(`/signup/t/${encodeURIComponent(token)}/status?error=mandate_refused`);
    }
    if (err instanceof AppError) {
      return redirectTo(`/signup/t/${encodeURIComponent(token)}/status?error=${encodeURIComponent(err.code.toLowerCase())}`);
    }
    logger.error("signup.mandate.return.failed", {
      registrationIdTail: reg.id.slice(-6),
      detail: err instanceof Error ? err.message : String(err),
    });
    return redirectTo(`/signup/t/${encodeURIComponent(token)}/status?error=mandate_server_error`);
  }
}
