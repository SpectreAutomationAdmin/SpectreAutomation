// Microsoft 365 / Outlook email delivery via Microsoft Graph.
//
// Auth model
// ----------
// OAuth 2.0 *client credentials* (app-only). The club's Microsoft 365
// administrator creates an App Registration with the
// **Microsoft Graph → Mail.Send** *application* permission, grants
// admin consent, and (recommended) scopes the app to a single mailbox
// via an Application Access Policy:
//
//   New-ApplicationAccessPolicy -AppId <CLIENT_ID> `
//     -PolicyScopeGroupId receipts@silverspringsgolfclub.com `
//     -AccessRight RestrictAccess
//
// That keeps Spectre's tenant-wide Mail.Send grant operationally
// limited to the receipts mailbox — Spectre never gains access to any
// other club user's inbox.
//
// We deliberately do NOT support delegated / ROPC / password flows;
// neither requires a user password to live in Spectre, which is the
// whole point of moving off SMTP+password for production.
//
// Test seam
// ---------
// All HTTP I/O goes through a `GraphTransport`. Production uses the
// real fetch-based implementation; tests inject a stub via
// `setGraphTransportForTest()` so no real Microsoft tenant is needed.

import type { NotificationDeliveryAdapter } from "../enterprise/notifications";

const TOKEN_URL_TEMPLATE = "https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token";
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";

// -------------------------------------------------------------------------
// Graph payload shape — only the bits we use. We send plain-text and
// optionally an HTML alternative; attachments aren't wired yet because the
// existing receipt flow links to the chit PDF rather than embedding it.
// -------------------------------------------------------------------------
type GraphMessage = {
  subject: string;
  body: { contentType: "Text" | "HTML"; content: string };
  toRecipients: Array<{ emailAddress: { address: string } }>;
};
type GraphSendMailRequest = { message: GraphMessage; saveToSentItems: boolean };

// -------------------------------------------------------------------------
// Transport interface. Production impl uses fetch; tests inject a mock.
// -------------------------------------------------------------------------
export type GraphTransport = {
  fetchToken: (args: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
  }) => Promise<{ accessToken: string; expiresInSec: number }>;
  sendMail: (args: {
    accessToken: string;
    fromMailbox: string;
    request: GraphSendMailRequest;
  }) => Promise<{ requestId: string | null }>;
};

// -------------------------------------------------------------------------
// Test seam. Process-wide override; null restores the real transport.
// `clearGraphTokenCache()` lets tests start each case with a clean slate.
// -------------------------------------------------------------------------
let testTransport: GraphTransport | null = null;
export function setGraphTransportForTest(t: GraphTransport | null) {
  testTransport = t;
  clearGraphTokenCache();
}

function activeTransport(): GraphTransport {
  return testTransport ?? realGraphTransport;
}

