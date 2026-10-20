// SIGNUP-1F (2026-10-20) — POST /api/signup/resume/request.
//
// Public endpoint.  Accepts {email}, issues a fresh SignupRecoveryLink
// if the email matches a VERIFIED-identity registration, and sends
// the recovery email.  Always returns the same shape regardless of
// match — the applicant can't use this to enumerate registered
// addresses.
//
// Rate-limited by IP + email prefix.  No raw tokens in logs.

import { NextResponse, type NextRequest } from "next/server";
import { findRegistrationIdByAdminEmail, issueRecoveryLink } from "@/lib/signup/recovery-link";
import { sendResumeEmail } from "@/lib/signup/resume-email";
import { checkAuthRateLimit } from "@/lib/security/auth-guard";
import { env } from "@/lib/env";
import { logger } from "@/lib/observability/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function redirectTo(path: string): NextResponse {
  return NextResponse.redirect(new URL(path, env.APP_URL), { status: 303 });
}

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const form = await req.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();

  if (!email || email.length < 3 || email.length > 320 || !email.includes("@")) {
    return redirectTo("/signup/resume?error=invalid_link");
  }

  const rate = await checkAuthRateLimit("signup_recovery_request", email.slice(0, 32), ip ?? "unknown");
  if (!rate.allowed) {
    return redirectTo("/signup/resume?error=rate_limited");
  }

  // Enumeration-safe: perform the lookup, issue + send if matched,
  // but always redirect to the same "sent" acknowledgement.  Any
  // internal classification (match / no-match / abandoned) is logged
  // (masked) but never surfaced to the applicant.
  try {
    const match = await findRegistrationIdByAdminEmail(email);
    if (match) {
      const { token } = await issueRecoveryLink({
        registrationId: match.registrationId,
        toEmail: email,
        issuedByIp: ip,
      });
      await sendResumeEmail({
        toEmail: email,
        resumeToken: token,
        legalName: match.legalName,
        adminDisplayName: match.adminDisplayName,
      });
      logger.info("signup.recovery.request.sent", {
        registrationIdTail: match.registrationId.slice(-6),
      });
    } else {
      logger.info("signup.recovery.request.no_match");
    }
  } catch (e) {
    // Any pipeline failure is logged (masked) but the user sees the
    // same acknowledgement.  Prevents the error path from leaking
    // match-vs-no-match signal.
    logger.warn("signup.recovery.request.pipeline_failed", {
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  return redirectTo("/signup/resume?sent=1");
}
