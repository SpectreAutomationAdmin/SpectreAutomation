// Sprint 2 B2 (2026-07-19) — Delegated Microsoft Graph provider.
//
// This module is DELIBERATELY separate from
// src/lib/integrations/microsoft-graph.ts, which implements the
// existing client-credentials Mail.Send flow. The two token
// lifecycles never share a code path, per §2 of the B2 directive.
//
// The exported interface `MicrosoftDelegatedProvider` is the mockable
// boundary. Tests inject `MockMicrosoftDelegatedProvider`; production
// wires `MsalMicrosoftDelegatedProvider`. All Graph calls in the
// mailbox flow route through this interface — the mailbox service
// never imports `@azure/msal-node` directly.

import { env, mailboxRedirectUri } from "@/lib/env";
import { logger } from "@/lib/observability/logger";

// Sprint 2 Checkpoint 13C (2026-07-22) — parse AADSTS number out of
// the free-form MSAL/Microsoft error message. AADSTS codes are the
// authoritative "what went wrong" identifier from Entra; MSAL wraps
// them in errorMessage but does not expose them structurally.
function extractAADSTSCode(msg: string | undefined | null): string | null {
  if (!msg) return null;
  const m = msg.match(/\b(AADSTS\d+)\b/);
  return m ? m[1] : null;
}

// Sprint 2 Checkpoint 13C — take a snapshot of every diagnostic field
// MSAL exposes on its error objects (AuthError, ServerError,
// ClientAuthError, InteractionRequiredAuthError, etc.) plus fields
// commonly attached by @azure/msal-node's HTTP client. Every field is
// safe to log — no bearer tokens, no headers, no ciphertext.
function collectMsalErrorDiagnostics(err: unknown): Record<string, unknown> {
  const e = err as {
    name?: string;
    errorCode?: string;
    errorMessage?: string;
    subError?: string;
    stack?: string;
    correlationId?: string;
    // Microsoft's diagnostic trace id; sometimes on the error, sometimes
    // in nested response objects. Capture both places.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    response?: any;
    statusCode?: number;
    retryAfter?: number | string;
    timestamp?: string;
    // @azure/msal-common may put http headers here
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    headers?: any;
  };
  const msg = e?.errorMessage ?? (err instanceof Error ? err.message : undefined);
  const trace = e?.response?.headers?.["x-ms-trace-id"] ?? e?.response?.headers?.["x-ms-request-id"];
  const httpStatus = e?.statusCode ?? e?.response?.status;
  return {
    msalErrorName: e?.name,
    msalErrorCode: e?.errorCode,
    msalErrorMessage: msg,
    msalSubError: e?.subError,
    aadstsCode: extractAADSTSCode(msg),
    httpStatus,
    // Retry-After can be seconds or a Date string; log both places we've
    // seen MSAL expose it.
    retryAfter: e?.retryAfter,
    correlationId: e?.correlationId,
    traceId: trace,
    timestamp: e?.timestamp,
    // Class name is often the only stable classifier for MSAL exceptions
    // that don't set errorCode (e.g., NetworkError vs ServerError).
    errorClass: err?.constructor?.name,
  };
}

// ---------------------------------------------------------------------------
// Approved delegated scopes. Founder-approved list, §2 of the B2 directive.
// A change to this list is a policy change — do not extend it silently.
// ---------------------------------------------------------------------------
export const APPROVED_DELEGATED_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "User.Read",
  "Mail.Read",
  // Sprint 2 Checkpoint 14C-B (2026-07-23) — delegated reply sending.
  // This scope authorises `POST /me/messages/{id}/reply` on behalf
  // of the connected user. It does NOT grant broad mutation
  // permission — `Mail.ReadWrite` remains deliberately absent so
  // the app cannot mark other messages read, move them between
  // folders, or delete them.
  //
  // Adding this scope changes the Microsoft consent screen. Users
  // with existing consented mailboxes will see a "missing scope"
  // notice in the reply composer until they reconnect and approve
  // the updated scope list. The API refuses to send when the
  // stored grantedScopes on the MailboxConnection does not include
  // Mail.Send — production consent is enforced server-side, not
  // just at the OAuth flow.
  "Mail.Send",
  // Sprint 3 · Checkpoint 16G Stage E (2026-08-04) — founder-approved
  // read-only calendar access for Today's Commitments.
  //
  // Calendars.Read: delegated, read-only, single-user (the signed-in
  // user's calendar only). Adding this scope changes the Microsoft
  // consent screen — users with existing consent will see a "missing
  // scope" notice until they reconnect and approve the updated list.
  //
  // We deliberately do NOT request Calendars.Read.Shared (would
  // require admin consent to read anyone else's calendar) and
  // NOT Calendars.ReadWrite (writing to Outlook is explicitly
  // out-of-scope per §8 — Spectre does not create or modify events).
  "Calendars.Read",
  // Sprint 3 · Checkpoint 16H (2026-08-04) — founder-approved
  // read+write scope on the CONNECTED USER'S OWN mailbox only.
  //
  // Mail.ReadWrite: authorises `POST /me/messages/{id}/move` so
  // that when an email-backed Work Intake completes, Spectre can
  // move the associated Inbox message into the user's Archive
  // folder. Combined with Mail.Send this is the minimum needed
  // for the founder-approved reply-and-archive workflow.
  //
  // We deliberately do NOT request Mail.ReadWrite.Shared (would
  // require admin consent to mutate other users' mailboxes) and
  // NOT application-level Mail.ReadWrite (would allow tenant-wide
  // mutation without any signed-in user). Delegated single-user
  // read+write is sufficient for the founder's model: "the
  // connected mailbox is the signed-in user's own mailbox".
  "Mail.ReadWrite",
] as const;

