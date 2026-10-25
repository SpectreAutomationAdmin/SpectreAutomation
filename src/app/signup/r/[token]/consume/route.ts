// SIGNUP-1G defect repair (2026-10-25) -- Recovery-link consume route
// (POST-only).
//
// Replaces the former GET-consume route at /signup/r/[token]/route.ts.
// The parent segment is now a page.tsx landing surface; the consume
// step is this child segment's POST.  Scanners never POST, so the
// token is never redeemed by Microsoft Defender Safe Links or any
// other corporate email-security pre-fetcher.
//
// Everything else is unchanged from SIGNUP-1F:
//
//   • consumeRecoveryLink is atomic + race-safe + single-use.
//   • Rotates the resume cookie on SUCCESS.
//   • 303-redirects to /signup/t/[newToken]/status on SUCCESS.
//   • Classifies the exact failure mode in the redirect error code,
//     without leaking any PII.
//   • Rate-limited by IP + token-prefix.
//   • Zero logging of raw tokens or full URLs.

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

export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
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
