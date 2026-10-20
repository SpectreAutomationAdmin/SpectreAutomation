// SIGNUP-1 (2026-10-19) — GET /api/signup/microsoft/callback.
//
// Microsoft OAuth redirect target.  Validates state + nonce + rejects
// personal accounts; on success:
//   1. Writes the verified Microsoft identity to the SignupRegistration.
//   2. Runs organization-verification classifier → records the
//      ownership verification state.
//   3. Rotates emailResumeToken + sends the cross-device resume email.
//   4. Issues a FRESH URL token (so the browser's current token stays
//      valid AND the email token is independent) by setting a new
//      resume cookie.
//   5. Redirects to /signup/t/<new-token>/status.
//
// NEVER writes to User / Club / UserClubRole.

import { NextResponse, type NextRequest } from "next/server";
import {
  finaliseMicrosoftAuth,
} from "@/lib/signup/microsoft-oauth";
import {
  markVerified,
  _unsafe_findById,
} from "@/lib/signup/registration";
import { issueRecoveryLink } from "@/lib/signup/recovery-link";
import { classifyOrganization, recordOrganizationDecision } from "@/lib/signup/org-verification";
import { sendResumeEmail } from "@/lib/signup/resume-email";
import { env } from "@/lib/env";
import { logger } from "@/lib/observability/logger";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function errorRedirect(returnPath: string | null, msg: string): NextResponse {
  const base = returnPath && returnPath.startsWith("/signup/t/")
    ? returnPath.replace("/status", "/admin")
    : "/signup";
  return NextResponse.redirect(
    new URL(`${base}?error=${encodeURIComponent(msg)}`, env.APP_URL),
    { status: 303 },
  );
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? undefined;
  const microsoftError = url.searchParams.get("error") ?? undefined;

  const outcome = await finaliseMicrosoftAuth({ state, code, microsoftError });

  switch (outcome.status) {
    case "STATE_UNKNOWN":
      logger.warn("signup.callback.state_unknown");
      return errorRedirect(null, "This verification link is no longer valid. Please start again.");
    case "STATE_REPLAY":
      return errorRedirect(null, "This verification link has already been used. Please start a new verification.");
    case "STATE_EXPIRED":
      return errorRedirect(null, "This verification link has expired. Please start a new verification.");
    case "DENIED":
      return errorRedirect(null, "Microsoft sign-in was cancelled. You can try again.");
    case "NONCE_MISMATCH":
      return errorRedirect(null, "Verification failed. Please try again.");
    case "PERSONAL_ACCOUNT_REJECTED":
      return errorRedirect(null, "Spectre requires a Microsoft work-or-school account. Personal accounts aren't supported.");
    case "CALLBACK_ERROR":
      return errorRedirect(null, "Verification could not be completed. Please try again.");
    case "SUCCESS": {
      // Load the registration using the service-internal lookup
      // (we have the id from the transaction, which we trust).
      const reg = await _unsafe_findById(outcome.registrationId);
      if (!reg) {
        return errorRedirect(null, "Your registration could not be found. Please start again.");
      }
      await markVerified({
        registrationId: outcome.registrationId,
        adminEmail: outcome.identity.email,
        adminMicrosoftOid: outcome.identity.oid,
        adminMicrosoftTenantId: outcome.identity.tid,
        adminDisplayName: outcome.identity.displayName,
        adminGivenName: outcome.identity.givenName,
        adminSurname: outcome.identity.surname,
        adminPosition: reg.adminPosition, // null — set via /admin-position
      });
      // Automated organization verification.  Never discloses details
      // to the applicant — the decision persists on the row for
      // SpectreAdmin review.
      try {
        const evidence = await classifyOrganization({
          registrationId: outcome.registrationId,
          websiteUrl: reg.websiteUrl,
          adminEmail: outcome.identity.email,
          microsoftTenantId: outcome.identity.tid,
          legalName: reg.legalName,
          operatingName: reg.operatingName,
        });
        await recordOrganizationDecision(outcome.registrationId, evidence);
      } catch (e) {
        logger.warn("signup.org_verification.failed", {
          detail: e instanceof Error ? e.message : String(e),
        });
      }
      // SIGNUP-1F (2026-10-20) — issue a fresh recovery link in the
      // dedicated SignupRecoveryLink table.  Any still-active prior
      // links are auto-superseded.  Short-lived (24h), single-use,
      // revocable.  The plaintext token leaves this function exactly
      // once — placed in the email body, never logged.
      try {
        const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
        const { token: recoveryToken } = await issueRecoveryLink({
          registrationId: outcome.registrationId,
          toEmail: outcome.identity.email,
          issuedByIp: ip,
        });
        await sendResumeEmail({
          toEmail: outcome.identity.email,
          resumeToken: recoveryToken,
          legalName: reg.legalName,
          adminDisplayName: outcome.identity.displayName,
        });
      } catch (e) {
        logger.warn("signup.resume_email.pipeline_failed", {
          detail: e instanceof Error ? e.message : String(e),
        });
      }
      // Pre-callback registration audit (clubId=null — SIGNUP-1
      // has no tenant).  Note: audit() requires a principal; use a
      // sentinel null principal for this pre-tenant event.
      try {
        await audit(null, {
          action: "signup.microsoft.verified",
          entityType: "SignupRegistration",
          entityId: outcome.registrationId,
          clubId: null,
          meta: {
            tenantIdTail: outcome.identity.tid.slice(-6),
            oidTail: outcome.identity.oid.slice(-6),
          },
        });
      } catch (e) {
        // Audit failure must never block the user from reaching Screen 3.
        logger.warn("signup.audit.failed", { detail: e instanceof Error ? e.message : String(e) });
      }
      // Return to /signup/t/<old-token>/status — the original URL
      // token still works because the registration row is unchanged
      // (only the emailResumeTokenHash was added, not resumeTokenHash
      // rotated).  This preserves the cookie-based resume path AND
      // adds the independent email-based one.
      return NextResponse.redirect(new URL(outcome.returnPath, env.APP_URL), { status: 303 });
    }
  }
}
