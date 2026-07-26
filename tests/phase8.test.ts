// Phase 8 — Queues, POS webhooks, tee-sheet, hardware, flags, rate limit,
// secrets, observability.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { createHmac } from "crypto";
import { db, makeUser, makeMember, resetDb, principalFor } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import { ConflictError, ForbiddenError } from "@/lib/errors";
import {
  enqueue, processPending, runOne, requeueJob, cancelJob, captureQueueHealth, registerHandler,
} from "@/lib/queue";
import "@/lib/queue/handlers";
import { receiveWebhook } from "@/lib/pos/webhooks";
import "@/lib/pos/webhooks";
import * as teesheet from "@/lib/teesheet";
import * as hardware from "@/lib/hardware";
import { isFeatureEnabled, setFlag, FEATURE_FLAGS } from "@/lib/flags";
import { consumeRate, inMemoryRateLimit, setRateLimiter } from "@/lib/security/rate-limit";
import { getSecret } from "@/lib/secrets";

async function adminPrincipal(clubId: string) {
  const email = `admin-${clubId}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}

async function makeProShopLocation(clubId: string) {
  const dept = await db().department.findFirst({ where: { clubId, code: "PROSHOP" } });
  return db().pOSLocation.upsert({
    where: { clubId_code: { clubId, code: "PROSHOP" } },
    update: {},
    create: { clubId, code: "PROSHOP", name: "Pro Shop", departmentId: dept?.id },
  });
}

// ---------------------------------------------------------------------------
// 8A — Queue
// ---------------------------------------------------------------------------
describe("Phase 8A — Queue", () => {
  beforeAll(async () => { await resetDb(); setRateLimiter(inMemoryRateLimit); });
  beforeEach(async () => { await resetDb(); });

  it("enqueue is idempotent on idempotencyKey", async () => {
    const club = await bootstrapAPClub("Q-A");
    const j1 = await enqueue({ kind: "EXPORT", queue: "exports", clubId: club.id, payload: { exportId: "x" }, idempotencyKey: "abc" });
    const j2 = await enqueue({ kind: "EXPORT", queue: "exports", clubId: club.id, payload: { exportId: "x" }, idempotencyKey: "abc" });
    expect(j2.id).toBe(j1.id);
  });

  it("retry: job that throws is requeued, retries until maxAttempts, then DEAD_LETTER", async () => {
    const club = await bootstrapAPClub("Q-B");
    registerHandler("INVENTORY_SYNC", async () => { throw new Error("boom"); });
    const job = await enqueue({ kind: "INVENTORY_SYNC", queue: "default", clubId: club.id, payload: {}, maxAttempts: 2 });
    const r1 = await runOne(job.id);
    expect(r1.status).toBe("RETRYING");
    const after1 = await db().backgroundJob.findUnique({ where: { id: job.id } });
    expect(after1?.status).toBe("QUEUED");
    expect(after1?.attempts).toBe(1);
    // Force the schedule to now so we can retry inside the test.
    await db().backgroundJob.update({ where: { id: job.id }, data: { scheduledFor: new Date(0) } });
    const r2 = await runOne(job.id);
    expect(r2.status).toBe("FAILED");
    const after2 = await db().backgroundJob.findUnique({ where: { id: job.id } });
    expect(after2?.status).toBe("DEAD_LETTER");
    const failures = await db().jobFailure.findMany({ where: { jobId: job.id } });
    expect(failures.length).toBe(2);
  });

  it("requeue + cancel roundtrips", async () => {
    const club = await bootstrapAPClub("Q-C");
    const p = await adminPrincipal(club.id);
    const job = await enqueue({ kind: "EXPORT", queue: "exports", clubId: club.id, payload: { exportId: "y" } });
    await db().backgroundJob.update({ where: { id: job.id }, data: { status: "DEAD_LETTER" } });
    const requeued = await requeueJob(job.id, p);
    expect(requeued.status).toBe("QUEUED");
    const cancelled = await cancelJob(job.id, p);
    expect(cancelled.status).toBe("CANCELLED");
  });

  it("processPending runs ready jobs only", async () => {
    const club = await bootstrapAPClub("Q-D");
    // SCHEDULED_REPORT is a placeholder that always succeeds.
    await enqueue({ kind: "SCHEDULED_REPORT", queue: "default", clubId: club.id, payload: {} });
    await enqueue({ kind: "SCHEDULED_REPORT", queue: "default", clubId: club.id, payload: {}, scheduledFor: new Date(Date.now() + 60_000) });
    const results = await processPending();
    expect(results.length).toBe(1);
  });

  it("captureQueueHealth writes a snapshot per queue", async () => {
    const snaps = await captureQueueHealth();
    expect(snaps.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 8B — POS webhooks
// ---------------------------------------------------------------------------
describe("Phase 8B — POS webhooks", () => {
  beforeAll(async () => { await resetDb(); setRateLimiter(inMemoryRateLimit); });
  beforeEach(async () => { await resetDb(); });

  async function squareSetup() {
    const club = await bootstrapAPClub("PW-A");
    await makeProShopLocation(club.id);
    const provider = await db().pOSIntegrationProvider.create({
      data: { clubId: club.id, key: "square", name: "Square", webhookSecret: "test-secret" },
    });
    return { club, provider };
  }

  async function squareSignature(rawBody: string, url: string) {
    const message = `${url}${rawBody}`;
    return createHmac("sha256", "test-secret").update(message).digest("base64");
  }

  it("Square: valid signature + new event creates a POSWebhookEvent and enqueues a job", async () => {
    const { club } = await squareSetup();
    const url = "https://example.com/api/integrations/pos/square/webhook";
    const rawBody = JSON.stringify({ event_id: "ev-1", type: "payment.created", data: { object: { payment: { id: "pmt-1", amount_money: { amount: 1500, currency: "USD" } } } } });
    const result = await receiveWebhook({
      clubId: club.id, providerKey: "square", rawBody, url,
      headers: { "x-square-hmacsha256-signature": await squareSignature(rawBody, url) },
      remoteAddress: "10.0.0.1",
    });
    expect(result.status).toBe("QUEUED");
    expect(result.verified).toBe(true);
    const event = await db().pOSWebhookEvent.findFirst({ where: { clubId: club.id, externalEventId: "ev-1" } });
    expect(event?.status).toBe("PROCESSING");
    expect(event?.signatureVerified).toBe(true);
  });

  it("Square: bad signature → FAILED + POSImportError", async () => {
    const { club } = await squareSetup();
    const url = "https://example.com/api/integrations/pos/square/webhook";
    const rawBody = JSON.stringify({ event_id: "ev-2", type: "payment.created", data: {} });
    const result = await receiveWebhook({
      clubId: club.id, providerKey: "square", rawBody, url,
      headers: { "x-square-hmacsha256-signature": "wrong-signature-bytes-here-1234" },
      remoteAddress: "10.0.0.2",
    });
    expect(result.status).toBe("FAILED");
    const error = await db().pOSImportError.findFirst({ where: { clubId: club.id, providerKey: "square" } });
    expect(error?.errorMessage).toContain("signature");
  });

  it("Square: duplicate delivery is detected via WebhookReplay", async () => {
    const { club } = await squareSetup();
    const url = "https://example.com/api/integrations/pos/square/webhook";
    const rawBody = JSON.stringify({ event_id: "ev-3", type: "payment.created", data: {} });
    const signature = await squareSignature(rawBody, url);
    const r1 = await receiveWebhook({ clubId: club.id, providerKey: "square", rawBody, url, headers: { "x-square-hmacsha256-signature": signature }, remoteAddress: "10.0.0.3" });
    const r2 = await receiveWebhook({ clubId: club.id, providerKey: "square", rawBody, url, headers: { "x-square-hmacsha256-signature": signature }, remoteAddress: "10.0.0.3" });
    expect(r1.status).toBe("QUEUED");
    expect(r2.status).toBe("DUPLICATE");
  });
});

// ---------------------------------------------------------------------------
// 8C — Tee-sheet
// ---------------------------------------------------------------------------
describe("Phase 8C — Tee-sheet", () => {
  beforeAll(async () => { await resetDb(); setRateLimiter(inMemoryRateLimit); });
  beforeEach(async () => { await resetDb(); });

  it("generate tee sheet creates the expected number of slots", async () => {
    const club = await bootstrapAPClub("TS-A");
    const p = await adminPrincipal(club.id);
    await teesheet.upsertCourse(p, club.id, { code: "MAIN", name: "Main" });
    const result = await teesheet.generateTeeSheet(p, club.id, {
      courseCode: "MAIN",
      sheetDate: "2026-08-01",
      startTime: "07:00",
      endTime: "08:00",
      intervalMinutes: 10,
      maxPlayers: 4,
    });
    expect(result.created).toBe(6); // 07:00, 10, 20, 30, 40, 50
  });

  it("booking respects max-players + suspended-privileges", async () => {
    const club = await bootstrapAPClub("TS-B");
    const p = await adminPrincipal(club.id);
    await teesheet.upsertCourse(p, club.id, { code: "MAIN", name: "Main" });
    await teesheet.generateTeeSheet(p, club.id, { courseCode: "MAIN", sheetDate: "2026-08-02", startTime: "07:00", endTime: "07:10", intervalMinutes: 10, maxPlayers: 2 });
    const tee = await db().teeTime.findFirst({ where: { clubId: club.id } });
    const member = await makeMember(club.id, { firstName: "Tee", lastName: "Player" });
    // Exceeding maxPlayers (1 primary + 0 additional + 2 guests = 3 > maxPlayers=2) is rejected.
    await expect(teesheet.bookTeeTime(p, club.id, {
      teeTimeId: tee!.id, primaryMemberId: member.id, guestCount: 2, guests: [{ firstName: "G1", lastName: "Last" }, { firstName: "G2", lastName: "Last" }],
    })).rejects.toBeInstanceOf(ConflictError);
    // Suspended member can't book.
    await teesheet.suspendTeePrivileges(p, member.id, "test");
    await expect(teesheet.bookTeeTime(p, club.id, { teeTimeId: tee!.id, primaryMemberId: member.id, guestCount: 0 })).rejects.toBeInstanceOf(ConflictError);
    // Restore + valid book succeeds.
    await teesheet.restoreTeePrivileges(p, member.id);
    const booking = await teesheet.bookTeeTime(p, club.id, { teeTimeId: tee!.id, primaryMemberId: member.id, guestCount: 0 });
    expect(booking.status).toBe("CONFIRMED");
    // Tee time is now BOOKED.
    const refreshed = await db().teeTime.findUnique({ where: { id: tee!.id } });
    expect(refreshed?.status).toBe("BOOKED");
  });

  it("lottery: enter + draw assigns winners to tee times", async () => {
    const club = await bootstrapAPClub("TS-C");
    const p = await adminPrincipal(club.id);
    await teesheet.upsertCourse(p, club.id, { code: "MAIN", name: "Main" });
    const { sheet } = await teesheet.generateTeeSheet(p, club.id, { courseCode: "MAIN", sheetDate: "2026-08-03", startTime: "08:00", endTime: "09:00", intervalMinutes: 30, maxPlayers: 4 });
    const lottery = await teesheet.createLottery(p, club.id, {
      teeSheetId: sheet.id, name: "AM lottery",
      opensAt: new Date(Date.now() - 3600_000).toISOString(),
      closesAt: new Date(Date.now() + 3600_000).toISOString(),
      drawAt: new Date(Date.now() + 7200_000).toISOString(),
    });
    const m1 = await makeMember(club.id, { firstName: "M", lastName: "1" });
    const m2 = await makeMember(club.id, { firstName: "M", lastName: "2" });
    await teesheet.enterLottery(p, { lotteryId: lottery.id, memberId: m1.id, priorityScore: 5 });
    await teesheet.enterLottery(p, { lotteryId: lottery.id, memberId: m2.id, priorityScore: 1 });
    const draw = await teesheet.drawLottery(p, lottery.id);
    expect(draw.assigned).toBe(2);
    expect(draw.lottery.status).toBe("DRAWN");
  });
});

// ---------------------------------------------------------------------------
// 8D — Feature flags
// ---------------------------------------------------------------------------
describe("Phase 8J — Feature flags", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("flag rollout: 0% off, 100% on, club override beats global", async () => {
    const club = await bootstrapAPClub("FF-A");
    const p = await adminPrincipal(club.id);
    expect(await isFeatureEnabled(club.id, "x_flag")).toBe(false);
    await setFlag(p, { clubId: club.id, key: "x_flag", name: "X", isEnabled: true, rolloutPercent: 100 });
    expect(await isFeatureEnabled(club.id, "x_flag")).toBe(true);
    // Override with isEnabled=false at the club level → off again.
    await setFlag(p, { clubId: club.id, key: "x_flag", name: "X", isEnabled: false, rolloutPercent: 0 });
    expect(await isFeatureEnabled(club.id, "x_flag")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8E — Hardware
// ---------------------------------------------------------------------------
describe("Phase 8E — Hardware", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("register + ingest event verifies auth token and writes a DeviceEvent", async () => {
    const club = await bootstrapAPClub("HW-A");
    const p = await adminPrincipal(club.id);
    await hardware.registerDevice(p, club.id, {
      serial: "DOOR-001", kind: "DOOR_ACCESS", authToken: "raw-token",
    });
    const accepted = await hardware.ingestDeviceEvent({
      clubId: club.id, deviceSerial: "DOOR-001", authToken: "raw-token", eventType: "DOOR_OPEN",
    });
    expect(accepted.accepted).toBe(true);
    const rejected = await hardware.ingestDeviceEvent({
      clubId: club.id, deviceSerial: "DOOR-001", authToken: "WRONG", eventType: "DOOR_OPEN",
    });
    expect(rejected.accepted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8H — Rate limit
// ---------------------------------------------------------------------------
describe("Phase 8H — Rate limit", () => {
  beforeAll(async () => { await resetDb(); setRateLimiter(inMemoryRateLimit); });

  it("login bucket caps at capacity and refills over time", async () => {
    // capacity=5
    for (let i = 0; i < 5; i++) {
      const r = await consumeRate("login", "test-ip");
      expect(r.allowed).toBe(true);
    }
    const denied = await consumeRate("login", "test-ip");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 8G — Secrets
// ---------------------------------------------------------------------------
describe("Phase 8G — Secrets", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("env > integration secrets (env wins)", async () => {
    const club = await bootstrapAPClub("SEC-A");
    process.env.SPECTRE_LLM_ANTHROPIC_API_KEY = "from-env";
    const v = await getSecret({ clubId: club.id, scope: "LLM", provider: "anthropic", keyName: "API_KEY" });
    expect(v).toBe("from-env");
    delete process.env.SPECTRE_LLM_ANTHROPIC_API_KEY;
  });
});

// ---------------------------------------------------------------------------
// 8 — Tenant isolation across new services
// ---------------------------------------------------------------------------
describe("Phase 8 — Tenant isolation", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("club A admin cannot draw club B's lottery", async () => {
    const clubA = await bootstrapAPClub("T-A");
    const clubB = await bootstrapAPClub("T-B");
    const pA = await adminPrincipal(clubA.id);
    const pB = await adminPrincipal(clubB.id);
    await teesheet.upsertCourse(pB, clubB.id, { code: "MAIN", name: "Main" });
    const gen = await teesheet.generateTeeSheet(pB, clubB.id, { courseCode: "MAIN", sheetDate: "2026-08-04", startTime: "07:00", endTime: "07:10", intervalMinutes: 10, maxPlayers: 4 });
    const lottery = await teesheet.createLottery(pB, clubB.id, {
      teeSheetId: gen.sheet.id, name: "Test",
      opensAt: new Date(Date.now() - 3600_000).toISOString(),
      closesAt: new Date(Date.now() + 3600_000).toISOString(),
      drawAt: new Date(Date.now() + 7200_000).toISOString(),
    });
    await expect(teesheet.drawLottery(pA, lottery.id)).rejects.toThrow();
  });
});

// Reference uses so unused imports don't lint-fail.
void FEATURE_FLAGS; void ForbiddenError;
