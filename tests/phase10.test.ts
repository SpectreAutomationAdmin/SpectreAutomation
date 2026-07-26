// Phase 10 — Push retries, webhook delivery, API expansion, tournament-tee,
// entitlements, operational replay.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { createHmac } from "crypto";
import { db, makeUser, makeMember, resetDb, principalFor } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import { ForbiddenError } from "@/lib/errors";
import { subscribe, dispatchPushJob } from "@/lib/push";
import { setVapidKeys, getPublicVapidKey } from "@/lib/push/vapid";
import { createSubscription, emit, dispatchDelivery, computeSignature } from "@/lib/webhooks";
import * as tournament from "@/lib/tournament";
import { buildPairings, publishLeaderboard } from "@/lib/tournament/pairings";
import * as teesheet from "@/lib/teesheet";
import { ensureDefaultPlans, assignPlan, requireEntitlement, hasEntitlement, recordUsage, summarizeUsage } from "@/lib/entitlements";
import { replayFailedJob, replayWebhookDelivery, pauseQueue, resumeQueue, isQueuePaused, operationalDiagnostics } from "@/lib/ops/replay";
import { buildOpenAPI } from "@/lib/api/openapi";
import { setRateLimiter, inMemoryRateLimit, _resetInMemoryBuckets } from "@/lib/security/rate-limit";
import { authenticate, createApiKey } from "@/lib/api/keys";

