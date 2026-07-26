// Sprint 2 B2 (2026-07-19) — Mock delegated Graph provider for
// tests. Deterministic fixtures for every OAuth outcome the B2
// directive lists (§12). No test in the repo hits real Microsoft.

import type {
  MicrosoftDelegatedProvider,
  TokenResponse,
  MeResponse,
  AuthorizationUrlArgs,
  CodeExchangeArgs,
  ListInboxMessagesArgs,
  ListInboxMessagesDeltaArgs,
  ListAttachmentsArgs,
  RawGraphMessage,
  RawGraphMessagePage,
  RawGraphAttachmentMeta,
  ReplyToMessageArgs,
  ReplyToMessageResult,
  GetAttachmentBytesArgs,
} from "./microsoft-graph-delegated";
import { assertMicrosoftGraphDeltaUrl } from "./microsoft-graph-delegated";

export type MockOutcome =
  | "SUCCESS"
  | "CODE_EXCHANGE_FAILED"
  | "PERSONAL_ACCOUNT"
  | "TENANT_MISSING"
  | "NONCE_MISMATCH"
  | "ME_FAILED"
  | "TERMINAL_INVALID_GRANT"
  | "RETRYABLE_THROTTLE"
  | "REFRESH_NO_ROTATION";

export interface MockProviderConfig {
  /** Fixed tenant id echoed in id_token claims for the SUCCESS path. */
  tenantId: string;
  /** External Microsoft user id echoed in id_token claims and /me. */
  externalUserId: string;
  /** Connected email address returned by /me and mail claim. */
  connectedEmail: string;
  displayName: string;
  /** Nonce mock echoes back in id_token — usually the same nonce the
   *  caller supplied. Override for NONCE_MISMATCH fixture. */
  echoNonce?: string;
  /** Outcome the mock produces on next exchangeCode call. */
  exchangeOutcome?: MockOutcome;
  /** Outcome the mock produces on next refreshToken call. */
  refreshOutcome?: MockOutcome;
  /** Outcome the mock produces on next getMe call. */
  meOutcome?: MockOutcome;
  /** For refresh-no-rotation: MSAL sometimes returns a new access
   *  token without a new refresh token. The mock reflects that. */
  refreshReturnsNoRefreshToken?: boolean;
}

export class MockMicrosoftDelegatedProvider implements MicrosoftDelegatedProvider {
  public capturedAuthorizationUrls: AuthorizationUrlArgs[] = [];
  public capturedExchangeCalls: CodeExchangeArgs[] = [];
  public capturedRefreshCalls: string[] = [];
  public capturedMeCalls: string[] = [];

  private counter = 0;

  constructor(private config: MockProviderConfig) {}

