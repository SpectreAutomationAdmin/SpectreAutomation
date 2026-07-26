// Phase 12 — Enterprise scale + compliance + ecosystem.
//
// Coverage:
//   12A — KMS envelope encryption + webhook secret encryption-at-rest
//   12B — SSO OIDC role mapping
//   12C — Tournament conflict resolution
//   12E — Push analytics summarization
//   12F — Marketplace app registration, install, OAuth code exchange
//   12G — Compliance access reviews + evidence
//   12I — Resilience circuit breaker

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, makeUser, makeMember, resetDb, principalFor, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import {
  encryptSecret, decryptSecret, isEncryptedBlob,
  localKmsProvider, setKmsProvider,
} from "@/lib/kms";
import { createSubscription } from "@/lib/webhooks";
import { rotate, activate, activeSecretFor } from "@/lib/webhooks/rotation";
import { mapRoleFromClaims } from "@/lib/sso/oidc";
import { saveDraftVersioned, resolveConflict, listOpenConflicts } from "@/lib/tournament/conflict";
import { summarize, subscriptionHealth } from "@/lib/push/analytics";
import {
  registerApp, installApp, uninstallApp, listInstalls, listApps,
  authorize, exchangeCode, resolveAccessToken, revokeGrant, subscribeAppWebhook,
} from "@/lib/marketplace";
import {
  startReview, decideReviewItem, completeReview, reviewDetail,
  generateEvidence, listEvidence, requestPolicyAck, acknowledgePolicy,
} from "@/lib/compliance";
import { withBreaker, CircuitOpenError, forceCloseBreaker, forceOpenBreaker, listBreakers } from "@/lib/resilience";
import { setRateLimiter, inMemoryRateLimit } from "@/lib/security/rate-limit";

