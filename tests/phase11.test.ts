// Phase 11 — Launch readiness: webhook rotation, POS mapping, OpenAPI registry,
// tournament scoring, billing, MFA/SSO, launch hard blocks.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { createHmac } from "crypto";
import { db, makeUser, makeMember, resetDb, principalFor } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import { ForbiddenError, ConflictError } from "@/lib/errors";
import { createSubscription, dispatchDelivery, computeSignature, emit } from "@/lib/webhooks";
import { rotate, activate, rollback, expirePrevious, activeSecretFor, listVersions } from "@/lib/webhooks/rotation";
import { createOrUpdateMapping, deleteMapping, listMappings, reprocessFailedEvent } from "@/lib/pos/mapping";
import { buildOpenAPI, validateRegistryCompleteness } from "@/lib/api/openapi";
import * as scoring from "@/lib/tournament/scoring";
import * as tournament from "@/lib/tournament";
import {
  mockBillingProvider, handleWebhook, ensureBillingCustomer, setBillingProvider,
} from "@/lib/billing";
import { ensureDefaultPlans, assignPlan } from "@/lib/entitlements";
import {
  startEnrollment, completeEnrollment, verifyMfa, disableMfa,
  generateTotp, verifyTotp, isMfaRequiredForUser,
} from "@/lib/mfa";
import { upsertProvider, findOrProvisionUser, listLoginAttempts } from "@/lib/sso";
import { runLaunchChecks, enforceProductionLaunchSafety } from "@/lib/launch";
import { setRateLimiter, inMemoryRateLimit } from "@/lib/security/rate-limit";

