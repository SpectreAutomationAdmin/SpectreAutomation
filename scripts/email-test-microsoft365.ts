// Microsoft 365 / Graph delivery probe. Acquires a token via the real
// Microsoft identity platform and sends ONE test email through the
// configured club mailbox, so an operator can verify the App
// Registration + Application Access Policy are wired up correctly
// BEFORE running a POS settlement.
//
// Usage:
//
//   npm run email:test-microsoft365 -- you@example.com
//   RECIPIENT=you@example.com npm run email:test-microsoft365
//
// Refuses to send when:
//   - EMAIL_DELIVERY_MODE isn't "microsoft365"
//   - Any required Microsoft env var is missing
//   - The recipient looks invalid
//
// Never logs the client secret.

import "./lib/preload-env";

import { env } from "../src/lib/env";
import { microsoftGraphEmailAdapter } from "../src/lib/integrations/microsoft-graph";

function mask(email: string): string {
  const [n, h] = email.split("@");
  if (!h) return email;
  return `${n.slice(0, 1)}${"*".repeat(Math.max(2, n.length - 1))}@${h}`;
}
function maskId(id: string): string {
  if (id.length <= 8) return "****";
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

async function main() {
  const recipient = (process.argv[2] ?? process.env.RECIPIENT ?? "").trim();
  if (!recipient || !recipient.includes("@")) {
    // eslint-disable-next-line no-console
    console.error("Usage:  npm run email:test-microsoft365 -- <recipient@example.com>");
    process.exit(2);
  }

  if (env.EMAIL_DELIVERY_MODE !== "microsoft365") {
    // eslint-disable-next-line no-console
    console.error(`EMAIL_DELIVERY_MODE=${env.EMAIL_DELIVERY_MODE ?? "(unset)"} — this script only runs in 'microsoft365' mode.`);
    process.exit(1);
  }

  const missing = (
    ["MICROSOFT_TENANT_ID", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "MICROSOFT_FROM_MAILBOX"] as const
  ).filter((k) => !env[k]);
  if (missing.length) {
    // eslint-disable-next-line no-console
    console.error(`Missing env vars: ${missing.join(", ")} — check .env.local.`);
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log("\nMicrosoft 365 / Graph test");
  // eslint-disable-next-line no-console
  console.log("==========================");
  // eslint-disable-next-line no-console
  console.log(`Provider:      Microsoft Graph (POST /users/${env.MICROSOFT_FROM_MAILBOX}/sendMail)`);
  // eslint-disable-next-line no-console
  console.log(`Tenant ID:     ${maskId(env.MICROSOFT_TENANT_ID!)}`);
  // eslint-disable-next-line no-console
  console.log(`Client ID:     ${maskId(env.MICROSOFT_CLIENT_ID!)}`);
  // eslint-disable-next-line no-console
  console.log(`From mailbox:  ${env.MICROSOFT_FROM_MAILBOX}`);
  // eslint-disable-next-line no-console
  console.log(`To:            ${mask(recipient)}`);
  // eslint-disable-next-line no-console
  console.log("");

  const adapter = microsoftGraphEmailAdapter({
    tenantId: env.MICROSOFT_TENANT_ID!,
    clientId: env.MICROSOFT_CLIENT_ID!,
    clientSecret: env.MICROSOFT_CLIENT_SECRET!,
    fromMailbox: env.MICROSOFT_FROM_MAILBOX!,
  });

  const subject = `Spectre Microsoft 365 test (${new Date().toISOString().slice(0, 16)})`;
  const body = [
    `This is a diagnostic email sent via Microsoft Graph from ${env.MICROSOFT_FROM_MAILBOX}.`,
    ``,
    `If you received it in your real inbox, the App Registration's Mail.Send`,
    `permission is granted, admin consent is in place, and the mailbox is`,
    `licensed and reachable.`,
    ``,
    `Sent at: ${new Date().toISOString()}`,
  ].join("\n");

  const result = await adapter.send({
    clubId: "diagnostic",
    channel: "EMAIL",
    to: { email: recipient },
    subject,
    body,
  });

  if (result.status === "SENT") {
    // eslint-disable-next-line no-console
    console.log(`[OK] Microsoft Graph accepted the message.`);
    if (result.providerMessageId) {
      // eslint-disable-next-line no-console
      console.log(`     request-id: ${result.providerMessageId}`);
    }
    // eslint-disable-next-line no-console
    console.log(`     Check ${mask(recipient)} for the diagnostic email.`);
    // eslint-disable-next-line no-console
    console.log(`     If it doesn't arrive: check the recipient's spam folder, then`);
    // eslint-disable-next-line no-console
    console.log(`     the sender mailbox's Outlook outbox / message trace in Exchange admin center.`);
    process.exit(0);
  }
  // eslint-disable-next-line no-console
  console.error(`[FAIL] ${result.failureReason ?? "Unknown error"}`);
  // eslint-disable-next-line no-console
  console.error(`See docs/email-microsoft365.md → "Common errors" for diagnoses.`);
  process.exit(1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Script crashed:", err);
  process.exit(2);
});
