// HR mobile-hotfix (2026-08-26) — Employee Portal password-reset
// email. Composed + delivered through Spectre's canonical
// multi-provider email stack — the same adapter chain onboarding
// invitations use. No parallel mail stack.
//
// The raw reset token is embedded ONLY in the URL inside the email
// body and is NEVER logged, persisted, or returned to the caller.

import { selectEmailAdapter } from "../integrations/email";
import { prisma } from "../prisma";

export interface SendPortalPasswordResetEmailInput {
  clubId: string;
  toEmail: string;
  employeeDisplayName: string;
  resetUrl: string;
  expiresAt: Date;
  /** Optional acting user (admin who initiated the send from
   *  Employee Profile). Threaded through to the delegated adapter's
   *  token-refresh audit trail; null for employee self-service. */
  callerUserId?: string | null;
}

function formatDateTime(d: Date): string {
  return d.toLocaleString("en-US", {
    year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
}

export function composePortalPasswordResetEmail(args: {
  clubName: string;
  employeeDisplayName: string;
  resetUrl: string;
  expiresAt: Date;
}): { subject: string; html: string; text: string } {
  const subject = `${args.clubName} — reset your Employee Portal password`;
  const expires = formatDateTime(args.expiresAt);
  const text = [
    `Hello ${args.employeeDisplayName},`,
    ``,
    `We received a request to reset your Employee Portal password at ${args.clubName}.`,
    ``,
    `Follow this one-time link to choose a new password:`,
    args.resetUrl,
    ``,
    `This link expires at ${expires}. If you did not request a password reset, you can ignore this email; your existing password remains in effect.`,
    ``,
    `— ${args.clubName}`,
  ].join("\n");
  const html = [
    `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #111827; max-width: 560px; margin: 0 auto; padding: 24px;">`,
    `<p style="font-size: 15px; margin: 0 0 12px;">Hello ${escapeHtml(args.employeeDisplayName)},</p>`,
    `<p style="font-size: 14px; line-height: 1.55; margin: 0 0 12px;">We received a request to reset your Employee Portal password at <strong>${escapeHtml(args.clubName)}</strong>.</p>`,
    `<p style="font-size: 14px; line-height: 1.55; margin: 0 0 20px;">Follow this one-time link to choose a new password:</p>`,
    `<p style="margin: 0 0 24px;"><a href="${escapeAttr(args.resetUrl)}" style="display: inline-block; padding: 10px 18px; background: #065f46; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 500;">Reset password</a></p>`,
    `<p style="font-size: 12px; color: #6b7280; line-height: 1.5; margin: 0 0 12px;">This link expires at ${escapeHtml(expires)}. If you did not request a password reset, you can ignore this email; your existing password remains in effect.</p>`,
    `<p style="font-size: 12px; color: #6b7280; margin: 24px 0 0;">— ${escapeHtml(args.clubName)}</p>`,
    `</div>`,
  ].join("");
  return { subject, html, text };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}

export async function sendPortalPasswordResetEmail(
  input: SendPortalPasswordResetEmailInput,
): Promise<void> {
  const club = await prisma.club.findUnique({
    where: { id: input.clubId },
    select: { name: true },
  });
  if (!club) throw new Error("club not found");

  const composed = composePortalPasswordResetEmail({
    clubName: club.name,
    employeeDisplayName: input.employeeDisplayName,
    resetUrl: input.resetUrl,
    expiresAt: input.expiresAt,
  });

  const adapter = await selectEmailAdapter({
    clubId: input.clubId,
    callerUserId: input.callerUserId ?? null,
  });

  const result = await adapter.send({
    clubId: input.clubId,
    channel: "EMAIL",
    to: { email: input.toEmail },
    subject: composed.subject,
    body: composed.html,
  });

  // Operational log — never carries the raw URL / token.
  const recipientDomain = input.toEmail.split("@")[1] ?? "unknown";
  // eslint-disable-next-line no-console
  console.log("[hr-password-reset] email dispatch", {
    clubIdTail: input.clubId.slice(-8),
    recipientDomain,
    status: result.status,
    providerMessageIdTail: result.providerMessageId?.slice(-16) ?? null,
  });
}
