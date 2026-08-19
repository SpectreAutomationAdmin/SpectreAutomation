// Centralized, validated environment access.
// All process.env access should go through this module so we fail fast at
// boot when a required variable is missing or malformed, instead of throwing
// deep inside a request handler at 2am.

import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  // iron-session cookie password. Must be ≥ 32 chars for AES-256.
  SPECTRE_SESSION_SECRET: z
    .string()
    .min(32, "SPECTRE_SESSION_SECRET must be at least 32 characters"),
  SESSION_COOKIE_NAME: z.string().default("spectre_session"),
  // Trust X-Forwarded-For when behind a known proxy (load balancer / CDN).
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),

  // Phase 7 — integration env vars. All are OPTIONAL: a club without a given
  // integration configured falls back to the dev / mock adapter. Secrets should
  // come from the platform secret store (not committed). Per-club overrides in
  // the IntegrationSetting table take precedence over these defaults.
  SPECTRE_DEFAULT_EMAIL_PROVIDER: z.enum(["dev", "ses"]).optional(),
  SPECTRE_DEFAULT_SMS_PROVIDER: z.enum(["dev", "twilio"]).optional(),
  SPECTRE_DEFAULT_STORAGE_PROVIDER: z.enum(["memory", "local", "s3"]).optional(),
  SPECTRE_DEFAULT_LLM_PROVIDER: z.enum(["mock", "anthropic", "openai"]).optional(),

  // Phase 18 — email delivery mode. Drives selectEmailAdapter() when no
  // per-club IntegrationSetting(scope=EMAIL) row exists. Order of precedence:
  //   1. Per-club IntegrationSetting (provider="ses"|"smtp"|"microsoft365"|"dev")
  //   2. EMAIL_DELIVERY_MODE env var
  //   3. devEmailAdapter (console-log only)
  //
  // "console" is honest about what the dev adapter actually does: it does
  // NOT send mail. The success UI shows "Receipt generated in dev email log"
  // rather than claiming SENT. To verify a real email locally, point
  // EMAIL_DELIVERY_MODE=smtp at Mailhog/Maildev:
  //   SMTP_HOST=localhost SMTP_PORT=1025 SMTP_FROM=receipts@club.test
  EMAIL_DELIVERY_MODE: z.enum(["console", "smtp", "ses", "microsoft365"]).optional(),

  // SES defaults (used when no per-club override is configured).
  AWS_REGION: z.string().optional(),
  SES_FROM_ADDRESS: z.string().optional(),

  // SMTP defaults — used when EMAIL_DELIVERY_MODE=smtp or a per-club setting
  // selects the smtp provider. SMTP_SECURE=true forces TLS-on-connect (port
  // 465); leave unset for STARTTLS on 587 / plain SMTP on Mailhog.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : undefined))
    .refine((n) => n === undefined || (Number.isFinite(n) && n > 0 && n < 65536), {
      message: "SMTP_PORT must be a valid port number",
    }),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  SMTP_SECURE: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),

  // Microsoft 365 / Outlook email integration. Used when
  // EMAIL_DELIVERY_MODE=microsoft365 (env-driven default) OR when a
  // per-club IntegrationSetting picks provider="microsoft365" without
  // overriding individual fields. Auth uses the OAuth 2.0 client
  // credentials flow against the Microsoft identity platform; receipts
  // are sent via Microsoft Graph's POST /users/{from}/sendMail endpoint.
  // The from-mailbox is the *user-principal-name* (e.g.
  // receipts@silverspringsgolfclub.com) that the App Registration has
  // been authorized to send as.
  MICROSOFT_TENANT_ID: z.string().optional(),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_FROM_MAILBOX: z.string().optional(),

  // Sprint 2 — Outlook delegated integration (2026-07-19).
  //
  // These variables are OPTIONAL at boot so the app can build and
  // run without live Entra credentials during local development. The
  // MAILBOX_INTEGRATION_ENABLED flag gates every user-facing surface;
  // when it is false, every mailbox route no-ops and the feature is
  // invisible. Set the flag to true only when the redirect / webhook
  // pair below is reachable.
  MAILBOX_INTEGRATION_ENABLED: z.enum(["true", "false"]).default("false"),

  // Sprint 3 · Checkpoint 16H (2026-08-04) — three independent
  // feature gates for the Outlook capabilities. Deployed OFF; the
  // founder flips each to "true" separately as consent + verification
  // lands. Rollback: flip back to "false" without disconnecting
  // Outlook or removing consented permissions.
  OUTLOOK_CALENDAR_READ_ENABLED: z.enum(["true", "false"]).default("false"),
  OUTLOOK_REPLY_ENABLED: z.enum(["true", "false"]).default("false"),
  OUTLOOK_ARCHIVE_ON_COMPLETION_ENABLED: z.enum(["true", "false"]).default("false"),
  // Phase 4R rev-10 (2026-08-15) — Outlook mark-as-read on
  // Work Intake interaction. Defaults ON (only literal "false"
  // opts out) — see isEmailMarkReadOnInteractionEnabled().
  OUTLOOK_MARK_READ_ON_INTERACTION_ENABLED: z.enum(["true", "false"]).default("true"),

  // Canonical public base URL for THIS deployment — used to construct
  // OAuth callback + Graph webhook + Graph lifecycle URLs. Never
  // hardcoded anywhere in src/. Must be an absolute https URL in
  // staging/prod; http://localhost:3000 is the accepted dev value.
  APP_URL: z.string().url().default("http://localhost:3000"),
  // Mirrored to the client so client components can build absolute
  // URLs (e.g. share links) without a server round trip. Must equal
  // APP_URL. Enforced by a boot-time invariant below.
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),

  // Delegated-auth authority. For the founder-approved multi-tenant
  // organizational audience, use "organizations". Single-tenant
  // testing may use a specific tenant GUID. Never accept
  // "common" — that would admit personal Microsoft accounts, which
  // the founder explicitly excluded (§3 of the Phase B directive).
  MICROSOFT_GRAPH_AUTHORITY_HOST: z.string().url().default("https://login.microsoftonline.com"),
  MICROSOFT_GRAPH_AUTHORITY_AUDIENCE: z.enum(["organizations"]).default("organizations"),
  // The delegated-auth client id. May be the same as
  // MICROSOFT_CLIENT_ID if a single Entra app registration serves
  // both the existing Mail.Send client-credentials flow AND the new
  // delegated Mail.Read flow, but the founder-approved plan is to
  // register a NEW app for delegated auth so the two token paths
  // never share a secret. Optional at boot.
  MICROSOFT_GRAPH_DELEGATED_CLIENT_ID: z.string().optional(),
  MICROSOFT_GRAPH_DELEGATED_CLIENT_SECRET: z.string().optional(),
  // Callback URIs, constructed from APP_URL by default. Override only
  // when a reverse proxy is in the picture and the path differs.
  MICROSOFT_GRAPH_REDIRECT_URI: z.string().url().optional(),
  MICROSOFT_GRAPH_WEBHOOK_URL: z.string().url().optional(),
  MICROSOFT_GRAPH_LIFECYCLE_URL: z.string().url().optional(),

  // Attachment size cap enforced at Graph fetch time. Real value
  // lives in code (§12 of the Phase A brief); this env override is
  // for staging experiments only.
  MAILBOX_MAX_ATTACHMENT_MB: z.coerce.number().int().positive().default(25),
  // Twilio defaults.
  TWILIO_FROM_NUMBER: z.string().optional(),
  // S3 / R2 storage for mailbox attachments (Sprint 2 B4.1 / Step 6).
  //
  // Cloudflare R2 is S3-compatible; endpoint is
  // `https://<accountid>.r2.cloudflarestorage.com`. Credentials are
  // R2-scoped tokens deliberately named `R2_*` so they can NEVER be
  // confused with AWS-native credentials that the KMS provider uses
  // via the AWS SDK's default credential chain (`AWS_ACCESS_KEY_ID`
  // / `AWS_SECRET_ACCESS_KEY`). This separation is enforced by the
  // invariant below (`load()` throws if the two overlap).
  S3_BUCKET: z.string().optional(),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().optional(),                    // ignored by R2; kept for signature compat
  S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("true"),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),

  // AWS-native credentials for the KMS envelope provider. Read by
  // the AWS SDK's default credential chain — NEVER by the storage
  // adapter. The KMS provider is selected when SPECTRE_KMS_PROVIDER
  // = "aws"; otherwise the local-file envelope provider is used.
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_KMS_KEY_ID: z.string().optional(),
  SPECTRE_KMS_PROVIDER: z.enum(["local", "aws", "gcp"]).optional(),

  // Webhook signing secret for inbound POS integrations.
  POS_WEBHOOK_SIGNING_SECRET: z.string().optional(),

  // LLM defaults.
  ANTHROPIC_MODEL: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),

  // White-label custom-domain config.
  //
  // SPECTRE_PLATFORM_HOST is the hostname the Spectre platform itself runs on
  // (e.g. "app.spectre.cloud"). Requests on this host run in PLATFORM mode:
  // no club is pinned, SUPER_ADMIN-only pages are reachable. All other hosts
  // must match a `ClubDomain` row to receive traffic.
  //
  // Local dev: any host matching one of localhost / 127.0.0.1 / *.localtest.me
  // is treated as platform mode unless SPECTRE_LOCAL_PIN_CLUB_SLUG is set
  // (useful to simulate a club host in a tab without DNS plumbing).
  SPECTRE_PLATFORM_HOST: z.string().optional(),
  SPECTRE_LOCAL_PIN_CLUB_SLUG: z.string().optional(),

  // Sprint 2 Step 13A (2026-07-21) — CONTROLLED SYNC MODE.
  //
  // Master switch that gates three subordinate initial-sync controls
  // used to run a bounded, observable first mailbox synchronization
  // against a Spectre-owned staging mailbox. The master switch fails
  // closed outside staging/dev/test environments (see boot-time
  // invariant below). Subordinate variables are ignored (and rejected
  // at boot) when the master is off.
  //
  // Purpose: give operators the ability to run a small, first-of-its-
  // kind mailbox sync with tightly bounded blast radius, without ever
  // being able to accidentally cripple production mailbox behavior
  // by flipping a subordinate variable in isolation. Production
  // defaults (master unset) preserve every existing SYNC_SCOPE limit
  // and every existing handler side effect.
  MAILBOX_CONTROLLED_SYNC_MODE: z.enum(["true", "false"]).default("false"),
  // Positive integer, upper-bounded by SYNC_SCOPE.messageCap (500).
  // The effective cap used by the sync handler is Math.min(this,
  // SYNC_SCOPE.messageCap). Ignored (and rejected at boot) unless
  // MAILBOX_CONTROLLED_SYNC_MODE=true.
  MAILBOX_SYNC_MAX_MESSAGES_OVERRIDE: z.coerce.number().int().positive().max(500).optional(),
  MAILBOX_SYNC_SKIP_MATERIALIZATION: z.enum(["true", "false"]).default("false"),
  MAILBOX_SYNC_SKIP_ATTACHMENT_METADATA: z.enum(["true", "false"]).default("false"),
  // Sprint 2 Checkpoint 13C (2026-07-22) — DIAGNOSTIC-ONLY mode. When
  // true (and controlled mode is also on), the initial-sync handler
  // performs ONLY the token-refresh step and returns immediately —
  // no Graph mail-endpoint calls, no message ingestion, no page fetch.
  // Purpose: isolate the OAuth refresh path so operators can capture
  // the exact Microsoft response without side effects. Ignored (and
  // rejected at boot) unless MAILBOX_CONTROLLED_SYNC_MODE=true.
  MAILBOX_SYNC_DIAGNOSTIC_ONLY: z.enum(["true", "false"]).default("false"),
});