async function adminPrincipal(clubId: string) {
  const email = `admin-${clubId}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}

async function superPrincipal() {
  const email = `super-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@spectre.app`;
  await makeUser({ email, role: "SUPER_ADMIN", clubId: null });
  return principalFor(email);
}

// ===========================================================================
// 12A — KMS + webhook encryption-at-rest
// ===========================================================================
describe("Phase 12A — KMS envelope encryption", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); setRateLimiter(inMemoryRateLimit); setKmsProvider(localKmsProvider); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("round-trips a secret through encrypt + decrypt", async () => {
    const ciphertext = await encryptSecret({ scope: "WEBHOOK", secretReference: "test:1", plaintext: "hello-world" });
    expect(isEncryptedBlob(ciphertext)).toBe(true);
    expect(ciphertext.startsWith("enc:local:")).toBe(true);
    const plain = await decryptSecret({ scope: "WEBHOOK", secretReference: "test:1", ciphertext });
    expect(plain).toBe("hello-world");
  });

  it("isEncryptedBlob returns false for cleartext", () => {
    expect(isEncryptedBlob("plaintextsecret")).toBe(false);
  });

  it("rotated webhook secrets are stored encrypted and decrypted on read", async () => {
    const club = await bootstrapAPClub("KMS-A");
    const p = await adminPrincipal(club.id);
    const { subscription } = await createSubscription(p, club.id, {
      name: "Partner", url: "https://partner.example.com", events: ["member.created"],
    });
    const { secret: pendingSecret } = await rotate(p, { subscriptionId: subscription.id });
    await activate(p, subscription.id, 1);
    // Active secret read should yield the raw plaintext we just rotated to.
    expect(await activeSecretFor(subscription.id)).toBe(pendingSecret);
    // The stored row should be encrypted, not the plaintext.
    const v = await db().webhookSecretVersion.findFirst({ where: { subscriptionId: subscription.id, state: "ACTIVE" } });
    expect(v?.secret).toBeTruthy();
    expect(isEncryptedBlob(v!.secret)).toBe(true);
  });

  it("emits SecretAccessLog rows on encrypt + decrypt", async () => {
    await encryptSecret({ scope: "WEBHOOK", secretReference: "log:1", plaintext: "x" });
    const ct = await encryptSecret({ scope: "WEBHOOK", secretReference: "log:1", plaintext: "y" });
    await decryptSecret({ scope: "WEBHOOK", secretReference: "log:1", ciphertext: ct });
    const logs = await db().secretAccessLog.findMany({ where: { secretReference: "log:1" } });
    expect(logs.some((l) => l.action === "ENCRYPT")).toBe(true);
    expect(logs.some((l) => l.action === "DECRYPT")).toBe(true);
  });
});

// ===========================================================================
// 12B — SSO OIDC role mapping
// ===========================================================================
describe("Phase 12B — SSO OIDC role mapping", () => {
  it("maps a group claim to a Spectre role", () => {
    const mapping = { groups: { "Club-Admins": "CLUB_ADMIN", "Pro-Shop": "PRO_SHOP_MANAGER" }, default: "STAFF" };
    expect(mapRoleFromClaims(mapping, { groups: ["Club-Admins"] }, "STAFF")).toBe("CLUB_ADMIN");
    expect(mapRoleFromClaims(mapping, { groups: ["Pro-Shop"] }, "STAFF")).toBe("PRO_SHOP_MANAGER");
  });

  it("falls back to the mapping default when no group matches", () => {
    const mapping = { groups: { "Admins": "CLUB_ADMIN" }, default: "STAFF" };
    expect(mapRoleFromClaims(mapping, { groups: ["Unknown"] }, "MEMBER")).toBe("STAFF");
  });

  it("falls back to the provider default when no mapping exists", () => {
    expect(mapRoleFromClaims(null, { groups: ["Anything"] }, "MEMBER")).toBe("MEMBER");
  });
});

// ===========================================================================
// 12C — Tournament conflict resolution
// ===========================================================================
describe("Phase 12C — Tournament conflict resolution", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  async function setupTournament() {
    const club = await bootstrapAPClub("CONF-A");
    const p = await adminPrincipal(club.id);
    const member = await makeMember(club.id);
    const tournament = await db().tournament.create({
      data: { clubId: club.id, name: `T1-${Math.random().toString(36).slice(2, 8)}`, format: "STROKE", status: "OPEN", startDate: new Date(), endDate: new Date() },
    });
    const round = await db().tournamentRound.create({
      data: { clubId: club.id, tournamentId: tournament.id, roundNumber: 1, scheduledDate: new Date() },
    });
    const reg = await db().tournamentRegistration.create({
      data: { clubId: club.id, tournamentId: tournament.id, memberId: member.id, status: "CONFIRMED", handicap: 12 },
    });
    return { club, p, tournament, round, reg };
  }

  it("optimistic concurrency: matching version saves; mismatched version records a conflict", async () => {
    const { club, p, tournament, round, reg } = await setupTournament();
    const first = await saveDraftVersioned(p, {
      tournamentId: tournament.id, roundId: round.id, registrationId: reg.id,
      scores: { "1": 4, "2": 5 }, expectedVersion: 0,
    });
    expect(first.conflict).toBeNull();
    expect(first.draft.version).toBe(1);

    // Stale client thinks it's still v0 → conflict.
    const stale = await saveDraftVersioned(p, {
      tournamentId: tournament.id, roundId: round.id, registrationId: reg.id,
      scores: { "1": 6 }, expectedVersion: 0,
    });
    expect(stale.conflict).not.toBeNull();
    expect(stale.conflict!.resolution).toBe("PENDING");
    expect(stale.conflict!.serverVersion).toBe(1);

    const open = await listOpenConflicts(p, club.id);
    expect(open.length).toBe(1);
  });

  it("resolveConflict KEPT_CLIENT overwrites the draft scores", async () => {
    const { p, tournament, round, reg } = await setupTournament();
    await saveDraftVersioned(p, { tournamentId: tournament.id, roundId: round.id, registrationId: reg.id, scores: { "1": 4 }, expectedVersion: 0 });
    const { conflict } = await saveDraftVersioned(p, { tournamentId: tournament.id, roundId: round.id, registrationId: reg.id, scores: { "1": 6 }, expectedVersion: 0 });
    expect(conflict).not.toBeNull();
    await resolveConflict(p, { conflictId: conflict!.id, decision: "KEPT_CLIENT" });
    const draft = await db().tournamentScoreDraft.findUnique({ where: { id: conflict!.draftId } });
    expect(draft?.scoresJson).toContain("6");
  });
});

// ===========================================================================
// 12E — Push analytics
// ===========================================================================
describe("Phase 12E — Push analytics", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("summarize aggregates SENT/FAILED/EXPIRED counts and computes p50/p95/p99", async () => {
    const club = await bootstrapAPClub("PA-A");
    const p = await adminPrincipal(club.id);
    const member = await makeMember(club.id);
    const sub = await db().webPushSubscription.create({
      data: { clubId: club.id, memberId: member.id, endpoint: "https://push.test/x", p256dh: "k", authSecret: "a", isActive: true },
    });
    for (let i = 0; i < 8; i++) {
      await db().pushDeliveryAttempt.create({
        data: { clubId: club.id, subscriptionId: sub.id, status: "SENT", durationMs: 100 + i * 10, attemptedAt: new Date() },
      });
    }
    await db().pushDeliveryAttempt.create({
      data: { clubId: club.id, subscriptionId: sub.id, status: "FAILED", durationMs: 0, failureReason: "timeout", attemptedAt: new Date() },
    });
    await db().pushDeliveryAttempt.create({
      data: { clubId: club.id, subscriptionId: sub.id, status: "EXPIRED", durationMs: 0, attemptedAt: new Date() },
    });
    const summary = await summarize(p, club.id, "24h");
    expect(summary.sent).toBe(8);
    expect(summary.failed).toBe(1);
    expect(summary.expired).toBe(1);
    expect(summary.successRate).toBeCloseTo(8 / 10, 2);
    expect(summary.latency.p99).toBeGreaterThanOrEqual(summary.latency.p50);
    expect(summary.failureBuckets["timeout"]).toBe(1);
  });

  it("subscriptionHealth counts active vs failed subscriptions", async () => {
    const club = await bootstrapAPClub("PA-B");
    const p = await adminPrincipal(club.id);
    const member = await makeMember(club.id);
    await db().webPushSubscription.create({ data: { clubId: club.id, memberId: member.id, endpoint: "https://a", p256dh: "k", authSecret: "a", isActive: true } });
    await db().webPushSubscription.create({ data: { clubId: club.id, memberId: member.id, endpoint: "https://b", p256dh: "k", authSecret: "a", isActive: false, failureCount: 4 } });
    const h = await subscriptionHealth(p, club.id);
    expect(h.total).toBe(2);
    expect(h.active).toBe(1);
    expect(h.recentlyFailed).toBe(1);
  });
});

// ===========================================================================
// 12F — Marketplace foundations
// ===========================================================================
describe("Phase 12F — Marketplace foundations", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("super-admin registers an app, secret is returned exactly once", async () => {
    const sp = await superPrincipal();
    const { app, clientId, clientSecret } = await registerApp(sp, {
      key: "tee-time-pro", name: "Tee Time Pro",
      redirectUris: ["https://pro.example.com/callback"],
      defaultScopes: ["bookings:read", "members:read"],
    });
    expect(app.key).toBe("tee-time-pro");
    expect(clientId).toMatch(/^app_/);
    expect(clientSecret).toBeTruthy();
    // Hash stored, not raw.
    const stored = await db().marketplaceApp.findUnique({ where: { id: app.id } });
    expect(stored?.clientSecretHash).not.toBe(clientSecret);
  });

  it("non-super-admin cannot register an app", async () => {
    const club = await bootstrapAPClub("MP-1");
    const p = await adminPrincipal(club.id);
    await expect(registerApp(p, {
      key: "foo", name: "Foo", redirectUris: ["https://example.com/cb"],
    })).rejects.toThrow(NotFoundError);
  });

  it("install + uninstall flow updates status and revokes permissions", async () => {
    const sp = await superPrincipal();
    const club = await bootstrapAPClub("MP-2");
    const p = await adminPrincipal(club.id);
    const { app } = await registerApp(sp, {
      key: "billing-sync", name: "Billing Sync",
      redirectUris: ["https://example.com/cb"], defaultScopes: ["ar:read"],
    });
    const install = await installApp(p, { appId: app.id, clubId: club.id, scopes: ["ar:read"] });
    expect(install.status).toBe("ACTIVE");
    const installs = await listInstalls(p, club.id);
    expect(installs.find((i) => i.id === install.id)?.permissions).toContain("ar:read");
    await uninstallApp(p, install.id, "test");
    const after = await db().installedApp.findUnique({ where: { id: install.id } });
    expect(after?.status).toBe("REVOKED");
    const perms = await db().appPermission.findMany({ where: { installedAppId: install.id, revokedAt: null } });
    expect(perms.length).toBe(0);
  });

  it("rejects install scopes not declared by the app", async () => {
    const sp = await superPrincipal();
    const club = await bootstrapAPClub("MP-3");
    const p = await adminPrincipal(club.id);
    const { app } = await registerApp(sp, {
      key: "narrow", name: "Narrow",
      redirectUris: ["https://example.com/cb"], defaultScopes: ["ar:read"],
    });
    await expect(installApp(p, { appId: app.id, clubId: club.id, scopes: ["ar:write"] })).rejects.toThrow(ValidationError);
  });

  it("OAuth code exchange issues an access token; resolveAccessToken returns club/scopes; revoke invalidates it", async () => {
    const sp = await superPrincipal();
    const club = await bootstrapAPClub("MP-4");
    const p = await adminPrincipal(club.id);
    const { app, clientId, clientSecret } = await registerApp(sp, {
      key: "exchange-test", name: "X",
      redirectUris: ["https://example.com/cb"], defaultScopes: ["members:read"],
    });
    const install = await installApp(p, { appId: app.id, clubId: club.id });
    const { code } = await authorize(p, { installId: install.id });
    const { accessToken, grantId, scopes } = await exchangeCode({ clientId, clientSecret, code });
    expect(scopes).toContain("members:read");
    const ctx = await resolveAccessToken(accessToken);
    expect(ctx?.clubId).toBe(club.id);
    expect(ctx?.scopes).toContain("members:read");
    await revokeGrant(p, grantId);
    expect(await resolveAccessToken(accessToken)).toBeNull();
  });

  it("exchangeCode rejects an invalid client secret", async () => {
    const sp = await superPrincipal();
    const club = await bootstrapAPClub("MP-5");
    const p = await adminPrincipal(club.id);
    const { app, clientId } = await registerApp(sp, {
      key: "bad-secret", name: "X", redirectUris: ["https://example.com/cb"], defaultScopes: ["members:read"],
    });
    const install = await installApp(p, { appId: app.id, clubId: club.id });
    const { code } = await authorize(p, { installId: install.id });
    await expect(exchangeCode({ clientId, clientSecret: "wrong", code })).rejects.toThrow(ValidationError);
  });

  it("subscribeAppWebhook returns a raw signing secret once and stores its hash", async () => {
    const sp = await superPrincipal();
    const club = await bootstrapAPClub("MP-6");
    const p = await adminPrincipal(club.id);
    const { app } = await registerApp(sp, {
      key: "wh-app", name: "WH",
      redirectUris: ["https://example.com/cb"], defaultScopes: ["members:read"],
    });
    const install = await installApp(p, { appId: app.id, clubId: club.id });
    const { signingSecret, subscription } = await subscribeAppWebhook(p, {
      installedAppId: install.id, events: ["member.created"], url: "https://hook.example.com",
    });
    expect(signingSecret).toBeTruthy();
    const stored = await db().appWebhookSubscription.findUnique({ where: { id: subscription.id } });
    expect(stored?.secret).not.toBe(signingSecret);
  });
});

// ===========================================================================
// 12G — Compliance: access reviews + evidence
// ===========================================================================
describe("Phase 12G — Compliance access reviews + evidence", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("startReview snapshots all current users into AccessReviewItems", async () => {
    const club = await bootstrapAPClub("CP-1");
    const p = await adminPrincipal(club.id);
    await makeUser({ email: `extra-${club.id}@example.com`, role: "STAFF", clubId: club.id });
    const review = await startReview(p, { clubId: club.id, scope: "USERS", title: "Q-review" });
    expect(review.scope).toBe("USERS");
    expect(review.itemCount).toBeGreaterThanOrEqual(2);
    const detail = await reviewDetail(p, review.id);
    expect(detail.items.length).toBeGreaterThanOrEqual(2);
  });

  it("segregation of duties: reviewer cannot decide on items in their own review", async () => {
    const club = await bootstrapAPClub("CP-2");
    const p = await adminPrincipal(club.id);
    const review = await startReview(p, { clubId: club.id, scope: "USERS", title: "Self" });
    const detail = await reviewDetail(p, review.id);
    const firstItem = detail.items[0];
    await expect(decideReviewItem(p, { itemId: firstItem.id, decision: "APPROVED" })).rejects.toThrow(ConflictError);
  });

  it("a different reviewer can decide items, and completeReview requires zero pending", async () => {
    const club = await bootstrapAPClub("CP-3");
    const creator = await adminPrincipal(club.id);
    const reviewer = await adminPrincipal(club.id);
    const review = await startReview(creator, { clubId: club.id, scope: "USERS", title: "Cross" });
    const detail = await reviewDetail(creator, review.id);
    await expect(completeReview(reviewer, review.id)).rejects.toThrow(ConflictError); // pending items remain
    for (const item of detail.items) {
      await decideReviewItem(reviewer, { itemId: item.id, decision: "APPROVED" });
    }
    const done = await completeReview(reviewer, review.id);
    expect(done.status).toBe("COMPLETED");
  });

  it("generateEvidence records row counts over the requested period", async () => {
    const club = await bootstrapAPClub("CP-4");
    const p = await adminPrincipal(club.id);
    // Need a SUPER_ADMIN to have system:audit:read in default seed — CLUB_ADMIN has it via seed.
    const ev = await generateEvidence(p, {
      clubId: club.id, kind: "AUDIT_LOG", label: "Audit-30d",
      periodStart: new Date(Date.now() - 30 * 86400_000).toISOString(),
      periodEnd: new Date().toISOString(),
    });
    expect(ev.kind).toBe("AUDIT_LOG");
    expect(typeof ev.rowCount).toBe("number");
    const list = await listEvidence(p, club.id);
    expect(list.find((e) => e.id === ev.id)).toBeTruthy();
  });

  it("policy acknowledgement flow: request → acknowledge", async () => {
    const club = await bootstrapAPClub("CP-5");
    const admin = await adminPrincipal(club.id);
    const subjectEmail = `subject-${club.id}@example.com`;
    await makeUser({ email: subjectEmail, role: "STAFF", clubId: club.id });
    const subject = await principalFor(subjectEmail);
    await requestPolicyAck(admin, { clubId: club.id, userId: subject.id, policyKey: "acceptable-use", policyVersion: "v1" });
    const acked = await acknowledgePolicy(subject, { policyKey: "acceptable-use", policyVersion: "v1", ip: "127.0.0.1" });
    expect(acked.status).toBe("ACKNOWLEDGED");
    expect(acked.acknowledgedAt).toBeTruthy();
  });
});

// ===========================================================================
// 12I — Resilience: circuit breaker
// ===========================================================================
describe("Phase 12I — Resilience circuit breaker", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("breaker opens after configured failures and fails fast with CircuitOpenError", async () => {
    const resourceKey = `pos:test-${Date.now()}`;
    const call = async () => { throw new Error("boom"); };
    for (let i = 0; i < 3; i++) {
      await expect(withBreaker({ resourceKey, config: { failureThreshold: 3, cooldownMs: 60_000 }, call })).rejects.toThrow();
    }
    // Now OPEN — fast fail.
    await expect(withBreaker({ resourceKey, config: { failureThreshold: 3, cooldownMs: 60_000 }, call })).rejects.toThrow(CircuitOpenError);
    const state = await db().circuitBreakerState.findUnique({ where: { resourceKey } });
    expect(state?.state).toBe("OPEN");
  });

  it("HALF_OPEN trial success transitions to CLOSED", async () => {
    const resourceKey = `pos:half-${Date.now()}`;
    const failing = async () => { throw new Error("boom"); };
    const succeeding = async () => "ok";
    for (let i = 0; i < 3; i++) {
      await expect(withBreaker({ resourceKey, config: { failureThreshold: 3, cooldownMs: 1, halfOpenSuccesses: 1 }, call: failing })).rejects.toThrow();
    }
    await new Promise((r) => setTimeout(r, 10));
    const res = await withBreaker({ resourceKey, config: { failureThreshold: 3, cooldownMs: 1, halfOpenSuccesses: 1 }, call: succeeding });
    expect(res).toBe("ok");
    const state = await db().circuitBreakerState.findUnique({ where: { resourceKey } });
    expect(state?.state).toBe("CLOSED");
  });

  it("forceOpenBreaker + forceCloseBreaker admin overrides work", async () => {
    const key = `admin-force-${Date.now()}`;
    await forceOpenBreaker(key);
    let bs = await listBreakers();
    expect(bs.find((b) => b.resourceKey === key)?.state).toBe("OPEN");
    await forceCloseBreaker(key);
    bs = await listBreakers();
    expect(bs.find((b) => b.resourceKey === key)?.state).toBe("CLOSED");
  });
});
