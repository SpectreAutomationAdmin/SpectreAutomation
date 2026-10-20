// SIGNUP-1 (2026-10-19) — Cross-device resume email.
// SIGNUP-1 §2 hardening (2026-10-20) — platform-level transactional
// delivery via selectPlatformEmailAdapter.  Uses EMAIL_DELIVERY_MODE:
//
//   microsoft365  — needs MICROSOFT_TENANT_ID + MICROSOFT_CLIENT_ID
//                   + MICROSOFT_CLIENT_SECRET + MICROSOFT_FROM_MAILBOX.
//                   App registration must have `Mail.Send` application
//                   permission + admin consent.
//   smtp          — needs SMTP_HOST + SMTP_PORT + SMTP_FROM (+ optional
//                   SMTP_USER / SMTP_PASS / SMTP_SECURE).
//   ses           — reuses the AWS creds Spectre already has
//                   (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY +
//                   AWS_REGION) + a verified SES_FROM_ADDRESS.  The
//                   AWS IAM policy on these creds must include
//                   `ses:SendEmail` (grant once per account).
//
// None of these require a club tenant.  Falls back to the dev
// console adapter when none configured — logs to the Fly stream.
//
// Delivered to the Microsoft-verified address AFTER successful OAuth
// callback.  Carries the post-verify emailResumeToken so the applicant
// can resume on any device / after cookie loss.
//
// NO sensitive data in the email body beyond the resume URL itself.
// The email body displays no DB ids, no OAuth state, no PKCE
// verifier, no information about other registrations.

import { env } from "@/lib/env";
import { logger } from "@/lib/observability/logger";
import { selectPlatformEmailAdapter } from "@/lib/integrations/email";

export async function sendResumeEmail(args: {
  toEmail: string;
  resumeToken: string;
  legalName: string;
  adminDisplayName: string | null;
  // SIGNUP-1F (2026-10-20) — the token belongs to the dedicated
  // SignupRecoveryLink table.  Links are 30 min, single-use,
  // revocable.  The /signup/r/<token> route consumes the link once
  // and issues a fresh cookie-based session on the clicking browser.
  // The applicant can request another fresh link at any time from
  // /signup/resume.
  ttlMinutes?: number;
}): Promise<{ delivered: boolean; providerMessageId?: string; detail?: string }> {
  const resumeUrl = `${env.APP_URL}/signup/r/${encodeURIComponent(args.resumeToken)}`;
  const subject = "Resume your Spectre registration";
  const greeting = args.adminDisplayName ? `Hi ${args.adminDisplayName.split(" ")[0]},` : "Hi there,";
  const ttl = args.ttlMinutes ?? 30;
  const body = [
    greeting,
    "",
    `Your identity is verified for ${args.legalName}.`,
    "",
    "If you need to return to your Spectre registration from a different device, use this link:",
    "",
    resumeUrl,
    "",
    `This link is single-use and expires in ${ttl} minutes. If it expires or you need another one, visit ${env.APP_URL}/signup/resume and we will send a fresh link to your verified email.`,
    "",
    "Next step: your organization's verification will complete, and your subscription authorization will follow in a separate secure email.",
    "",
    "— Spectre",
  ].join("\n");
  try {
    const adapter = await selectPlatformEmailAdapter();
    const res = await adapter.send({
      // SIGNUP-1 has no club yet; the platform adapter accepts a
      // sentinel clubId.  Delivery mode is driven by
      // EMAIL_DELIVERY_MODE at the env level — microsoft365 / smtp
      // / ses / console.
      clubId: "signup",
      channel: "EMAIL",
      to: { email: args.toEmail },
      subject,
      body,
    });
    if (res.status === "SENT") {
      logger.info("signup.resume_email.sent", {
        toEmailMasked: maskEmail(args.toEmail),
        providerMessageId: res.providerMessageId,
      });
      return { delivered: true, providerMessageId: res.providerMessageId };
    }
    return { delivered: false, detail: res.failureReason };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn("signup.resume_email.failed", { detail });
    return { delivered: false, detail };
  }
}

function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 2) return "***";
  return `${email.slice(0, 2)}***@${email.slice(at + 1)}`;
}