function load() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    // Fail loudly. We deliberately throw rather than console.error+exit so that
    // in serverless this is surfaced to the platform/logs.
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const env = load();
export type Env = typeof env;

// Sprint 2 B4.1 / Step 6 (2026-07-20) — R2 vs AWS credential separation.
// The founder-approved rule: the two providers MUST NOT share
// credential env-var names. This guard fires at boot if anyone ever
// aliases `AWS_ACCESS_KEY_ID` to the R2 value (or vice versa) —
// which would silently give the KMS client the wrong scoped token
// (or the R2 client the wrong scoped token) and produce a very
// confusing decrypt-vs-storage-fault failure.
if (
  env.R2_ACCESS_KEY_ID &&
  env.AWS_ACCESS_KEY_ID &&
  env.R2_ACCESS_KEY_ID === env.AWS_ACCESS_KEY_ID
) {
  throw new Error(
    "Invalid environment configuration: R2_ACCESS_KEY_ID and AWS_ACCESS_KEY_ID must be different values. R2 (Cloudflare) and AWS KMS use scope-separated credentials.",
  );
}
if (
  env.R2_SECRET_ACCESS_KEY &&
  env.AWS_SECRET_ACCESS_KEY &&
  env.R2_SECRET_ACCESS_KEY === env.AWS_SECRET_ACCESS_KEY
) {
  throw new Error(
    "Invalid environment configuration: R2_SECRET_ACCESS_KEY and AWS_SECRET_ACCESS_KEY must be different values.",
  );
}

