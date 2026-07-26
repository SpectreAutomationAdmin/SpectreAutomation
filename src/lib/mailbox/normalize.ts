// Sprint 2 B4 (2026-07-19) — Email evidence normalizer.
//
// Translates one `RawGraphMessage` into the shape our
// `EmailMessage` row expects. HTML is sanitised through
// `sanitizeEmailHtml`. Missing sender / subject / preview are filled
// with safe placeholder text.

import type { RawGraphMessage, RawGraphMessageAddress } from "@/lib/integrations/microsoft-graph-delegated";
import { sanitizeEmailHtml, htmlToText } from "./sanitize";
import { SYNC_SCOPE } from "./sync-scope";

export interface NormalizedEmail {
  graphMessageId: string;
  immutableId: string | null;
  internetMessageId: string | null;
  conversationId: string | null;
  senderAddress: string;
  senderName: string;
  recipients: { to: string[]; cc: string[]; bcc: string[] };
  subject: string;
  receivedAt: Date;
  sentAt: Date | null;
  preview: string;
  bodyHtmlSanitized: string | null;
  bodyTextExtract: string | null;
  importance: "low" | "normal" | "high";
  isRead: boolean;
  hasAttachments: boolean;
  webLink: string | null;
  isRemoved: boolean;
  headers: Record<string, string>;
}

export function normalizeGraphMessage(raw: RawGraphMessage): NormalizedEmail {
  const sender = raw.from?.emailAddress ?? raw.sender?.emailAddress ?? null;
  const senderAddress = normaliseAddress(sender);
  const senderName = normaliseName(sender);
  const subject = truncate(sanitizeSingleLine(raw.subject ?? ""), 500) || "(no subject)";
  const preview = truncate(sanitizeSingleLine(raw.bodyPreview ?? ""), SYNC_SCOPE.previewCap);
  const bodyContentType = raw.body?.contentType ?? "text";
  const rawBody = raw.body?.content ?? "";
  const bodyHtmlSanitized = bodyContentType === "html"
    ? sanitizeEmailHtml(rawBody, { maxBytes: SYNC_SCOPE.maxBodyBytes })
    : null;
  const bodyTextExtract = bodyContentType === "html"
    ? htmlToText(rawBody, { maxBytes: 8000 })
    : truncateBytes(rawBody, 8000);

  const headers: Record<string, string> = {};
  for (const h of raw.internetMessageHeaders ?? []) {
    headers[h.name.toLowerCase()] = h.value;
  }

  return {
    graphMessageId: raw.id,
    immutableId: raw.immutableId ?? null,
    internetMessageId: raw.internetMessageId ?? null,
    conversationId: raw.conversationId ?? null,
    senderAddress,
    senderName,
    recipients: {
      to: (raw.toRecipients ?? []).map((r) => normaliseAddress(r.emailAddress)).filter(Boolean),
      cc: (raw.ccRecipients ?? []).map((r) => normaliseAddress(r.emailAddress)).filter(Boolean),
      bcc: (raw.bccRecipients ?? []).map((r) => normaliseAddress(r.emailAddress)).filter(Boolean),
    },
    subject,
    receivedAt: new Date(raw.receivedDateTime),
    sentAt: raw.sentDateTime ? new Date(raw.sentDateTime) : null,
    preview,
    bodyHtmlSanitized,
    bodyTextExtract,
    importance: (raw.importance ?? "normal") as "low" | "normal" | "high",
    isRead: raw.isRead ?? false,
    hasAttachments: raw.hasAttachments ?? false,
    webLink: raw.webLink ?? null,
    isRemoved: !!raw.removed,
    headers,
  };
}

function normaliseAddress(a: RawGraphMessageAddress | null | undefined): string {
  const raw = (a?.address ?? "").trim().toLowerCase();
  if (!raw) return "";
  // Guard against comma-injected fake addresses.
  return raw.split(",")[0].trim();
}

function normaliseName(a: RawGraphMessageAddress | null | undefined): string {
  const n = (a?.name ?? "").trim();
  return n || (a?.address ?? "").trim() || "Unknown sender";
}

function sanitizeSingleLine(s: string): string {
  return s.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}
function truncate(s: string, cap: number): string {
  return s.length > cap ? s.slice(0, cap) + "…" : s;
}
function truncateBytes(s: string, cap: number): string {
  return Buffer.byteLength(s, "utf8") > cap ? s.slice(0, cap) + "…" : s;
}

/**
 * Return the immutable, stable identity for a Graph message. In
 * order of preference: immutableId (opt-in via Prefer header) →
 * internetMessageId (RFC5322) → graph id. Used as the natural key
 * for EmailMessage upserts.
 */
export function stableIdentityForEmail(norm: NormalizedEmail): string {
  return norm.immutableId || norm.internetMessageId || norm.graphMessageId;
}