// ---------------------------------------------------------------------------
// Provider contract
// ---------------------------------------------------------------------------

export interface AuthorizationUrlArgs {
  state: string;
  pkceCodeChallenge: string;
  pkceMethod: "S256";
  nonce: string;
  loginHint?: string;
  redirectUri: string;
}

export interface CodeExchangeArgs {
  code: string;
  state: string;
  pkceCodeVerifier: string;
  redirectUri: string;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresOn: Date;
  idTokenClaims: {
    iss?: string;
    tid?: string;
    oid?: string;
    preferred_username?: string;
    name?: string;
    email?: string;
    nonce?: string;
    tenant_region_scope?: string;
    aud?: string;
    sub?: string;
    // Present when the identity is a Microsoft Account (Live).
    // Callers MUST refuse to persist a connection when this appears.
    // Recognised values include "MSA".
    idp?: string;
  };
  grantedScopes: ReadonlyArray<string>;
}

export interface MeResponse {
  id: string;
  displayName: string | null;
  mail: string | null;
  userPrincipalName: string | null;
}

// Sprint 2 B4 (2026-07-19) — Mailbox-read operations. A page of Graph
// message summaries; message detail; attachment metadata. The provider
// boundary keeps these operations mockable so tests never call
// Microsoft. Delta-cursor support is scaffolded now for C's
// continuous-sync work — see `RawGraphMessagePage.deltaLink`.

export interface RawGraphMessageAddress {
  address: string;
  name?: string | null;
}
export interface RawGraphRecipient {
  emailAddress: RawGraphMessageAddress;
}
export interface RawGraphAttachmentMeta {
  id: string;
  name: string;
  contentType: string;
  size: number;
  isInline: boolean;
}
export interface RawGraphMessage {
  id: string;
  immutableId?: string | null;
  internetMessageId?: string | null;
  conversationId?: string | null;
  from?: { emailAddress?: RawGraphMessageAddress } | null;
  sender?: { emailAddress?: RawGraphMessageAddress } | null;
  toRecipients?: RawGraphRecipient[];
  ccRecipients?: RawGraphRecipient[];
  bccRecipients?: RawGraphRecipient[];
  subject?: string | null;
  receivedDateTime: string; // ISO
  sentDateTime?: string | null;
  bodyPreview?: string | null;
  body?: { contentType?: "html" | "text" | null; content?: string | null } | null;
  importance?: "low" | "normal" | "high" | null;
  isRead?: boolean;
  hasAttachments?: boolean;
  webLink?: string | null;
  changeKey?: string | null;
  /** Present with a `@removed` marker on delta responses when a
   *  message has been deleted from the mailbox. */
  removed?: { reason?: string } | null;
  internetMessageHeaders?: Array<{ name: string; value: string }>;
}
export interface RawGraphMessagePage {
  messages: RawGraphMessage[];
  /** Present when more pages remain — pass verbatim to the next
   *  `listInboxMessages` call. */
  nextPageToken: string | null;
  /** Delta cursor to store on `MailboxConnection.deltaLink`.
   *  `null` from the initial (non-delta) list; populated from the
   *  delta endpoint used in Phase C. */
  deltaLink: string | null;
}

export interface ListInboxMessagesArgs {
  accessToken: string;
  receivedAfter: Date;
  /** Server-side page size hint. */
  pageSize: number;
  /** Continuation token from a prior `listInboxMessages` call. */
  pageToken?: string | null;
}

/**
 * Sprint 2 Checkpoint 13G — arguments for the Inbox delta endpoint.
 *
 * If `continuationUrl` is null/undefined, a NEW delta enumeration
 * begins at `/me/mailFolders/inbox/messages/delta` — the first call
 * enumerates existing messages until a terminal @odata.deltaLink is
 * received. If `continuationUrl` is provided, the caller supplies a
 * Microsoft-issued URL verbatim: either the @odata.nextLink from an
 * in-progress enumeration, or a previously-persisted @odata.deltaLink
 * to fetch only changes since that cursor.
 *
 * The provider validates `continuationUrl` (see
 * `assertMicrosoftGraphDeltaUrl`) — no arbitrary caller-supplied URL
 * is followed, even one that appears to be Microsoft-shaped.
 */
export interface ListInboxMessagesDeltaArgs {
  accessToken: string;
  /** Server-side page size hint. Bounded server-side by Microsoft to
   *  the same range as the list endpoint. */
  pageSize: number;
  /** Continuation URL from a prior delta call — either the
   *  @odata.nextLink (mid-enumeration) or a stored @odata.deltaLink
   *  (starting an incremental run). If null/undefined, a fresh
   *  enumeration is started. */
  continuationUrl?: string | null;
}