// Sprint 2 (2026-07-19) — cross-field invariant. NEXT_PUBLIC_APP_URL
// is copied verbatim to client bundles; if it drifts from APP_URL,
// client-side redirects will hit the wrong host and the OAuth
// callback will fail state validation. Fail-fast at boot instead of
// discovering it in production.
if (env.NEXT_PUBLIC_APP_URL !== env.APP_URL) {
  throw new Error(
    `Invalid environment configuration: NEXT_PUBLIC_APP_URL (${env.NEXT_PUBLIC_APP_URL}) must equal APP_URL (${env.APP_URL})`,
  );
}

// Sprint 2 (2026-07-19) — Outlook integration is behind a hard boot
// flag per §Phase B directive. Every route + job + UI surface that
// touches mailbox tokens or Graph must call this predicate; a
// disabled deployment MUST have zero code paths that hit Graph.
export function isMailboxIntegrationEnabled(): boolean {
  return env.MAILBOX_INTEGRATION_ENABLED === "true";
}

// Sprint 3 · Checkpoint 16H (2026-08-04) — three independent Outlook
// capability gates. Rolled off by default so a deploy alone does not
// begin calling Graph write endpoints. Each MUST also require
// isMailboxIntegrationEnabled() at the caller — these three flags
// are additional gates, not replacements for the master switch.
export function isOutlookCalendarReadEnabled(): boolean {
  return isMailboxIntegrationEnabled() && env.OUTLOOK_CALENDAR_READ_ENABLED === "true";
}
export function isOutlookReplyEnabled(): boolean {
  return isMailboxIntegrationEnabled() && env.OUTLOOK_REPLY_ENABLED === "true";
}
export function isOutlookArchiveOnCompletionEnabled(): boolean {
  return isMailboxIntegrationEnabled() && env.OUTLOOK_ARCHIVE_ON_COMPLETION_ENABLED === "true";
}
// Phase 4R rev-10 (2026-08-15) — Outlook read propagation on
// first meaningful Work Intake card interaction. Enabled by
// default when the mailbox integration is enabled; the env
// variable exists as an emergency kill switch (set explicitly to
// "false" to opt out without a rollback). The gate composes with
// isMailboxIntegrationEnabled() so a global mailbox-off toggle
// also disables the write path.
export function isEmailMarkReadOnInteractionEnabled(): boolean {
  if (!isMailboxIntegrationEnabled()) return false;
  const raw = env.OUTLOOK_MARK_READ_ON_INTERACTION_ENABLED;
  // Default ON. Only the literal string "false" opts out.
  return raw !== "false";
}