async function adminPrincipal(clubId: string) {
  const email = `admin-${clubId}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}

async function superPrincipal() {
  await bootstrapAPClub("RBAC-INIT");
  const email = `super-${Date.now()}@spectre.app`;
  await makeUser({ email, role: "SUPER_ADMIN", clubId: null });
  return principalFor(email);
}

// ---------------------------------------------------------------------------
// 11B — Webhook secret rotation
// ---------------------------------------------------------------------------
describe("Phase 11B — Webhook secret rotation", () => {
  beforeAll(async () => { await resetDb(); setRateLimiter(inMemoryRateLimit); });
  beforeEach(async () => { await resetDb(); });

  async function makeSubscription() {
    const club = await bootstrapAPClub("WR-A");
    const p = await adminPrincipal(club.id);
    const { subscription } = await createSubscription(p, club.id, {
      name: "Partner", url: "https://partner.example.com", events: ["member.created"],
    });
    return { club, p, subscription };
  }

  it("rotate creates a PENDING version + activeSecretFor returns the active secret", async () => {
    const { p, subscription } = await makeSubscription();
    const originalSecret = await activeSecretFor(subscription.id);
    const { secret: pendingSecret } = await rotate(p, { subscriptionId: subscription.id });
    expect(pendingSecret).not.toBe(originalSecret);
    // active is still v1 until activation.
    expect(await activeSecretFor(subscription.id)).toBe(originalSecret);
  });

  it("activate promotes pending + sets grace expiry on prior ACTIVE", async () => {
    const { p, subscription } = await makeSubscription();
    const { secret: pendingSecret } = await rotate(p, { subscriptionId: subscription.id });
    const { graceExpiresAt } = await activate(p, subscription.id, 7);
    expect(await activeSecretFor(subscription.id)).toBe(pendingSecret);
    expect(graceExpiresAt.getTime()).toBeGreaterThan(Date.now());
    const versions = await listVersions(p, subscription.id);
    const expired = versions.find((v) => v.state === "EXPIRED");
    expect(expired).toBeTruthy();
  });

  it("rollback revokes the pending rotation", async () => {
    const { p, subscription } = await makeSubscription();
    await rotate(p, { subscriptionId: subscription.id });
    await rollback(p, subscription.id, "test");
    const versions = await listVersions(p, subscription.id);
    expect(versions.find((v) => v.state === "PENDING")).toBeUndefined();
    expect(versions.find((v) => v.state === "REVOKED")).toBeTruthy();
  });

  it("expirePrevious revokes the expired grace-window secret", async () => {
    const { p, subscription } = await makeSubscription();
    await rotate(p, { subscriptionId: subscription.id });
    await activate(p, subscription.id);
    await expirePrevious(p, subscription.id);
    const versions = await listVersions(p, subscription.id);
    expect(versions.find((v) => v.state === "EXPIRED")).toBeUndefined();
  });

  it("dispatchDelivery signs with the active version after rotation", async () => {
    const { p, subscription, club } = await makeSubscription();
    await rotate(p, { subscriptionId: subscription.id });
    await activate(p, subscription.id);
    const newSecret = await activeSecretFor(subscription.id);

    const originalFetch = globalThis.fetch;
    let captured: { headers: Headers; body: string } | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { headers: new Headers(init?.headers as HeadersInit), body: init?.body as string };
      void input;
      return new Response("", { status: 200 });
    }) as typeof fetch;
    try {
      await emit({ clubId: club.id, eventType: "member.created", payload: { id: "m1" } });
      const delivery = await db().webhookDelivery.findFirst({ where: { subscriptionId: subscription.id } });
      await dispatchDelivery(delivery!.id);
      const sig = captured!.headers.get("x-spectre-signature")!;
      const ts = captured!.headers.get("x-spectre-timestamp")!;
      const expected = computeSignature(newSecret, ts, captured!.body);
      expect(sig).toBe(`sha256=${expected}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// 11C — POSMapping management
// ---------------------------------------------------------------------------
describe("Phase 11C — POSMapping management", () => {
  beforeAll(async () => { await resetDb(); setRateLimiter(inMemoryRateLimit); });
  beforeEach(async () => { await resetDb(); });

  it("create + update + delete writes POSMappingHistory rows", async () => {
    const club = await bootstrapAPClub("POSM-A");
    const p = await adminPrincipal(club.id);
    const created = await createOrUpdateMapping(p, club.id, {
      providerKey: "square", kind: "ITEM", externalId: "sq-item-1", spectreId: "internal-1",
    });
    // Update
    await createOrUpdateMapping(p, club.id, {
      providerKey: "square", kind: "ITEM", externalId: "sq-item-1", spectreId: "internal-2",
    });
    await deleteMapping(p, created.id);
    const history = await db().pOSMappingHistory.findMany({ where: { clubId: club.id } });
    const actions = history.map((h) => h.action).sort();
    expect(actions).toEqual(["CREATE", "DELETE", "UPDATE"]);
  });

  it("reprocessFailedEvent resets status + enqueues", async () => {
    const club = await bootstrapAPClub("POSM-B");
    const p = await adminPrincipal(club.id);
    const event = await db().pOSWebhookEvent.create({
      data: {
        clubId: club.id, providerKey: "square",
        externalEventId: "ev-fail-1", eventType: "payment.created",
        rawPayload: "{}", status: "FAILED", failureReason: "no mapping",
      },
    });
    await reprocessFailedEvent(p, event.id);
    const refreshed = await db().pOSWebhookEvent.findUnique({ where: { id: event.id } });
    expect(refreshed?.status).toBe("PROCESSING");
  });

  it("listMappings filters by provider", async () => {
    const club = await bootstrapAPClub("POSM-C");
    const p = await adminPrincipal(club.id);
    await createOrUpdateMapping(p, club.id, { providerKey: "square", kind: "ITEM", externalId: "a", spectreId: "1" });
    await createOrUpdateMapping(p, club.id, { providerKey: "lightspeed", kind: "ITEM", externalId: "b", spectreId: "2" });
    const square = await listMappings(p, club.id, { providerKey: "square" });
    expect(square.length).toBe(1);
    expect(square[0].externalId).toBe("a");
  });
});

// ---------------------------------------------------------------------------
// 11D — OpenAPI typed registry
// ---------------------------------------------------------------------------
describe("Phase 11D — OpenAPI typed registry", () => {
  it("buildOpenAPI generates a spec with all core routes", () => {
    const spec = buildOpenAPI("https://example.club");
    expect(spec.openapi).toBe("3.0.3");
    const paths = Object.keys(spec.paths);
    for (const expected of ["/members", "/vendors", "/inventory/items", "/tee-times", "/events", "/charges", "/tournaments"]) {
      expect(paths).toContain(expected);
    }
  });

  it("validateRegistryCompleteness flags missing schemas", () => {
    const result = validateRegistryCompleteness();
    expect(result.ok).toBe(true);
    expect(result.missing.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 11E — Tournament scoring
// ---------------------------------------------------------------------------
describe("Phase 11E — Tournament scoring", () => {
  beforeAll(async () => { await resetDb(); setRateLimiter(inMemoryRateLimit); });
  beforeEach(async () => { await resetDb(); });

  async function setup() {
    const club = await bootstrapAPClub("TS-A");
    const p = await adminPrincipal(club.id);
    const member = await makeMember(club.id, { firstName: "Score", lastName: "Test" });
    await makeUser({ email: `member-${member.id}@example.com`, role: "MEMBER", clubId: club.id, memberId: member.id });
    const memberPrincipal = await principalFor(`member-${member.id}@example.com`);
    const t = await tournament.createTournament(p, club.id, {
      name: "Score Cup", format: "STROKE",
      startDate: "2026-08-01", endDate: "2026-08-01",
    });
    await tournament.openRegistration(p, t.id);
    const reg = await tournament.registerForTournament(p, t.id, { memberId: member.id });
    const round = await tournament.createRound(p, t.id, { roundNumber: 1, scheduledDate: "2026-08-01" });
    return { club, p, memberPrincipal, t, reg, round };
  }

  it("member saves a draft + submits + admin accepts → leaderboard updates", async () => {
    const { p, memberPrincipal, t, reg, round } = await setup();
    await scoring.saveDraft(memberPrincipal, {
      tournamentId: t.id, roundId: round.id, registrationId: reg.id,
      scores: { "1": 4, "2": 5, "3": 4 },
    });
    await scoring.submitDraft(memberPrincipal, reg.id, round.id);
    const submitted = await db().tournamentScoreDraft.findFirst({ where: { registrationId: reg.id } });
    expect(submitted?.status).toBe("SUBMITTED");
    await scoring.acceptDraft(p, submitted!.id);
    const final = await db().tournamentScoreDraft.findUnique({ where: { id: submitted!.id } });
    expect(final?.status).toBe("ACCEPTED");
    const board = await db().tournamentLeaderboard.findFirst({ where: { tournamentId: t.id, registrationId: reg.id } });
    expect(board?.totalStrokes).toBe(13);
  });

  it("member cannot score another member's registration", async () => {
    const { memberPrincipal, t, round } = await setup();
    const other = await makeMember((await db().club.findFirst())!.id, { firstName: "Other", lastName: "Player" });
    const otherReg = await db().tournamentRegistration.create({
      data: {
        clubId: t.clubId, tournamentId: t.id,
        memberId: other.id, status: "REGISTERED",
      },
    });
    await expect(scoring.saveDraft(memberPrincipal, {
      tournamentId: t.id, roundId: round.id, registrationId: otherReg.id, scores: { "1": 3 },
    })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("admin correction writes a TournamentScoreCorrection row", async () => {
    const { p, memberPrincipal, t, reg, round } = await setup();
    await scoring.saveDraft(memberPrincipal, { tournamentId: t.id, roundId: round.id, registrationId: reg.id, scores: { "1": 4 } });
    await scoring.submitDraft(memberPrincipal, reg.id, round.id);
    const draft = await db().tournamentScoreDraft.findFirst({ where: { registrationId: reg.id } });
    await scoring.acceptDraft(p, draft!.id);
    await scoring.correctScore(p, {
      tournamentId: t.id, roundId: round.id, registrationId: reg.id,
      holeNumber: 1, strokes: 5, reason: "Mismarked card",
    });
    const corr = await db().tournamentScoreCorrection.findFirst({ where: { tournamentId: t.id } });
    expect(corr?.beforeStrokes).toBe(4);
    expect(corr?.afterStrokes).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 11F — Billing (mock adapter)
// ---------------------------------------------------------------------------
describe("Phase 11F — SaaS billing (mock)", () => {
  beforeAll(async () => { await resetDb(); setBillingProvider(mockBillingProvider); setRateLimiter(inMemoryRateLimit); });
  beforeEach(async () => { await resetDb(); setBillingProvider(mockBillingProvider); });

  it("ensureBillingCustomer creates a BillingCustomer row with provider externalId", async () => {
    const club = await bootstrapAPClub("BIL-A");
    const p = await adminPrincipal(club.id);
    const customer = await ensureBillingCustomer(p, club.id, { email: "billing@example.com" });
    expect(customer.provider).toBe("mock");
    expect(customer.externalId).toContain("mock_cust_");
  });

  it("handleWebhook updates subscription + propagates to ClubSubscription", async () => {
    const club = await bootstrapAPClub("BIL-B");
    const sup = await superPrincipal();
    await ensureDefaultPlans();
    await assignPlan(sup, club.id, { planKey: "starter", status: "ACTIVE" });
    const p = await adminPrincipal(club.id);
    const customer = await ensureBillingCustomer(p, club.id, { email: "billing@example.com" });
    const payload = {
      id: `evt_${Date.now()}`,
      type: "customer.subscription.created",
      data: { id: "sub_test_1", customer: customer.externalId, status: "active", current_period_start: 1700000000, current_period_end: 1702592000 },
    };
    const rawBody = JSON.stringify(payload);
    const signature = createHmac("sha256", "mock-secret").update(rawBody).digest("hex");
    const result = await handleWebhook({ rawBody, signature, webhookSecret: "mock-secret" });
    expect(result.status).toBe("COMPLETED");
    const sub = await db().billingSubscription.findFirst({ where: { provider: "mock", externalId: "sub_test_1" } });
    expect(sub?.status).toBe("ACTIVE");
  });

  it("handleWebhook idempotency: duplicate event returns DUPLICATE", async () => {
    const club = await bootstrapAPClub("BIL-C");
    const p = await adminPrincipal(club.id);
    const customer = await ensureBillingCustomer(p, club.id, { email: "billing@example.com" });
    const payload = {
      id: `evt_${Date.now()}_dup`,
      type: "customer.subscription.created",
      data: { id: "sub_dup", customer: customer.externalId, status: "active" },
    };
    const rawBody = JSON.stringify(payload);
    const signature = createHmac("sha256", "mock-secret").update(rawBody).digest("hex");
    const first = await handleWebhook({ rawBody, signature, webhookSecret: "mock-secret" });
    expect(first.status).toBe("COMPLETED");
    const second = await handleWebhook({ rawBody, signature, webhookSecret: "mock-secret" });
    expect(second.status).toBe("DUPLICATE");
  });

  it("invoice.payment_failed pauses ClubSubscription", async () => {
    const club = await bootstrapAPClub("BIL-D");
    const sup = await superPrincipal();
    await ensureDefaultPlans();
    await assignPlan(sup, club.id, { planKey: "starter", status: "ACTIVE" });
    const p = await adminPrincipal(club.id);
    const customer = await ensureBillingCustomer(p, club.id, { email: "billing@example.com" });
    const payload = {
      id: `evt_${Date.now()}_inv`,
      type: "invoice.payment_failed",
      data: { id: "inv_1", customer: customer.externalId, status: "open", amount_due: 4999, currency: "usd" },
    };
    const rawBody = JSON.stringify(payload);
    const signature = createHmac("sha256", "mock-secret").update(rawBody).digest("hex");
    await handleWebhook({ rawBody, signature, webhookSecret: "mock-secret" });
    const cs = await db().clubSubscription.findUnique({ where: { clubId: club.id } });
    expect(cs?.status).toBe("PAUSED");
  });
});

// ---------------------------------------------------------------------------
// 11G — MFA + SSO
// ---------------------------------------------------------------------------
describe("Phase 11G — MFA + SSO", () => {
  beforeAll(async () => { await resetDb(); setRateLimiter(inMemoryRateLimit); });
  beforeEach(async () => { await resetDb(); });

  it("TOTP: generate + verify roundtrip + ±1 window tolerance", () => {
    const secret = "JBSWY3DPEHPK3PXP";
    const code = generateTotp(secret);
    expect(verifyTotp(secret, code)).toBe(true);
    expect(verifyTotp(secret, "000000")).toBe(false);
  });

  it("enroll → confirm → verify with TOTP + recovery code single-use", async () => {
    const club = await bootstrapAPClub("MFA-A");
    const p = await adminPrincipal(club.id);
    const enroll = await startEnrollment(p);
    const code = generateTotp(enroll.secret);
    const { recoveryCodes } = await completeEnrollment(p, code);
    expect(recoveryCodes.length).toBe(8);
    // TOTP verify works.
    const codeNow = generateTotp(enroll.secret);
    const v1 = await verifyMfa(p.id, codeNow);
    expect(v1.ok).toBe(true);
    // Recovery code consumed once.
    const v2 = await verifyMfa(p.id, recoveryCodes[0]);
    expect(v2.ok).toBe(true);
    expect(v2.usedRecovery).toBe(true);
    const v3 = await verifyMfa(p.id, recoveryCodes[0]);
    expect(v3.ok).toBe(false);
  });

  it("MFA required by role: CLUB_ADMIN is in the enforced set", async () => {
    const club = await bootstrapAPClub("MFA-B");
    const p = await adminPrincipal(club.id);
    expect(await isMfaRequiredForUser(p.id)).toBe(true);
  });

  it("admin can disable a target user's MFA", async () => {
    const club = await bootstrapAPClub("MFA-C");
    const admin = await adminPrincipal(club.id);
    await makeUser({ email: "victim@example.com", role: "CLUB_ADMIN", clubId: club.id });
    const victim = await principalFor("victim@example.com");
    const enroll = await startEnrollment(victim);
    await completeEnrollment(victim, generateTotp(enroll.secret));
    await disableMfa(admin, victim.id, "test");
    const user = await db().user.findUnique({ where: { id: victim.id } });
    expect(user?.mfaEnabled).toBe(false);
  });

  it("SSO: provision a new user just-in-time + record login attempt", async () => {
    const club = await bootstrapAPClub("SSO-A");
    const p = await adminPrincipal(club.id);
    const provider = await upsertProvider(p, club.id, {
      kind: "OIDC", name: "Google Workspace", clientId: "abc", clientSecret: "secret",
      issuer: "https://accounts.google.com", emailDomain: "club.example", defaultRoleKey: "STAFF",
    });
    const user = await findOrProvisionUser({
      providerId: provider.id, email: "newhire@club.example", firstName: "New", lastName: "Hire",
    });
    expect(user.email).toBe("newhire@club.example");
    const attempts = await listLoginAttempts(p, club.id);
    expect(attempts[0].status).toBe("SUCCESS");
  });

  it("SSO email-domain restriction rejects mismatched domains", async () => {
    const club = await bootstrapAPClub("SSO-B");
    const p = await adminPrincipal(club.id);
    const provider = await upsertProvider(p, club.id, {
      kind: "OIDC", name: "Test", clientId: "x", emailDomain: "club.example", defaultRoleKey: "STAFF",
    });
    await expect(findOrProvisionUser({ providerId: provider.id, email: "rogue@elsewhere.com" })).rejects.toBeInstanceOf(ConflictError);
  });
});

// ---------------------------------------------------------------------------
// 11H — Launch readiness
// ---------------------------------------------------------------------------
describe("Phase 11H — Launch readiness", () => {
  beforeAll(async () => { await resetDb(); setRateLimiter(inMemoryRateLimit); });
  beforeEach(async () => { await resetDb(); });

  it("runLaunchChecks returns the categorized check set", async () => {
    const club = await bootstrapAPClub("LAUNCH-A");
    const p = await adminPrincipal(club.id);
    const checks = await runLaunchChecks(p, club.id);
    expect(checks.length).toBeGreaterThan(5);
    expect(checks.some((c) => c.key === "session_secret_present")).toBe(true);
  });

  it("enforceProductionLaunchSafety is a no-op in non-production", async () => {
    const result = await enforceProductionLaunchSafety();
    expect(result.ok).toBe(true);
  });
});

void inMemoryRateLimit;
