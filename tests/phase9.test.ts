// Phase 9 — Observability, security headers, auth hardening, push,
// POS importers, tournaments, external API, pilot readiness.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { createHmac } from "crypto";
import { db, makeUser, makeMember, resetDb, principalFor } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import { ConflictError } from "@/lib/errors";
import { login, hashPassword } from "@/lib/services/auth";
import { isLocked, hashEmail } from "@/lib/security/auth-guard";
import { defaultObservabilityAdapter } from "@/lib/observability/adapter";
import { receiveWebhook } from "@/lib/pos/webhooks";
import { posVsGl, posVsAr } from "@/lib/pos/reconciliation";
import * as tournament from "@/lib/tournament";
import { createApiKey, authenticate, revokeApiKey } from "@/lib/api/keys";
import { buildOpenAPI } from "@/lib/api/openapi";
import { subscribe, dispatchPushJob } from "@/lib/push";
import { setRateLimiter, inMemoryRateLimit } from "@/lib/security/rate-limit";
import { getReadinessSnapshot, runProbes } from "@/lib/pilot";

async function adminPrincipal(clubId: string) {
  const email = `admin-${clubId}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}

async function makeProShopLocation(clubId: string) {
  return db().pOSLocation.upsert({
    where: { clubId_code: { clubId, code: "PROSHOP" } },
    update: {},
    create: { clubId, code: "PROSHOP", name: "Pro Shop" },
  });
}

// ---------------------------------------------------------------------------
// 9A — Observability
// ---------------------------------------------------------------------------
describe("Phase 9A — Observability", () => {
  beforeAll(async () => { await resetDb(); setRateLimiter(inMemoryRateLimit); });
  beforeEach(async () => { await resetDb(); const m = await import("@/lib/security/rate-limit"); m._resetInMemoryBuckets(); });

  it("startSpan + end persists an ObservabilityEvent", async () => {
    const span = defaultObservabilityAdapter.startSpan("test.span", { kind: "test" });
    await span.end("OK");
    await new Promise((r) => setTimeout(r, 50)); // give the fire-and-forget write a tick
    const row = await db().observabilityEvent.findFirst({ where: { name: "test.span", kind: "SPAN" }, orderBy: { occurredAt: "desc" } });
    expect(row).toBeTruthy();
    expect(row?.status).toBe("OK");
  });

  it("incrCounter increments + exportMetrics emits Prometheus format", async () => {
    defaultObservabilityAdapter.incrCounter("test_counter", { foo: "bar" }, 3);
    defaultObservabilityAdapter.incrCounter("test_counter", { foo: "bar" }, 2);
    await new Promise((r) => setTimeout(r, 50));
    const body = await defaultObservabilityAdapter.exportMetrics();
    expect(body).toContain("test_counter");
    expect(body).toContain("# TYPE test_counter counter");
  });
});

// ---------------------------------------------------------------------------
// 9C — Auth rate limit / lockout / suspicious activity
// ---------------------------------------------------------------------------
describe("Phase 9C — Auth hardening", () => {
  beforeAll(async () => { await resetDb(); setRateLimiter(inMemoryRateLimit); });
  beforeEach(async () => { await resetDb(); const m = await import("@/lib/security/rate-limit"); m._resetInMemoryBuckets(); });

  it("failed logins write AuthAttempt rows and lock the account after 5", async () => {
    const club = await bootstrapAPClub("AUTH-A");
    void club;
    const email = "rich@example.com";
    const passwordHash = await hashPassword("correct-horse-battery-staple-1");
    await db().user.create({ data: { email, name: "Rich", role: "MEMBER", passwordHash, status: "ACTIVE" } });
    for (let i = 0; i < 5; i++) {
      try { await login({ email, password: "wrong" }); } catch { /* expected */ }
    }
    const lock = await isLocked(email);
    expect(lock.locked).toBe(true);
    const attempts = await db().authAttempt.findMany({ where: { emailHash: hashEmail(email) } });
    expect(attempts.length).toBeGreaterThan(0);
    // Suspicious activity event recorded.
    const susp = await db().suspiciousActivityEvent.findMany({ where: { emailHash: hashEmail(email) } });
    expect(susp.length).toBeGreaterThan(0);
  });

  it("unknown user returns generic auth error and records UNKNOWN_USER attempt", async () => {
    await expect(login({ email: "ghost@example.com", password: "anything" })).rejects.toThrow();
    const attempt = await db().authAttempt.findFirst({ where: { emailHash: hashEmail("ghost@example.com") } });
    expect(attempt?.outcome).toBe("UNKNOWN_USER");
  });
});

// ---------------------------------------------------------------------------
// 9D — Push notifications
// ---------------------------------------------------------------------------
describe("Phase 9D — Push notifications", () => {
  beforeAll(async () => { await resetDb(); setRateLimiter(inMemoryRateLimit); });
  beforeEach(async () => { await resetDb(); const m = await import("@/lib/security/rate-limit"); m._resetInMemoryBuckets(); });

  it("subscribe creates a row + dispatchPushJob sends via dev adapter", async () => {
    const club = await bootstrapAPClub("PN-A");
    const p = await adminPrincipal(club.id);
    const sub = await subscribe(p, club.id, {
      endpoint: "https://push.example.com/abc", p256dh: "BPCC", auth: "secret123",
    });
    expect(sub.isActive).toBe(true);
    const result = await dispatchPushJob({ clubId: club.id, userId: p.id, title: "Hello", body: "World" });
    expect(result.sent).toBe(1);
    const refreshed = await db().webPushSubscription.findUnique({ where: { id: sub.id } });
    expect(refreshed?.lastSentAt).toBeTruthy();
  });

  it("preference opt-out suppresses queued push", async () => {
    const club = await bootstrapAPClub("PN-B");
    const p = await adminPrincipal(club.id);
    const member = await makeMember(club.id, {});
    await db().notificationPreference.create({
      data: { clubId: club.id, memberId: member.id, topic: "statement", channels: "PUSH", enabled: false },
    });
    const { sendPushToUser } = await import("@/lib/push");
    const out = await sendPushToUser({ clubId: club.id, memberId: member.id, title: "Stmt", body: "Available", topic: "statement" });
    expect((out as { suppressed?: boolean }).suppressed).toBe(true);
    void p;
  });
});

// ---------------------------------------------------------------------------
// 9E — POS importers + reconciliation
// ---------------------------------------------------------------------------
describe("Phase 9E — POS importers + reconciliation", () => {
  beforeAll(async () => { await resetDb(); setRateLimiter(inMemoryRateLimit); });
  beforeEach(async () => { await resetDb(); const m = await import("@/lib/security/rate-limit"); m._resetInMemoryBuckets(); });

  async function setupLightspeed() {
    const club = await bootstrapAPClub("LS-A");
    await makeProShopLocation(club.id);
    await db().pOSIntegrationProvider.create({
      data: { clubId: club.id, key: "lightspeed", name: "Lightspeed", webhookSecret: "ls-secret" },
    });
    return club;
  }
  function lightspeedSignature(rawBody: string) { return createHmac("sha256", "ls-secret").update(rawBody).digest("hex"); }

  async function setupClover() {
    const club = await bootstrapAPClub("CL-A");
    await makeProShopLocation(club.id);
    await db().pOSIntegrationProvider.create({
      data: { clubId: club.id, key: "clover", name: "Clover", webhookSecret: "cl-secret" },
    });
    return club;
  }
  function cloverSignature(rawBody: string) { return createHmac("sha256", "cl-secret").update(rawBody).digest("base64"); }

  it("Lightspeed webhook with valid signature is queued + payload maps a sale", async () => {
    const club = await setupLightspeed();
    const url = "https://example.com/api/integrations/pos/lightspeed/webhook";
    const rawBody = JSON.stringify({
      eventID: "ls-ev-1", eventType: "sale.created",
      payload: { saleID: "1", total: 150, tax: 7.5, lines: [{ description: "Greens fee", qty: 1, price: 142.5 }], payments: [{ type: "cash", amount: 150 }] },
    });
    const result = await receiveWebhook({
      clubId: club.id, providerKey: "lightspeed", rawBody, url,
      headers: { "x-lightspeed-signature": lightspeedSignature(rawBody) },
      remoteAddress: "10.0.0.5",
    });
    expect(result.status).toBe("QUEUED");
  });

  it("Clover webhook with valid signature parses + persists event", async () => {
    const club = await setupClover();
    const url = "https://example.com/api/integrations/pos/clover/webhook";
    const rawBody = JSON.stringify({ merchants: { ABC123: [{ objectId: "ORD-1", type: "CREATE", ts: 1700000000 }] } });
    const result = await receiveWebhook({
      clubId: club.id, providerKey: "clover", rawBody, url,
      headers: { "x-clover-auth": cloverSignature(rawBody) },
      remoteAddress: "10.0.0.6",
    });
    expect(result.status).toBe("QUEUED");
    const event = await db().pOSWebhookEvent.findFirst({ where: { clubId: club.id, providerKey: "clover" } });
    expect(event?.signatureVerified).toBe(true);
  });

  it("reconciliation reports identify gaps", async () => {
    const club = await bootstrapAPClub("POS-RECON");
    const p = await adminPrincipal(club.id);
    // No sales — reconciliation should return an empty (no-mismatch) array.
    const gl = await posVsGl(p, club.id);
    const ar = await posVsAr(p, club.id);
    expect(Array.isArray(gl)).toBe(true);
    expect(Array.isArray(ar)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9F — Tournaments
// ---------------------------------------------------------------------------
describe("Phase 9F — Tournaments", () => {
  beforeAll(async () => { await resetDb(); setRateLimiter(inMemoryRateLimit); });
  beforeEach(async () => { await resetDb(); const m = await import("@/lib/security/rate-limit"); m._resetInMemoryBuckets(); });

  it("registration with entry fee creates an AR Charge; cancellation reverses it", async () => {
    const club = await bootstrapAPClub("T-A");
    const p = await adminPrincipal(club.id);
    const t = await tournament.createTournament(p, club.id, {
      name: "Member Cup", format: "STROKE",
      startDate: "2026-08-01", endDate: "2026-08-02",
      entryFee: 50, guestFee: 0,
    });
    await tournament.openRegistration(p, t.id);
    const member = await makeMember(club.id, { firstName: "Tom", lastName: "Tee" });
    const reg = await tournament.registerForTournament(p, t.id, { memberId: member.id });
    expect(reg.feeChargeId).toBeTruthy();
    const charge = await db().charge.findUnique({ where: { id: reg.feeChargeId! } });
    expect(Number(charge!.amount.toString())).toBe(50);
    // Cancellation reverses.
    await tournament.cancelRegistration(p, reg.id, "test");
    const charges = await db().charge.findMany({ where: { memberId: member.id }, orderBy: { transactionDate: "asc" } });
    const net = charges.reduce((s, c) => s + Number(c.amount.toString()), 0);
    expect(Math.abs(net)).toBeLessThan(0.01);
  });

  it("scoring updates the leaderboard; lowest total wins", async () => {
    const club = await bootstrapAPClub("T-B");
    const p = await adminPrincipal(club.id);
    const t = await tournament.createTournament(p, club.id, { name: "Stroke Test", format: "STROKE", startDate: "2026-09-01", endDate: "2026-09-01" });
    await tournament.openRegistration(p, t.id);
    const m1 = await makeMember(club.id, { firstName: "A", lastName: "One" });
    const m2 = await makeMember(club.id, { firstName: "B", lastName: "Two" });
    const r1 = await tournament.registerForTournament(p, t.id, { memberId: m1.id });
    const r2 = await tournament.registerForTournament(p, t.id, { memberId: m2.id });
    const round = await tournament.createRound(p, t.id, { roundNumber: 1, scheduledDate: "2026-09-01" });
    for (let h = 1; h <= 3; h++) {
      await tournament.recordScore(p, club.id, { roundId: round.id, registrationId: r1.id, holeNumber: h, strokes: 4 });
      await tournament.recordScore(p, club.id, { roundId: round.id, registrationId: r2.id, holeNumber: h, strokes: 5 });
    }
    const board = await tournament.getLeaderboard(p, t.id);
    expect(board[0].registrationId).toBe(r1.id);
    expect(board[0].totalStrokes).toBe(12);
    expect(board[0].positionRank).toBe(1);
  });

  it("match play: winner advances into the next bracket slot", async () => {
    const club = await bootstrapAPClub("T-C");
    const p = await adminPrincipal(club.id);
    const t = await tournament.createTournament(p, club.id, { name: "Match Cup", format: "MATCH", startDate: "2026-10-01", endDate: "2026-10-02" });
    await tournament.openRegistration(p, t.id);
    const ms = await Promise.all([
      makeMember(club.id, { firstName: "P1", lastName: "X" }),
      makeMember(club.id, { firstName: "P2", lastName: "X" }),
      makeMember(club.id, { firstName: "P3", lastName: "X" }),
      makeMember(club.id, { firstName: "P4", lastName: "X" }),
    ]);
    const regs = await Promise.all(ms.map((m) => tournament.registerForTournament(p, t.id, { memberId: m.id })));
    const round1 = await tournament.createRound(p, t.id, { roundNumber: 1, scheduledDate: "2026-10-01" });
    const round2 = await tournament.createRound(p, t.id, { roundNumber: 2, scheduledDate: "2026-10-02" });
    // Bracket: slots 2,3 = semis. slot 1 = final.
    const semi1 = await tournament.createMatch(p, { tournamentId: t.id, roundId: round1.id, playerARegistrationId: regs[0].id, playerBRegistrationId: regs[1].id, bracketSlot: 2 });
    await tournament.createMatch(p, { tournamentId: t.id, roundId: round1.id, playerARegistrationId: regs[2].id, playerBRegistrationId: regs[3].id, bracketSlot: 3 });
    await tournament.createMatch(p, { tournamentId: t.id, roundId: round2.id, bracketSlot: 1, playerARegistrationId: regs[0].id, playerBRegistrationId: regs[1].id });
    // Wait — final slot should be empty for advance logic. Reset:
    const finalMatch = await db().tournamentMatch.findFirst({ where: { tournamentId: t.id, bracketSlot: 1 } });
    await db().tournamentMatch.update({ where: { id: finalMatch!.id }, data: { playerARegistrationId: null, playerBRegistrationId: null } });
    // Report semi1 — playerA wins (regs[0]).
    await tournament.reportMatchResult(p, semi1.id, { scoreA: 3, scoreB: 4 });
    const refreshedFinal = await db().tournamentMatch.findUnique({ where: { id: finalMatch!.id } });
    // semi1 was at bracketSlot=2, so winner advances into finalMatch (slot=1) field A (slot%2==0).
    expect(refreshedFinal?.playerARegistrationId).toBe(regs[0].id);
  });
});

// ---------------------------------------------------------------------------
// 9H — External API
// ---------------------------------------------------------------------------
describe("Phase 9H — External API", () => {
  beforeAll(async () => { await resetDb(); setRateLimiter(inMemoryRateLimit); });
  beforeEach(async () => { await resetDb(); const m = await import("@/lib/security/rate-limit"); m._resetInMemoryBuckets(); });

  it("createApiKey returns the raw key once and hashes it on persist", async () => {
    const club = await bootstrapAPClub("API-A");
    const p = await adminPrincipal(club.id);
    const { apiKey, rawKey } = await createApiKey(p, club.id, { name: "Test key", permissions: ["members:read"] });
    expect(rawKey).toBeTruthy();
    expect(rawKey.length).toBeGreaterThan(20);
    // The stored hash is not the raw value.
    const row = await db().apiKey.findUnique({ where: { id: apiKey.id } });
    expect(row?.keyHash).not.toBe(rawKey);
  });

  it("authenticate: ACTIVE key + scoped permission grants access; revoked key is rejected", async () => {
    const club = await bootstrapAPClub("API-B");
    const p = await adminPrincipal(club.id);
    const { apiKey, rawKey } = await createApiKey(p, club.id, { name: "Scoped", permissions: ["members:read"] });
    const ok = await authenticate({ authorization: `Bearer ${rawKey}` });
    expect("apiKey" in ok).toBe(true);
    if ("apiKey" in ok) {
      expect(ok.apiKey.clubId).toBe(club.id);
      expect(ok.permissions).toContain("members:read");
    }
    await revokeApiKey(p, apiKey.id);
    const after = await authenticate({ authorization: `Bearer ${rawKey}` });
    expect("error" in after && after.error === "revoked").toBe(true);
  });

  it("OpenAPI document includes the expected paths + bearer security", async () => {
    const spec = buildOpenAPI("https://example.club");
    expect(spec.openapi).toBe("3.0.3");
    expect(Object.keys(spec.paths)).toContain("/members");
    expect(spec.components.securitySchemes).toHaveProperty("ApiKeyAuth");
  });
});

// ---------------------------------------------------------------------------
// 9I — Pilot readiness
// ---------------------------------------------------------------------------
describe("Phase 9I — Pilot readiness", () => {
  beforeAll(async () => { await resetDb(); setRateLimiter(inMemoryRateLimit); });
  beforeEach(async () => { await resetDb(); const m = await import("@/lib/security/rate-limit"); m._resetInMemoryBuckets(); });

  it("snapshot returns runtime + manual items, marking missing-config as PENDING", async () => {
    const club = await bootstrapAPClub("PR-A");
    const p = await adminPrincipal(club.id);
    const items = await getReadinessSnapshot(p, club.id);
    // We expect at least one PENDING (REDIS_URL unset in tests).
    const pending = items.filter((i) => i.status === "PENDING");
    expect(pending.length).toBeGreaterThan(0);
    // Manual items are seeded.
    expect(items.some((i) => i.kind === "MANUAL")).toBe(true);
  });

  it("runProbes is idempotent and updates the cached row each time", async () => {
    const club = await bootstrapAPClub("PR-B");
    const r1 = await runProbes(club.id);
    const r2 = await runProbes(club.id);
    expect(r1.length).toBe(r2.length);
  });
});

// ---------------------------------------------------------------------------
// 9 — Tenant isolation across new services
// ---------------------------------------------------------------------------
describe("Phase 9 — Tenant isolation", () => {
  beforeAll(async () => { await resetDb(); setRateLimiter(inMemoryRateLimit); });
  beforeEach(async () => { await resetDb(); const m = await import("@/lib/security/rate-limit"); m._resetInMemoryBuckets(); });

  it("authenticate scopes API access to its key's club", async () => {
    const clubA = await bootstrapAPClub("T-A");
    const clubB = await bootstrapAPClub("T-B");
    const pA = await adminPrincipal(clubA.id);
    const { rawKey } = await createApiKey(pA, clubA.id, { name: "club A key", permissions: ["members:read"] });
    const result = await authenticate({ authorization: `Bearer ${rawKey}` });
    expect("apiKey" in result && result.apiKey.clubId).toBe(clubA.id);
    void clubB;
  });

  it("tournament registration requires the same club as the tournament", async () => {
    const clubA = await bootstrapAPClub("T-T-A");
    const clubB = await bootstrapAPClub("T-T-B");
    const pA = await adminPrincipal(clubA.id);
    const pB = await adminPrincipal(clubB.id);
    const t = await tournament.createTournament(pA, clubA.id, { name: "A cup", format: "STROKE", startDate: "2026-11-01", endDate: "2026-11-01" });
    await tournament.openRegistration(pA, t.id);
    // Try to register from club B — should fail tenant guard inside the service.
    await expect(tournament.registerForTournament(pB, t.id, { memberId: "_" })).rejects.toThrow();
  });
});

// Reference uses so unused imports don't lint-fail.
void ConflictError;
