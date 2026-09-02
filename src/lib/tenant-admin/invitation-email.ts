// TA-1B closeout (2026-09-03) — Admin invitation email delivery.
//
// Mirrors src/lib/hr/invitation-email.ts one-to-one so administrative
// invitations use the same canonical multi-provider stack (console /
// SMTP / SES / MS365 / MS365-delegated) resolved per-Club via
// selectEmailAdapter(clubId). No parallel mail system is introduced.
//
// The raw activation token is embedded ONLY in the outbound email
// body's single-use URL — never returned to callers, never persisted,
// never logged.

import { selectEmailAdapter, getEmailMode, getEmailDeliveryDescriptor, type EmailMode } from "../integrations/email";
import { prisma } from "../prisma";

// ---------------------------------------------------------------------
// Delivery-result vocabulary (matches HR's shape so the DB persistence
// layer + operator alerts read consistently across invitation kinds).
// ---------------------------------------------------------------------
export type AdminInvitationDeliveryStatus =
  | "NOT_ATTEMPTED"
  | "DEV_LOGGED"
  | "DELIVERED"
  | "FAILED";

export interface AdminInvitationDeliveryResult {
  status: AdminInvitationDeliveryStatus;
  provider: "console" | "smtp" | "ses" | "microsoft365" | "microsoft365_delegated" | null;
  providerMessageId: string | null;
  failureReason: string | null;
  externalSendConfirmed: boolean;
  operatorAlert: boolean;
  senderIdentity?: string | null;
}

interface Composed {
  subject: string;
  text: string;
  html: string;
}

interface ComposeArgs {
  clubName: string;
  inviterName: string;
  displayName: string;
  isExistingUser: boolean;
  activationUrl: string;
  expiresAt: Date;
}

interface SendArgs extends Omit<ComposeArgs, "activationUrl"> {
  clubId: string;
  invitationId: string;
  toEmail: string;
  rawToken: string;
  publicHost: string;
  callerUserId: string | null;
}