  updateConfig(patch: Partial<MockProviderConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  /** Test-only read access to the current mock identity, so a
   *  duplicate-conflict test can build a second provider with the
   *  SAME externalUserId + connectedEmail without hardcoding
   *  literals in the test file. */
  identity(): { tenantId: string; externalUserId: string; connectedEmail: string; displayName: string } {
    return {
      tenantId: this.config.tenantId,
      externalUserId: this.config.externalUserId,
      connectedEmail: this.config.connectedEmail,
      displayName: this.config.displayName,
    };
  }

  async buildAuthorizationUrl(args: AuthorizationUrlArgs): Promise<string> {
    this.capturedAuthorizationUrls.push(args);
    const params = new URLSearchParams({
      state: args.state,
      code_challenge: args.pkceCodeChallenge,
      code_challenge_method: args.pkceMethod,
      nonce: args.nonce,
      redirect_uri: args.redirectUri,
      scope: "openid profile email offline_access User.Read Mail.Read",
      response_type: "code",
      response_mode: "query",
    });
    return `https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?${params.toString()}`;
  }

  async exchangeCode(args: CodeExchangeArgs): Promise<TokenResponse> {
    this.capturedExchangeCalls.push(args);
    const outcome = this.config.exchangeOutcome ?? "SUCCESS";
    if (outcome === "CODE_EXCHANGE_FAILED") {
      throw makeMsalError({ errorCode: "invalid_grant", errorNo: "AADSTS9002313" });
    }
    if (outcome === "PERSONAL_ACCOUNT") {
      return {
        accessToken: this.nextToken("at"),
        refreshToken: this.nextToken("rt"),
        expiresOn: new Date(Date.now() + 3600 * 1000),
        idTokenClaims: {
          iss: "https://login.live.com/",
          tid: "9188040d-6c67-4c5b-b112-36a304b66dad", // MSA tenant guid
          oid: "personal_account_oid",
          preferred_username: "user@outlook.com",
          name: "MSA User",
          nonce: this.config.echoNonce ?? args.pkceCodeVerifier, // nonce from AuthorizationUrl call
          idp: "MSA",
        },
        grantedScopes: ["openid", "profile", "email", "offline_access", "User.Read", "Mail.Read"],
      };
    }
    if (outcome === "TENANT_MISSING") {
      return {
        accessToken: this.nextToken("at"),
        refreshToken: this.nextToken("rt"),
        expiresOn: new Date(Date.now() + 3600 * 1000),
        idTokenClaims: {
          iss: "https://login.microsoftonline.com/organizations/v2.0",
          oid: this.config.externalUserId,
          preferred_username: this.config.connectedEmail,
          nonce: this.config.echoNonce ?? "",
        },
        grantedScopes: ["openid", "profile", "email", "offline_access", "User.Read", "Mail.Read"],
      };
    }
    // SUCCESS
    return {
      accessToken: this.nextToken("at"),
      refreshToken: this.nextToken("rt"),
      expiresOn: new Date(Date.now() + 3600 * 1000),
      idTokenClaims: {
        iss: `https://login.microsoftonline.com/${this.config.tenantId}/v2.0`,
        tid: this.config.tenantId,
        oid: this.config.externalUserId,
        preferred_username: this.config.connectedEmail,
        name: this.config.displayName,
        email: this.config.connectedEmail,
        nonce: this.config.echoNonce ?? "",
      },
      grantedScopes: ["openid", "profile", "email", "offline_access", "User.Read", "Mail.Read"],
    };
  }

  async refreshToken(refreshToken: string): Promise<TokenResponse> {
    this.capturedRefreshCalls.push(refreshToken);
    const outcome = this.config.refreshOutcome ?? "SUCCESS";
    if (outcome === "TERMINAL_INVALID_GRANT") {
      throw makeMsalError({ errorCode: "invalid_grant" });
    }
    if (outcome === "RETRYABLE_THROTTLE") {
      throw makeMsalError({ errorCode: "temporarily_unavailable", response: { status: 429 } });
    }
    return {
      accessToken: this.nextToken("at"),
      refreshToken: this.config.refreshReturnsNoRefreshToken ? null : this.nextToken("rt"),
      expiresOn: new Date(Date.now() + 3600 * 1000),
      idTokenClaims: {
        iss: `https://login.microsoftonline.com/${this.config.tenantId}/v2.0`,
        tid: this.config.tenantId,
        oid: this.config.externalUserId,
        preferred_username: this.config.connectedEmail,
      },
      grantedScopes: ["openid", "profile", "email", "offline_access", "User.Read", "Mail.Read"],
    };
  }

  async getMe(accessToken: string): Promise<MeResponse> {
    this.capturedMeCalls.push(accessToken);
    if (this.config.meOutcome === "ME_FAILED") throw new Error("Graph /me failed with status 500");
    return {
      id: this.config.externalUserId,
      displayName: this.config.displayName,
      mail: this.config.connectedEmail,
      userPrincipalName: this.config.connectedEmail,
    };
  }

  private nextToken(prefix: string): string {
    this.counter += 1;
    return `mock_${prefix}_${this.counter}_${Math.random().toString(36).slice(2, 8)}`;
  }

  // ------------------------------------------------------------------
  // Sprint 2 B4 — Mailbox-read fixtures.
  // ------------------------------------------------------------------
  /** In-memory Inbox the mock returns pages from. Tests can replace
   *  it via `setFixtureMessages(...)` and control pagination via
   *  `pageSize` in the call args. */
  private fixtureMessages: RawGraphMessage[] = [];
  private fixtureAttachments = new Map<string, RawGraphAttachmentMeta[]>();
  private listInboxOutcome: "SUCCESS" | "RETRYABLE_THROTTLE" | "TERMINAL_INVALID_GRANT" = "SUCCESS";
  public capturedListInboxCalls: ListInboxMessagesArgs[] = [];

  setFixtureMessages(messages: RawGraphMessage[]): void {
    this.fixtureMessages = messages;
  }
  setFixtureAttachments(graphMessageId: string, atts: RawGraphAttachmentMeta[]): void {
    this.fixtureAttachments.set(graphMessageId, atts);
  }
  setListInboxOutcome(o: "SUCCESS" | "RETRYABLE_THROTTLE" | "TERMINAL_INVALID_GRANT"): void {
    this.listInboxOutcome = o;
  }

  async listInboxMessages(args: ListInboxMessagesArgs): Promise<RawGraphMessagePage> {
    this.capturedListInboxCalls.push(args);
    if (this.listInboxOutcome === "TERMINAL_INVALID_GRANT") {
      throw makeMsalError({ errorCode: "invalid_grant" });
    }
    if (this.listInboxOutcome === "RETRYABLE_THROTTLE") {
      throw makeMsalError({ errorCode: "temporarily_unavailable", response: { status: 429 } });
    }
    // Determine slice from the pageToken (opaque cursor is just the
    // offset stringified for the mock).
    const offset = args.pageToken ? Number(args.pageToken) : 0;
    const filtered = this.fixtureMessages.filter(
      (m) => new Date(m.receivedDateTime).getTime() >= args.receivedAfter.getTime(),
    );
    const slice = filtered.slice(offset, offset + args.pageSize);
    const nextOffset = offset + slice.length;
    return {
      messages: slice,
      nextPageToken: nextOffset < filtered.length ? String(nextOffset) : null,
      deltaLink: nextOffset >= filtered.length ? "mock-delta-cursor-v1" : null,
    };
  }

  async listAttachmentMetadata(args: ListAttachmentsArgs): Promise<RawGraphAttachmentMeta[]> {
    return this.fixtureAttachments.get(args.graphMessageId) ?? [];
  }

  // ------------------------------------------------------------------
  // Sprint 2 Checkpoint 13G — Delta fixtures.
  // ------------------------------------------------------------------
  /** Pages a test wants the mock to emit for a delta enumeration.
   *  Each entry is one call's return value; entries are consumed in
   *  order. If more calls happen than entries provided, an error is
   *  thrown so tests never silently succeed against exhausted mocks. */
  private deltaPages: RawGraphMessagePage[] = [];
  /** For test inspection: every ListInboxMessagesDeltaArgs the mock
   *  saw, in call order. */
  public capturedListInboxDeltaCalls: ListInboxMessagesDeltaArgs[] = [];
  private listInboxDeltaOutcome: "SUCCESS" | "RETRYABLE_THROTTLE" | "TERMINAL_INVALID_GRANT" = "SUCCESS";

  /** Set the ordered pages the mock will emit on successive delta
   *  calls. Test authors should always supply at least one page. */
  setFixtureDeltaPages(pages: RawGraphMessagePage[]): void {
    this.deltaPages = pages;
  }
  setListInboxDeltaOutcome(o: "SUCCESS" | "RETRYABLE_THROTTLE" | "TERMINAL_INVALID_GRANT"): void {
    this.listInboxDeltaOutcome = o;
  }

  // Sprint 2 Checkpoint 14C-B mock reply capture.
  public capturedReplyCalls: ReplyToMessageArgs[] = [];
  private replyOutcome: "SUCCESS" | "RETRYABLE_THROTTLE" | "TERMINAL_INSUFFICIENT_SCOPE" | "TERMINAL_INVALID_GRANT" = "SUCCESS";
  setReplyOutcome(o: "SUCCESS" | "RETRYABLE_THROTTLE" | "TERMINAL_INSUFFICIENT_SCOPE" | "TERMINAL_INVALID_GRANT"): void {
    this.replyOutcome = o;
  }
  async replyToMessage(args: ReplyToMessageArgs): Promise<ReplyToMessageResult> {
    this.capturedReplyCalls.push(args);
    if (!args.graphMessageId) throw new Error("Reply requires graphMessageId");
    if (!args.body || args.body.trim().length === 0) throw new Error("Reply body cannot be empty");
    if (this.replyOutcome === "RETRYABLE_THROTTLE") {
      throw makeMsalError({ errorCode: "temporarily_unavailable", response: { status: 429 } });
    }
    if (this.replyOutcome === "TERMINAL_INSUFFICIENT_SCOPE") {
      throw makeMsalError({ errorCode: "insufficient_scope", response: { status: 403 } });
    }
    if (this.replyOutcome === "TERMINAL_INVALID_GRANT") {
      throw makeMsalError({ errorCode: "invalid_grant" });
    }
    return { sentAt: new Date() };
  }

  // Sprint 3 Checkpoint 15D — attachment-bytes mock.
  private fixtureAttachmentBytes = new Map<string, Buffer>();
  private getAttachmentBytesOutcome: "SUCCESS" | "RETRYABLE_THROTTLE" | "TERMINAL_INVALID_GRANT" = "SUCCESS";
  public capturedAttachmentBytesCalls: GetAttachmentBytesArgs[] = [];

  setFixtureAttachmentBytes(key: { graphMessageId: string; graphAttachmentId: string }, bytes: Buffer): void {
    this.fixtureAttachmentBytes.set(`${key.graphMessageId}::${key.graphAttachmentId}`, bytes);
  }
  setGetAttachmentBytesOutcome(o: "SUCCESS" | "RETRYABLE_THROTTLE" | "TERMINAL_INVALID_GRANT"): void {
    this.getAttachmentBytesOutcome = o;
  }
  async getAttachmentBytes(args: GetAttachmentBytesArgs): Promise<Buffer> {
    this.capturedAttachmentBytesCalls.push(args);
    if (this.getAttachmentBytesOutcome === "RETRYABLE_THROTTLE") {
      throw makeMsalError({ errorCode: "temporarily_unavailable", response: { status: 429 } });
    }
    if (this.getAttachmentBytesOutcome === "TERMINAL_INVALID_GRANT") {
      throw makeMsalError({ errorCode: "invalid_grant" });
    }
    const bytes = this.fixtureAttachmentBytes.get(`${args.graphMessageId}::${args.graphAttachmentId}`);
    if (!bytes) {
      throw new Error(
        `MockMicrosoftDelegatedProvider.getAttachmentBytes: no fixture bytes registered for message=${args.graphMessageId} attachment=${args.graphAttachmentId}`,
      );
    }
    return bytes;
  }

  async listInboxMessagesDelta(args: ListInboxMessagesDeltaArgs): Promise<RawGraphMessagePage> {
    this.capturedListInboxDeltaCalls.push(args);
    if (this.listInboxDeltaOutcome === "TERMINAL_INVALID_GRANT") {
      throw makeMsalError({ errorCode: "invalid_grant" });
    }
    if (this.listInboxDeltaOutcome === "RETRYABLE_THROTTLE") {
      throw makeMsalError({ errorCode: "temporarily_unavailable", response: { status: 429 } });
    }
    // Enforce the same continuation-URL validation as the real
    // provider so the mock catches URL-validation bugs at test time.
    if (args.continuationUrl) {
      assertMicrosoftGraphDeltaUrl(args.continuationUrl);
    }
    const page = this.deltaPages.shift();
    if (!page) {
      throw new Error(
        "MockMicrosoftDelegatedProvider.listInboxMessagesDelta: no more fixture pages configured — did the caller loop past the intended boundary?",
      );
    }
    return page;
  }
}

function makeMsalError(fields: { errorCode: string; errorNo?: string; subError?: string; response?: { status: number } }): Error {
  const err = new Error(`Mock MSAL error: ${fields.errorCode}`);
  Object.assign(err, fields);
  return err;
}
