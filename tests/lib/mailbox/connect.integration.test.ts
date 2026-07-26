// Sprint 2 B2 (2026-07-19) — Mocked end-to-end OAuth round trip
// against a real Prisma test database. Uses
// MockMicrosoftDelegatedProvider; NEVER hits Microsoft.
//
// Covers §13 (security tests) of the B2 directive.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  setMicrosoftDelegatedProvider,
} from "@/lib/integrations/microsoft-graph-delegated";
import {
  MockMicrosoftDelegatedProvider,
  type MockProviderConfig,
} from "@/lib/integrations/microsoft-graph-delegated-mock";
import {
  startConnect,
  finaliseConnection,
  disconnectMailbox,
  getFreshDelegatedAccessToken,
} from "@/lib/mailbox/connect";
import { MailboxFlowError } from "@/lib/mailbox/errors";
import { MAILBOX_STATUS } from "@/lib/mailbox/status";

// --------------------------------------------------------------------------
// Fixture setup helpers
// --------------------------------------------------------------------------

async function seedClubAndUser(prefix: string) {
  const club = await prisma.club.create({
    data: { name: `Test Club ${prefix}`, slug: `test-club-${prefix}-${Date.now()}` },
  });
  const user = await prisma.user.create({
    data: {
      name: `Test User ${prefix}`,
      email: `${prefix}-${Date.now()}@example.test`,
      role: "CLUB_ADMIN",
      passwordHash: "not-used-in-these-tests",
      clubId: club.id,
    },
  });
  return { clubId: club.id, userId: user.id };
}

let PROVIDER_INSTANCE_COUNT = 0;
function makeMockProvider(overrides: Partial<MockProviderConfig> = {}): MockMicrosoftDelegatedProvider {
  // Vary the external identity per instantiation so cross-test
  // bleed does not trip the uniqueness policy. Individual tests
  // override this when they specifically need a fixed identity
  // (e.g. reconnect / same-user tests re-use the same provider).
  PROVIDER_INSTANCE_COUNT += 1;
  const suffix = `${Date.now()}_${PROVIDER_INSTANCE_COUNT}`;
  return new MockMicrosoftDelegatedProvider({
    tenantId: "00000000-0000-0000-0000-tenant00abc0",
    externalUserId: `extuser_${suffix}`,
    connectedEmail: `user_${suffix}@corporate.example.test`,
    displayName: "Corporate User",
    ...overrides,
  });
}

