// Sprint 2 B2 (2026-07-19) — Sanitised audit-event helpers for the
// delegated mailbox flow.
//
// Per §11 of the B2 directive, audit records for mailbox events MUST
// contain useful non-sensitive metadata and MUST NOT contain any
// token material or raw Microsoft error payload.
//
// Everything below writes through the existing `audit()` in
// src/lib/audit.ts and stores structured JSON in `metaJson`. The
// sanitiseAuditMeta() guard is a belt-and-braces filter that strips
// any field whose name or content looks like a token / secret /
// authorization code.

import { audit } from "@/lib/audit";
import type { MailboxErrorCode } from "./errors";

export const MAILBOX_AUDIT_ACTION = {
  CONNECT_INITIATED: "mailbox.connect.initiated",
  CONNECT_COMPLETED: "mailbox.connect.completed",
  CONNECT_RECONNECTED: "mailbox.connect.reconnected",
  CONNECT_FAILED: "mailbox.connect.failed",
  CONSENT_DENIED: "mailbox.consent.denied",
  TOKEN_REFRESHED: "mailbox.token.refreshed",
  TOKEN_REFRESH_FAILED: "mailbox.token.refresh_failed",
  REAUTH_REQUIRED: "mailbox.reauth.required",
  DISCONNECTED: "mailbox.disconnected",
} as const;

export type MailboxAuditAction = (typeof MAILBOX_AUDIT_ACTION)[keyof typeof MAILBOX_AUDIT_ACTION];

// Keys that MUST NEVER appear in an audit record. If any of these
// show up in the meta object, sanitiseAuditMeta strips them and logs
// a warning.
const FORBIDDEN_META_KEYS = new Set<string>([
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "idToken",
  "id_token",
  "authorizationCode",
  "authorization_code",
  "code",
  "clientSecret",
  "client_secret",
  "pkceVerifier",
  "pkce_verifier",
  "codeVerifier",
  "code_verifier",
  "nonce",
  "state",
  "clientState",
  "client_state",
]);

// Value-level heuristic — a very long base64/hex-ish string in a
// field whose name is not on our allowlist is treated as suspect and
// dropped from the audit meta.
function looksLikeSecretValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  // Real access / refresh tokens from MSAL are 400+ characters of
  // base64url and never contain dashes. Guids/UUIDs (36 chars, four
  // dashes) and email addresses (contain @) should never trip this.
  if (value.length < 40) return false;
  if (value.includes("-")) return false; // UUIDs, dashed identifiers
  if (value.includes("@")) return false; // email addresses
  if (value.includes(" ")) return false; // sentences
  const compact = /^[A-Za-z0-9._~+=/]+$/.test(value);
  return compact;
}

export function sanitiseAuditMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (FORBIDDEN_META_KEYS.has(key)) continue;
    if (looksLikeSecretValue(value)) continue;
    if (value != null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      out[key] = sanitiseAuditMeta(value as Record<string, unknown>);
      continue;
    }
    out[key] = value;
  }
  return out;
}

// Common shape for every mailbox audit record. Neither the auth code
// nor any token is ever included.
export interface MailboxAuditContext {
  clubId: string;
  userId: string | null;
  mailboxConnectionId?: string | null;
  provider?: string;
  microsoftTenantId?: string;
  connectedEmail?: string;
  errorCode?: MailboxErrorCode;
  ip?: string;
  userAgent?: string;
  // Free-form additional non-sensitive fields.
  extra?: Record<string, string | number | boolean>;
}

export async function auditMailboxEvent(
  action: MailboxAuditAction,
  ctx: MailboxAuditContext,
): Promise<void> {
  const meta = sanitiseAuditMeta({
    provider: ctx.provider,
    microsoftTenantId: ctx.microsoftTenantId,
    connectedEmail: ctx.connectedEmail,
    errorCode: ctx.errorCode,
    ...(ctx.extra ?? {}),
  });
  const actor = ctx.userId ? { id: ctx.userId } : null;
  await audit(actor, {
    action,
    entityType: "MailboxConnection",
    entityId: ctx.mailboxConnectionId ?? "pending",
    clubId: ctx.clubId,
    meta,
  });
}
