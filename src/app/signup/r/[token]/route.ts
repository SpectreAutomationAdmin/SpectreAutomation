// SIGNUP-1F (2026-10-20) — Recovery-link consume route.
//
// Public GET endpoint invoked by the recipient when they click the
// recovery link in the email we send after Microsoft identity
// verification.  The URL path parameter is the plaintext recovery
// token; its sha-256 hash is looked up in SignupRecoveryLink and
// consumed atomically.
//
// Flow:
//   1. Hash the path-token.  Call consumeRecoveryLink — this is
//      single-shot: a second click of the same link returns
//      ALREADY_CONSUMED.
//   2. On SUCCESS: rotate the browser-session resumeToken for the
//      registration (the clicking browser gets a fresh HTTPOnly
//      cookie; any previously-paired browser's cookie becomes
//      stale and must request a fresh link to recover).
//   3. Set the resume cookie + 303-redirect to the status page.
//   4. On any failure outcome: redirect to /signup/resume with an
//      error message explaining the specific failure mode (expired
//      vs already-used vs unknown) — the user can request a fresh
//      link from there.
//
// Security:
//   - Rate-limited (recovery_consume bucket) to prevent token
//     enumeration via the single-use failure path.
//   - Zero logging of the plaintext token.
//   - Zero logging of the full URL.
//   - 404 for malformed path tokens (not 400 — same shape as a
//     real not-found).

import { NextResponse, type NextRequest } from "next/server";
import { consumeRecoveryLink } from "@/lib/signup/recovery-link";
import { rotateResumeToken } from "@/lib/signup/registration";
import { checkAuthRateLimit } from "@/lib/security/auth-guard";
import { env } from "@/lib/env";
import { logger } from "@/lib/observability/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RESUME_COOKIE = "spectre_signup_resume";
const RESUME_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

function redirectTo(path: string): NextResponse {
  return NextResponse.redirect(new URL(path, env.APP_URL), { status: 303 });
}

export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const token = params.token;
  // Shape pre-check — no logging of the token itself.
  if (!token || token.length < 20 || token.length > 200) {
    return redirectTo("/signup/resume?error=invalid_link");
  }
  // Rate-limit the consume endpoint keyed by IP + the first 8 chars
  // of the (public) token.  Prevents brute-force / enumeration
  // against the single-use failure branch.
  const rate = await checkAuthRateLimit("signup_recovery_consume", token.slice(0, 8), ip ?? "unknown");
  if (!rate.allowed) {
    return redirectTo("/signup/resume?error=rate_limited");
  }

  const outcome = await consumeRecoveryLink({ token, consumedByIp: ip });
  switch (outcome.status) {
    case "NOT_FOUND":
      logger.info("signup.recovery.consume.not_found", { ipKnown: !!ip });
      return redirectTo("/signup/resume?error=unknown_link");
    case "ALREADY_CONSUMED":
      return redirectTo("/signup/resume?error=already_used");
    case "REVOKED":
      return redirectTo("/signup/resume?error=revoked");
    case "EXPIRED":
      return redirectTo("/signup/resume?error=expired");
    case "SUCCESS": {
      // Rotate the browser-session resumeToken so this browser
      // establishes its own session.  The plaintext resumeToken
      // leaves rotateResumeToken exactly once; it never enters a
      // log line.
      const resumeToken = await rotateResumeToken(outcome.registrationId);
      const res = redirectTo(`/signup/t/${encodeURIComponent(resumeToken)}/status`);
      res.cookies.set(RESUME_COOKIE, resumeToken, {
        httpOnly: true,
        secure: env.APP_URL.startsWith("https://"),
        sameSite: "lax",
        path: "/signup",
        maxAge: RESUME_COOKIE_MAX_AGE_SECONDS,
      });
      return res;
    }
  }
}
