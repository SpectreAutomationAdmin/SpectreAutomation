// SIGNUP-1 (2026-10-19) — POST /api/signup/microsoft/start.
//
// Receives the token from the Screen 2 form, creates a
// SignupOAuthTransaction, and redirects the browser to Microsoft's
// authorization URL.
//
// Scope: identity-only (openid + profile + email + offline_access).
// NO mailbox scopes.

import { NextResponse, type NextRequest } from "next/server";
import { resolveRegistrationByToken, transitionStep } from "@/lib/signup/registration";
import { startMicrosoftAuth } from "@/lib/signup/microsoft-oauth";
import { checkAuthRateLimit } from "@/lib/security/auth-guard";
import { env } from "@/lib/env";
import { isAppError } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const form = await req.formData();
  const token = String(form.get("token") ?? "").trim();
  if (!token) {
    return NextResponse.redirect(new URL("/signup?error=missing_token", env.APP_URL), { status: 303 });
  }
  const rate = await checkAuthRateLimit("signup_microsoft", token.slice(0, 32), ip ?? "unknown");
  if (!rate.allowed) {
    return NextResponse.redirect(
      new URL(
        `/signup/t/${encodeURIComponent(token)}/admin?error=${encodeURIComponent("Too many attempts. Please wait a moment and try again.")}`,
        env.APP_URL,
      ),
      { status: 303 },
    );
  }
  const reg = await resolveRegistrationByToken(token);
  if (!reg) {
    return NextResponse.redirect(new URL("/signup?error=session_expired", env.APP_URL), { status: 303 });
  }
  try {
    const { authorizationUrl } = await startMicrosoftAuth({
      registrationId: reg.id,
      // SIGNUP-1E (2026-10-20) — return to /admin, NOT /status.
      // After the Microsoft callback persists the verified identity,
      // the admin page's redirect gate (adminVerifiedAt + adminPosition)
      // determines whether to show the position form (position=null)
      // or forward to /status (both captured).  Returning directly
      // to /status would bypass the position form — the role would
      // never be collected, and status would render "Pending" forever.
      returnPath: `/signup/t/${encodeURIComponent(token)}/admin`,
    });
    await transitionStep(reg.id, { step: "ADMIN_PENDING" });
    logger.info("signup.microsoft.redirecting", {
      registrationIdTail: reg.id.slice(-6),
    });
    return NextResponse.redirect(authorizationUrl, { status: 303 });
  } catch (err) {
    const msg = isAppError(err) ? err.safeMessage : "Microsoft identity is temporarily unavailable. Please try again later.";
    return NextResponse.redirect(
      new URL(`/signup/t/${encodeURIComponent(token)}/admin?error=${encodeURIComponent(msg)}`, env.APP_URL),
      { status: 303 },
    );
  }
}
