// HR-2B.1 (2026-08-18) — Invitation email delivery.
// HR-2B.3 tail (2026-08-20) — return + persist a canonical delivery
// result so the invitation route can distinguish issued+delivered from
// issued-but-not-delivered.
//
// Delivered through Spectre's canonical multi-provider email stack
// (`selectEmailAdapter(clubId)` — console/SMTP/SES/MS365 per Club).
// No parallel mail stack is introduced.
//
// The raw magic-link token is NEVER stored, logged, or persisted —
// it lives only inside the outbound email body's single-use URL.
// deliveryFailureReason is provider-supplied text (e.g. SMTP status
// line) — never contains the token or plaintext PII.

import { selectEmailAdapter, getEmailMode, type EmailMode } from "../integrations/email";
import { prisma } from "../prisma";

// ---------------------------------------------------------------------------
// Delivery result vocabulary.
// ---------------------------------------------------------------------------
export type InvitationDeliveryStatus =
  | "NOT_ATTEMPTED"   // no recipient address on file at issue time
  | "DEV_LOGGED"      // console-only devEmailAdapter fired (no external mail)
  | "DELIVERED"       // real provider accepted the message
  | "FAILED";         // real provider was selected but rejected the send

export interface InvitationDeliveryResult {
  status: InvitationDeliveryStatus;
  provider: "console" | "smtp" | "ses" | "microsoft365" | null;
  providerMessageId: string | null;
  failureReason: string | null;
  /** Whether the message actually reached the outbound provider. False
   *  for NOT_ATTEMPTED, DEV_LOGGED, and FAILED. True only for DELIVERED.
   *  Callers should surface this distinction in Club-facing UI. */
  externalSendConfirmed: boolean;
  /** Whether an operator should be alerted. True for FAILED and
   *  DEV_LOGGED (in production/staging); false in local dev. */
  operatorAlert: boolean;
}

// ---------------------------------------------------------------------------
// Composed message shape.
// ---------------------------------------------------------------------------
interface SendInvitationArgs {
  clubId: string;
  invitationId: string;
  employeeId: string;
  toEmail: string;
  rawToken: string;
  expiresAt: Date;
  publicHost: string;
}

interface Composed {
  subject: string;
  text: string;
  html: string;
}

