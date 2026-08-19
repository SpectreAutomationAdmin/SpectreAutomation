// HR-2B.3 tail (2026-08-18) — Delegated Microsoft 365 outbound
// email adapter. Consumes the existing Work Intake OAuth/token
// architecture (`microsoft-graph-delegated.ts` + `mailbox/connect.ts`).
//
// Auth model
// ----------
// OAuth 2.0 authorization-code + PKCE, DELEGATED identity. The
// signed-in user is the connected mailbox owner (e.g.
// `cturcato@spectreautomation.com`). The `Mail.Send` delegated scope
// is already in `APPROVED_DELEGATED_SCOPES` and is present on every
// production MailboxConnection consented since Sprint 2 Checkpoint
// 14C-B (2026-07-23). No Microsoft re-consent is required for
// arbitrary `/me/sendMail` beyond what Work Intake reply-sending
// already granted.
//
// Architectural separation (per B2 §2 directive — preserved)
// ----------------------------------------------------------
// This module DELIBERATELY does not import from
// `src/lib/integrations/microsoft-graph.ts`, which implements the
// separate client-credentials (app-only) `Mail.Send` flow. The two
// token lifecycles never share a code path.
//
// Sender identity
// ---------------
// `POST /me/sendMail` — the sender is IMPLICIT (the signed-in user
// of the access token). This adapter DOES NOT expose a `fromMailbox`
// argument to callers; sender substitution is structurally
// impossible. The recipient comes from the caller (invitation route
// reads `Employee.personalEmail` scoped by `clubId`).
//
// Sent-Items policy
// -----------------
// `saveToSentItems: false` — automated Spectre correspondence stays
// out of the connected user's Outlook "Sent Items" folder. Delivery
// is auditable on `EmployeeOnboardingInvitation.deliveryProviderMessageId`
// + audit log rather than the user's personal mailbox.

import type { NotificationDeliveryAdapter } from "../enterprise/notifications";
import { getFreshDelegatedAccessToken } from "../mailbox/connect";
import { MAILBOX_STATUS } from "../mailbox/status";
import { MAILBOX_ERROR_CODE, MailboxFlowError } from "../mailbox/errors";
import { prisma } from "../prisma";

const GRAPH_ME_SEND_MAIL_URL = "https://graph.microsoft.com/v1.0/me/sendMail";
export const DELEGATED_MAIL_SEND_SCOPE = "Mail.Send";

// ---------------------------------------------------------------------------
// Test seam — mirrors the pattern used by `microsoft-graph.ts::setGraphTransportForTest`.
// Production defaults to the real fetch-based sendMail; tests inject a
// stub via `setDelegatedSendMailTransportForTest()` so no real
// Microsoft tenant is ever contacted.
// ---------------------------------------------------------------------------
export interface DelegatedSendMailTransport {
  sendMail(args: {
    accessToken: string;
    subject: string;
    htmlBody: string;
    toEmail: string;
  }): Promise<{ status: number; providerMessageId: string | null; retryAfterSeconds?: number; errorBody?: string }>;
}

let testTransport: DelegatedSendMailTransport | null = null;
export function setDelegatedSendMailTransportForTest(t: DelegatedSendMailTransport | null): void {
  testTransport = t;
}

const realTransport: DelegatedSendMailTransport = {
  async sendMail({ accessToken, subject, htmlBody, toEmail }) {
    let res: Response;
    try {
      res = await fetch(GRAPH_ME_SEND_MAIL_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          message: {
            subject,
            body: { contentType: "HTML", content: htmlBody },
            toRecipients: [{ emailAddress: { address: toEmail } }],
          },
          // Automated Club correspondence should NOT clutter the
          // connected user's Outlook Sent Items. Delivery is
          // auditable via the invitation row + audit log.
          saveToSentItems: false,
        }),
      });
    } catch (err) {
      // Network failure — no response object. Classify as a transient
      // provider failure. Bearer token never leaves the closure.
      return {
        status: 0,
        providerMessageId: null,
        errorBody: err instanceof Error ? err.message : String(err),
      };
    }
    // Graph returns 202 Accepted on success.
    const providerMessageId = res.headers.get("request-id") ?? res.headers.get("x-ms-request-id");
    if (res.status === 202) {
      return { status: 202, providerMessageId };
    }
    const errorBody = await safeText(res);
    const retryAfter = res.headers.get("Retry-After");
    return {
      status: res.status,
      providerMessageId,
      retryAfterSeconds: parseRetryAfter(retryAfter),
      errorBody,
    };
  },
};

async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ""; }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const s = Number(value);
  if (Number.isFinite(s) && s > 0) return s;
  const asDate = Date.parse(value);
  if (!Number.isNaN(asDate)) {
    const delta = Math.floor((asDate - Date.now()) / 1000);
    if (delta > 0) return delta;
  }
  return undefined;
}

function activeTransport(): DelegatedSendMailTransport {
  return testTransport ?? realTransport;
}

/**
 * Extract the safest possible operator-facing error snippet from a
 * Graph error response body. Never emits raw bearer tokens; the
 * Graph API's error bodies do not contain the token, but we guard
 * against future oddness by strip-detecting anything JWT-shaped.
 */
