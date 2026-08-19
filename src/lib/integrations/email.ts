// Phase 7B / 18 — Email delivery adapters.
//
// Three adapters:
//   - devEmailAdapter   — writes to console only (no network). Returns
//                         status="SENT" with messageId prefix "dev-" so the
//                         POS receipt path can downgrade to DEV_LOGGED.
//   - smtpEmailAdapter  — dynamically imports nodemailer to talk to ANY
//                         SMTP server (Mailhog, Maildev, Gmail, Postmark
//                         SMTP relay, etc.). Configured via env vars or
//                         per-club IntegrationSetting.
//   - sesEmailAdapter   — dynamically imports @aws-sdk/client-ses.
//
// selectEmailAdapter(clubId) resolves the active adapter in this order:
//   1. Per-club IntegrationSetting (provider="ses"|"smtp"|"dev")
//   2. EMAIL_DELIVERY_MODE env var
//   3. devEmailAdapter (console-only)

import type { NotificationDeliveryAdapter } from "../enterprise/notifications";
import { env } from "../env";
import { getActiveIntegration, readConfig, readSecrets } from "./config";

// Modes a caller can ask about so it can shape UI/audit copy honestly. The
// dev adapter is "console" — receipts get DEV_LOGGED rather than SENT.
//
// HR-2B.3 tail (2026-08-18) — "microsoft365_delegated" is the NEW
// Priority-1 mode: the Club's explicitly-designated Work Intake
// MailboxConnection sends via `POST /me/sendMail`. It is DISTINCT
// from "microsoft365" (client-credentials app-only), which remains
// available at Priority 2 via per-Club IntegrationSetting.
export type EmailMode = "console" | "smtp" | "ses" | "microsoft365" | "microsoft365_delegated";

export const devEmailAdapter: NotificationDeliveryAdapter = {
  async send({ channel, to, subject, body }) {
    if (channel !== "EMAIL") return { status: "FAILED", failureReason: "wrong channel" };
    // Phase 14D — even in dev, suppressed addresses fail loudly so test data
    // mirrors production behaviour.
    if (to.email) {
      const { isSuppressed } = await import("../email-delivery");
      const sup = await isSuppressed(to.email);
      if (sup.suppressed) return { status: "FAILED", failureReason: `suppressed: ${sup.reason}` };
    }
    // eslint-disable-next-line no-console
    console.log(`[dev:email] → ${to.email ?? to.userId ?? to.memberId} | ${subject}`);
    void body;
    // Prefix "dev-" lets receipts.ts detect a console-mode send and
    // surface DEV_LOGGED so the UI doesn't lie about delivery.
    return { status: "SENT", providerMessageId: `dev-${Date.now()}` };
  },
};