export function composeInvitationEmail(args: {
  clubName: string;
  employeePreferredName: string | null;
  employeeFirstName: string;
  employeeLastName: string;
  departmentName: string | null;
  positionName: string | null;
  expectedStartDate: Date | null;
  redemptionUrl: string;
  expiresAt: Date;
}): Composed {
  const displayName = args.employeePreferredName?.trim().length
    ? args.employeePreferredName.trim()
    : args.employeeFirstName;
  const roleContext =
    args.departmentName && args.positionName
      ? `the ${args.departmentName} team as ${args.positionName}`
      : args.departmentName
        ? `the ${args.departmentName} team`
        : args.positionName
          ? `us as ${args.positionName}`
          : "our team";
  const startLine = args.expectedStartDate
    ? `Before your first day on ${formatDate(args.expectedStartDate)}, `
    : "Before your first day, ";
  const expiryLine = `This invitation is valid until ${formatDate(args.expiresAt)}.`;

  const subject = `Welcome to ${args.clubName}, ${displayName}`;

  const text = [
    `Welcome to ${args.clubName}, ${displayName}.`,
    ``,
    `We're excited to have you joining ${roleContext}.`,
    ``,
    `${startLine}we'll collect a few details to get you set up for payroll and ready to begin. It should only take a few minutes, and you can save and return at any time.`,
    ``,
    `Begin your onboarding:`,
    args.redemptionUrl,
    ``,
    expiryLine,
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
            <h1 style="margin:8px 0 24px 0;font-family:Georgia,'Times New Roman',serif;font-weight:600;font-size:28px;line-height:1.2;color:#1c1917;">Welcome to ${escapeHtml(args.clubName)}, ${escapeHtml(displayName)}.</h1>
          </td></tr>
          <tr><td style="padding:0 40px;">
            <p style="margin:0 0 16px 0;font-size:15px;color:#292524;">We're excited to have you joining ${escapeHtml(roleContext)}.</p>
            <p style="margin:0 0 16px 0;font-size:15px;color:#292524;">${escapeHtml(startLine)}we'll collect a few details to get you set up for payroll and ready to begin. It should only take a few minutes, and you can save and return at any time.</p>
          </td></tr>
          <tr><td style="padding:24px 40px;">
            <a href="${escapeAttr(args.redemptionUrl)}" style="display:inline-block;background:#166534;color:#ffffff;text-decoration:none;font-size:15px;font-weight:500;padding:12px 24px;border-radius:6px;">Begin your onboarding</a>
          </td></tr>
          <tr><td style="padding:8px 40px 32px 40px;">
            <p style="margin:0;font-size:12px;color:#78716c;">${escapeHtml(expiryLine)}</p>
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

// ---------------------------------------------------------------------------
// Classify a NotificationDeliveryAdapter.send() result into our
// canonical InvitationDeliveryStatus vocabulary.
// ---------------------------------------------------------------------------
/**
 * Distinguish real delivery from the dev/console adapter. The dev
 * adapter returns `{status: "SENT", providerMessageId: "dev-<ts>"}` —
 * that IS the contract other callers rely on (POS receipts etc.), but
 * for invitations we treat it as DEV_LOGGED so the admin UI is not
 * lied to.
 */
export function classifyDeliveryResult(
  adapterMode: EmailMode,
  sendResult: { status: string; providerMessageId?: string; failureReason?: string },
): Omit<InvitationDeliveryResult, "operatorAlert"> {
  const provider =
    adapterMode === "console" ? "console"
    : adapterMode === "smtp" ? "smtp"
    : adapterMode === "ses" ? "ses"
    : adapterMode === "microsoft365" ? "microsoft365"
    : null;

  // dev/console adapter always returns SENT + "dev-*" messageId.
  // Treat as DEV_LOGGED regardless of the returned status string —
  // a real send never has that prefix.
  const isDevLogged =
    adapterMode === "console" ||
    (typeof sendResult.providerMessageId === "string" &&
      sendResult.providerMessageId.startsWith("dev-"));

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
  // Everything else — FAILED (adapter returned a non-SENT status or
  // an explicit failureReason).
  return {
    status: "FAILED",
    provider,
    providerMessageId: sendResult.providerMessageId ?? null,
    failureReason: sendResult.failureReason ?? sendResult.status ?? "unknown",
    externalSendConfirmed: false,
  };
}

/**
 * Persist the delivery attempt on the invitation row. Idempotent —
 * subsequent attempts overwrite (a resend is a distinct
 * `hr.onboarding.invite.update` event whose delivery outcome we want
 * to reflect on the row).
 */
export async function persistInvitationDelivery(
  invitationId: string,
  result: Omit<InvitationDeliveryResult, "operatorAlert">,
): Promise<void> {
  await prisma.employeeOnboardingInvitation.update({
    where: { id: invitationId },
    data: {
      deliveryStatus: result.status,
      deliveryProvider: result.provider,
      deliveryProviderMessageId: result.providerMessageId,
      deliveryAttemptedAt: new Date(),
      // Truncate provider reason at a generous cap so a chatty SMTP
      // server does not blow up the column. Reasons are safe to
      // display but should be operationally short.
      deliveryFailureReason: result.failureReason ? result.failureReason.slice(0, 500) : null,
    },
  });
}

/**
 * Deliver the invitation email through Spectre's canonical email stack
 * and return a structured, safe-to-display result. The rawToken is
 * embedded ONLY in the URL inside the email body and is NEVER
 * returned to the caller, logged, or persisted after this call.
 *
 * The `operatorAlert` field is set to `true` for FAILED (real
 * provider rejected the send) and DEV_LOGGED in production/staging
 * (no real provider is configured — an operator must fix this) —
 * distinct from local dev where DEV_LOGGED is the expected shape.
 */
export async function sendInvitationEmail(
  args: SendInvitationArgs,
): Promise<InvitationDeliveryResult> {
  const [club, employee] = await Promise.all([
    prisma.club.findUnique({ where: { id: args.clubId }, select: { name: true } }),
    prisma.employee.findUnique({
      where: { id: args.employeeId },
      select: {
        firstName: true,
        lastName: true,
        preferredName: true,
        expectedStartDate: true,
        department: { select: { name: true } },
        position: { select: { name: true } },
      },
    }),
  ]);
  if (!club || !employee) {
    return {
      status: "NOT_ATTEMPTED",
      provider: null,
      providerMessageId: null,
      failureReason: "employee or club not found",
      externalSendConfirmed: false,
      operatorAlert: true,
    };
  }
  if (!args.toEmail) {
    return {
      status: "NOT_ATTEMPTED",
      provider: null,
      providerMessageId: null,
      failureReason: "no recipient email on file",
      externalSendConfirmed: false,
      operatorAlert: true,
    };
  }

  const composed = composeInvitationEmail({
    clubName: club.name,
    employeePreferredName: employee.preferredName,
    employeeFirstName: employee.firstName,
    employeeLastName: employee.lastName,
    departmentName: employee.department?.name ?? null,
    positionName: employee.position?.name ?? null,
    expectedStartDate: employee.expectedStartDate,
    redemptionUrl: `${args.publicHost.replace(/\/$/, "")}/hr/onboarding/${args.rawToken}`,
    expiresAt: args.expiresAt,
  });

  // Resolve the adapter + mode in parallel. `getEmailMode` mirrors
  // `selectEmailAdapter`'s resolution order.
  const [adapter, mode] = await Promise.all([
    selectEmailAdapter(args.clubId),
    getEmailMode(args.clubId),
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
    sendResult = {
      status: "FAILED",
      failureReason: err instanceof Error ? err.message : String(err),
    };
  }

  const classified = classifyDeliveryResult(mode, sendResult);
  const isProdLike = process.env.NODE_ENV === "production";
  const operatorAlert =
    classified.status === "FAILED" ||
    (classified.status === "DEV_LOGGED" && isProdLike) ||
    classified.status === "NOT_ATTEMPTED";
  const result: InvitationDeliveryResult = { ...classified, operatorAlert };

  // Persist attempt metadata (never blocks the caller on failure).
  try {
    await persistInvitationDelivery(args.invitationId, classified);
  } catch (err) {
    // eslint-disable-next-line no-console -- best-effort persistence; caller sees the result regardless
    console.warn("[hr-invitation] failed to persist delivery attempt", {
      invitationIdTail: args.invitationId.slice(-8),
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Structured operational log — never carries the raw token.
  const recipientDomain = args.toEmail.split("@")[1] ?? "unknown";
  // eslint-disable-next-line no-console -- operational log (safe fields only)
  console.log("[hr-invitation] delivery attempt", {
    invitationIdTail: args.invitationId.slice(-8),
    clubIdTail: args.clubId.slice(-8),
    recipientDomain,
    channel: "EMAIL",
    provider: result.provider,
    status: result.status,
    externalSendConfirmed: result.externalSendConfirmed,
    providerMessageIdTail: result.providerMessageId?.slice(-16) ?? null,
    failureReason: result.failureReason,
  });

  return result;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
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
