// SIGNUP-1 (2026-10-19) — Cross-device resume email.
// SIGNUP-1 §2 hardening (2026-10-20) — platform-level transactional
// delivery via selectPlatformEmailAdapter.  Uses EMAIL_DELIVERY_MODE
// + MICROSOFT_TENANT_ID / MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET
// / MICROSOFT_FROM_MAILBOX (microsoft365) OR SMTP_* (smtp) OR
// AWS_REGION + SES_FROM_ADDRESS (ses).  No club tenant required.
// Falls back to the dev console adapter when none configured.
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
}): Promise<{ delivered: boolean; providerMessageId?: string; detail?: string }> {
  const resumeUrl = `${env.APP_URL}/signup/t/${encodeURIComponent(args.resumeToken)}/status`;
  const subject = "Resume your Spectre registration";
  const greeting = args.adminDisplayName ? `Hi ${args.adminDisplayName.split(" ")[0]},` : "Hi there,";
  const body = [
    greeting,
    "",
    `Your identity is verified for ${args.legalName}.`,
    "",
    "If you need to return to your Spectre registration from a different device, use this link:",
    "",
    resumeUrl,
    "",
    "This link is single-use for sign-in purposes and expires in 72 hours.",
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