export interface ListAttachmentsArgs {
  accessToken: string;
  graphMessageId: string;
}

/**
 * Sprint 2 Checkpoint 14C-B — arguments for the delegated reply
 * endpoint. The `graphMessageId` must be resolved server-side from
 * the authorised WorkIntakeItem's PRIMARY origin — callers MUST NOT
 * accept an arbitrary message id from the browser.
 *
 * `body` is plain text. The Graph reply endpoint accepts an HTML
 * body via `message.body.contentType="html"` but this provider
 * uses text-only for the first staging release to reduce the
 * sanitizer footprint. HTML reply support can be added later.
 */
export interface ReplyToMessageArgs {
  accessToken: string;
  graphMessageId: string;
  body: string;
}

export interface ReplyToMessageResult {
  /** Microsoft's POST /me/messages/{id}/reply endpoint returns 202
   *  Accepted with an empty body on success. `sentAt` is the
   *  server's local timestamp — a truthful "reply sent" moment. */
  sentAt: Date;
}

// Sprint 3 · Checkpoint 16H (2026-08-04) — moveMessage types.
export interface MoveMessageArgs {
  accessToken: string;
  graphMessageId: string;
  /** Well-known folder name ("archive", "deleteditems", …) or an
   *  opaque parentFolderId. Well-known names avoid depending on
   *  the localised display name of the Archive folder. */
  destinationId: string;
}
export interface MoveMessageResult {
  resultingGraphMessageId: string;
  destinationFolderId: string;
  movedAt: Date;
}

// Sprint 3 · Checkpoint 16H rejection (2026-08-06) — Sent-Items
// lookup for reply-reconciliation.
//
// Founder-mandated §7 validation of the Graph query contract:
//
//   Endpoint:
//     GET /v1.0/me/mailFolders/sentitems/messages
//       ?$filter={conversationId eq '{cid}' and sentDateTime ge {lo}
//                 and sentDateTime le {hi}}
//       &$orderby=sentDateTime desc
//       &$top=25
//       &$select=id,internetMessageId,conversationId,subject,from,
//                toRecipients,ccRecipients,sentDateTime,bodyPreview,body
//     Header: ConsistencyLevel: eventual
//
//   Why this shape:
//     • `conversationId` is a filterable string property on the
//       Message resource (Graph reference: Message properties).
//     • `sentDateTime` is filterable + orderable and lives on the
//       SentItems folder items (delegated identity is the owner).
//     • Combining $filter over conversationId with $orderby on
//       sentDateTime requires `ConsistencyLevel: eventual` because
//       the two are indexed independently. Passing the header
//       silences the "InefficientFilter" 400 and enables the
//       secondary sort.
//     • Scope of the search is bounded to `/mailfolders/sentitems`
//       — Graph will NOT return Inbox or archived items even if
//       they share the conversationId.
//     • `$top=25` bounds a runaway result; a single Spectre reply
//       is expected to be one of the newest messages in the
//       conversation.
//
//   Retry / lag policy (§8):
//     A newly-sent message may not yet be indexed. Callers back off
//     30s → 2min → 10min before giving up; the local outbound
//     ConversationMessage row remains visible throughout.
//
//   Identity matching (§10):
//     conversationId + sender = mailbox owner + tight sentAt window
//     is the "medium confidence" fallback. If the returned message
//     has an internetMessageId matching a stored value, that is
//     upgraded to "high confidence."
export interface LookupSentMessagesArgs {
  accessToken: string;
  conversationId: string;
  /** ISO — search window opens; typically mutation.sentAt - 60s. */
  sentAfterIso: string;
  /** ISO — search window closes; typically mutation.sentAt + 60min. */
  sentBeforeIso: string;
  /** Optional cap; provider default 25 (Graph max reasonable). */
  top?: number;
}
export interface RawGraphSentMessage {
  id: string;
  internetMessageId: string | null;
  conversationId: string | null;
  subject: string | null;
  from: { emailAddress?: { name?: string; address?: string } } | null;
  toRecipients: Array<{ emailAddress?: { name?: string; address?: string } }> | null;
  ccRecipients: Array<{ emailAddress?: { name?: string; address?: string } }> | null;
  sentDateTime: string | null;
  bodyPreview: string | null;
  body: { contentType?: "text" | "html"; content?: string } | null;
}
export interface LookupSentMessagesResult {
  messages: RawGraphSentMessage[];
}

