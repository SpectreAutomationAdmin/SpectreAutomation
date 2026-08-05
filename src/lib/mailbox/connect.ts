// Sprint 2 B2 (2026-07-19) — Delegated Microsoft Graph mailbox
// connection service.
//
// Orchestrates the OAuth flow, token persistence, and disconnect
// semantics per §§3–10 of the B2 directive. Every Graph call is
// routed through the `MicrosoftDelegatedProvider` boundary so tests
// can inject `MockMicrosoftDelegatedProvider` without touching
// Microsoft's servers.
//
// Notes on the "SecretRef" column naming — the columns
// `accessTokenSecretRef` and `refreshTokenSecretRef` on
// MailboxConnection store the CIPHERTEXT blob returned by
// `encryptSecret()`. The stable secret-reference identifier used by
// KMS bookkeeping is constructed here as
// `mailbox:{connectionId}:access` / `:refresh`. The column names are
// kept per the B1 schema so downstream code (§8) reads them as
// "secret material to feed decryptSecret".

import { randomBytes, createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { env, isMailboxIntegrationEnabled, mailboxRedirectUri } from "@/lib/env";
import { encryptSecret, decryptSecret } from "@/lib/kms";
import type { Prisma } from "@prisma/client";
import {
  APPROVED_DELEGATED_SCOPES,
  defaultRedirectUri,
  getMicrosoftDelegatedProvider,
  type TokenResponse,
} from "@/lib/integrations/microsoft-graph-delegated";
import { MAILBOX_STATUS, assertMailboxStatusTransition, isTerminalStatus } from "./status";
import {
  MAILBOX_ERROR_CODE,
  MailboxFlowError,
  classifyMsalError,
  type MailboxErrorCode,
} from "./errors";
import {
  MAILBOX_AUDIT_ACTION,
  auditMailboxEvent,
} from "./audit";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const TRANSACTION_TTL_MS = 10 * 60 * 1000; // 10 minutes
const ACCESS_TOKEN_REFRESH_BUFFER_MS = 60 * 1000; // 60s safety window
// Personal Microsoft account tenant guid. Rejected in
// finaliseConnection() so a user cannot connect their @outlook.com
// account through the "organizations" audience if they somehow slip
// past the identity-platform layer.
const PERSONAL_MSA_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";
// Internal-return allowlist — every returnPath MUST start with one
// of these to defeat open-redirect attacks. See §3 of B2 directive.
const RETURN_PATH_ALLOWLIST = ["/app/user/settings", "/app/admin/mission-control", "/app"];

// ---------------------------------------------------------------------------
// ID helpers
// ---------------------------------------------------------------------------
// Sprint 2 B3 hardening (2026-07-19). Generate the connection ID BEFORE
// any DB row exists so encryption can proceed against a stable secret
// reference. If encryption fails, the ID is discarded — no half-created
// MailboxConnection row can survive. The `mc_` prefix mirrors the
// project convention for locally-generated identifiers.
function generateConnectionId(): string {
  return `mc_${randomBytes(16).toString("hex")}`;
}
function secretReferenceForAccess(connectionId: string): string {
  return `mailbox:${connectionId}:access`;
}
function secretReferenceForRefresh(connectionId: string): string {
  return `mailbox:${connectionId}:refresh`;
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------
function base64url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function generatePkceVerifier(): string {
  return base64url(randomBytes(32));
}
function pkceChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}
function generateState(): string {
  return base64url(randomBytes(32));
}
function generateNonce(): string {
  return base64url(randomBytes(24));
}

export function assertReturnPathSafe(returnPath: string): void {
  if (!returnPath.startsWith("/")) {
    throw new MailboxFlowError(MAILBOX_ERROR_CODE.OAUTH_UNSAFE_RETURN_URL, { returnPath });
  }
  const allowed = RETURN_PATH_ALLOWLIST.some((p) => returnPath === p || returnPath.startsWith(p + "/") || returnPath.startsWith(p + "?"));
  if (!allowed) {
    throw new MailboxFlowError(MAILBOX_ERROR_CODE.OAUTH_UNSAFE_RETURN_URL, { returnPath });
  }
}

function assertFeatureEnabled(): void {
  if (!isMailboxIntegrationEnabled()) {
    throw new MailboxFlowError(MAILBOX_ERROR_CODE.FEATURE_DISABLED);
  }
}

// ---------------------------------------------------------------------------
// startConnect — creates the OAuth transaction row and returns the
// Microsoft authorization URL. Called by the /connect route.
// ---------------------------------------------------------------------------
export async function startConnect(args: {
  userId: string;
  clubId: string;
  returnPath: string;
  loginHint?: string;
  // Sprint 3 · Checkpoint 16H remediation (2026-08-05) — when the
  // caller is updating permissions on an already-connected mailbox,
  // it passes the connection id. startConnect derives loginHint +
  // captures the expected identity on the transaction row so the
  // callback can validate the returning Microsoft identity BEFORE
  // any token write.
  expectedMailboxConnectionId?: string;
}): Promise<{ authorizationUrl: string; transactionId: string }> {
  assertFeatureEnabled();
  assertReturnPathSafe(args.returnPath);

  // Resolve expected-identity fields from the connection row when
  // caller provided the id. Enforces tenant + user ownership before
  // trusting anything from the connection.
  let expectedMailboxConnectionId: string | null = null;
  let expectedExternalUserId: string | null = null;
  let expectedExternalTenantId: string | null = null;
  let derivedLoginHint: string | undefined = args.loginHint;
  if (args.expectedMailboxConnectionId) {
    const conn = await prisma.mailboxConnection.findUnique({
      where: { id: args.expectedMailboxConnectionId },
      select: {
        id: true, userId: true, clubId: true,
        externalUserId: true, microsoftTenantId: true,
        connectedEmail: true, mailboxType: true,
      },
    });
    if (!conn) throw new MailboxFlowError(MAILBOX_ERROR_CODE.CONNECTION_NOT_FOUND);
    // Cross-club / cross-user protection — the caller must own the mailbox.
    if (conn.userId !== args.userId || conn.clubId !== args.clubId) {
      throw new MailboxFlowError(MAILBOX_ERROR_CODE.PERMISSION_DENIED, { reason: "cross-user-or-club-permission-update" });
    }
    expectedMailboxConnectionId = conn.id;
    expectedExternalUserId = conn.externalUserId ?? null;
    expectedExternalTenantId = conn.microsoftTenantId ?? null;
    // login_hint is an identity-selection AID (not a security control).
    // The callback still validates the returned identity server-side.
    if (!derivedLoginHint && conn.connectedEmail) derivedLoginHint = conn.connectedEmail;
  }

  const state = generateState();
  const pkceVerifier = generatePkceVerifier();
  const nonce = generateNonce();
  const now = new Date();
  const transaction = await prisma.mailboxOAuthTransaction.create({
    data: {
      state,
      userId: args.userId,
      clubId: args.clubId,
      pkceVerifier,
      nonce,
      returnPath: args.returnPath,
      expiresAt: new Date(now.getTime() + TRANSACTION_TTL_MS),
      expectedMailboxConnectionId,
      expectedExternalUserId,
      expectedExternalTenantId,
    },
  });
  const provider = getMicrosoftDelegatedProvider();
  const authorizationUrl = await provider.buildAuthorizationUrl({
    state,
    pkceCodeChallenge: pkceChallenge(pkceVerifier),
    pkceMethod: "S256",
    nonce,
    loginHint: derivedLoginHint,
    redirectUri: mailboxRedirectUri(),
  });

  await auditMailboxEvent(MAILBOX_AUDIT_ACTION.CONNECT_INITIATED, {
    clubId: args.clubId,
    userId: args.userId,
    provider: "MICROSOFT_365",
    extra: {
      transactionId: transaction.id,
      permissionUpdateFlow: !!expectedMailboxConnectionId,
    },
  });
  return { authorizationUrl, transactionId: transaction.id };
}

// ---------------------------------------------------------------------------
// finaliseConnection — consumes the transaction, exchanges the code,
// validates identity, upserts the mailbox connection, encrypts and
// stores tokens. Called by the /callback route.
// ---------------------------------------------------------------------------
export interface FinaliseConnectionArgs {
  state: string;
  code?: string;
  microsoftError?: string;
  microsoftErrorDescription?: string;
  callerUserId: string; // The session's Spectre user — validated against transaction.userId
  callerClubId: string; // The session's active club — validated against transaction.clubId
  ip?: string;
  userAgent?: string;
}

export interface FinaliseConnectionResult {
  mailboxConnectionId: string;
  returnPath: string;
  status: (typeof MAILBOX_STATUS)[keyof typeof MAILBOX_STATUS];
  isReconnect: boolean;
}

export async function finaliseConnection(args: FinaliseConnectionArgs): Promise<FinaliseConnectionResult> {
  assertFeatureEnabled();

  // Load transaction and enforce single-use + expiry BEFORE touching Graph.
  if (!args.state) {
    throw new MailboxFlowError(MAILBOX_ERROR_CODE.OAUTH_STATE_MISSING);
  }
  const transaction = await prisma.mailboxOAuthTransaction.findUnique({ where: { state: args.state } });
  if (!transaction) throw new MailboxFlowError(MAILBOX_ERROR_CODE.OAUTH_STATE_UNKNOWN);
  if (transaction.consumedAt) {
    throw new MailboxFlowError(MAILBOX_ERROR_CODE.OAUTH_STATE_REPLAY, { transactionId: transaction.id });
  }
  if (transaction.expiresAt.getTime() < Date.now()) {
    await markTransactionOutcome(transaction.id, "EXPIRED");
    throw new MailboxFlowError(MAILBOX_ERROR_CODE.OAUTH_STATE_EXPIRED, { transactionId: transaction.id });
  }
  if (transaction.userId !== args.callerUserId) {
    await markTransactionOutcome(transaction.id, "USER_MISMATCH");
    throw new MailboxFlowError(MAILBOX_ERROR_CODE.OAUTH_USER_MISMATCH, { transactionId: transaction.id });
  }
  if (transaction.clubId !== args.callerClubId) {
    await markTransactionOutcome(transaction.id, "CLUB_MISMATCH");
    throw new MailboxFlowError(MAILBOX_ERROR_CODE.OAUTH_CLUB_MISMATCH, { transactionId: transaction.id });
  }

  // Handle Microsoft error redirects (user denied consent, admin
  // approval required, etc.) BEFORE attempting a code exchange.
  if (args.microsoftError) {
    const code = args.microsoftError === "access_denied"
      ? MAILBOX_ERROR_CODE.OAUTH_DENIED_BY_USER
      : args.microsoftError === "consent_required" || args.microsoftError === "interaction_required"
        ? MAILBOX_ERROR_CODE.OAUTH_ADMIN_CONSENT_REQUIRED
        : MAILBOX_ERROR_CODE.OAUTH_CODE_EXCHANGE_FAILED;
    await markTransactionOutcome(transaction.id, code === MAILBOX_ERROR_CODE.OAUTH_DENIED_BY_USER ? "DENIED" : "CODE_EXCHANGE_FAILED");
    await auditMailboxEvent(MAILBOX_AUDIT_ACTION.CONSENT_DENIED, {
      clubId: transaction.clubId,
      userId: transaction.userId,
      provider: "MICROSOFT_365",
      errorCode: code,
    });
    throw new MailboxFlowError(code, { microsoftError: args.microsoftError });
  }

  if (!args.code) {
    await markTransactionOutcome(transaction.id, "CODE_EXCHANGE_FAILED");
    throw new MailboxFlowError(MAILBOX_ERROR_CODE.OAUTH_CODE_EXCHANGE_FAILED, { reason: "code missing" });
  }

  const provider = getMicrosoftDelegatedProvider();

  // Mark the transaction consumed BEFORE token exchange so a
  // second concurrent callback with the same state finds it
  // consumed and rejects as a replay. If the exchange itself
  // fails afterwards we update the outcome; the transaction
  // remains consumed either way.
  await prisma.mailboxOAuthTransaction.update({
    where: { id: transaction.id, consumedAt: null },
    data: { consumedAt: new Date() },
  }).catch(async () => {
    // The row was consumed in a race — treat as replay.
    throw new MailboxFlowError(MAILBOX_ERROR_CODE.OAUTH_STATE_REPLAY, { transactionId: transaction.id });
  });

  let tokenResponse: TokenResponse;
  try {
    tokenResponse = await provider.exchangeCode({
      code: args.code,
      state: args.state,
      pkceCodeVerifier: transaction.pkceVerifier,
      redirectUri: defaultRedirectUri(),
    });
  } catch (err) {
    await markTransactionOutcome(transaction.id, "CODE_EXCHANGE_FAILED");
    await auditMailboxEvent(MAILBOX_AUDIT_ACTION.CONNECT_FAILED, {
      clubId: transaction.clubId,
      userId: transaction.userId,
      provider: "MICROSOFT_365",
      errorCode: MAILBOX_ERROR_CODE.OAUTH_CODE_EXCHANGE_FAILED,
    });
    throw new MailboxFlowError(MAILBOX_ERROR_CODE.OAUTH_CODE_EXCHANGE_FAILED, { classification: classifyMsalError(err) });
  }

  // Validate id_token claims BEFORE we persist anything.
  const claims = tokenResponse.idTokenClaims;
  // 1. Nonce echo — mitigates token substitution.
  if (!claims.nonce || claims.nonce !== transaction.nonce) {
    await markTransactionOutcome(transaction.id, "IDENTITY_INVALID");
    throw new MailboxFlowError(MAILBOX_ERROR_CODE.OAUTH_NONCE_MISMATCH);
  }
  // 2. Reject personal Microsoft accounts FIRST — MSA identities
  //    carry both a well-known tenant guid and an "MSA" idp claim,
  //    AND their issuer is on login.live.com. Checking for the MSA
  //    signals before the issuer check gives the caller a precise
  //    error code ("this is a personal account, use a work one")
  //    instead of the generic "issuer invalid".
  const tenantId = claims.tid;
  const isPersonalAccount =
    tenantId === PERSONAL_MSA_TENANT_ID ||
    claims.idp === "MSA" ||
    (claims.iss ?? "").startsWith("https://login.live.com/");
  if (isPersonalAccount) {
    await markTransactionOutcome(transaction.id, "PERSONAL_ACCOUNT");
    await auditMailboxEvent(MAILBOX_AUDIT_ACTION.CONNECT_FAILED, {
      clubId: transaction.clubId,
      userId: transaction.userId,
      microsoftTenantId: tenantId ?? undefined,
      errorCode: MAILBOX_ERROR_CODE.OAUTH_PERSONAL_ACCOUNT_REJECTED,
    });
    throw new MailboxFlowError(MAILBOX_ERROR_CODE.OAUTH_PERSONAL_ACCOUNT_REJECTED, {
      tenantId: tenantId ?? "",
    });
  }
  // 3. Issuer must be a Microsoft organizations issuer.
  const issuer = claims.iss ?? "";
  if (!issuer.startsWith(env.MICROSOFT_GRAPH_AUTHORITY_HOST + "/") || issuer.startsWith(env.MICROSOFT_GRAPH_AUTHORITY_HOST + "/common")) {
    await markTransactionOutcome(transaction.id, "IDENTITY_INVALID");
    throw new MailboxFlowError(MAILBOX_ERROR_CODE.OAUTH_ISSUER_INVALID, { issuer });
  }
  if (!tenantId) {
    await markTransactionOutcome(transaction.id, "TENANT_MISMATCH");
    throw new MailboxFlowError(MAILBOX_ERROR_CODE.OAUTH_TENANT_MISSING);
  }
  const externalUserId = claims.oid;
  if (!externalUserId) {
    await markTransactionOutcome(transaction.id, "IDENTITY_INVALID");
    throw new MailboxFlowError(MAILBOX_ERROR_CODE.OAUTH_ISSUER_INVALID, { reason: "oid claim missing" });
  }

  // Authoritative identity lookup from Graph /me.
  let me;
  try {
    me = await provider.getMe(tokenResponse.accessToken);
  } catch (err) {
    await markTransactionOutcome(transaction.id, "ME_FAILED");
    throw new MailboxFlowError(MAILBOX_ERROR_CODE.OAUTH_ME_FAILED, { reason: (err as Error).message });
  }
  const connectedEmail = me.mail ?? me.userPrincipalName ?? claims.preferred_username ?? claims.email ?? null;
  if (!connectedEmail) {
    await markTransactionOutcome(transaction.id, "IDENTITY_INVALID");
    throw new MailboxFlowError(MAILBOX_ERROR_CODE.OAUTH_MAILBOX_ADDRESS_MISSING);
  }

  // Sprint 3 · Checkpoint 16H remediation (2026-08-05) — expected-
  // identity gate.
  //
  // When the transaction was started with expectedMailboxConnectionId
  // (permission-update reconnect flow), the returned Microsoft
  // identity MUST match the stored expected identity. Any mismatch
  // → refuse WITHOUT touching tokens, WITHOUT modifying grantedScopes,
  // WITHOUT disconnecting the working mailbox. login_hint on the
  // authorization URL is an identity-selection aid; this server-side
  // comparison is authoritative.
  if (transaction.expectedMailboxConnectionId) {
    const expectedOidMismatch =
      transaction.expectedExternalUserId != null &&
      transaction.expectedExternalUserId !== externalUserId;
    const expectedTidMismatch =
      transaction.expectedExternalTenantId != null &&
      transaction.expectedExternalTenantId !== tenantId;
    if (expectedOidMismatch || expectedTidMismatch) {
      await markTransactionOutcome(transaction.id, "PERMISSION_UPDATE_IDENTITY_MISMATCH");
      await auditMailboxEvent(MAILBOX_AUDIT_ACTION.CONNECT_FAILED, {
        clubId: transaction.clubId, userId: transaction.userId,
        provider: "MICROSOFT_365", microsoftTenantId: tenantId,
        errorCode: MAILBOX_ERROR_CODE.PERMISSION_UPDATE_IDENTITY_MISMATCH,
        extra: {
          expectedConnectionId: transaction.expectedMailboxConnectionId,
          oidMismatch: expectedOidMismatch, tidMismatch: expectedTidMismatch,
        },
      });
      throw new MailboxFlowError(MAILBOX_ERROR_CODE.PERMISSION_UPDATE_IDENTITY_MISMATCH, {
        expectedConnectionId: transaction.expectedMailboxConnectionId,
      });
    }
  }

  // Uniqueness / policy checks. Wrapped so a throw here (e.g.
  // ACTIVE_PERSONAL_MAILBOX_REPLACEMENT_REQUIRED for a first-time
  // reconnect where different identity was picked without the
  // expected-identity contract) still marks the transaction outcome
  // — no more `outcome: null` leaks.
  try {
    await enforceMailboxUniqueness({
      userId: transaction.userId,
      clubId: transaction.clubId,
      microsoftTenantId: tenantId,
      externalUserId,
    });
  } catch (err) {
    if (err instanceof MailboxFlowError) {
      await markTransactionOutcome(transaction.id, `UNIQUENESS_${err.code}`);
    }
    throw err;
  }

  // Look up an existing connection FIRST, outside the transaction,
  // so we can encrypt against a stable id. Encryption performs its
  // own DB writes for KMS metadata and audit; running it inside the
  // wrapping transaction would deadlock the SQLite connection.
  const existing = await prisma.mailboxConnection.findUnique({
    where: {
      userId_clubId_provider_externalUserId: {
        userId: transaction.userId,
        clubId: transaction.clubId,
        provider: "MICROSOFT_365",
        externalUserId,
      },
    },
  });

  let mailboxConnectionId: string;
  let isReconnect = false;
  let previousStatus: string | null = null;

  // Sprint 2 B3 hardening (2026-07-19). Encrypt FIRST, insert the
  // row LAST. If encryption throws, no MailboxConnection row is ever
  // created — retry safely without accumulating half-connected
  // pseudo-connections. For reconnect, the existing row already has
  // an ID we can key the KMS reference to; if encryption fails there,
  // the row keeps its previous credentials and connect throws.
  if (existing) {
    previousStatus = existing.status;
    isReconnect = true;
    assertMailboxStatusTransition(previousStatus, MAILBOX_STATUS.CONNECTED_PENDING_SYNC);
    const accessCiphertext = await encryptSecret({
      scope: "MAILBOX",
      secretReference: secretReferenceForAccess(existing.id),
      plaintext: tokenResponse.accessToken,
      clubId: transaction.clubId,
      actorUserId: transaction.userId,
    });
    const refreshCiphertext = tokenResponse.refreshToken
      ? await encryptSecret({
          scope: "MAILBOX",
          secretReference: secretReferenceForRefresh(existing.id),
          plaintext: tokenResponse.refreshToken,
          clubId: transaction.clubId,
          actorUserId: transaction.userId,
        })
      : existing.refreshTokenSecretRef;
    await prisma.mailboxConnection.update({
      where: { id: existing.id },
      data: {
        accessTokenSecretRef: accessCiphertext,
        refreshTokenSecretRef: refreshCiphertext,
        accessTokenExpiresAt: tokenResponse.expiresOn,
        grantedScopes: [...tokenResponse.grantedScopes].join(" "),
        status: MAILBOX_STATUS.CONNECTED_PENDING_SYNC,
        disconnectedAt: null,
        disconnectedByUserId: null,
        lastSyncError: null,
        connectedEmail,
        microsoftTenantId: tenantId,
        tokenRevision: { increment: 1 },
      },
    });
    // Re-instate the owner MailboxAccess (revoked on prior disconnect).
    const owner = await prisma.mailboxAccess.findFirst({
      where: { mailboxConnectionId: existing.id, userId: transaction.userId, role: "OWNER" },
    });
    if (owner) {
      if (owner.revokedAt) {
        await prisma.mailboxAccess.update({
          where: { id: owner.id },
          data: { revokedAt: null, revokedByUserId: null },
        });
      }
    } else {
      await prisma.mailboxAccess.create({
        data: {
          mailboxConnectionId: existing.id,
          userId: transaction.userId,
          role: "OWNER",
          grantedByUserId: transaction.userId,
        },
      });
    }
    mailboxConnectionId = existing.id;
  } else {
    // Fresh connect — generate the connection ID up front so we can
    // key the KMS envelope. Encrypt both secrets. Only then does a
    // single atomic transaction create the row + owner access with
    // real ciphertext. If encryption throws, `newConnectionId` is
    // discarded and no row exists.
    const newConnectionId = generateConnectionId();
    const accessCiphertext = await encryptSecret({
      scope: "MAILBOX",
      secretReference: secretReferenceForAccess(newConnectionId),
      plaintext: tokenResponse.accessToken,
      clubId: transaction.clubId,
      actorUserId: transaction.userId,
    });
    const refreshCiphertext = tokenResponse.refreshToken
      ? await encryptSecret({
          scope: "MAILBOX",
          secretReference: secretReferenceForRefresh(newConnectionId),
          plaintext: tokenResponse.refreshToken,
          clubId: transaction.clubId,
          actorUserId: transaction.userId,
        })
      : null;
    try {
      await prisma.$transaction([
        prisma.mailboxConnection.create({
          data: {
            id: newConnectionId,
            userId: transaction.userId,
            clubId: transaction.clubId,
            provider: "MICROSOFT_365",
            mailboxType: "PERSONAL",
            externalUserId,
            microsoftTenantId: tenantId,
            connectedEmail,
            accessTokenSecretRef: accessCiphertext,
            refreshTokenSecretRef: refreshCiphertext,
            accessTokenExpiresAt: tokenResponse.expiresOn,
            grantedScopes: [...tokenResponse.grantedScopes].join(" "),
            status: MAILBOX_STATUS.CONNECTED_PENDING_SYNC,
            tokenRevision: 1,
          },
        }),
        prisma.mailboxAccess.create({
          data: {
            mailboxConnectionId: newConnectionId,
            userId: transaction.userId,
            role: "OWNER",
            grantedByUserId: transaction.userId,
          },
        }),
      ]);
    } catch (err) {
      // Row creation failed AFTER encryption succeeded. The KMS
      // metadata rows we produced are orphaned (their ciphertext is
      // not referenced by any MailboxConnection row). Delete them so
      // no dangling metadata accumulates and secretReferenceForAccess
      // stays available if the user retries.
      await prisma.encryptedSecretMetadata.deleteMany({
        where: {
          scope: "MAILBOX",
          secretReference: { in: [secretReferenceForAccess(newConnectionId), secretReferenceForRefresh(newConnectionId)] },
        },
      });
      throw err;
    }
    mailboxConnectionId = newConnectionId;
  }
  const result = { mailboxConnectionId, isReconnect, previousStatus };

  await markTransactionOutcome(transaction.id, "SUCCESS");
  await auditMailboxEvent(
    result.isReconnect ? MAILBOX_AUDIT_ACTION.CONNECT_RECONNECTED : MAILBOX_AUDIT_ACTION.CONNECT_COMPLETED,
    {
      clubId: transaction.clubId,
      userId: transaction.userId,
      mailboxConnectionId: result.mailboxConnectionId,
      provider: "MICROSOFT_365",
      microsoftTenantId: tenantId,
      connectedEmail,
      extra: result.previousStatus ? { previousStatus: result.previousStatus } : {},
      ip: args.ip,
      userAgent: args.userAgent,
    },
  );

  // Sprint 2 B4 (2026-07-19) — enqueue initial sync AFTER the row + owner
  // access are durable. The idempotency key includes the connection id so
  // reconnects don't spawn a second concurrent initial-sync job while the
  // first is still queued. Best-effort: a failed enqueue does not fail the
  // callback; the user can trigger Sync now.
  try {
    const { enqueue } = await import("@/lib/queue");
    await enqueue({
      kind: "MAILBOX_INITIAL_SYNC",
      payload: { mailboxConnectionId: result.mailboxConnectionId },
      clubId: transaction.clubId,
      idempotencyKey: `mailbox:initial-sync:${result.mailboxConnectionId}`,
      correlationId: `mailbox:${result.mailboxConnectionId}`,
    });
  } catch {
    // Swallow — connect succeeded; sync can be manually retried.
  }
  return {
    mailboxConnectionId: result.mailboxConnectionId,
    returnPath: transaction.returnPath,
    status: MAILBOX_STATUS.CONNECTED_PENDING_SYNC,
    isReconnect: result.isReconnect,
  };
  // A note on B4 hand-off: initial-sync enqueue is intentionally
  // NOT done here per §5 of the B2 directive. B4 will register a
  // MAILBOX_INITIAL_SYNC handler and enqueue from a follow-up step.
}

async function markTransactionOutcome(id: string, outcome: string): Promise<void> {
  await prisma.mailboxOAuthTransaction.updateMany({
    where: { id, outcome: null },
    data: { outcome, consumedAt: new Date() },
  });
}

// ---------------------------------------------------------------------------
// Uniqueness policy (§6 of B2 directive)
// ---------------------------------------------------------------------------
async function enforceMailboxUniqueness(args: {
  userId: string;
  clubId: string;
  microsoftTenantId: string;
  externalUserId: string;
}): Promise<void> {
  // Different Spectre user in this club already owns this Microsoft
  // mailbox as PERSONAL — reject.
  const conflict = await prisma.mailboxConnection.findFirst({
    where: {
      clubId: args.clubId,
      provider: "MICROSOFT_365",
      externalUserId: args.externalUserId,
      microsoftTenantId: args.microsoftTenantId,
      mailboxType: "PERSONAL",
      status: { notIn: [MAILBOX_STATUS.DISCONNECTED] },
      userId: { not: args.userId },
    },
    select: { id: true, userId: true },
  });
  if (conflict) {
    throw new MailboxFlowError(MAILBOX_ERROR_CODE.DUPLICATE_MAILBOX_DIFFERENT_USER, {
      existingConnectionId: conflict.id,
    });
  }
  // "One active personal mailbox per user per club." If the user
  // already has a different personal mailbox connected in this club,
  // require explicit replacement (B3 will surface the confirmation).
  const otherPersonal = await prisma.mailboxConnection.findFirst({
    where: {
      userId: args.userId,
      clubId: args.clubId,
      provider: "MICROSOFT_365",
      mailboxType: "PERSONAL",
      status: { notIn: [MAILBOX_STATUS.DISCONNECTED] },
      externalUserId: { not: args.externalUserId },
    },
    select: { id: true, connectedEmail: true },
  });
  if (otherPersonal) {
    throw new MailboxFlowError(MAILBOX_ERROR_CODE.ACTIVE_PERSONAL_MAILBOX_REPLACEMENT_REQUIRED, {
      existingConnectionId: otherPersonal.id,
      existingEmail: otherPersonal.connectedEmail,
    });
  }
  // Cross-club policy: for now, no user may connect the same
  // Microsoft mailbox as PERSONAL in more than one Spectre club.
  const crossClub = await prisma.mailboxConnection.findFirst({
    where: {
      provider: "MICROSOFT_365",
      microsoftTenantId: args.microsoftTenantId,
      externalUserId: args.externalUserId,
      mailboxType: "PERSONAL",
      status: { notIn: [MAILBOX_STATUS.DISCONNECTED] },
      clubId: { not: args.clubId },
    },
    select: { id: true },
  });
  if (crossClub) {
    throw new MailboxFlowError(MAILBOX_ERROR_CODE.CROSS_CLUB_MAILBOX_DENIED, {
      existingConnectionId: crossClub.id,
    });
  }
}

// ---------------------------------------------------------------------------
// Access-token retrieval with concurrency-safe refresh (§8 of B2 directive)
// ---------------------------------------------------------------------------
export async function getFreshDelegatedAccessToken(args: {
  mailboxConnectionId: string;
  callerClubId: string;
  callerUserId: string | null;
}): Promise<{ accessToken: string; expiresAt: Date }> {
  assertFeatureEnabled();
  const conn = await prisma.mailboxConnection.findUnique({
    where: { id: args.mailboxConnectionId },
  });
  if (!conn) throw new MailboxFlowError(MAILBOX_ERROR_CODE.CONNECTION_NOT_FOUND);
  if (conn.clubId !== args.callerClubId) {
    throw new MailboxFlowError(MAILBOX_ERROR_CODE.PERMISSION_DENIED, { reason: "cross-club-token-request" });
  }
  if (isTerminalStatus(conn.status)) {
    throw new MailboxFlowError(
      conn.status === MAILBOX_STATUS.REAUTH_REQUIRED
        ? MAILBOX_ERROR_CODE.REFRESH_TERMINAL
        : MAILBOX_ERROR_CODE.CONNECTION_ALREADY_DISCONNECTED,
      { status: conn.status },
    );
  }
  // Sprint 2 B3 hardening (2026-07-19) — nullable token refs mean
  // "credentials retired". A retired connection cannot be used even
  // if its status happens to be non-terminal — throw the same
  // reauth-required error the terminal branch throws.
  if (!conn.accessTokenSecretRef || !conn.refreshTokenSecretRef) {
    throw new MailboxFlowError(MAILBOX_ERROR_CODE.REFRESH_TERMINAL, { reason: "credentials-retired" });
  }
  // Cache-hit path — plenty of headroom on the current access token.
  if (conn.accessTokenExpiresAt.getTime() - Date.now() > ACCESS_TOKEN_REFRESH_BUFFER_MS) {
    const accessToken = await decryptSecret({
      scope: "MAILBOX",
      secretReference: secretReferenceForAccess(conn.id),
      ciphertext: conn.accessTokenSecretRef,
      clubId: conn.clubId,
      actorUserId: args.callerUserId,
    });
    return { accessToken, expiresAt: conn.accessTokenExpiresAt };
  }
  return refreshDelegatedAccessToken({ mailboxConnectionId: conn.id, callerUserId: args.callerUserId });
}

// Concurrency-safe refresh via optimistic CAS on tokenRevision.
async function refreshDelegatedAccessToken(args: {
  mailboxConnectionId: string;
  callerUserId: string | null;
}): Promise<{ accessToken: string; expiresAt: Date }> {
  const conn = await prisma.mailboxConnection.findUnique({ where: { id: args.mailboxConnectionId } });
  if (!conn) throw new MailboxFlowError(MAILBOX_ERROR_CODE.CONNECTION_NOT_FOUND);
  if (!conn.accessTokenSecretRef || !conn.refreshTokenSecretRef) {
    throw new MailboxFlowError(MAILBOX_ERROR_CODE.REFRESH_TERMINAL, { reason: "credentials-retired" });
  }
  const previousRevision = conn.tokenRevision;
  const currentRefreshToken = await decryptSecret({
    scope: "MAILBOX",
    secretReference: secretReferenceForRefresh(conn.id),
    ciphertext: conn.refreshTokenSecretRef,
    clubId: conn.clubId,
    actorUserId: args.callerUserId,
  });

  const provider = getMicrosoftDelegatedProvider();
  let tokenResponse: TokenResponse;
  try {
    tokenResponse = await provider.refreshToken(currentRefreshToken);
  } catch (err) {
    const classification = classifyMsalError(err);
    await prisma.mailboxConnection.update({
      where: { id: conn.id },
      data: {
        lastSyncError: `refresh ${classification}`,
        status:
          classification === "terminal"
            ? MAILBOX_STATUS.REAUTH_REQUIRED
            : conn.status === MAILBOX_STATUS.CONNECTED
              ? MAILBOX_STATUS.CONNECTED
              : conn.status,
      },
    });
    await auditMailboxEvent(MAILBOX_AUDIT_ACTION.TOKEN_REFRESH_FAILED, {
      clubId: conn.clubId,
      userId: args.callerUserId,
      mailboxConnectionId: conn.id,
      errorCode: classification === "terminal" ? MAILBOX_ERROR_CODE.REFRESH_TERMINAL : MAILBOX_ERROR_CODE.REFRESH_RETRYABLE,
    });
    if (classification === "terminal") {
      await auditMailboxEvent(MAILBOX_AUDIT_ACTION.REAUTH_REQUIRED, {
        clubId: conn.clubId,
        userId: args.callerUserId,
        mailboxConnectionId: conn.id,
        errorCode: MAILBOX_ERROR_CODE.REFRESH_TERMINAL,
      });
    }
    throw new MailboxFlowError(
      classification === "terminal" ? MAILBOX_ERROR_CODE.REFRESH_TERMINAL : MAILBOX_ERROR_CODE.REFRESH_RETRYABLE,
    );
  }

  // Encrypt new secrets.
  const nextAccessCiphertext = await encryptSecret({
    scope: "MAILBOX",
    secretReference: secretReferenceForAccess(conn.id),
    plaintext: tokenResponse.accessToken,
    clubId: conn.clubId,
    actorUserId: args.callerUserId,
  });
  const nextRefreshCiphertext = tokenResponse.refreshToken
    ? await encryptSecret({
        scope: "MAILBOX",
        secretReference: secretReferenceForRefresh(conn.id),
        plaintext: tokenResponse.refreshToken,
        clubId: conn.clubId,
        actorUserId: args.callerUserId,
      })
    : null;

  // CAS write — only succeeds if no concurrent refresh already
  // advanced tokenRevision. On loss, reload and return the winner's
  // access token.
  const casResult = await prisma.mailboxConnection.updateMany({
    where: { id: conn.id, tokenRevision: previousRevision },
    data: {
      accessTokenSecretRef: nextAccessCiphertext,
      refreshTokenSecretRef: nextRefreshCiphertext ?? conn.refreshTokenSecretRef,
      accessTokenExpiresAt: tokenResponse.expiresOn,
      tokenRevision: { increment: 1 },
      lastSyncError: null,
      status: conn.status === MAILBOX_STATUS.REAUTH_REQUIRED
        ? conn.status // should not happen — terminal status blocked at top
        : conn.status === MAILBOX_STATUS.CONNECTED
          ? MAILBOX_STATUS.CONNECTED
          : conn.status,
    },
  });
  if (casResult.count === 0) {
    // We lost the race. Read the fresh connection and reuse the
    // winner's access token. The refresh token we just successfully
    // exchanged is now stale from Microsoft's side (rotated by the
    // winner's exchange), but the winner already stored the new
    // one — safe to discard the loser's tokens.
    const winner = await prisma.mailboxConnection.findUnique({ where: { id: conn.id } });
    if (!winner) throw new MailboxFlowError(MAILBOX_ERROR_CODE.CONNECTION_NOT_FOUND);
    if (!winner.accessTokenSecretRef) {
      throw new MailboxFlowError(MAILBOX_ERROR_CODE.REFRESH_TERMINAL, { reason: "credentials-retired" });
    }
    const accessToken = await decryptSecret({
      scope: "MAILBOX",
      secretReference: secretReferenceForAccess(winner.id),
      ciphertext: winner.accessTokenSecretRef,
      clubId: winner.clubId,
      actorUserId: args.callerUserId,
    });
    return { accessToken, expiresAt: winner.accessTokenExpiresAt };
  }

  await auditMailboxEvent(MAILBOX_AUDIT_ACTION.TOKEN_REFRESHED, {
    clubId: conn.clubId,
    userId: args.callerUserId,
    mailboxConnectionId: conn.id,
    extra: { rotated: nextRefreshCiphertext ? "yes" : "no" },
  });
  return { accessToken: tokenResponse.accessToken, expiresAt: tokenResponse.expiresOn };
}

// ---------------------------------------------------------------------------
// Disconnect
// ---------------------------------------------------------------------------
export async function disconnectMailbox(args: {
  mailboxConnectionId: string;
  callerUserId: string;
  callerClubId: string;
  ip?: string;
  userAgent?: string;
}): Promise<{ status: (typeof MAILBOX_STATUS)[keyof typeof MAILBOX_STATUS] }> {
  assertFeatureEnabled();
  const conn = await prisma.mailboxConnection.findUnique({
    where: { id: args.mailboxConnectionId },
    include: { accesses: true },
  });
  if (!conn) throw new MailboxFlowError(MAILBOX_ERROR_CODE.CONNECTION_NOT_FOUND);
  if (conn.clubId !== args.callerClubId) {
    throw new MailboxFlowError(MAILBOX_ERROR_CODE.PERMISSION_DENIED, { reason: "cross-club-disconnect" });
  }
  // Ownership check considers ANY access row this user ever held on
  // this connection — including revoked ones. This makes disconnect
  // idempotent (a second disconnect after we already revoked the
  // OWNER row still recognises the connecting user) AND still
  // rejects a stranger who never owned the mailbox.
  const owns = conn.accesses.some(
    (a) => a.userId === args.callerUserId && (a.role === "OWNER" || a.role === "MANAGER"),
  );
  if (!owns) throw new MailboxFlowError(MAILBOX_ERROR_CODE.PERMISSION_DENIED, { reason: "not-mailbox-owner" });
  if (conn.status === MAILBOX_STATUS.DISCONNECTED) {
    // Idempotent no-op.
    return { status: MAILBOX_STATUS.DISCONNECTED };
  }
  assertMailboxStatusTransition(conn.status, MAILBOX_STATUS.DISCONNECTED);

  // Sprint 2 B3 hardening (2026-07-19) — explicit secret retirement.
  // Null the token reference columns and DELETE the KMS metadata
  // rows for this connection's secrets. Any future call to decrypt
  // these references will fail because (a) the ref column is null on
  // the row, and (b) there is no metadata row identifying the key
  // that would decrypt the (nonexistent) ciphertext. There is no
  // encrypted-empty-string convention any more.
  await prisma.$transaction([
    prisma.mailboxConnection.update({
      where: { id: conn.id },
      data: {
        status: MAILBOX_STATUS.DISCONNECTED,
        disconnectedAt: new Date(),
        disconnectedByUserId: args.callerUserId,
        accessTokenSecretRef: null,
        refreshTokenSecretRef: null,
        tokenRevision: { increment: 1 },
        accessTokenExpiresAt: new Date(0),
        lastSyncError: null,
      },
    }),
    prisma.mailboxAccess.updateMany({
      where: { mailboxConnectionId: conn.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedByUserId: args.callerUserId },
    }),
    prisma.encryptedSecretMetadata.deleteMany({
      where: {
        scope: "MAILBOX",
        secretReference: {
          in: [secretReferenceForAccess(conn.id), secretReferenceForRefresh(conn.id)],
        },
      },
    }),
  ]);

  await auditMailboxEvent(MAILBOX_AUDIT_ACTION.DISCONNECTED, {
    clubId: conn.clubId,
    userId: args.callerUserId,
    mailboxConnectionId: conn.id,
    ip: args.ip,
    userAgent: args.userAgent,
  });

  // Extension points for B4 / C1 — no-ops today:
  //   • cancel queued MAILBOX_* jobs for this connection
  //   • delete Graph subscriptions (GraphSubscription rows)
  //   • stop reconciliation heartbeat entries
  // Left as TODO markers wired through named service functions so
  // downstream slices can implement them without touching this file.

  return { status: MAILBOX_STATUS.DISCONNECTED };
}

// ---------------------------------------------------------------------------
// Public error-code type for API routes to translate to HTTP status
// ---------------------------------------------------------------------------
export type { MailboxErrorCode };
