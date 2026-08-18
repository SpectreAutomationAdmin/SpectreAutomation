// HR-2B.1 (2026-08-18) — Invitation email delivery.
//
// Replaces the HR-2A stderr log with a real branded email delivered
// through Spectre's canonical multi-provider email stack
// (`selectEmailAdapter(clubId)` — console/SMTP/SES/MS365 per Club).
// No parallel mail stack is introduced.
//
// The raw magic-link token is NEVER stored, logged, or persisted —
// it only lives inside the outbound email body's single-use URL.

import { selectEmailAdapter } from "../integrations/email";
import { prisma } from "../prisma";

interface SendInvitationArgs {
  clubId: string;
  employeeId: string;
  toEmail: string;
  rawToken: string;
  expiresAt: Date;
  publicHost: string; // e.g. "https://staging.spectreautomation.com" or the Club domain
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

  // Simple, restrained inline HTML — mirrors the private-club editorial
  // voice of the rest of the product. No aggressive branding, no
  // marketing chrome. Club identity is prominent; Spectre is not.
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

/**
 * Deliver the invitation email through Spectre's canonical email stack.
 * The rawToken is embedded ONLY in the URL inside the email body and is
 * NEVER returned to the caller, logged, or persisted after this call.
 */
export async function sendInvitationEmail(args: SendInvitationArgs): Promise<void> {
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
  if (!club || !employee) return; // silent — caller sees the response, email is best-effort

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

  const adapter = await selectEmailAdapter(args.clubId);
  await adapter.send({
    clubId: args.clubId,
    channel: "EMAIL",
    to: { email: args.toEmail },
    subject: composed.subject,
    body: composed.html,
  });
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