// Sprint 2 Step 13A (2026-07-21) — controlled-sync-mode invariants.
//
// The master switch MAILBOX_CONTROLLED_SYNC_MODE gates three
// subordinate overrides. Rules enforced at boot:
//
//   1. Master OFF (or unset): all subordinate variables MUST be at
//      their defaults (or unset). If any subordinate is set to a
//      non-default value, boot fails. This prevents the case where
//      an operator flips e.g. MAILBOX_SYNC_SKIP_MATERIALIZATION=true
//      alone and silently disables Work Intake creation in prod.
//
//   2. Master ON: the environment MUST look staging/dev/test — the
//      APP_URL hostname must be localhost OR contain one of the
//      known non-prod tokens ("staging", "dev", "test"). Production
//      hosts (e.g. "app.spectreautomation.com") fail boot even if
//      an operator sets MAILBOX_CONTROLLED_SYNC_MODE=true directly.
//      This is a stronger discriminator than the Fly app name; it
//      derives from the Zod-validated env.APP_URL which is not
//      request-controlled.
//
// Boot failure is the correct posture: a subtly-wrong controlled
// mode should abort startup, not silently fall back to production
// behavior.
function isControlledSyncAllowedEnvironment(): boolean {
  try {
    const host = new URL(env.APP_URL).hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1") return true;
    return (
      host.includes("staging") ||
      host.includes("dev") ||
      host.includes("test") ||
      host.endsWith(".localtest.me")
    );
  } catch {
    return false;
  }
}