function safeGraphErrorSnippet(errorBody: string | undefined, status: number, retryAfterSeconds: number | undefined): string {
  const looksLikeJwt = /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/;
  const safeBody = errorBody?.replace(looksLikeJwt, "[jwt-redacted]") ?? "";
  const parsed = safeParseErrorJson(safeBody);
  const base = parsed
    ? `Graph ${parsed.code ?? "error"}: ${parsed.message ?? "no message"}`
    : `Graph ${status}: ${safeBody.slice(0, 240) || "(no response body)"}`;
  if (retryAfterSeconds != null) return `${base} (retry after ${retryAfterSeconds}s)`;
  return base;
}

function safeParseErrorJson(text: string): { code?: string; message?: string } | null {
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    const err = j?.error;
    if (err && typeof err === "object") {
      return {
        code: typeof err.code === "string" ? err.code : undefined,
        message: typeof err.message === "string" ? err.message.split("\r\n")[0] : undefined,
      };
    }
    if (typeof err === "string") return { code: undefined, message: err };
  } catch { /* fall through */ }
  return null;
}

// ---------------------------------------------------------------------------
// Adapter factory.
// ---------------------------------------------------------------------------
export interface MailboxConnectionAdapterArgs {
  /** The MailboxConnection to send FROM. The clubId here MUST match
   *  the caller's tenant scope; `getFreshDelegatedAccessToken` enforces
   *  that at the token layer via `PERMISSION_DENIED`. */
  mailboxConnectionId: string;
  /** The Club making the send. Passed to `getFreshDelegatedAccessToken`
   *  as the cross-tenant guard. */
  callerClubId: string;
  /** Optional acting user id — the invitation route passes the
   *  principal.id when available; a system-triggered send may pass
   *  null. */
  callerUserId?: string | null;
}

/**
 * Build a `NotificationDeliveryAdapter` bound to a specific Club-
 * designated MailboxConnection. The `.send()` call:
 *
 *   1. Re-loads the MailboxConnection row inside the adapter (do NOT
 *      trust adapter-construction-time state).
 *   2. Rejects if the connection has moved to a non-CONNECTED status,
 *      has lost the `Mail.Send` scope, or does not belong to
 *      `callerClubId`. All refusals return a canonical
 *      `NotificationDeliveryAdapter` FAILED result — never throw.
 *   3. Acquires a fresh access token via
 *      `getFreshDelegatedAccessToken(...)` — this is the canonical
 *      concurrency-safe path (token cache + CAS refresh + KMS decrypt +
 *      audit + terminal-status classification). This adapter does NOT
 *      duplicate any of that logic.
 *   4. `POST /me/sendMail` with `saveToSentItems: false` and NO
 *      `fromMailbox` field — sender identity is implicit.
 *   5. Maps Graph 202 → SENT with the `request-id` header as
 *      `providerMessageId`. Anything else → FAILED with a safe
 *      operator-facing snippet (never the bearer token).
 */