export interface MicrosoftDelegatedProvider {
  buildAuthorizationUrl(args: AuthorizationUrlArgs): Promise<string>;
  exchangeCode(args: CodeExchangeArgs): Promise<TokenResponse>;
  refreshToken(refreshToken: string): Promise<TokenResponse>;
  getMe(accessToken: string): Promise<MeResponse>;
  /** Read a page of Inbox messages received after `receivedAfter`.
   *  The provider owns pagination + retry-guidance parsing; the
   *  handler just loops until `nextPageToken` is null OR the message
   *  cap is reached. */
  listInboxMessages(args: ListInboxMessagesArgs): Promise<RawGraphMessagePage>;
  /** Attachment metadata for one message. Bytes are NOT fetched. */
  listAttachmentMetadata(args: ListAttachmentsArgs): Promise<RawGraphAttachmentMeta[]>;
  /** Sprint 2 Checkpoint 13G — Inbox delta enumeration.
   *
   *  Contract:
   *    - When continuationUrl is null/undefined, calls
   *      /v1.0/me/mailFolders/inbox/messages/delta to start a fresh
   *      enumeration. The @odata.deltaLink is only present on the
   *      TERMINAL page of the enumeration; mid-enumeration pages
   *      return @odata.nextLink only.
   *    - When continuationUrl is supplied, the URL is validated by
   *      `assertMicrosoftGraphDeltaUrl` and then fetched verbatim.
   *    - Tombstones (Graph `@removed`) are surfaced on
   *      RawGraphMessage.removed and treated as soft-deletes by the
   *      shared ingestion pipeline.
   *    - This method is read-only; it MUST NOT issue POST/PATCH/DELETE
   *      or hit any endpoint other than the delta enumeration URL.
   */
  listInboxMessagesDelta(args: ListInboxMessagesDeltaArgs): Promise<RawGraphMessagePage>;
  /** Sprint 2 Checkpoint 14C-B — delegated reply.
   *
   *  Contract:
   *    - Calls POST /me/messages/{graphMessageId}/reply as the
   *      connected user (delegated identity, NOT application
   *      identity — the reply is sent FROM the user's mailbox).
   *    - Recipient(s) and subject are derived server-side by
   *      Microsoft from the source message; no client-supplied
   *      overrides.
   *    - Body is plain text; wrapped in the Graph reply payload.
   *    - Throws with classification-friendly errors on failure so
   *      classifyMsalError can distinguish retryable, terminal, and
   *      consent errors.
   */
  replyToMessage(args: ReplyToMessageArgs): Promise<ReplyToMessageResult>;
  /** Sprint 3 Checkpoint 15D (2026-07-24) — Fetch attachment bytes.
   *
   *  Endpoint: GET /v1.0/me/messages/{graphMessageId}/attachments/{graphAttachmentId}/$value
   *
   *  Contract:
   *    - Delegated identity (Mail.Read scope; NO extra consent required).
   *    - Returns raw bytes as a Buffer. The caller is responsible for
   *      validating size + magic number + hashing before persistence.
   *    - Throws classification-friendly errors so retryable / terminal /
   *      consent failures land the right MAILBOX_ERROR_CODE.
   */
  getAttachmentBytes(args: GetAttachmentBytesArgs): Promise<Buffer>;
  /** Sprint 3 · Checkpoint 16H (2026-08-04) — move a message.
   *
   *  Endpoint: POST /v1.0/me/messages/{graphMessageId}/move
   *  Payload:  { "destinationId": "archive" | "<opaqueFolderId>" }
   *  Response: 201 Created with the new message (may have a
   *            different `id` after the move; the immutable id
   *            remains stable for tenants that support ImmutableId).
   *
   *  Contract:
   *    - Delegated identity (Mail.ReadWrite scope).
   *    - Uses well-known folder names ("archive", "deleteditems",
   *      etc.) where Graph accepts them, avoiding hardcoding
   *      localised folder display strings.
   *    - Returns the resulting graphMessageId so the caller can
   *      persist the new identifier (may differ post-move on some
   *      tenants).
   */
  moveMessage(args: MoveMessageArgs): Promise<MoveMessageResult>;
  /** Sprint 3 · Checkpoint 16H rejection (2026-08-06) — Sent-Items
   *  lookup for reconciling a Spectre-originated reply back to its
   *  real Graph message id. See LookupSentMessagesArgs docs for the
   *  validated Graph query contract. */
  lookupSentMessagesInConversation(args: LookupSentMessagesArgs): Promise<LookupSentMessagesResult>;
}

export interface GetAttachmentBytesArgs {
  accessToken: string;
  graphMessageId: string;
  graphAttachmentId: string;
}

// ---------------------------------------------------------------------------
// Provider registry — module-level swappable ref for dependency injection.
// Tests call `setMicrosoftDelegatedProvider(mock)` in beforeEach; production
// uses the MSAL implementation created lazily on first use.
// ---------------------------------------------------------------------------

let CURRENT_PROVIDER: MicrosoftDelegatedProvider | null = null;

export function setMicrosoftDelegatedProvider(provider: MicrosoftDelegatedProvider | null): void {
  CURRENT_PROVIDER = provider;
}

export function getMicrosoftDelegatedProvider(): MicrosoftDelegatedProvider {
  if (CURRENT_PROVIDER) return CURRENT_PROVIDER;
  CURRENT_PROVIDER = createMsalMicrosoftDelegatedProvider();
  return CURRENT_PROVIDER;
}

// ---------------------------------------------------------------------------
// Real MSAL implementation
// ---------------------------------------------------------------------------

function authorityUrl(): string {
  // Founder-directed authority for the multi-tenant organizational
  // audience. `login.microsoftonline.com/organizations` REJECTS
  // personal Microsoft accounts at the identity-platform layer,
  // regardless of what scopes we request.
  return `${env.MICROSOFT_GRAPH_AUTHORITY_HOST}/${env.MICROSOFT_GRAPH_AUTHORITY_AUDIENCE}`;
}