// Complete a full connect + callback via the two service functions,
// mirroring what /connect and /callback do minus the HTTP layer.
async function runOAuthRoundTrip(args: {
  provider: MockMicrosoftDelegatedProvider;
  userId: string;
  clubId: string;
  returnPath?: string;
}) {
  setMicrosoftDelegatedProvider(args.provider);
  const { authorizationUrl, transactionId } = await startConnect({
    userId: args.userId,
    clubId: args.clubId,
    returnPath: args.returnPath ?? "/app/user/settings",
  });
  const url = new URL(authorizationUrl);
  const state = url.searchParams.get("state")!;
  // The mock provider echoes nonce=verifier by default when unset.
  // We look the real nonce up out of the transaction row and update
  // the provider's echoNonce so the finaliseConnection nonce check
  // passes. Real Microsoft handles this without our help.
  const tx = await prisma.mailboxOAuthTransaction.findUnique({ where: { state } });
  args.provider.updateConfig({ echoNonce: tx!.nonce });
  const result = await finaliseConnection({
    state,
    code: "auth_code_from_mock",
    callerUserId: args.userId,
    callerClubId: args.clubId,
  });
  return { transactionId, mailboxConnectionId: result.mailboxConnectionId, result };
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe("mailbox — mocked OAuth round trip (success path)", () => {
  let userId: string;
  let clubId: string;
  beforeEach(async () => {
    ({ userId, clubId } = await seedClubAndUser("happy"));
  });
  afterEach(() => setMicrosoftDelegatedProvider(null));

  it("connects a fresh mailbox and lands in CONNECTED_PENDING_SYNC", async () => {
    const provider = makeMockProvider();
    const { mailboxConnectionId } = await runOAuthRoundTrip({ provider, userId, clubId });
    const conn = await prisma.mailboxConnection.findUnique({ where: { id: mailboxConnectionId } });
    expect(conn?.status).toBe(MAILBOX_STATUS.CONNECTED_PENDING_SYNC);
    expect(conn?.connectedEmail).toBe(provider.identity().connectedEmail);
    expect(conn?.mailboxType).toBe("PERSONAL");
    expect(conn?.tokenRevision).toBeGreaterThan(0);
    expect(conn?.grantedScopes).toContain("Mail.Read");
    // Owner MailboxAccess row exists
    const access = await prisma.mailboxAccess.findFirst({
      where: { mailboxConnectionId, userId, role: "OWNER" },
    });
    expect(access).not.toBeNull();
    expect(access?.revokedAt).toBeNull();
  });

  it("stores tokens as KMS ciphertext, never plaintext", async () => {
    const provider = makeMockProvider();
    const { mailboxConnectionId } = await runOAuthRoundTrip({ provider, userId, clubId });
    const conn = await prisma.mailboxConnection.findUnique({ where: { id: mailboxConnectionId } });
    // Ciphertext MUST start with the envelope prefix, never the mock
    // token literal.
    expect(conn?.accessTokenSecretRef).toBeTruthy();
    expect(conn?.refreshTokenSecretRef).toBeTruthy();
    expect(conn!.accessTokenSecretRef!.startsWith("enc:")).toBe(true);
    expect(conn!.refreshTokenSecretRef!.startsWith("enc:")).toBe(true);
    // Absolutely no leaked plaintext of the mock token.
    expect(conn!.accessTokenSecretRef!.includes("mock_at_")).toBe(false);
    expect(conn!.refreshTokenSecretRef!.includes("mock_rt_")).toBe(false);
  });

  it("reconnecting the same mailbox updates the existing connection and rotates tokens", async () => {
    const provider = makeMockProvider();
    const first = await runOAuthRoundTrip({ provider, userId, clubId });
    const before = await prisma.mailboxConnection.findUnique({ where: { id: first.mailboxConnectionId } });
    const second = await runOAuthRoundTrip({ provider, userId, clubId });
    expect(second.mailboxConnectionId).toBe(first.mailboxConnectionId);
    const after = await prisma.mailboxConnection.findUnique({ where: { id: first.mailboxConnectionId } });
    expect(after!.tokenRevision).toBeGreaterThan(before!.tokenRevision);
    // Second CONNECT_COMPLETED audit exists.
    const audits = await prisma.auditLog.findMany({
      where: { entityType: "MailboxConnection", entityId: first.mailboxConnectionId },
    });
    expect(audits.length).toBeGreaterThanOrEqual(2);
  });

  it("audit records include tenant + email but NEVER tokens or codes", async () => {
    const provider = makeMockProvider();
    const { mailboxConnectionId } = await runOAuthRoundTrip({ provider, userId, clubId });
    const audits = await prisma.auditLog.findMany({
      where: { entityType: "MailboxConnection", entityId: mailboxConnectionId },
    });
    expect(audits.length).toBeGreaterThan(0);
    for (const row of audits) {
      const meta = row.metaJson ?? "";
      expect(meta).not.toContain("mock_at_");
      expect(meta).not.toContain("mock_rt_");
      expect(meta).not.toContain("auth_code_from_mock");
      // Sanity: an audit for a real connect DOES capture the tenant.
      if (row.action === "mailbox.connect.completed") {
        expect(meta).toContain("tenant00abc0");
      }
    }
  });

  it("refreshDelegatedAccessToken cache-hits when the token is fresh", async () => {
    const provider = makeMockProvider();
    const { mailboxConnectionId } = await runOAuthRoundTrip({ provider, userId, clubId });
    const provider2 = makeMockProvider();
    setMicrosoftDelegatedProvider(provider2);
    // Ask twice; only the KMS decrypt should be called, not the mock.
    await getFreshDelegatedAccessToken({ mailboxConnectionId, callerClubId: clubId, callerUserId: userId });
    await getFreshDelegatedAccessToken({ mailboxConnectionId, callerClubId: clubId, callerUserId: userId });
    expect(provider2.capturedRefreshCalls.length).toBe(0);
  });
});

describe("mailbox — OAuth security guards (§13)", () => {
  let userId: string;
  let clubId: string;
  beforeEach(async () => {
    ({ userId, clubId } = await seedClubAndUser("sec"));
  });
  afterEach(() => setMicrosoftDelegatedProvider(null));

  it("rejects a missing state", async () => {
    setMicrosoftDelegatedProvider(makeMockProvider());
    await expect(
      finaliseConnection({ state: "", code: "x", callerUserId: userId, callerClubId: clubId }),
    ).rejects.toMatchObject({ code: "oauth_state_missing" });
  });

  it("rejects an unknown state", async () => {
    setMicrosoftDelegatedProvider(makeMockProvider());
    await expect(
      finaliseConnection({ state: "never-issued", code: "x", callerUserId: userId, callerClubId: clubId }),
    ).rejects.toMatchObject({ code: "oauth_state_unknown" });
  });

  it("rejects state reuse (replay)", async () => {
    const provider = makeMockProvider();
    const { transactionId } = await runOAuthRoundTrip({ provider, userId, clubId });
    const tx = await prisma.mailboxOAuthTransaction.findUnique({ where: { id: transactionId } });
    setMicrosoftDelegatedProvider(makeMockProvider());
    await expect(
      finaliseConnection({ state: tx!.state, code: "auth_code_from_mock", callerUserId: userId, callerClubId: clubId }),
    ).rejects.toMatchObject({ code: "oauth_state_replay" });
  });

  it("rejects expired state", async () => {
    setMicrosoftDelegatedProvider(makeMockProvider());
    const started = await startConnect({ userId, clubId, returnPath: "/app/user/settings" });
    // Force expiry.
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    await prisma.mailboxOAuthTransaction.update({
      where: { state },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(
      finaliseConnection({ state, code: "x", callerUserId: userId, callerClubId: clubId }),
    ).rejects.toMatchObject({ code: "oauth_state_expired" });
  });

  it("rejects a callback that changes user identity mid-flow", async () => {
    setMicrosoftDelegatedProvider(makeMockProvider());
    const started = await startConnect({ userId, clubId, returnPath: "/app/user/settings" });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    const attacker = await seedClubAndUser("attacker");
    await expect(
      finaliseConnection({ state, code: "x", callerUserId: attacker.userId, callerClubId: clubId }),
    ).rejects.toMatchObject({ code: "oauth_user_mismatch" });
  });

  it("rejects a callback that switches club mid-flow", async () => {
    setMicrosoftDelegatedProvider(makeMockProvider());
    const started = await startConnect({ userId, clubId, returnPath: "/app/user/settings" });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    const otherClub = await prisma.club.create({ data: { name: "Other", slug: `other-${Date.now()}` } });
    await expect(
      finaliseConnection({ state, code: "x", callerUserId: userId, callerClubId: otherClub.id }),
    ).rejects.toMatchObject({ code: "oauth_club_mismatch" });
  });

  it("rejects a personal Microsoft account (MSA idp + Live issuer)", async () => {
    const provider = makeMockProvider({ exchangeOutcome: "PERSONAL_ACCOUNT" });
    setMicrosoftDelegatedProvider(provider);
    const started = await startConnect({ userId, clubId, returnPath: "/app/user/settings" });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    const tx = await prisma.mailboxOAuthTransaction.findUnique({ where: { state } });
    provider.updateConfig({ echoNonce: tx!.nonce });
    await expect(
      finaliseConnection({ state, code: "auth_code_from_mock", callerUserId: userId, callerClubId: clubId }),
    ).rejects.toMatchObject({ code: "oauth_personal_account_rejected" });
  });

  it("rejects unsafe return URLs", async () => {
    await expect(
      startConnect({ userId, clubId, returnPath: "https://evil.example.test" }),
    ).rejects.toMatchObject({ code: "oauth_unsafe_return_url" });
    await expect(
      startConnect({ userId, clubId, returnPath: "//attacker" }),
    ).rejects.toMatchObject({ code: "oauth_unsafe_return_url" });
    await expect(
      startConnect({ userId, clubId, returnPath: "/random-path" }),
    ).rejects.toMatchObject({ code: "oauth_unsafe_return_url" });
  });

  it("captures user-denied consent as a DENIED outcome with no connection created", async () => {
    setMicrosoftDelegatedProvider(makeMockProvider());
    const started = await startConnect({ userId, clubId, returnPath: "/app/user/settings" });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    await expect(
      finaliseConnection({
        state,
        microsoftError: "access_denied",
        callerUserId: userId,
        callerClubId: clubId,
      }),
    ).rejects.toMatchObject({ code: "oauth_denied_by_user" });
    const conn = await prisma.mailboxConnection.findFirst({ where: { userId, clubId } });
    expect(conn).toBeNull();
  });
});

describe("mailbox — uniqueness policy (§6)", () => {
  let userA: { userId: string; clubId: string };
  let userB: { userId: string; clubId: string };
  beforeEach(async () => {
    userA = await seedClubAndUser("uniqA");
    userB = { ...await seedClubAndUser("uniqB"), clubId: userA.clubId };
    // userB shares clubA.
    await prisma.user.update({ where: { id: userB.userId }, data: { clubId: userA.clubId } });
  });
  afterEach(() => setMicrosoftDelegatedProvider(null));

  it("prevents a different user in the same club from claiming the same Microsoft mailbox", async () => {
    const provider = makeMockProvider();
    await runOAuthRoundTrip({ provider, userId: userA.userId, clubId: userA.clubId });
    // Second attempt uses the SAME Microsoft identity — this is
    // exactly the conflict the guard must catch.
    const shared = provider.identity();
    const provider2 = new MockMicrosoftDelegatedProvider({ ...shared });
    setMicrosoftDelegatedProvider(provider2);
    const started = await startConnect({ userId: userB.userId, clubId: userA.clubId, returnPath: "/app/user/settings" });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    const tx = await prisma.mailboxOAuthTransaction.findUnique({ where: { state } });
    provider2.updateConfig({ echoNonce: tx!.nonce });
    await expect(
      finaliseConnection({ state, code: "auth_code_from_mock", callerUserId: userB.userId, callerClubId: userA.clubId }),
    ).rejects.toMatchObject({ code: "duplicate_mailbox_different_user" });
  });

  it("prevents connecting a second personal mailbox while an active one already exists", async () => {
    const provider = makeMockProvider();
    await runOAuthRoundTrip({ provider, userId: userA.userId, clubId: userA.clubId });
    const provider2 = makeMockProvider({ externalUserId: "different_extuser_222" });
    setMicrosoftDelegatedProvider(provider2);
    const started = await startConnect({ userId: userA.userId, clubId: userA.clubId, returnPath: "/app/user/settings" });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    const tx = await prisma.mailboxOAuthTransaction.findUnique({ where: { state } });
    provider2.updateConfig({ echoNonce: tx!.nonce });
    await expect(
      finaliseConnection({ state, code: "auth_code_from_mock", callerUserId: userA.userId, callerClubId: userA.clubId }),
    ).rejects.toMatchObject({ code: "active_personal_mailbox_replacement_required" });
  });
});

describe("mailbox — refresh lifecycle (§8)", () => {
  let userId: string;
  let clubId: string;
  let mailboxConnectionId: string;
  beforeEach(async () => {
    ({ userId, clubId } = await seedClubAndUser("ref"));
    const provider = makeMockProvider();
    const rt = await runOAuthRoundTrip({ provider, userId, clubId });
    mailboxConnectionId = rt.mailboxConnectionId;
    // Force the access token stale so getFreshDelegatedAccessToken triggers a refresh.
    await prisma.mailboxConnection.update({
      where: { id: mailboxConnectionId },
      data: { accessTokenExpiresAt: new Date(Date.now() - 60_000) },
    });
  });
  afterEach(() => setMicrosoftDelegatedProvider(null));

  it("refreshes when the current token is past the buffer, rotating tokenRevision", async () => {
    const provider = makeMockProvider();
    setMicrosoftDelegatedProvider(provider);
    const before = await prisma.mailboxConnection.findUnique({ where: { id: mailboxConnectionId } });
    const result = await getFreshDelegatedAccessToken({ mailboxConnectionId, callerClubId: clubId, callerUserId: userId });
    const after = await prisma.mailboxConnection.findUnique({ where: { id: mailboxConnectionId } });
    expect(provider.capturedRefreshCalls.length).toBe(1);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(after!.tokenRevision).toBeGreaterThan(before!.tokenRevision);
  });

  it("survives the case where MSAL returns no new refresh token (retains previous one)", async () => {
    const provider = makeMockProvider({ refreshReturnsNoRefreshToken: true });
    setMicrosoftDelegatedProvider(provider);
    const before = await prisma.mailboxConnection.findUnique({ where: { id: mailboxConnectionId } });
    await getFreshDelegatedAccessToken({ mailboxConnectionId, callerClubId: clubId, callerUserId: userId });
    const after = await prisma.mailboxConnection.findUnique({ where: { id: mailboxConnectionId } });
    // refreshTokenSecretRef unchanged; accessTokenSecretRef changed.
    expect(after!.refreshTokenSecretRef).toBe(before!.refreshTokenSecretRef);
    expect(after!.accessTokenSecretRef).not.toBe(before!.accessTokenSecretRef);
  });

  it("flips the connection to REAUTH_REQUIRED on terminal invalid_grant", async () => {
    const provider = makeMockProvider({ refreshOutcome: "TERMINAL_INVALID_GRANT" });
    setMicrosoftDelegatedProvider(provider);
    await expect(
      getFreshDelegatedAccessToken({ mailboxConnectionId, callerClubId: clubId, callerUserId: userId }),
    ).rejects.toMatchObject({ code: "refresh_terminal" });
    const conn = await prisma.mailboxConnection.findUnique({ where: { id: mailboxConnectionId } });
    expect(conn?.status).toBe(MAILBOX_STATUS.REAUTH_REQUIRED);
  });

  it("keeps the connection usable after a retryable throttle and does not flip status", async () => {
    const provider = makeMockProvider({ refreshOutcome: "RETRYABLE_THROTTLE" });
    setMicrosoftDelegatedProvider(provider);
    await expect(
      getFreshDelegatedAccessToken({ mailboxConnectionId, callerClubId: clubId, callerUserId: userId }),
    ).rejects.toMatchObject({ code: "refresh_retryable" });
    const conn = await prisma.mailboxConnection.findUnique({ where: { id: mailboxConnectionId } });
    // Status was CONNECTED_PENDING_SYNC (or transitioned from it);
    // we assert it did NOT become REAUTH_REQUIRED.
    expect(conn?.status).not.toBe(MAILBOX_STATUS.REAUTH_REQUIRED);
  });

  it("concurrency: two simultaneous refreshes end with exactly one tokenRevision increment", async () => {
    const provider = makeMockProvider();
    setMicrosoftDelegatedProvider(provider);
    const before = await prisma.mailboxConnection.findUnique({ where: { id: mailboxConnectionId } });
    await Promise.all([
      getFreshDelegatedAccessToken({ mailboxConnectionId, callerClubId: clubId, callerUserId: userId }),
      getFreshDelegatedAccessToken({ mailboxConnectionId, callerClubId: clubId, callerUserId: userId }),
    ]);
    const after = await prisma.mailboxConnection.findUnique({ where: { id: mailboxConnectionId } });
    // Both callers observed the same fresh access token, but only
    // one CAS write landed — revision advances by 1, not 2.
    expect(after!.tokenRevision).toBe(before!.tokenRevision + 1);
  });
});

describe("mailbox — B3 hardening: no placeholder row on encryption failure", () => {
  let userId: string;
  let clubId: string;
  beforeEach(async () => {
    ({ userId, clubId } = await seedClubAndUser("harden"));
  });
  afterEach(() => setMicrosoftDelegatedProvider(null));

  it("throws when KMS encryption fails and leaves NO MailboxConnection row behind", async () => {
    // Simulate an encryption failure by pointing the KMS scope at a
    // non-existent provider mid-flow. We do that via a spy that
    // rejects only when the "MAILBOX" scope is used with a
    // secret_reference that matches our pattern.
    const kms = await import("@/lib/kms");
    const original = kms.encryptSecret;
    const encryptSpy = vi.spyOn(kms, "encryptSecret").mockImplementation(async (args) => {
      if (args.scope === "MAILBOX") {
        throw new Error("simulated KMS outage");
      }
      return original(args);
    });
    try {
      const provider = makeMockProvider();
      setMicrosoftDelegatedProvider(provider);
      const started = await startConnect({ userId, clubId, returnPath: "/app/user/settings" });
      const state = new URL(started.authorizationUrl).searchParams.get("state")!;
      const tx = await prisma.mailboxOAuthTransaction.findUnique({ where: { state } });
      provider.updateConfig({ echoNonce: tx!.nonce });
      await expect(
        finaliseConnection({ state, code: "auth_code_from_mock", callerUserId: userId, callerClubId: clubId }),
      ).rejects.toThrow(/simulated KMS outage/);
      // No connection row exists.
      const rows = await prisma.mailboxConnection.findMany({ where: { userId, clubId } });
      expect(rows).toHaveLength(0);
      // No orphaned MailboxAccess either.
      const access = await prisma.mailboxAccess.findMany({ where: { userId } });
      expect(access).toHaveLength(0);
    } finally {
      encryptSpy.mockRestore();
    }
  });

  it("repeated failed attempts do not accumulate rows", async () => {
    const kms = await import("@/lib/kms");
    const encryptSpy = vi.spyOn(kms, "encryptSecret").mockRejectedValue(new Error("still down"));
    try {
      for (let i = 0; i < 3; i++) {
        const provider = makeMockProvider();
        setMicrosoftDelegatedProvider(provider);
        const started = await startConnect({ userId, clubId, returnPath: "/app/user/settings" });
        const state = new URL(started.authorizationUrl).searchParams.get("state")!;
        const tx = await prisma.mailboxOAuthTransaction.findUnique({ where: { state } });
        provider.updateConfig({ echoNonce: tx!.nonce });
        await expect(
          finaliseConnection({ state, code: "auth_code_from_mock", callerUserId: userId, callerClubId: clubId }),
        ).rejects.toThrow();
      }
      const rows = await prisma.mailboxConnection.findMany({ where: { userId, clubId } });
      expect(rows).toHaveLength(0);
    } finally {
      encryptSpy.mockRestore();
    }
  });

  it("reconnect after prior encryption failure succeeds without a lingering placeholder", async () => {
    const kms = await import("@/lib/kms");
    const encryptSpy = vi.spyOn(kms, "encryptSecret").mockRejectedValueOnce(new Error("transient"));
    try {
      // First attempt fails.
      const p1 = makeMockProvider();
      setMicrosoftDelegatedProvider(p1);
      const started = await startConnect({ userId, clubId, returnPath: "/app/user/settings" });
      const state = new URL(started.authorizationUrl).searchParams.get("state")!;
      const tx = await prisma.mailboxOAuthTransaction.findUnique({ where: { state } });
      p1.updateConfig({ echoNonce: tx!.nonce });
      await expect(
        finaliseConnection({ state, code: "auth_code_from_mock", callerUserId: userId, callerClubId: clubId }),
      ).rejects.toThrow();
      encryptSpy.mockRestore();
    } finally {
      // ensure restored
    }
    // Second attempt succeeds cleanly.
    const p2 = makeMockProvider();
    const { mailboxConnectionId } = await runOAuthRoundTrip({ provider: p2, userId, clubId });
    const rows = await prisma.mailboxConnection.findMany({ where: { userId, clubId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(mailboxConnectionId);
    expect(rows[0].accessTokenSecretRef).toBeTruthy();
  });
});

describe("mailbox — B3 hardening: explicit secret retirement on disconnect", () => {
  let userId: string;
  let clubId: string;
  let mailboxConnectionId: string;
  beforeEach(async () => {
    ({ userId, clubId } = await seedClubAndUser("retire"));
    const provider = makeMockProvider();
    const rt = await runOAuthRoundTrip({ provider, userId, clubId });
    mailboxConnectionId = rt.mailboxConnectionId;
  });
  afterEach(() => setMicrosoftDelegatedProvider(null));

  it("nulls the token reference columns", async () => {
    await disconnectMailbox({ mailboxConnectionId, callerUserId: userId, callerClubId: clubId });
    const conn = await prisma.mailboxConnection.findUnique({ where: { id: mailboxConnectionId } });
    expect(conn?.accessTokenSecretRef).toBeNull();
    expect(conn?.refreshTokenSecretRef).toBeNull();
  });

  it("deletes the KMS metadata rows for the connection's secrets", async () => {
    // Before disconnect: metadata rows exist for both secrets.
    const before = await prisma.encryptedSecretMetadata.findMany({
      where: {
        scope: "MAILBOX",
        secretReference: { in: [`mailbox:${mailboxConnectionId}:access`, `mailbox:${mailboxConnectionId}:refresh`] },
      },
    });
    expect(before.length).toBe(2);
    await disconnectMailbox({ mailboxConnectionId, callerUserId: userId, callerClubId: clubId });
    const after = await prisma.encryptedSecretMetadata.findMany({
      where: {
        scope: "MAILBOX",
        secretReference: { in: [`mailbox:${mailboxConnectionId}:access`, `mailbox:${mailboxConnectionId}:refresh`] },
      },
    });
    expect(after.length).toBe(0);
  });

  it("token retrieval on a disconnected connection throws (no empty-string decrypt)", async () => {
    await disconnectMailbox({ mailboxConnectionId, callerUserId: userId, callerClubId: clubId });
    // Either the terminal-status guard or the null-ref guard fires
    // first; both prevent any decrypt. The distinguishing point is
    // that NO ciphertext exists to be decoded as an empty plaintext
    // (the old bug). We assert the error class and one of the two
    // expected error codes.
    await expect(
      getFreshDelegatedAccessToken({ mailboxConnectionId, callerClubId: clubId, callerUserId: userId }),
    ).rejects.toBeInstanceOf(MailboxFlowError);
    try {
      await getFreshDelegatedAccessToken({ mailboxConnectionId, callerClubId: clubId, callerUserId: userId });
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      expect(["refresh_terminal", "connection_already_disconnected"]).toContain(code);
    }
  });

  it("reconnect after disconnect restores usable credentials and re-instates owner access", async () => {
    await disconnectMailbox({ mailboxConnectionId, callerUserId: userId, callerClubId: clubId });
    // Reconnect with SAME identity — the mock produced a stable
    // externalUserId in the beforeEach; a fresh provider with the
    // same identity mimics the user coming back through OAuth.
    const first = await prisma.mailboxConnection.findUnique({ where: { id: mailboxConnectionId } });
    const firstExtIdentity = { tenantId: first!.microsoftTenantId, externalUserId: first!.externalUserId, connectedEmail: first!.connectedEmail, displayName: "Corporate User" };
    const provider2 = new MockMicrosoftDelegatedProvider(firstExtIdentity);
    const rt2 = await runOAuthRoundTrip({ provider: provider2, userId, clubId });
    expect(rt2.mailboxConnectionId).toBe(mailboxConnectionId); // preserved identity
    const conn = await prisma.mailboxConnection.findUnique({ where: { id: mailboxConnectionId } });
    expect(conn?.accessTokenSecretRef).toBeTruthy();
    expect(conn?.refreshTokenSecretRef).toBeTruthy();
    expect(conn?.status).toBe(MAILBOX_STATUS.CONNECTED_PENDING_SYNC);
    // Owner access row is restored.
    const active = await prisma.mailboxAccess.findMany({
      where: { mailboxConnectionId, userId, role: "OWNER", revokedAt: null },
    });
    expect(active).toHaveLength(1);
  });
});

describe("mailbox — disconnect (§10)", () => {
  let userId: string;
  let clubId: string;
  let mailboxConnectionId: string;
  beforeEach(async () => {
    ({ userId, clubId } = await seedClubAndUser("disc"));
    const provider = makeMockProvider();
    const rt = await runOAuthRoundTrip({ provider, userId, clubId });
    mailboxConnectionId = rt.mailboxConnectionId;
  });
  afterEach(() => setMicrosoftDelegatedProvider(null));

  it("marks the connection DISCONNECTED and revokes access rows", async () => {
    const result = await disconnectMailbox({ mailboxConnectionId, callerUserId: userId, callerClubId: clubId });
    expect(result.status).toBe(MAILBOX_STATUS.DISCONNECTED);
    const conn = await prisma.mailboxConnection.findUnique({ where: { id: mailboxConnectionId } });
    expect(conn?.disconnectedAt).not.toBeNull();
    const access = await prisma.mailboxAccess.findMany({ where: { mailboxConnectionId } });
    expect(access.every((a) => a.revokedAt != null)).toBe(true);
  });

  it("subsequent token fetch on a disconnected mailbox is refused", async () => {
    await disconnectMailbox({ mailboxConnectionId, callerUserId: userId, callerClubId: clubId });
    await expect(
      getFreshDelegatedAccessToken({ mailboxConnectionId, callerClubId: clubId, callerUserId: userId }),
    ).rejects.toBeInstanceOf(MailboxFlowError);
  });

  it("is idempotent — a second disconnect is a no-op", async () => {
    await disconnectMailbox({ mailboxConnectionId, callerUserId: userId, callerClubId: clubId });
    const second = await disconnectMailbox({ mailboxConnectionId, callerUserId: userId, callerClubId: clubId });
    expect(second.status).toBe(MAILBOX_STATUS.DISCONNECTED);
  });

  it("rejects disconnect by a different user", async () => {
    const attacker = await seedClubAndUser("attacker2");
    // Attacker in a different club is denied.
    await expect(
      disconnectMailbox({ mailboxConnectionId, callerUserId: attacker.userId, callerClubId: attacker.clubId }),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("rejects a cross-club token fetch even for the connecting user", async () => {
    const other = await prisma.club.create({ data: { name: "Other C", slug: `other-c-${Date.now()}` } });
    await expect(
      getFreshDelegatedAccessToken({ mailboxConnectionId, callerClubId: other.id, callerUserId: userId }),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });
});
