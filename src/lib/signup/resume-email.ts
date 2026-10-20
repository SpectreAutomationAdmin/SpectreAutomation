// SIGNUP-1 (2026-10-19) — Cross-device resume email.
//
// Delivered to the Microsoft-verified address AFTER successful OAuth
// callback.  Carries the post-verify emailResumeToken so the applicant
// can resume on any device / after cookie loss.
//
// Delivery:
//   - Uses the dev email adapter when EMAIL_DELIVERY_MODE is
//     "console" (the default on staging + local).  The sendResumeEmail
//     function returns { delivered: boolean; providerMessageId? }
//     so the OAuth callback can log the outcome without failing the
//     signup when email cannot be delivered.
//   - On staging, the dev adapter prints the resume URL to the Fly
//     log stream — SpectreAdmin can read it there for test purposes.
//   - A later slice will wire SMTP / SES / Microsoft 365 delegated
//     delivery; the function signature is stable.
//
// NO sensitive data in the email body beyond the resume URL itself.

import { env } from "@/lib/env";
import { logger } from "@/lib/observability/logger";
import { devEmailAdapter } from "@/lib/integrations/email";

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
    const res = await devEmailAdapter.send({
      // SIGNUP-1 has no club yet; the dev adapter accepts a sentinel
      // clubId.  Production delivery is a later slice; this logs to
      // the structured log stream on staging.
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