// SMTP adapter — uses nodemailer (optional dep). When nodemailer is not
// installed OR required config is missing, the adapter returns FAILED with
// a descriptive reason so the operator can see exactly what to fix.
export async function smtpEmailAdapter(args: {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  fromAddress: string;
  secure?: boolean;
}): Promise<NotificationDeliveryAdapter> {
  const { optionalImport } = await import("./optional-import");
  const mod = await optionalImport("nodemailer");
  // Dynamic ESM import returns { default, ...named }. CJS may return the
  // module itself. Accept either.
  const nm = mod?.createTransport ? mod : mod?.default;
  if (!nm) {
    return {
      async send() {
        return { status: "FAILED", failureReason: "nodemailer not installed (run: npm install nodemailer)" };
      },
    };
  }
  const transporter = nm.createTransport({
    host: args.host,
    port: args.port,
    secure: !!args.secure,
    auth: args.user && args.pass ? { user: args.user, pass: args.pass } : undefined,
  });
  return {
    async send({ channel, to, subject, body }) {
      if (channel !== "EMAIL") return { status: "FAILED", failureReason: "wrong channel" };
      if (!to.email) return { status: "FAILED", failureReason: "no recipient email" };
      const { isSuppressed } = await import("../email-delivery");
      const sup = await isSuppressed(to.email);
      if (sup.suppressed) return { status: "FAILED", failureReason: `suppressed: ${sup.reason}` };
      try {
        const info = await transporter.sendMail({
          from: args.fromAddress,
          to: to.email,
          subject,
          text: body,
          html: bodyToHtml(body),
        });
        return { status: "SENT", providerMessageId: info.messageId };
      } catch (err) {
        return { status: "FAILED", failureReason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

// SES adapter built on dynamic import. We avoid a hard dependency so a club
// without SES does not need the SDK installed.
export async function sesEmailAdapter(args: { region: string; fromAddress: string; accessKeyId: string; secretAccessKey: string; }): Promise<NotificationDeliveryAdapter> {
  const { optionalImport } = await import("./optional-import");
  const SESModule = await optionalImport("@aws-sdk/client-ses");
  if (!SESModule) {
    return {
      async send() { return { status: "FAILED", failureReason: "@aws-sdk/client-ses not installed" }; },
    };
  }
  const { SESClient, SendEmailCommand } = SESModule;
  const client = new SESClient({
    region: args.region,
    credentials: { accessKeyId: args.accessKeyId, secretAccessKey: args.secretAccessKey },
  });
  return {
    async send({ channel, to, subject, body }) {
      if (channel !== "EMAIL") return { status: "FAILED", failureReason: "wrong channel" };
      if (!to.email) return { status: "FAILED", failureReason: "no recipient email" };
      // Phase 14D — suppression check before handing to provider.
      const { isSuppressed } = await import("../email-delivery");
      const sup = await isSuppressed(to.email);
      if (sup.suppressed) return { status: "FAILED", failureReason: `suppressed: ${sup.reason}` };
      try {
        const command = new SendEmailCommand({
          Source: args.fromAddress,
          Destination: { ToAddresses: [to.email] },
          Message: {
            Subject: { Charset: "UTF-8", Data: subject },
            Body: {
              Text: { Charset: "UTF-8", Data: body },
              Html: { Charset: "UTF-8", Data: bodyToHtml(body) },
            },
          },
        });
        const result = await client.send(command);
        return { status: "SENT", providerMessageId: result.MessageId };
      } catch (err) {
        return { status: "FAILED", failureReason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

function bodyToHtml(plain: string): string {
  const escaped = plain.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html><html><body style="font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; color: #111; line-height: 1.5"><pre style="font-family: inherit; white-space: pre-wrap; margin: 0">${escaped}</pre></body></html>`;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------
// A seeded "dev" placeholder is treated as "no real provider chosen
// yet" so the env-driven mode (set by the operator running the
// process) can take effect. Without this, every freshly-seeded club
// would silently pin itself to console mode even after EMAIL_DELIVERY_MODE
// is configured.
function settingIsPlaceholder(setting: { provider: string }): boolean {
  return setting.provider === "dev" || setting.provider === "local";
}

// Returns the mode the club's email is delivered through right now, so
// callers (POS receipts UI, history page) can describe delivery honestly.
// Mirrors selectEmailAdapter's resolution order — Priority 1 (Work
// Intake delegated) → Priority 2 (per-Club IntegrationSetting) →
// Priority 3 (env) → Priority 4 (console).
export async function getEmailMode(clubId: string): Promise<EmailMode> {
  // Priority 1 — Club-designated Work Intake mailbox with Mail.Send.
  const { resolveDesignatedOutboundMailbox } = await import("./email-via-mailbox-connection");
  const designated = await resolveDesignatedOutboundMailbox(clubId);
  if (designated) return "microsoft365_delegated";

  const setting = await getActiveIntegration(clubId, "EMAIL");
  if (setting && !settingIsPlaceholder(setting)) {
    if (setting.provider === "ses") return "ses";
    if (setting.provider === "smtp") return "smtp";
    if (setting.provider === "microsoft365") return "microsoft365";
    return "console";
  }
  if (env.EMAIL_DELIVERY_MODE === "ses") return "ses";
  if (env.EMAIL_DELIVERY_MODE === "smtp") return "smtp";
  if (env.EMAIL_DELIVERY_MODE === "microsoft365") return "microsoft365";
  return "console";
}

// Richer descriptor for the admin/history banner: also reveals whether
// the SMTP target is a local sink (Maildev / Mailhog on localhost) or
// an external relay. Operators need to know which one is active — a
// "SMTP" badge alone is misleading when running Maildev.
export type EmailDeliveryDescriptor = {
  mode: EmailMode;
  source: "club-override" | "env" | "default" | "designated-mailbox";
  // Only set when mode === "smtp".
  smtpHost?: string;
  smtpPort?: number;
  smtpTarget?: "local" | "external";
  // Only set when mode === "microsoft365". Never includes the client
  // secret — admin UIs read these for display, and we don't want a
  // tenant secret leaking into the server-rendered HTML.
  microsoftTenantId?: string;
  microsoftFromMailbox?: string;
  // HR-2B.3 tail (2026-08-18) — only set when mode === "microsoft365_delegated".
  // Populated from the designated MailboxConnection so the Club-side
  // People UI can render "Invitation will be sent from <email>"
  // before the operator clicks Invite. Never exposes tokens or scopes.
  designatedMailboxConnectionId?: string;
  designatedConnectedEmail?: string;
};

const LOCAL_SMTP_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "host.docker.internal"]);

function classifySmtpHost(host: string): "local" | "external" {
  return LOCAL_SMTP_HOSTS.has(host.toLowerCase()) ? "local" : "external";
}

export async function getEmailDeliveryDescriptor(clubId: string): Promise<EmailDeliveryDescriptor> {
  // Priority 1 — Club-designated Work Intake mailbox.
  const { resolveDesignatedOutboundMailbox } = await import("./email-via-mailbox-connection");
  const designated = await resolveDesignatedOutboundMailbox(clubId);
  if (designated) {
    return {
      mode: "microsoft365_delegated",
      source: "designated-mailbox",
      designatedMailboxConnectionId: designated.mailboxConnectionId,
      designatedConnectedEmail: designated.connectedEmail,
      microsoftTenantId: designated.microsoftTenantId,
    };
  }
  const setting = await getActiveIntegration(clubId, "EMAIL");
  if (setting && !settingIsPlaceholder(setting)) {
    if (setting.provider === "ses") {
      return { mode: "ses", source: "club-override" };
    }
    if (setting.provider === "smtp") {
      const cfg = readConfig<{ host?: string; port?: number }>(setting);
      return {
        mode: "smtp",
        source: "club-override",
        smtpHost: cfg.host,
        smtpPort: cfg.port,
        smtpTarget: cfg.host ? classifySmtpHost(cfg.host) : undefined,
      };
    }
    if (setting.provider === "microsoft365") {
      const cfg = readConfig<{ tenantId?: string; clientId?: string; fromMailbox?: string }>(setting);
      return {
        mode: "microsoft365",
        source: "club-override",
        microsoftTenantId: cfg.tenantId,
        microsoftFromMailbox: cfg.fromMailbox,
      };
    }
    return { mode: "console", source: "club-override" };
  }
  if (env.EMAIL_DELIVERY_MODE === "ses") {
    return { mode: "ses", source: "env" };
  }
  if (env.EMAIL_DELIVERY_MODE === "smtp") {
    return {
      mode: "smtp",
      source: "env",
      smtpHost: env.SMTP_HOST,
      smtpPort: env.SMTP_PORT,
      smtpTarget: env.SMTP_HOST ? classifySmtpHost(env.SMTP_HOST) : undefined,
    };
  }
  if (env.EMAIL_DELIVERY_MODE === "microsoft365") {
    return {
      mode: "microsoft365",
      source: "env",
      microsoftTenantId: env.MICROSOFT_TENANT_ID,
      microsoftFromMailbox: env.MICROSOFT_FROM_MAILBOX,
    };
  }
  return { mode: "console", source: "default" };
}

// HR-2B.3 tail (2026-08-18) — extended arguments for the invitation
// route to pass the acting user id through to the delegated adapter's
// token-refresh path. Backwards-compatible: callers that pass only
// clubId (the historical shape) get null callerUserId.
export interface SelectEmailAdapterArgs {
  clubId: string;
  callerUserId?: string | null;
}

export async function selectEmailAdapter(
  clubIdOrArgs: string | SelectEmailAdapterArgs,
): Promise<NotificationDeliveryAdapter> {
  const clubId = typeof clubIdOrArgs === "string" ? clubIdOrArgs : clubIdOrArgs.clubId;
  const callerUserId = typeof clubIdOrArgs === "string" ? null : (clubIdOrArgs.callerUserId ?? null);

  // Priority 1 — Club-designated Work Intake mailbox with Mail.Send.
  // If the designated mailbox exists AND meets every eligibility
  // check, use it. If ANY check fails, we fall THROUGH to Priority 2
  // per the founder brief §3 — "do not silently choose some other
  // connected mailbox." resolveDesignatedOutboundMailbox already
  // encodes that ruleset and returns null on any failure.
  const {
    mailboxConnectionEmailAdapter,
    resolveDesignatedOutboundMailbox,
  } = await import("./email-via-mailbox-connection");
  const designated = await resolveDesignatedOutboundMailbox(clubId);
  if (designated) {
    return mailboxConnectionEmailAdapter({
      mailboxConnectionId: designated.mailboxConnectionId,
      callerClubId: clubId,
      callerUserId,
    });
  }

  const setting = await getActiveIntegration(clubId, "EMAIL");
  if (setting && !settingIsPlaceholder(setting)) {
    const config = readConfig<{
      region?: string; fromAddress?: string;
      host?: string; port?: number; user?: string; secure?: boolean;
    }>(setting);
    const secrets = readSecrets<{
      accessKeyId?: string; secretAccessKey?: string; pass?: string;
    }>(setting);
    if (setting.provider === "ses") {
      if (!config.region || !config.fromAddress || !secrets.accessKeyId || !secrets.secretAccessKey) {
        return devEmailAdapter;
      }
      return sesEmailAdapter({
        region: config.region, fromAddress: config.fromAddress,
        accessKeyId: secrets.accessKeyId, secretAccessKey: secrets.secretAccessKey,
      });
    }
    if (setting.provider === "smtp") {
      if (!config.host || !config.port || !config.fromAddress) return devEmailAdapter;
      return smtpEmailAdapter({
        host: config.host, port: config.port,
        user: config.user, pass: secrets.pass,
        fromAddress: config.fromAddress, secure: config.secure,
      });
    }
    if (setting.provider === "microsoft365") {
      const msConfig = readConfig<{ tenantId?: string; clientId?: string; fromMailbox?: string }>(setting);
      const msSecrets = readSecrets<{ clientSecret?: string }>(setting);
      const { microsoftGraphEmailAdapter } = await import("./microsoft-graph");
      return microsoftGraphEmailAdapter({
        tenantId: msConfig.tenantId ?? "",
        clientId: msConfig.clientId ?? "",
        clientSecret: msSecrets.clientSecret ?? "",
        fromMailbox: msConfig.fromMailbox ?? "",
      });
    }
    // Unknown provider — refuse to send. (dev/local already short-circuited
    // via settingIsPlaceholder.)
    return {
      async send() { return { status: "FAILED", failureReason: `Unknown EMAIL provider: ${setting.provider}` }; },
    };
  }

  // No per-club override — fall back to env-driven mode.
  if (env.EMAIL_DELIVERY_MODE === "smtp") {
    if (!env.SMTP_HOST || !env.SMTP_PORT || !env.SMTP_FROM) {
      // Misconfigured: explicit failure beats silent fallback.
      return {
        async send() {
          return { status: "FAILED", failureReason: "EMAIL_DELIVERY_MODE=smtp but SMTP_HOST/SMTP_PORT/SMTP_FROM not set" };
        },
      };
    }
    return smtpEmailAdapter({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
      fromAddress: env.SMTP_FROM,
      secure: env.SMTP_SECURE,
    });
  }
  if (env.EMAIL_DELIVERY_MODE === "microsoft365") {
    if (!env.MICROSOFT_TENANT_ID || !env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET || !env.MICROSOFT_FROM_MAILBOX) {
      return {
        async send() {
          return {
            status: "FAILED",
            failureReason:
              "EMAIL_DELIVERY_MODE=microsoft365 but MICROSOFT_TENANT_ID / MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET / MICROSOFT_FROM_MAILBOX not all set",
          };
        },
      };
    }
    const { microsoftGraphEmailAdapter } = await import("./microsoft-graph");
    return microsoftGraphEmailAdapter({
      tenantId: env.MICROSOFT_TENANT_ID,
      clientId: env.MICROSOFT_CLIENT_ID,
      clientSecret: env.MICROSOFT_CLIENT_SECRET,
      fromMailbox: env.MICROSOFT_FROM_MAILBOX,
    });
  }
  if (env.EMAIL_DELIVERY_MODE === "ses") {
    if (!env.AWS_REGION || !env.SES_FROM_ADDRESS) {
      return {
        async send() {
          return { status: "FAILED", failureReason: "EMAIL_DELIVERY_MODE=ses but AWS_REGION/SES_FROM_ADDRESS not set" };
        },
      };
    }
    // SES needs credentials too; we don't accept them as env in the schema
    // today — the per-club secret store is the supported source. Returning
    // a clear error is better than silently logging to console.
    return {
      async send() {
        return { status: "FAILED", failureReason: "SES requires per-club IntegrationSetting with accessKeyId/secretAccessKey secrets" };
      },
    };
  }
  return devEmailAdapter;
}