function createMsalMicrosoftDelegatedProvider(): MicrosoftDelegatedProvider {
  return {
    async buildAuthorizationUrl(args) {
      const app = await lazyConfidentialClient();
      return app.getAuthCodeUrl({
        scopes: [...APPROVED_DELEGATED_SCOPES],
        redirectUri: args.redirectUri,
        state: args.state,
        nonce: args.nonce,
        codeChallenge: args.pkceCodeChallenge,
        codeChallengeMethod: args.pkceMethod,
        loginHint: args.loginHint,
        // Prevent silent SSO from bypassing the "which account?"
        // picker when the user has multiple work accounts signed in.
        prompt: "select_account",
      });
    },
    async exchangeCode(args) {
      const app = await lazyConfidentialClient();
      const result = await app.acquireTokenByCode({
        scopes: [...APPROVED_DELEGATED_SCOPES],
        redirectUri: args.redirectUri,
        code: args.code,
        codeVerifier: args.pkceCodeVerifier,
      });
      if (!result) throw new Error("MSAL returned null on acquireTokenByCode");
      // Sprint 2 Checkpoint 12B (2026-07-21) — MSAL's AuthenticationResult
      // does NOT surface `refreshToken` as a top-level property; the refresh
      // token is stored only in MSAL's internal token cache. Extract it
      // explicitly so downstream code can persist it (KMS-encrypted). See
      // extractRefreshTokenFromCache() below.
      const refreshToken = await extractRefreshTokenFromCache(app, result.account?.homeAccountId ?? null);
      return normaliseTokenResponse(result, refreshToken);
    },
    async refreshToken(refreshToken) {
      const app = await lazyConfidentialClient();
      // Sprint 2 Checkpoint 13C — capture Microsoft's exact response.
      // These logger.warn/info events flow through the structured
      // logger which redacts anything looking like a secret. No
      // access/refresh tokens or Authorization headers are logged.
      logger.info("mailbox.msal.refresh.attempt", {
        scopes: [...APPROVED_DELEGATED_SCOPES],
        refreshTokenPresented: !!refreshToken,
        refreshTokenLength: refreshToken?.length ?? 0,
      });
      let result: import("@azure/msal-node").AuthenticationResult | null = null;
      try {
        result = await app.acquireTokenByRefreshToken({
          scopes: [...APPROVED_DELEGATED_SCOPES],
          refreshToken,
        });
      } catch (err) {
        // Emit every safe diagnostic field so the operator can classify
        // WITHOUT re-running the refresh. Then re-throw so the caller's
        // catch (classifyMsalError → REAUTH_REQUIRED vs DELAYED) still
        // fires per the existing production contract.
        const diag = collectMsalErrorDiagnostics(err);
        logger.warn("mailbox.msal.refresh.failed", diag);
        throw err;
      }
      if (!result) {
        logger.warn("mailbox.msal.refresh.null_result", { hint: "MSAL returned null AuthenticationResult" });
        throw new Error("MSAL returned null on acquireTokenByRefreshToken");
      }
      // Microsoft may (and typically does) issue a rotated refresh token
      // on each refresh. Pull the current one from the MSAL cache. If null,
      // the caller keeps using the previously-stored refresh token.
      const rotated = await extractRefreshTokenFromCache(app, result.account?.homeAccountId ?? null);
      logger.info("mailbox.msal.refresh.success", {
        hasAccessToken: !!result.accessToken,
        accessTokenLength: result.accessToken?.length ?? 0,
        rotatedRefreshTokenPresent: !!rotated,
        expiresOnIso: result.expiresOn?.toISOString(),
        scopesEcho: result.scopes,
        homeAccountIdPresent: !!result.account?.homeAccountId,
      });
      return normaliseTokenResponse(result, rotated);
    },
    async getMe(accessToken) {
      const res = await fetch("https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        const status = res.status;
        throw new Error(`Graph /me failed with status ${status}`);
      }
      const body = (await res.json()) as { id: string; displayName: string | null; mail: string | null; userPrincipalName: string | null };
      return {
        id: body.id,
        displayName: body.displayName ?? null,
        mail: body.mail ?? null,
        userPrincipalName: body.userPrincipalName ?? null,
      };
    },
    async listInboxMessages(args) {
      // Sprint 2 B4 — Inbox pagination. The stable identity strategy:
      // prefer the `immutableId` header when Microsoft returns one;
      // otherwise fall back to the `id` (which is stable within an
      // Outlook mailbox unless the message is moved between folders,
      // which our Inbox-only scope prevents).
      const iso = args.receivedAfter.toISOString();
      const sel = [
        "id",
        "internetMessageId",
        "conversationId",
        "from",
        "sender",
        "toRecipients",
        "ccRecipients",
        "bccRecipients",
        "subject",
        "receivedDateTime",
        "sentDateTime",
        "bodyPreview",
        "body",
        "importance",
        "isRead",
        "hasAttachments",
        "webLink",
        "changeKey",
        "internetMessageHeaders",
      ].join(",");
      const base = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages";
      const url = args.pageToken ?? `${base}?$select=${sel}&$top=${args.pageSize}&$filter=receivedDateTime ge ${iso}&$orderby=receivedDateTime desc`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${args.accessToken}`,
          // Request immutable ids where the tenant supports them.
          Prefer: 'IdType="ImmutableId"',
        },
      });
      if (!res.ok) {
        throw graphErrorFromResponse(res);
      }
      const body = (await res.json()) as {
        value: RawGraphMessage[];
        "@odata.nextLink"?: string;
        "@odata.deltaLink"?: string;
      };
      return {
        messages: body.value ?? [],
        nextPageToken: body["@odata.nextLink"] ?? null,
        deltaLink: body["@odata.deltaLink"] ?? null,
      };
    },
    async listAttachmentMetadata(args) {
      const url = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(args.graphMessageId)}/attachments?$select=id,name,contentType,size,isInline`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${args.accessToken}`,
        },
      });
      if (!res.ok) throw graphErrorFromResponse(res);
      const body = (await res.json()) as { value: RawGraphAttachmentMeta[] };
      return body.value ?? [];
    },
    async replyToMessage(args) {
      // Sprint 2 Checkpoint 14C-B — delegated reply.
      //
      // Endpoint: POST /me/messages/{graphMessageId}/reply
      // Payload:  { "comment": <plain text> }
      // Response: 202 Accepted with empty body on success.
      //
      // We DELIBERATELY use the `/reply` action + `comment` field
      // rather than constructing a `message` object with a HTML
      // body, To/Cc, or subject overrides. This forces Microsoft
      // to derive every routing decision from the source message —
      // no client-controlled override surface. If the operator
      // ever needs subject or recipient control, that must be a
      // separate authorized endpoint with its own review.
      if (!args.graphMessageId) throw new Error("Reply requires graphMessageId");
      if (!args.body || args.body.trim().length === 0) throw new Error("Reply body cannot be empty");

      const url = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(args.graphMessageId)}/reply`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${args.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ comment: args.body }),
      });
      if (!res.ok) throw graphErrorFromResponse(res);
      return { sentAt: new Date() };
    },
    async moveMessage(args) {
      // Sprint 3 · Checkpoint 16H (2026-08-04) — delegated move.
      //
      // Endpoint: POST /me/messages/{graphMessageId}/move
      // Payload:  { "destinationId": <folder-id-or-well-known-name> }
      //
      // Graph accepts well-known folder names ("archive",
      // "deleteditems", "junkemail", "inbox", "sentitems", "drafts")
      // in place of an opaque folder id — this avoids depending on
      // any localised display name for the Archive folder.
      //
      // Response body is the moved message with a NEW `id` — the
      // per-folder id changes on move, but the immutable id remains
      // stable for tenants that support ImmutableId. Callers persist
      // both original + resulting ids for delta-sync reconciliation.
      if (!args.graphMessageId) throw new Error("moveMessage requires graphMessageId");
      if (!args.destinationId) throw new Error("moveMessage requires destinationId");
      const url = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(args.graphMessageId)}/move`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${args.accessToken}`,
          "Content-Type": "application/json",
          Prefer: 'IdType="ImmutableId"',
        },
        body: JSON.stringify({ destinationId: args.destinationId }),
      });
      if (!res.ok) throw graphErrorFromResponse(res);
      const body = (await res.json()) as {
        id: string;
        parentFolderId?: string;
      };
      return {
        resultingGraphMessageId: body.id,
        destinationFolderId: body.parentFolderId ?? args.destinationId,
        movedAt: new Date(),
      };
    },
    async lookupSentMessagesInConversation(args) {
      // Sprint 3 · Checkpoint 16H rejection (2026-08-06) — Sent-Items
      // lookup with two-step filter contract. See
      // LookupSentMessagesArgs for the full rationale.
      //
      // Empirical observation on staging (2026-08-05): the primary
      // combined filter (conversationId + sentDateTime) is rejected
      // with 400 InefficientFilter on some tenants even with
      // ConsistencyLevel: eventual. We fall back to a sentDateTime-
      // only filter and rely on the caller (pickBestSentMatch) to
      // enforce owner + conversationId + tight-window matching. That
      // preserves §10 — conversationId alone can still not merge.
      if (!args.conversationId) throw new Error("lookupSentMessagesInConversation requires conversationId");
      const top = Math.min(Math.max(args.top ?? 25, 1), 100);
      const select = [
        "id",
        "internetMessageId",
        "conversationId",
        "subject",
        "from",
        "toRecipients",
        "ccRecipients",
        "sentDateTime",
        "bodyPreview",
        "body",
      ].join(",");
      const base = `https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages`;
      const orderBy = encodeURIComponent("sentDateTime desc");
      const selectQs = encodeURIComponent(select);
      const runFilter = async (filter: string): Promise<{ ok: boolean; status: number; body: unknown }> => {
        const url = `${base}?$filter=${encodeURIComponent(filter)}&$orderby=${orderBy}&$top=${top}&$select=${selectQs}`;
        const res = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${args.accessToken}`,
            ConsistencyLevel: "eventual",
          },
        });
        const bodyJson = res.ok ? await res.json() : await res.text();
        return { ok: res.ok, status: res.status, body: bodyJson };
      };
      const escConv = args.conversationId.replace(/'/g, "''");
      const primary =
        `conversationId eq '${escConv}'` +
        ` and sentDateTime ge ${args.sentAfterIso}` +
        ` and sentDateTime le ${args.sentBeforeIso}`;
      let result = await runFilter(primary);
      if (!result.ok) {
        // Fallback: sentDateTime-only.
        const fallback = `sentDateTime ge ${args.sentAfterIso} and sentDateTime le ${args.sentBeforeIso}`;
        result = await runFilter(fallback);
      }
      if (!result.ok) {
        // Both failed — throw the second-attempt classification so
        // classifyMsalError sees a real Graph error.
        const err = new Error(`Graph request failed with status ${result.status}`);
        Object.assign(err, { response: { status: result.status } });
        throw err;
      }
      const body = result.body as { value?: RawGraphSentMessage[] };
      return { messages: Array.isArray(body.value) ? body.value : [] };
    },
    async getAttachmentBytes(args) {
      // Sprint 3 Checkpoint 15D (2026-07-24) — Fetch attachment bytes.
      //
      // Endpoint: GET /me/messages/{msgId}/attachments/{attId}/$value
      // Returns raw bytes for the FileAttachment content stream.
      //
      // We DELIBERATELY use $value (raw bytes) rather than
      // GET /attachments/{id} (which returns a Graph JSON envelope
      // with base64-encoded contentBytes). $value is smaller on the
      // wire and can be piped straight to storage without a decode
      // step.
      if (!args.graphMessageId) throw new Error("getAttachmentBytes requires graphMessageId");
      if (!args.graphAttachmentId) throw new Error("getAttachmentBytes requires graphAttachmentId");
      const url =
        `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(args.graphMessageId)}` +
        `/attachments/${encodeURIComponent(args.graphAttachmentId)}/$value`;
      const res = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${args.accessToken}` },
      });
      if (!res.ok) throw graphErrorFromResponse(res);
      const buf = Buffer.from(await res.arrayBuffer());
      return buf;
    },
    async listInboxMessagesDelta(args) {
      // Sprint 2 Checkpoint 13G — Inbox delta enumeration.
      //
      // $select must mirror the initial-sync list endpoint so
      // downstream normalization sees the same fields on a delta
      // page as on a plain list page. Note: delta responses do NOT
      // support $filter=receivedDateTime — lookback is implicit
      // in cursor state.
      const sel = [
        "id",
        "internetMessageId",
        "conversationId",
        "from",
        "sender",
        "toRecipients",
        "ccRecipients",
        "bccRecipients",
        "subject",
        "receivedDateTime",
        "sentDateTime",
        "bodyPreview",
        "body",
        "importance",
        "isRead",
        "hasAttachments",
        "webLink",
        "changeKey",
        "internetMessageHeaders",
      ].join(",");
      let url: string;
      if (args.continuationUrl) {
        // Founder §"Provider implementation" — validate every
        // caller-supplied URL before it becomes a fetch target.
        assertMicrosoftGraphDeltaUrl(args.continuationUrl);
        url = args.continuationUrl;
      } else {
        const base = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta";
        url = `${base}?$select=${sel}&$top=${args.pageSize}`;
      }
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${args.accessToken}`,
          // Request immutable ids where the tenant supports them.
          Prefer: 'IdType="ImmutableId"',
        },
      });
      if (!res.ok) {
        throw graphErrorFromResponse(res);
      }
      const body = (await res.json()) as {
        value: RawGraphMessage[];
        "@odata.nextLink"?: string;
        "@odata.deltaLink"?: string;
      };
      return {
        messages: body.value ?? [],
        nextPageToken: body["@odata.nextLink"] ?? null,
        deltaLink: body["@odata.deltaLink"] ?? null,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Sprint 2 Checkpoint 13G — Continuation-URL validator for delta calls.
//
// Microsoft returns absolute URLs on @odata.nextLink and
// @odata.deltaLink that the client is expected to fetch verbatim.
// We MUST NOT follow arbitrary URLs — a malformed cursor or a URL
// injected via a tampered DB row could otherwise leak the bearer
// token to a hostile host. The delegated flow only ever needs URLs
// under the /me/ path on graph.microsoft.com.
//
// This validator throws if the URL fails any of:
//   - scheme is not https:
//   - hostname is not exactly graph.microsoft.com
//   - path does not begin with /v1.0/me/mailFolders
//   - path does not end with /messages/delta (allowing an optional
//     "/" between "delta" and the query string is not permitted —
//     Microsoft's cursor URLs never carry additional path segments
//     after "delta")
//
// Exported so tests can lock the exact rejection surface without
// running the full provider.
// ---------------------------------------------------------------------------
export function assertMicrosoftGraphDeltaUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid Microsoft Graph delta URL: not a parseable URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Invalid Microsoft Graph delta URL: non-HTTPS scheme (${parsed.protocol})`);
  }
  if (parsed.hostname !== "graph.microsoft.com") {
    throw new Error(`Invalid Microsoft Graph delta URL: unexpected hostname (${parsed.hostname})`);
  }
  // Path must start with /v1.0/me/mailFolders. Any of these are accepted:
  //   /v1.0/me/mailFolders/inbox/messages/delta
  //   /v1.0/me/mailFolders('inbox')/messages/delta
  //   /v1.0/me/mailFolders('AAMkAG...opaque_id...')/messages/delta
  if (!parsed.pathname.startsWith("/v1.0/me/mailFolders")) {
    throw new Error(`Invalid Microsoft Graph delta URL: path must begin with /v1.0/me/mailFolders (got ${parsed.pathname})`);
  }
  // Path must end with /messages/delta — no additional segments after "delta".
  if (!parsed.pathname.endsWith("/messages/delta")) {
    throw new Error(`Invalid Microsoft Graph delta URL: path must end with /messages/delta (got ${parsed.pathname})`);
  }
}