export function mailboxConnectionEmailAdapter(args: MailboxConnectionAdapterArgs): NotificationDeliveryAdapter {
  return {
    async send({ channel, to, subject, body }) {
      if (channel !== "EMAIL") return { status: "FAILED", failureReason: "wrong channel" };
      if (!to.email) return { status: "FAILED", failureReason: "no recipient email" };

      // Suppression-list parity with the other email adapters.
      const { isSuppressed } = await import("../email-delivery");
      const sup = await isSuppressed(to.email);
      if (sup.suppressed) {
        return { status: "FAILED", failureReason: `suppressed: ${sup.reason}` };
      }

      // Fresh row read — adapter-construction-time state may be stale.
      const conn = await prisma.mailboxConnection.findUnique({
        where: { id: args.mailboxConnectionId },
        select: {
          id: true,
          clubId: true,
          status: true,
          provider: true,
          grantedScopes: true,
          accessTokenSecretRef: true,
          refreshTokenSecretRef: true,
        },
      });
      if (!conn) return { status: "FAILED", failureReason: "mailbox connection not found" };
      if (conn.clubId !== args.callerClubId) {
        // Defence-in-depth. `getFreshDelegatedAccessToken` already
        // enforces this, but a failed check should never call the
        // token service at all.
        return { status: "FAILED", failureReason: "cross-club mailbox refused" };
      }
      if (conn.provider !== "MICROSOFT_365") {
        return { status: "FAILED", failureReason: `unsupported mailbox provider: ${conn.provider}` };
      }
      if (conn.status !== MAILBOX_STATUS.CONNECTED) {
        return {
          status: "FAILED",
          failureReason:
            conn.status === MAILBOX_STATUS.REAUTH_REQUIRED
              ? "mailbox reauth required"
              : conn.status === MAILBOX_STATUS.DISCONNECTED
                ? "mailbox disconnected"
                : `mailbox status: ${conn.status}`,
        };
      }
      if (!conn.accessTokenSecretRef || !conn.refreshTokenSecretRef) {
        return { status: "FAILED", failureReason: "mailbox credentials retired" };
      }
      if (!(conn.grantedScopes ?? "").split(/\s+/).includes(DELEGATED_MAIL_SEND_SCOPE)) {
        return { status: "FAILED", failureReason: `mailbox missing ${DELEGATED_MAIL_SEND_SCOPE} scope` };
      }

      // Fresh delegated access token — canonical concurrency-safe
      // refresh path.
      let accessToken: string;
      try {
        const res = await getFreshDelegatedAccessToken({
          mailboxConnectionId: conn.id,
          callerClubId: args.callerClubId,
          callerUserId: args.callerUserId ?? null,
        });
        accessToken = res.accessToken;
      } catch (err) {
        if (err instanceof MailboxFlowError) {
          const code = err.code;
          if (code === MAILBOX_ERROR_CODE.PERMISSION_DENIED) {
            return { status: "FAILED", failureReason: "cross-club mailbox refused" };
          }
          if (code === MAILBOX_ERROR_CODE.REFRESH_TERMINAL) {
            return { status: "FAILED", failureReason: "mailbox reauth required" };
          }
          if (code === MAILBOX_ERROR_CODE.REFRESH_RETRYABLE) {
            return { status: "FAILED", failureReason: "mailbox token refresh temporarily failed" };
          }
          if (code === MAILBOX_ERROR_CODE.CONNECTION_ALREADY_DISCONNECTED) {
            return { status: "FAILED", failureReason: "mailbox disconnected" };
          }
          if (code === MAILBOX_ERROR_CODE.CONNECTION_NOT_FOUND) {
            return { status: "FAILED", failureReason: "mailbox connection not found" };
          }
          return { status: "FAILED", failureReason: `mailbox token error: ${code}` };
        }
        return {
          status: "FAILED",
          failureReason: `mailbox token error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      // POST /me/sendMail — sender identity implicit; no fromMailbox override.
      const send = await activeTransport().sendMail({
        accessToken,
        subject,
        htmlBody: body,
        toEmail: to.email,
      });

      if (send.status === 202) {
        return {
          status: "SENT",
          providerMessageId: send.providerMessageId ?? undefined,
        };
      }

      // Map Graph failure classes to safe operator-facing reasons.
      const httpKind =
        send.status === 401 ? "authentication rejected" :
        send.status === 403 ? "permission denied" :
        send.status === 429 ? "throttled" :
        send.status >= 500 && send.status < 600 ? "provider error" :
        send.status === 0 ? "network error" :
        "provider rejection";
      const snippet = safeGraphErrorSnippet(send.errorBody, send.status, send.retryAfterSeconds);
      return {
        status: "FAILED",
        failureReason: `${httpKind}: ${snippet}`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Designation resolver — used by selectEmailAdapter's Priority-1 branch
// AND by the Club-side UI to render "Invitation will be sent from …".
// ---------------------------------------------------------------------------
export interface DesignatedOutboundMailbox {
  mailboxConnectionId: string;
  connectedEmail: string;
  microsoftTenantId: string;
  status: string;
  grantedScopes: string;
}

/**
 * Return the Club's designated outbound MailboxConnection IF AND ONLY IF
 * it passes every canonical eligibility check:
 *   • Club.outboundMailboxConnectionId is set.
 *   • The referenced row exists and belongs to this Club (FK cascade
 *     protects us but we recheck at read time).
 *   • provider === MICROSOFT_365.
 *   • status === CONNECTED (NOT PENDING/DELAYED/REAUTH/DISCONNECTED).
 *   • grantedScopes contains Mail.Send.
 *   • Access + refresh token ciphertext rows are non-null.
 *
 * Returns null if any condition fails — the selector falls through
 * to Priority 2 (per-Club IntegrationSetting) rather than silently
 * substituting another Club mailbox. Returning null NEVER involves
 * looking at any other MailboxConnection.
 */
export async function resolveDesignatedOutboundMailbox(
  clubId: string,
): Promise<DesignatedOutboundMailbox | null> {
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { outboundMailboxConnectionId: true },
  });
  if (!club || !club.outboundMailboxConnectionId) return null;
  const conn = await prisma.mailboxConnection.findUnique({
    where: { id: club.outboundMailboxConnectionId },
    select: {
      id: true, clubId: true, status: true, provider: true,
      connectedEmail: true, microsoftTenantId: true, grantedScopes: true,
      accessTokenSecretRef: true, refreshTokenSecretRef: true,
    },
  });
  if (!conn) return null;
  if (conn.clubId !== clubId) return null;
  if (conn.provider !== "MICROSOFT_365") return null;
  if (conn.status !== MAILBOX_STATUS.CONNECTED) return null;
  if (!conn.accessTokenSecretRef || !conn.refreshTokenSecretRef) return null;
  if (!(conn.grantedScopes ?? "").split(/\s+/).includes(DELEGATED_MAIL_SEND_SCOPE)) return null;
  return {
    mailboxConnectionId: conn.id,
    connectedEmail: conn.connectedEmail,
    microsoftTenantId: conn.microsoftTenantId,
    status: conn.status,
    grantedScopes: conn.grantedScopes,
  };
}