const controlledModeOn = env.MAILBOX_CONTROLLED_SYNC_MODE === "true";
const subordinateSetOutsideDefault =
  env.MAILBOX_SYNC_MAX_MESSAGES_OVERRIDE !== undefined ||
  env.MAILBOX_SYNC_SKIP_MATERIALIZATION === "true" ||
  env.MAILBOX_SYNC_SKIP_ATTACHMENT_METADATA === "true" ||
  env.MAILBOX_SYNC_DIAGNOSTIC_ONLY === "true";

if (controlledModeOn) {
  if (!isControlledSyncAllowedEnvironment()) {
    throw new Error(
      `Invalid environment configuration: MAILBOX_CONTROLLED_SYNC_MODE=true is only permitted when APP_URL hostname indicates a staging/dev/test environment (localhost, or a hostname containing "staging"/"dev"/"test"). Got APP_URL=${env.APP_URL}. This fails closed to protect production.`,
    );
  }
} else if (subordinateSetOutsideDefault) {
  throw new Error(
    "Invalid environment configuration: MAILBOX_SYNC_MAX_MESSAGES_OVERRIDE / MAILBOX_SYNC_SKIP_MATERIALIZATION / MAILBOX_SYNC_SKIP_ATTACHMENT_METADATA are only honored when MAILBOX_CONTROLLED_SYNC_MODE=true. Refusing to boot with a subordinate override set in isolation — set the master switch or remove the subordinate.",
  );
}

// Sprint 2 Step 13A — helpers for the sync handler. Kept in env.ts
// so the controlled-mode surface is one file's responsibility.
export function isControlledSyncModeActive(): boolean {
  return env.MAILBOX_CONTROLLED_SYNC_MODE === "true";
}

// Sprint 2 (2026-07-19) — canonical URL builders. Prefer these over
// interpolating env.APP_URL directly so the pattern is easy to grep
// and future env-var renames touch one place.
export function mailboxRedirectUri(): string {
  return env.MICROSOFT_GRAPH_REDIRECT_URI ?? `${env.APP_URL}/api/integrations/microsoft/callback`;
}
export function mailboxWebhookUrl(): string {
  return env.MICROSOFT_GRAPH_WEBHOOK_URL ?? `${env.APP_URL}/api/webhooks/microsoft/mail-notifications`;
}
export function mailboxLifecycleUrl(): string {
  return env.MICROSOFT_GRAPH_LIFECYCLE_URL ?? `${env.APP_URL}/api/webhooks/microsoft/lifecycle`;
}