// Sprint 2 B4 — wrap Graph HTTP failures in an Error whose shape
// `classifyMsalError` (which also handles Graph errors) can inspect.
// Retry-After is preserved so the queue can back off appropriately.
function graphErrorFromResponse(res: Response): Error {
  const err = new Error(`Graph request failed with status ${res.status}`);
  Object.assign(err, {
    response: { status: res.status },
    retryAfterSeconds: parseRetryAfter(res.headers.get("Retry-After")),
  });
  return err;
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

// MSAL is loaded lazily so `import` cost doesn't hit at boot when
// the feature flag is off. Also required because we do not want the
// module to blow up if MICROSOFT_GRAPH_DELEGATED_CLIENT_ID is
// missing during local development.
let CLIENT_INSTANCE: import("@azure/msal-node").ConfidentialClientApplication | null = null;
async function lazyConfidentialClient(): Promise<import("@azure/msal-node").ConfidentialClientApplication> {
  if (CLIENT_INSTANCE) return CLIENT_INSTANCE;
  const clientId = env.MICROSOFT_GRAPH_DELEGATED_CLIENT_ID;
  const clientSecret = env.MICROSOFT_GRAPH_DELEGATED_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "Delegated Microsoft Graph is not configured. Set MICROSOFT_GRAPH_DELEGATED_CLIENT_ID and MICROSOFT_GRAPH_DELEGATED_CLIENT_SECRET.",
    );
  }
  const msal = await import("@azure/msal-node");
  CLIENT_INSTANCE = new msal.ConfidentialClientApplication({
    auth: {
      clientId,
      clientSecret,
      authority: authorityUrl(),
    },
  });
  return CLIENT_INSTANCE;
}