// ---------------------------------------------------------------------
// Compose the message body.
//
// The CTA lands on /invite/[token]. Server-side, that page detects
// whether the email matches an existing User and routes to either
// account creation (Path A) or "Sign in to accept" (Path B). Email
// copy therefore stays neutral: "Continue to accept your invitation".
// ---------------------------------------------------------------------
export function composeAdminInvitationEmail(args: ComposeArgs): Composed {
  const expiryLine = `This invitation is valid until ${formatDate(args.expiresAt)}.`;
  const acceptLine = args.isExistingUser
    ? `Sign in to your Spectre account and accept your invitation.`
    : `Set up your Spectre account to begin.`;

  const subject = `You've been invited to Spectre — ${args.clubName}`;

  const text = [
    `Hello ${args.displayName || "there"},`,
    ``,
    `${args.inviterName} has invited you to help operate ${args.clubName} on Spectre.`,
    ``,
    acceptLine,
    args.activationUrl,
    ``,
    expiryLine,
    ``,
    `If you did not expect this invitation you can ignore this email; the link will expire automatically.`,
    ``,
    `— ${args.clubName}`,
  ].join("\n");

  const html = `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f5f4f1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1c1917;line-height:1.55;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f4f1;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e7e5e4;border-radius:8px;">
          <tr><td style="padding:32px 40px 8px 40px;">
            <div style="font-size:11px;letter-spacing:0.25em;text-transform:uppercase;color:#78716c;">${escapeHtml(args.clubName)}</div>
          </td></tr>
          <tr><td style="padding:0 40px;">
            <h1 style="margin:8px 0 24px 0;font-family:Georgia,'Times New Roman',serif;font-weight:600;font-size:26px;line-height:1.2;color:#1c1917;">You've been invited.</h1>
          </td></tr>
          <tr><td style="padding:0 40px;">
            <p style="margin:0 0 16px 0;font-size:15px;color:#292524;">Hello ${escapeHtml(args.displayName || "there")},</p>
            <p style="margin:0 0 16px 0;font-size:15px;color:#292524;">${escapeHtml(args.inviterName)} has invited you to help operate ${escapeHtml(args.clubName)} on Spectre.</p>
            <p style="margin:0 0 24px 0;font-size:15px;color:#292524;">${escapeHtml(acceptLine)}</p>
          </td></tr>
          <tr><td style="padding:0 40px 24px 40px;">
            <a href="${escapeAttr(args.activationUrl)}" style="display:inline-block;background:#166534;color:#ffffff;text-decoration:none;font-size:15px;font-weight:500;padding:12px 24px;border-radius:6px;">Continue to accept</a>
          </td></tr>
          <tr><td style="padding:0 40px 24px 40px;">
            <p style="margin:0;font-size:12px;color:#78716c;">${escapeHtml(expiryLine)}</p>
            <p style="margin:8px 0 0 0;font-size:12px;color:#a8a29e;">If you did not expect this invitation you can ignore this email; the link will expire automatically.</p>
          </td></tr>
          <tr><td style="padding:16px 40px 24px 40px;border-top:1px solid #f5f4f1;">
            <p style="margin:0;font-size:11px;color:#a8a29e;">— ${escapeHtml(args.clubName)}</p>
          </td></tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  return { subject, text, html };
}

// ---------------------------------------------------------------------
// Classify a NotificationDeliveryAdapter.send() result. Console adapter
// returns `dev-<ts>` message ids — treat as DEV_LOGGED (never claim
// SENT). Structurally identical to hr/invitation-email.ts's classifier.
// ---------------------------------------------------------------------
function classifyDeliveryResult(
  adapterMode: EmailMode,
  sendResult: { status: string; providerMessageId?: string; failureReason?: string },
): Omit<AdminInvitationDeliveryResult, "operatorAlert" | "senderIdentity"> {
  const provider =
    adapterMode === "console" ? "console"
    : adapterMode === "smtp" ? "smtp"
    : adapterMode === "ses" ? "ses"
    : adapterMode === "microsoft365" ? "microsoft365"
    : adapterMode === "microsoft365_delegated" ? "microsoft365_delegated"
    : null;
  const isDevLogged =
    adapterMode === "console" ||
    (typeof sendResult.providerMessageId === "string" && sendResult.providerMessageId.startsWith("dev-"));
  if (isDevLogged) {
    return {
      status: "DEV_LOGGED",
      provider: "console",
      providerMessageId: sendResult.providerMessageId ?? null,
      failureReason: null,
      externalSendConfirmed: false,
    };
  }
  if (sendResult.status === "SENT") {
    return {
      status: "DELIVERED",
      provider,
      providerMessageId: sendResult.providerMessageId ?? null,
      failureReason: null,
      externalSendConfirmed: true,
    };
  }
  return {
    status: "FAILED",
    provider,
    providerMessageId: sendResult.providerMessageId ?? null,
    failureReason: sendResult.failureReason ?? sendResult.status ?? "unknown",
    externalSendConfirmed: false,
  };
}

// ---------------------------------------------------------------------
// Persist delivery attempt onto the AdminInvitation row.
//
//   status DELIVERED       → invitation.status := SENT
//   status DEV_LOGGED      → invitation.status := SENT (still marked
//                            sent for founder-facing UI; operatorAlert
//                            surfaces the console-only reality)
//   status FAILED          → invitation.status := FAILED
//   status NOT_ATTEMPTED   → invitation.status remains PENDING
//
// deliveryFailureReason is provider-supplied text — never contains
// the token or plaintext PII. Truncated at 500 chars.
// ---------------------------------------------------------------------
async function persistInvitationDelivery(
  invitationId: string,
  classified: Omit<AdminInvitationDeliveryResult, "operatorAlert" | "senderIdentity">,
): Promise<void> {
  const nextStatus =
    classified.status === "DELIVERED" || classified.status === "DEV_LOGGED" ? "SENT" :
    classified.status === "FAILED" ? "FAILED" : null;
  const now = new Date();
  await prisma.adminInvitation.update({
    where: { id: invitationId },
    data: {
      ...(nextStatus ? { status: nextStatus } : {}),
      ...(nextStatus === "SENT" ? { sentAt: now, failedAt: null, lastError: null } : {}),
      ...(nextStatus === "FAILED" ? { failedAt: now, lastError: classified.failureReason?.slice(0, 500) ?? "unknown" } : {}),
      sendCount: { increment: 1 },
    },
  });
}

// ---------------------------------------------------------------------
// Send. Returns a structured result. Never throws provider errors
// upwards — a failed delivery returns { status: "FAILED", ... }.
// ---------------------------------------------------------------------
export async function sendAdminInvitationEmail(args: SendArgs): Promise<AdminInvitationDeliveryResult> {
  if (!args.toEmail) {
    return {
      status: "NOT_ATTEMPTED", provider: null, providerMessageId: null,
      failureReason: "no recipient email on file", externalSendConfirmed: false, operatorAlert: true,
    };
  }

  const activationUrl = `${args.publicHost.replace(/\/$/, "")}/invite/${args.rawToken}`;
  const composed = composeAdminInvitationEmail({
    clubName: args.clubName,
    inviterName: args.inviterName,
    displayName: args.displayName,
    isExistingUser: args.isExistingUser,
    activationUrl,
    expiresAt: args.expiresAt,
  });

  const [adapter, mode, descriptor] = await Promise.all([
    selectEmailAdapter({ clubId: args.clubId, callerUserId: args.callerUserId }),
    getEmailMode(args.clubId),
    getEmailDeliveryDescriptor(args.clubId),
  ]);

  let sendResult: { status: string; providerMessageId?: string; failureReason?: string };
  try {
    sendResult = await adapter.send({
      clubId: args.clubId,
      channel: "EMAIL",
      to: { email: args.toEmail },
      subject: composed.subject,
      body: composed.html,
    });
  } catch (err) {
    sendResult = { status: "FAILED", failureReason: err instanceof Error ? err.message : String(err) };
  }

  const classified = classifyDeliveryResult(mode, sendResult);
  const isProdLike = process.env.NODE_ENV === "production";
  const operatorAlert =
    classified.status === "FAILED" ||
    (classified.status === "DEV_LOGGED" && isProdLike) ||
    classified.status === "NOT_ATTEMPTED";
  const senderIdentity =
    mode === "microsoft365_delegated" ? (descriptor.designatedConnectedEmail ?? null) : null;
  const result: AdminInvitationDeliveryResult = { ...classified, operatorAlert, senderIdentity };

  try {
    await persistInvitationDelivery(args.invitationId, classified);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[tenant-admin invitation] failed to persist delivery attempt", {
      invitationIdTail: args.invitationId.slice(-8),
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Structured operational log — recipient domain only, never the raw token.
  const recipientDomain = args.toEmail.split("@")[1] ?? "unknown";
  // eslint-disable-next-line no-console
  console.info("[tenant-admin invitation] delivery attempt", {
    invitationIdTail: args.invitationId.slice(-8),
    recipientDomain,
    mode,
    status: classified.status,
    externalSendConfirmed: classified.externalSendConfirmed,
    operatorAlert,
  });

  return result;
}

// ---------------------------------------------------------------------
// Helper: resolve the canonical public host for URL construction.
// Prefers explicit APP_URL / NEXT_PUBLIC_APP_URL (set on Fly). Never
// derives from an arbitrary request Host header — an attacker who
// spoofed Host could otherwise poison invitation links.
// ---------------------------------------------------------------------
export function resolvePublicHost(): string {
  const host = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "";
  if (!host) {
    throw new Error("APP_URL is not configured; cannot construct invitation URL.");
  }
  return host;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" });
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
