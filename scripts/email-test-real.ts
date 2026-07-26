// Real-SMTP delivery probe. Sends ONE test email through whatever SMTP
// relay the current EMAIL_DELIVERY_MODE / SMTP_* env vars point at, so
// an operator can verify a real provider (Postmark, SendGrid, SES,
// Gmail, etc.) is wired up correctly BEFORE running a POS settlement.
//
// Usage:
//
//   npm run email:test-real -- you@example.com
//   RECIPIENT=you@example.com npm run email:test-real
//
// What it does:
//   1. Loads .env.local + .env, validates EMAIL_DELIVERY_MODE=smtp.
//   2. Detects whether the configured SMTP_HOST is a local sink
//      (Maildev / Mailhog on localhost) or an external relay and prints
//      that distinction prominently — never silently let an operator
//      think a Maildev hit means real delivery happened.
//   3. Runs nodemailer's transporter.verify() to handshake with the
//      server before sending.
//   4. Sends a clearly-marked diagnostic email to the recipient.
//   5. Reports the provider's message id and exits 0 on success.
//
// Refuses to send if:
//   - EMAIL_DELIVERY_MODE isn't "smtp"
//   - SMTP_HOST / SMTP_PORT / SMTP_FROM are missing
//   - The recipient looks invalid

import "./lib/preload-env";

import { env } from "../src/lib/env";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "host.docker.internal"]);

function mask(email: string): string {
  const [n, h] = email.split("@");
  if (!h) return email;
  return `${n.slice(0, 1)}${"*".repeat(Math.max(2, n.length - 1))}@${h}`;
}

function classifyHost(host: string): "local" | "external" {
  return LOCAL_HOSTS.has(host.toLowerCase()) ? "local" : "external";
}

async function main() {
  const recipient = (process.argv[2] ?? process.env.RECIPIENT ?? "").trim();
  if (!recipient || !recipient.includes("@")) {
    // eslint-disable-next-line no-console
    console.error("Usage:  npm run email:test-real -- <recipient@example.com>");
    process.exit(2);
  }

  if (env.EMAIL_DELIVERY_MODE !== "smtp") {
    // eslint-disable-next-line no-console
    console.error(`EMAIL_DELIVERY_MODE=${env.EMAIL_DELIVERY_MODE ?? "(unset)"} — this script only runs in 'smtp' mode.`);
    process.exit(1);
  }
  if (!env.SMTP_HOST || !env.SMTP_PORT || !env.SMTP_FROM) {
    // eslint-disable-next-line no-console
    console.error("Missing SMTP_HOST / SMTP_PORT / SMTP_FROM — check .env.local.");
    process.exit(1);
  }

  const target = classifyHost(env.SMTP_HOST);
  // eslint-disable-next-line no-console
  console.log("\nSMTP test — real provider delivery");
  // eslint-disable-next-line no-console
  console.log("===================================");
  // eslint-disable-next-line no-console
  console.log(`Target:    ${target === "local" ? "LOCAL inbox (Maildev/Mailhog) — does NOT deliver to real mailboxes" : "EXTERNAL SMTP relay — will deliver to real mailbox"}`);
  // eslint-disable-next-line no-console
  console.log(`Host:      ${env.SMTP_HOST}:${env.SMTP_PORT}${env.SMTP_SECURE ? " (TLS)" : " (STARTTLS / plain)"}`);
  // eslint-disable-next-line no-console
  console.log(`Auth:      ${env.SMTP_USER ? "user/pass set" : "anonymous (no SMTP_USER set)"}`);
  // eslint-disable-next-line no-console
  console.log(`From:      ${env.SMTP_FROM}`);
  // eslint-disable-next-line no-console
  console.log(`To:        ${mask(recipient)}`);
  // eslint-disable-next-line no-console
  console.log("");

  const nm = await import("nodemailer");
  const transporter = nm.default.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: !!env.SMTP_SECURE,
    auth: env.SMTP_USER && env.SMTP_PASS ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });

  // 1. Handshake — many real providers reject bad credentials at this
  // point with a clear error message that's much more useful than
  // letting the send fail mid-transaction.
  try {
    await transporter.verify();
    // eslint-disable-next-line no-console
    console.log("[OK] SMTP handshake (transporter.verify()) succeeded.");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[FAIL] SMTP handshake failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // 2. Send.
  const subject = `Spectre real-SMTP test (${new Date().toISOString().slice(0, 16)})`;
  const banner = target === "local"
    ? "This email landed in your LOCAL Maildev/Mailhog inbox. Real external recipients did not receive it. Configure an external SMTP relay (Postmark / SendGrid / SES) to deliver for real."
    : "This email was sent through your configured external SMTP relay. If you received it in your real inbox, real receipt delivery is working.";

  try {
    const info = await transporter.sendMail({
      from: env.SMTP_FROM,
      to: recipient,
      subject,
      text: [
        banner,
        "",
        "Diagnostics:",
        `  SMTP host:     ${env.SMTP_HOST}:${env.SMTP_PORT}`,
        `  Target:        ${target === "local" ? "LOCAL Maildev/Mailhog" : "EXTERNAL relay"}`,
        `  From address:  ${env.SMTP_FROM}`,
        `  Sent at:       ${new Date().toISOString()}`,
        "",
        "— Spectre Automation",
      ].join("\n"),
    });
    // eslint-disable-next-line no-console
    console.log(`[OK] Provider accepted the message. messageId=${info.messageId}`);
    if (info.response) {
      // eslint-disable-next-line no-console
      console.log(`     response: ${info.response}`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[FAIL] Send failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // 3. Honest summary.
  // eslint-disable-next-line no-console
  console.log("");
  if (target === "local") {
    // eslint-disable-next-line no-console
    console.log(`View it at: http://${env.SMTP_HOST}:8025  (Maildev web inbox)`);
    // eslint-disable-next-line no-console
    console.log("NOTE: this was NOT real external delivery. Configure a real SMTP relay (see docs/email-testing.md) to verify real-inbox delivery.");
  } else {
    // eslint-disable-next-line no-console
    console.log(`Check ${mask(recipient)} for the diagnostic email.`);
    // eslint-disable-next-line no-console
    console.log("If it didn't arrive: check spam, sender-domain verification, and provider's send logs.");
  }
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Script crashed:", err);
  process.exit(2);
});