function normaliseTokenResponse(
  result: import("@azure/msal-node").AuthenticationResult,
  refreshToken: string | null,
): TokenResponse {
  const claims = (result.idTokenClaims ?? {}) as TokenResponse["idTokenClaims"];
  // Microsoft's OAuth token endpoint omits `offline_access` from the
  // `scope` response field — it's a control scope (asks for a refresh
  // token), not a resource scope, so it never appears in `result.scopes`
  // even when honored. The presence of a refresh token IS the confirmation
  // that `offline_access` was granted. Add it to grantedScopes when true
  // so downstream consumers see the accurate delegated-scope set.
  const resourceScopes = (result.scopes ?? []) as string[];
  const grantedScopes: ReadonlyArray<string> =
    refreshToken && !resourceScopes.includes("offline_access")
      ? [...resourceScopes, "offline_access"]
      : resourceScopes;
  return {
    accessToken: result.accessToken,
    refreshToken,
    expiresOn: result.expiresOn ?? new Date(Date.now() + 45 * 60 * 1000),
    idTokenClaims: claims,
    grantedScopes,
  };
}

// Sprint 2 Checkpoint 12B — MSAL Node keeps refresh tokens in its
// internal token cache; AuthenticationResult does NOT expose
// `refreshToken`. Serialize the cache and pull the token by home
// account id (filter to the specific account we just authenticated).
async function extractRefreshTokenFromCache(
  app: import("@azure/msal-node").ConfidentialClientApplication,
  homeAccountId: string | null,
): Promise<string | null> {
  let serialized: string;
  try {
    serialized = await app.getTokenCache().serialize();
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return null;
  }
  const rtBag = (parsed as { RefreshToken?: Record<string, { secret?: string; home_account_id?: string }> }).RefreshToken;
  if (!rtBag) return null;
  const entries = Object.entries(rtBag);
  if (entries.length === 0) return null;
  if (homeAccountId) {
    const match = entries.find(([, v]) => v?.home_account_id === homeAccountId);
    if (match && match[1]?.secret) return match[1].secret;
  }
  // Fallback: return the last-inserted entry (MSAL preserves insertion
  // order; the call above just added a token). This preserves single-
  // account correctness even if homeAccountId isn't available.
  const last = entries[entries.length - 1];
  return last[1]?.secret ?? null;
}

// ---------------------------------------------------------------------------
// Helpers for callers
// ---------------------------------------------------------------------------

export function defaultRedirectUri(): string {
  return mailboxRedirectUri();
}