// -------------------------------------------------------------------------
// Real transport — fetch against Microsoft login + Graph endpoints. Uses
// the global fetch built in to Node 18+.
// -------------------------------------------------------------------------
export const realGraphTransport: GraphTransport = {
  async fetchToken({ tenantId, clientId, clientSecret }) {
    const url = TOKEN_URL_TEMPLATE.replace("{tenantId}", encodeURIComponent(tenantId));
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: GRAPH_SCOPE,
    });
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await safeText(res);
      // Pull the AADSTS code if present — the most useful single hint
      // when debugging a misconfigured tenant or expired secret.
      throw new GraphError(`Token request failed (${res.status}): ${shortenAadError(text)}`);
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new GraphError("Token response missing access_token");
    return {
      accessToken: data.access_token,
      expiresInSec: data.expires_in ?? 3600,
    };
  },

  async sendMail({ accessToken, fromMailbox, request }) {
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(fromMailbox)}/sendMail`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    });
    // Graph returns 202 Accepted on success. Anything else is a failure.
    if (res.status !== 202) {
      const text = await safeText(res);
      throw new GraphError(`Graph sendMail failed (${res.status}): ${shortenAadError(text)}`);
    }
    // Graph forwards the request-id; it's the closest thing to a
    // provider message-id we can record for auditing. There is no
    // delivery-status from sendMail — bounces arrive asynchronously
    // to the sender's mailbox.
    return { requestId: res.headers.get("request-id") };
  },
};

// -------------------------------------------------------------------------
// Token cache. Keyed by tenant+client. Microsoft tokens are valid for
// ~1 hour by default; we refresh 60s early to avoid edge-of-expiry races.
// -------------------------------------------------------------------------
type CachedToken = { accessToken: string; expiresAtMs: number };
const tokenCache = new Map<string, CachedToken>();

export function clearGraphTokenCache() {
  tokenCache.clear();
}

async function acquireToken(args: {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}): Promise<string> {
  const key = `${args.tenantId}|${args.clientId}`;
  const now = Date.now();
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAtMs - 60_000 > now) {
    return cached.accessToken;
  }
  const { accessToken, expiresInSec } = await activeTransport().fetchToken(args);
  tokenCache.set(key, { accessToken, expiresAtMs: now + expiresInSec * 1000 });
  return accessToken;
}

// -------------------------------------------------------------------------
// Adapter factory. Returns the standard NotificationDeliveryAdapter
// shape so existing callers (selectEmailAdapter, the POS receipts
// pipeline) don't care which underlying provider is in play.
// -------------------------------------------------------------------------
export function microsoftGraphEmailAdapter(args: {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  fromMailbox: string;
}): NotificationDeliveryAdapter {
  // Fail-fast validation. Empty strings are common slip-ups when admins
  // copy-paste from the Azure portal.
  const missing = (["tenantId", "clientId", "clientSecret", "fromMailbox"] as const).filter(
    (k) => !args[k] || !args[k].trim(),
  );
  if (missing.length) {
    return {
      async send() {
        return {
          status: "FAILED",
          failureReason: `Microsoft 365 config incomplete: missing ${missing.join(", ")}`,
        };
      },
    };
  }
  return {
    async send({ channel, to, subject, body }) {
      if (channel !== "EMAIL") return { status: "FAILED", failureReason: "wrong channel" };
      if (!to.email) return { status: "FAILED", failureReason: "no recipient email" };

      // Suppression-list parity with the SMTP / SES adapters.
      const { isSuppressed } = await import("../email-delivery");
      const sup = await isSuppressed(to.email);
      if (sup.suppressed) {
        return { status: "FAILED", failureReason: `suppressed: ${sup.reason}` };
      }

      let token: string;
      try {
        token = await acquireToken({
          tenantId: args.tenantId,
          clientId: args.clientId,
          clientSecret: args.clientSecret,
        });
      } catch (err) {
        return {
          status: "FAILED",
          failureReason: redactSecret(err instanceof Error ? err.message : String(err), args.clientSecret),
        };
      }

      const request: GraphSendMailRequest = {
        message: {
          subject,
          body: { contentType: "HTML", content: bodyToHtml(body) },
          toRecipients: [{ emailAddress: { address: to.email } }],
        },
        // saveToSentItems=false keeps Spectre's automated sends out of
        // the operator's Outlook "Sent Items" — they're auditable in
        // EmailDeliveryEvent already and would otherwise clutter the
        // human user's mailbox.
        saveToSentItems: false,
      };

      try {
        const result = await activeTransport().sendMail({
          accessToken: token,
          fromMailbox: args.fromMailbox,
          request,
        });
        return { status: "SENT", providerMessageId: result.requestId ?? undefined };
      } catch (err) {
        return {
          status: "FAILED",
          failureReason: redactSecret(err instanceof Error ? err.message : String(err), args.clientSecret),
        };
      }
    },
  };
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------
class GraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphError";
  }
}

async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ""; }
}

// Microsoft errors look like:
//   {"error":"invalid_client","error_description":"AADSTS7000215: Invalid client secret..."}
// or
//   {"error":{"code":"ErrorAccessDenied","message":"..."}}
// Surface a short, useful snippet without dumping the whole HTML / JSON.
function shortenAadError(raw: string): string {
  if (!raw) return "(no response body)";
  try {
    const j = JSON.parse(raw);
    if (typeof j.error_description === "string") return j.error_description.split("\r\n")[0];
    if (typeof j?.error?.message === "string") return j.error.message;
    if (typeof j.error === "string") return j.error;
  } catch { /* fall through */ }
  return raw.slice(0, 240);
}

// Defensive: if a stack trace or library error somehow leaked the
// secret into a message, scrub it before persisting. Belt-and-braces —
// the helpers above shouldn't include it in the first place.
function redactSecret(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join("***");
}

function bodyToHtml(plain: string): string {
  const escaped = plain
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<!doctype html><html><body style="font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; color: #111; line-height: 1.5"><pre style="font-family: inherit; white-space: pre-wrap; margin: 0">${escaped}</pre></body></html>`;
}