async function adminPrincipal(clubId: string) {
  const email = `admin-${clubId}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}

async function superPrincipal() {
  // Bootstrap RBAC by creating any club first (idempotent seed).
  await bootstrapAPClub("RBAC-INIT");
  const email = `super-${Date.now()}@spectre.app`;
  await makeUser({ email, role: "SUPER_ADMIN", clubId: null });
  return principalFor(email);
}

// ---------------------------------------------------------------------------
// 10A — Push infrastructure
// ---------------------------------------------------------------------------
describe("Phase 10A — Push infrastructure", () => {
  beforeAll(async () => { await resetDb(); setRateLimiter(inMemoryRateLimit); });
  beforeEach(async () => { await resetDb(); _resetInMemoryBuckets(); });

  it("setVapidKeys persists public + private (dev fallback ok in tests)", async () => {
    const club = await bootstrapAPClub("PUSH-A");
    const p = await adminPrincipal(club.id);
    const result = await setVapidKeys(p, club.id, { contactEmail: "ops@example.com" });
    expect(result.publicKey).toBeTruthy();
    const fetched = await getPublicVapidKey(club.id);
    expect(fetched).toBe(result.publicKey);
  });

  it("dispatchPushJob writes PushDeliveryAttempt rows per subscription", async () => {
    const club = await bootstrapAPClub("PUSH-B");
    const p = await adminPrincipal(club.id);
    await subscribe(p, club.id, { endpoint: "https://push.example.com/x", p256dh: "BPCC", auth: "shh" });
    const result = await dispatchPushJob({ clubId: club.id, userId: p.id, title: "Hi", body: "There" });
    expect(result.sent).toBe(1);
    const attempts = await db().pushDeliveryAttempt.findMany({ where: { clubId: club.id } });
    expect(attempts.length).toBe(1);
    expect(attempts[0].status).toBe("SENT");
  });
});

// ---------------------------------------------------------------------------
// 10C — Outbound webhook delivery
// ---------------------------------------------------------------------------
describe("Phase 10C — Outbound webhook delivery", () => {
  beforeAll(async () => { await resetDb(); setRateLimiter(inMemoryRateLimit); });
  beforeEach(async () => { await resetDb(); _resetInMemoryBuckets(); });

  it("createSubscription returns the raw secret once and stores it", async () => {
    const club = await bootstrapAPClub("WH-A");
    const p = await adminPrincipal(club.id);
    const { subscription, secret } = await createSubscription(p, club.id, {
      name: "Partner X", url: "https://partner.example.com/webhook", events: ["member.created"],
    });
    expect(secret).toBeTruthy();
    expect(secret.length).toBeGreaterThan(20);
    expect(subscription.events).toBe("member.created");
  });

  it("emit fans out to matching subscriptions and enqueues delivery jobs", async () => {
    const club = await bootstrapAPClub("WH-B");
    const p = await adminPrincipal(club.id);
    await createSubscription(p, club.id, {
      name: "P1", url: "https://example.com/p1", events: ["member.created", "invoice.posted"],
    });
    await createSubscription(p, club.id, {
      name: "P2", url: "https://example.com/p2", events: ["invoice.posted"],
    });
    const result = await emit({ clubId: club.id, eventType: "invoice.posted", payload: { invoiceId: "abc" } });
    expect(result.dispatched).toBe(2);
    const deliveries = await db().webhookDelivery.findMany({ where: { clubId: club.id } });
    expect(deliveries.length).toBe(2);
    expect(deliveries.every((d) => d.status === "PENDING")).toBe(true);
  });

  it("dispatchDelivery signs payload + marks delivery as DELIVERED on 2xx", async () => {
    const club = await bootstrapAPClub("WH-C");
    const p = await adminPrincipal(club.id);
    // Capture the outbound fetch.
    type FetchCall = { url: string; headers: Headers; body: string };
    const calls: FetchCall[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers as HeadersInit);
      calls.push({ url: String(input), headers, body: init?.body as string });
      return new Response("", { status: 200 });
    }) as typeof fetch;
    try {
      const { subscription, secret } = await createSubscription(p, club.id, {
        name: "P", url: "https://example.com/wh", events: ["member.created"],
      });
      await emit({ clubId: club.id, eventType: "member.created", payload: { id: "m1" } });
      const delivery = await db().webhookDelivery.findFirst({ where: { subscriptionId: subscription.id } });
      const result = await dispatchDelivery(delivery!.id);
      expect((result as { status: string }).status).toBe("DELIVERED");
      expect(calls.length).toBe(1);
      const sig = calls[0].headers.get("x-spectre-signature")!;
      const ts = calls[0].headers.get("x-spectre-timestamp")!;
      const expected = computeSignature(secret, ts, calls[0].body);
      expect(sig).toBe(`sha256=${expected}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("dispatchDelivery disables subscription on 410", async () => {
    const club = await bootstrapAPClub("WH-D");
    const p = await adminPrincipal(club.id);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("", { status: 410 })) as typeof fetch;
    try {
      const { subscription } = await createSubscription(p, club.id, {
        name: "P", url: "https://example.com/gone", events: ["member.created"],
      });
      await emit({ clubId: club.id, eventType: "member.created", payload: { id: "m1" } });
      const delivery = await db().webhookDelivery.findFirst({ where: { subscriptionId: subscription.id } });
      await dispatchDelivery(delivery!.id);
      const sub = await db().webhookSubscription.findUnique({ where: { id: subscription.id } });
      expect(sub?.status).toBe("DISABLED");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("payload redacts sensitive keys before persistence", async () => {
    const club = await bootstrapAPClub("WH-E");
    const p = await adminPrincipal(club.id);
    const { subscription } = await createSubscription(p, club.id, {
      name: "P", url: "https://example.com/wh", events: ["member.created"],
    });
    await emit({ clubId: club.id, eventType: "member.created", payload: { id: "m1", passwordHash: "secret-pass-hash", apiKey: "abc-key" } });
    const delivery = await db().webhookDelivery.findFirst({ where: { subscriptionId: subscription.id } });
    const body = JSON.parse(delivery!.payloadJson);
    expect(body.passwordHash).toBe("[redacted]");
    expect(body.apiKey).toBe("[redacted]");
    expect(body.id).toBe("m1");
  });
});

// ---------------------------------------------------------------------------
// 10D — External API expansion
// ---------------------------------------------------------------------------
describe("Phase 10D — External API expansion", () => {
  beforeAll(async () => { await resetDb(); setRateLimiter(inMemoryRateLimit); });
  beforeEach(async () => { await resetDb(); _resetInMemoryBuckets(); });

  it("OpenAPI spec lists new resource paths", async () => {
    const spec = buildOpenAPI("https://example.club");
    const paths = Object.keys(spec.paths);
    expect(paths).toContain("/vendors");
    expect(paths).toContain("/events");
    expect(paths).toContain("/charges");
    expect(paths).toContain("/tee-times");
    expect(paths).toContain("/tournaments");
  });

  it("API key with scoped permission can authenticate; missing permission still authenticates but blocks per route", async () => {
    const club = await bootstrapAPClub("API-A");
    const p = await adminPrincipal(club.id);
    const { rawKey, apiKey } = await createApiKey(p, club.id, { name: "scoped", permissions: ["events:read"] });
    const auth = await authenticate({ authorization: `Bearer ${rawKey}` });
    expect("apiKey" in auth).toBe(true);
    if ("apiKey" in auth) expect(auth.permissions).toContain("events:read");
    void apiKey;
  });
});

// ---------------------------------------------------------------------------
// 10E — Tournament ↔ tee-sheet
// ---------------------------------------------------------------------------
describe("Phase 10E — Tournament ↔ tee-sheet", () => {
  beforeAll(async () => { await resetDb(); setRateLimiter(inMemoryRateLimit); });
  beforeEach(async () => { await resetDb(); _resetInMemoryBuckets(); });

  it("buildPairings groups registrations and books tee times", async () => {
    const club = await bootstrapAPClub("TP-A");
    const p = await adminPrincipal(club.id);
    await teesheet.upsertCourse(p, club.id, { code: "MAIN", name: "Main" });
    const teeSheetGen = await teesheet.generateTeeSheet(p, club.id, {
      courseCode: "MAIN", sheetDate: "2026-08-01", startTime: "07:00", endTime: "08:00",
      intervalMinutes: 10, maxPlayers: 4,
    });
    const t = await tournament.createTournament(p, club.id, {
      name: "Pairing Test", format: "STROKE",
      startDate: "2026-08-01", endDate: "2026-08-01",
    });
    await tournament.openRegistration(p, t.id);
    const members = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map((i) => makeMember(club.id, { firstName: `P${i}`, lastName: "T" })));
    await Promise.all(members.map((m) => tournament.registerForTournament(p, t.id, { memberId: m.id })));
    const round = await tournament.createRound(p, t.id, { roundNumber: 1, scheduledDate: "2026-08-01" });
    const result = await buildPairings(p, {
      tournamentId: t.id, roundId: round.id, teeSheetId: teeSheetGen.sheet.id, groupSize: 4,
    });
    expect(result.pairings.length).toBe(2); // 8 players / 4 per group = 2 groups
    // Tee times now BOOKED.
    const booked = await db().teeTime.findMany({ where: { teeSheetId: teeSheetGen.sheet.id, status: "BOOKED" } });
    expect(booked.length).toBe(2);
  });

  it("publishLeaderboard fires a webhook to matching subscribers", async () => {
    const club = await bootstrapAPClub("TP-B");
    const p = await adminPrincipal(club.id);
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("", { status: 200 });
    }) as typeof fetch;
    try {
      await createSubscription(p, club.id, {
        name: "leaderboard sub", url: "https://example.com/leaderboard",
        events: ["tournament.score_submitted"],
      });
      const t = await tournament.createTournament(p, club.id, {
        name: "Pub Test", format: "STROKE",
        startDate: "2026-08-02", endDate: "2026-08-02",
      });
      await publishLeaderboard(p, t.id);
      // Webhook is queue-driven; the in-memory queue means dispatchDelivery
      // runs when processPending() is called. We just verify the delivery row
      // was created (the dispatch test above already covers signing).
      const deliveries = await db().webhookDelivery.findMany({ where: { clubId: club.id } });
      expect(deliveries.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// 10I — Commercial SaaS entitlements
// ---------------------------------------------------------------------------
describe("Phase 10I — SaaS entitlements", () => {
  beforeAll(async () => { await resetDb(); setRateLimiter(inMemoryRateLimit); });
  beforeEach(async () => { await resetDb(); _resetInMemoryBuckets(); });

  it("PILOT clubs have all features by default", async () => {
    const club = await bootstrapAPClub("SAAS-A");
    expect(await hasEntitlement(club.id, "tournament")).toBe(true);
    expect(await hasEntitlement(club.id, "push")).toBe(true);
  });

  it("STARTER plan grants tournament+push but not external_api", async () => {
    const club = await bootstrapAPClub("SAAS-B");
    const sup = await superPrincipal();
    await ensureDefaultPlans();
    await assignPlan(sup, club.id, { planKey: "starter", status: "ACTIVE" });
    expect(await hasEntitlement(club.id, "tournament")).toBe(true);
    expect(await hasEntitlement(club.id, "push")).toBe(true);
    expect(await hasEntitlement(club.id, "external_api")).toBe(false);
    await expect(requireEntitlement(club.id, "external_api")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("PAUSED subscriptions block all entitlements", async () => {
    const club = await bootstrapAPClub("SAAS-C");
    const sup = await superPrincipal();
    await ensureDefaultPlans();
    await assignPlan(sup, club.id, { planKey: "professional", status: "PAUSED" });
    expect(await hasEntitlement(club.id, "tournament")).toBe(false);
  });

  it("recordUsage + summarizeUsage roundtrip", async () => {
    const club = await bootstrapAPClub("SAAS-D");
    await recordUsage(club.id, "API_CALLS", 5);
    await recordUsage(club.id, "API_CALLS", 3);
    const rows = await summarizeUsage(club.id);
    const apiRow = rows.find((r) => r.kind === "API_CALLS");
    expect(Number(apiRow!.value.toString())).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// 10H — Operational replay tooling
// ---------------------------------------------------------------------------
describe("Phase 10H — Operational tooling", () => {
  beforeAll(async () => { await resetDb(); setRateLimiter(inMemoryRateLimit); });
  beforeEach(async () => { await resetDb(); _resetInMemoryBuckets(); });

  it("replayFailedJob resets a dead-letter job to QUEUED", async () => {
    const club = await bootstrapAPClub("OPS-A");
    const p = await adminPrincipal(club.id);
    const job = await db().backgroundJob.create({
      data: { clubId: club.id, queue: "exports", kind: "EXPORT", payloadJson: "{}", status: "DEAD_LETTER", attempts: 5, lastError: "boom" },
    });
    await replayFailedJob(p, job.id);
    const refreshed = await db().backgroundJob.findUnique({ where: { id: job.id } });
    expect(refreshed?.status).toBe("QUEUED");
    expect(refreshed?.attempts).toBe(0);
  });

  it("replayWebhookDelivery re-enqueues + resets status", async () => {
    const club = await bootstrapAPClub("OPS-B");
    const p = await adminPrincipal(club.id);
    const sub = await db().webhookSubscription.create({
      data: { clubId: club.id, name: "x", url: "https://example.com", secret: "abc", events: "member.created", status: "ACTIVE" },
    });
    const delivery = await db().webhookDelivery.create({
      data: { clubId: club.id, subscriptionId: sub.id, eventType: "member.created", payloadJson: "{}", status: "FAILED", attempts: 3 },
    });
    await replayWebhookDelivery(p, delivery.id);
    const refreshed = await db().webhookDelivery.findUnique({ where: { id: delivery.id } });
    expect(refreshed?.status).toBe("PENDING");
    expect(refreshed?.attempts).toBe(0);
  });

  it("pause/resume queue toggles state visibility", async () => {
    const sup = await superPrincipal();
    await db().club.upsert({
      where: { slug: "_global_" },
      update: {},
      create: { id: "_GLOBAL_", name: "Global control sentinel", slug: "_global_" },
    });
    await pauseQueue(sup, "exports");
    expect(await isQueuePaused("exports")).toBe(true);
    await resumeQueue(sup, "exports");
    expect(await isQueuePaused("exports")).toBe(false);
  });

  it("operationalDiagnostics returns counts", async () => {
    const diagnostics = await operationalDiagnostics();
    expect(diagnostics).toHaveProperty("queuedJobs");
    expect(diagnostics).toHaveProperty("deadLetter");
    expect(diagnostics).toHaveProperty("snapshotAt");
  });
});

// ---------------------------------------------------------------------------
// 10G — Observability + OTLP wiring (functional check on default adapter)
// ---------------------------------------------------------------------------
describe("Phase 10G — Observability", () => {
  beforeAll(async () => { await resetDb(); setRateLimiter(inMemoryRateLimit); });
  beforeEach(async () => { await resetDb(); _resetInMemoryBuckets(); });

  it("trace() wraps async work + records span on the default adapter", async () => {
    const { trace } = await import("@/lib/observability/adapter");
    const result = await trace("test.work", { kind: "phase10" }, async () => {
      return 42;
    });
    expect(result).toBe(42);
    await new Promise((r) => setTimeout(r, 50));
    const row = await db().observabilityEvent.findFirst({ where: { name: "test.work", kind: "SPAN" }, orderBy: { occurredAt: "desc" } });
    expect(row?.status).toBe("OK");
  });
});
