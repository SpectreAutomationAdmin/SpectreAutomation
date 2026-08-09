// Sprint 3 · Phase 4 Slice 5.7B (2026-08-09) — durable cache + async
// research infrastructure tests. §28 synthetic matrix (1-22).
//
// Uses the local SQLite dev DB via Prisma. Each test isolates itself
// by deleting only its own normalizedKey rows before / after — no
// destructive teardown.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// A canonical synthetic key used across the matrix. Values are
// completely fabricated — no real manufacturer, no real model.
const SYN = {
  mfr: "SYNTH-MFR",
  model: "SYNTH-MODEL-A1",
  part: "SP-001",
  key: "SYNTH-MFR|SYNTH-MODEL-A1|SP-001",
};

// Second synthetic product for cross-invoice / dedupe tests.
const SYN2 = {
  mfr: "SYNTH-MFR-2",
  model: "SYNTH-MODEL-B1",
  part: null,
  key: "SYNTH-MFR-2|SYNTH-MODEL-B1|",
};

async function cleanSyntheticRows() {
  await prisma.productReference.deleteMany({
    where: {
      OR: [
        { normalizedKey: { contains: "SYNTH" } },
        { normalizedKey: { contains: "TEN-A" } },
        { normalizedKey: { contains: "TEN-B" } },
      ],
    },
  });
  await prisma.backgroundJob.deleteMany({
    where: { kind: "PRODUCT_REFERENCE_RESEARCH", idempotencyKey: { contains: "SYNTH" } },
  });
}

beforeEach(async () => { await cleanSyntheticRows(); });
afterEach(async () => { await cleanSyntheticRows(); });

// -----------------------------------------------------------------
// (1) no cache → one research job
// (2) repeated render → still one job
// -----------------------------------------------------------------
describe("§28.1-2 first render enqueues; repeated renders reuse", () => {
  it("first render creates a PENDING durable row + one enqueued job", async () => {
    const { ensureProductResearchEnqueued } = await import(
      "@/lib/ap-intelligence/external-product-reference/enqueue"
    );
    const decision = await ensureProductResearchEnqueued({
      refRequest: {
        brandCandidates: [SYN.mfr],
        modelCandidates: [SYN.model],
        skuCandidates: [SYN.part],
        serialCandidates: [],
        descriptionExcerpt: "test object",
        observedUnitPrice: null,
        currency: null,
        maxCalls: 2,
      },
      clubId: "synthetic-club-1",
      ingestedDocumentId: "synthetic-doc-1",
    });
    expect(decision.kind).toBe("RESEARCH_JUST_ENQUEUED");
    const jobs = await prisma.backgroundJob.count({
      where: { kind: "PRODUCT_REFERENCE_RESEARCH", idempotencyKey: { contains: SYN.key } },
    });
    expect(jobs).toBe(1);
  });

  it("repeated calls with same normalizedKey do not enqueue a second job", async () => {
    const { ensureProductResearchEnqueued } = await import(
      "@/lib/ap-intelligence/external-product-reference/enqueue"
    );
    const req = {
      refRequest: {
        brandCandidates: [SYN.mfr], modelCandidates: [SYN.model],
        skuCandidates: [SYN.part], serialCandidates: [],
        descriptionExcerpt: "test", observedUnitPrice: null,
        currency: null, maxCalls: 2,
      },
      clubId: "c1", ingestedDocumentId: "d1",
    };
    const first = await ensureProductResearchEnqueued(req);
    const second = await ensureProductResearchEnqueued(req);
    const third = await ensureProductResearchEnqueued(req);
    expect(first.kind).toBe("RESEARCH_JUST_ENQUEUED");
    expect(second.kind).toBe("AWAITING_PENDING");
    expect(third.kind).toBe("AWAITING_PENDING");
    const jobs = await prisma.backgroundJob.count({
      where: { kind: "PRODUCT_REFERENCE_RESEARCH", idempotencyKey: { contains: SYN.key } },
    });
    expect(jobs).toBe(1);
  });
});

// -----------------------------------------------------------------
// (3) concurrent analyses → one provider execution
// (4) worker retry → idempotent evidence
// -----------------------------------------------------------------
describe("§28.3-4 concurrency + retry idempotence", () => {
  it("concurrent enqueue calls collapse to one job (unique-key protection)", async () => {
    const { ensureProductResearchEnqueued } = await import(
      "@/lib/ap-intelligence/external-product-reference/enqueue"
    );
    const req = {
      refRequest: {
        brandCandidates: [SYN.mfr], modelCandidates: [SYN.model],
        skuCandidates: [SYN.part], serialCandidates: [],
        descriptionExcerpt: "test", observedUnitPrice: null,
        currency: null, maxCalls: 2,
      },
      clubId: "c1", ingestedDocumentId: "d1",
    };
    const results = await Promise.all([
      ensureProductResearchEnqueued(req),
      ensureProductResearchEnqueued(req),
      ensureProductResearchEnqueued(req),
    ]);
    const enqueued = results.filter((r) => r.kind === "RESEARCH_JUST_ENQUEUED").length;
    const awaiting = results.filter((r) => r.kind === "AWAITING_PENDING" || r.kind === "AWAITING_RUNNING").length;
    expect(enqueued).toBe(1);
    expect(awaiting).toBe(2);
    const jobs = await prisma.backgroundJob.count({
      where: { kind: "PRODUCT_REFERENCE_RESEARCH", idempotencyKey: { contains: SYN.key } },
    });
    expect(jobs).toBe(1);
  });

  it("worker rerun on the same PENDING key is idempotent (no double provider call)", async () => {
    const { runProductReferenceResearchJob } = await import(
      "@/lib/ap-intelligence/external-product-reference/research-worker"
    );
    const { claimProductReferenceForResearch, normalizeProductKey } = await import(
      "@/lib/ap-intelligence/external-product-reference/durable-cache"
    );
    const { _resetProductReferenceProviderForTest } = await import(
      "@/lib/ap-intelligence/external-product-reference/factory"
    );
    let callCount = 0;
    _resetProductReferenceProviderForTest({
      async resolve() {
        callCount++;
        return {
          state: "RESOLVED",
          callCount: 1,
          products: [{
            evidenceType: "OEM_PRODUCT_MATCH",
            sourceDomain: "example.com",
            sourceTitle: "Test", retrievedAt: new Date().toISOString(),
            queryFingerprint: "fp", matchedManufacturer: SYN.mfr,
            matchedModel: SYN.model, matchedPartNumber: SYN.part,
            matchedProductFamily: "TEST_FAMILY", observedPrice: null,
            currency: null, confidence: 0.9,
            evidenceSnippet: "synthetic OEM match",
          }],
          prices: [],
          diagnostic: "synthetic",
        };
      },
    });
    const key = normalizeProductKey({ manufacturer: SYN.mfr, model: SYN.model, partNumber: SYN.part })!;
    await claimProductReferenceForResearch(key);
    const first = await runProductReferenceResearchJob({
      jobId: "j1",
      payload: {
        normalizedKey: key,
        refRequest: { brandCandidates: [SYN.mfr], modelCandidates: [SYN.model], skuCandidates: [SYN.part], serialCandidates: [], descriptionExcerpt: "", observedUnitPrice: null, currency: null, maxCalls: 2 },
        dependents: [], researchVersion: "1",
      },
    });
    const second = await runProductReferenceResearchJob({
      jobId: "j2",
      payload: {
        normalizedKey: key,
        refRequest: { brandCandidates: [SYN.mfr], modelCandidates: [SYN.model], skuCandidates: [SYN.part], serialCandidates: [], descriptionExcerpt: "", observedUnitPrice: null, currency: null, maxCalls: 2 },
        dependents: [], researchVersion: "1",
      },
    });
    expect(first.outcome).toBe("COMPLETED");
    expect(second.outcome).toBe("SKIPPED_COMPLETED");
    expect(callCount).toBe(1);
    _resetProductReferenceProviderForTest(null);
  });
});

// -----------------------------------------------------------------
// (5) completed cache → no provider call
// (6) expired price evidence but valid identity evidence
// -----------------------------------------------------------------
describe("§28.5-6 completed reuse + TTL separation", () => {
  it("REUSED_COMPLETED short-circuits without touching the queue", async () => {
    await prisma.productReference.create({
      data: {
        normalizedKey: SYN.key,
        normalizedManufacturer: SYN.mfr,
        normalizedModel: SYN.model,
        normalizedPartNumber: SYN.part,
        researchState: "COMPLETED",
        productFamily: "TEST_FAMILY",
        objectType: "TEST_FAMILY",
        identityEvidenceJson: JSON.stringify([{
          evidenceType: "OEM_PRODUCT_MATCH", sourceDomain: "example.com",
          sourceTitle: "T", retrievedAt: new Date().toISOString(),
          queryFingerprint: "fp", matchedManufacturer: SYN.mfr,
          matchedModel: SYN.model, matchedPartNumber: SYN.part,
          matchedProductFamily: "TEST_FAMILY", observedPrice: null,
          currency: null, confidence: 0.9, evidenceSnippet: "synthetic",
        }]),
        sourceEvidenceJson: "[]",
        identityVerifiedAt: new Date(),
        identityExpiresAt: new Date(Date.now() + 30 * 86_400_000),
        researchVersion: "1", evidenceSchemaVersion: "1",
        provider: "test",
      },
    });
    const { ensureProductResearchEnqueued } = await import(
      "@/lib/ap-intelligence/external-product-reference/enqueue"
    );
    const decision = await ensureProductResearchEnqueued({
      refRequest: {
        brandCandidates: [SYN.mfr], modelCandidates: [SYN.model],
        skuCandidates: [SYN.part], serialCandidates: [],
        descriptionExcerpt: "", observedUnitPrice: null,
        currency: null, maxCalls: 2,
      },
      clubId: "c1", ingestedDocumentId: "d1",
    });
    expect(decision.kind).toBe("REUSED_COMPLETED");
    const jobs = await prisma.backgroundJob.count({
      where: { kind: "PRODUCT_REFERENCE_RESEARCH", idempotencyKey: { contains: SYN.key } },
    });
    expect(jobs).toBe(0);
  });

  it("expired identityExpiresAt causes lookup to report HIT_EXPIRED (re-research eligible)", async () => {
    await prisma.productReference.create({
      data: {
        normalizedKey: SYN.key,
        normalizedManufacturer: SYN.mfr, normalizedModel: SYN.model,
        normalizedPartNumber: SYN.part, researchState: "COMPLETED",
        identityExpiresAt: new Date(Date.now() - 1_000),
        identityEvidenceJson: "[]", sourceEvidenceJson: "[]",
        researchVersion: "1", evidenceSchemaVersion: "1",
      },
    });
    const { lookupProductReference, normalizeProductKey } = await import(
      "@/lib/ap-intelligence/external-product-reference/durable-cache"
    );
    const key = normalizeProductKey({ manufacturer: SYN.mfr, model: SYN.model, partNumber: SYN.part })!;
    const out = await lookupProductReference(key);
    expect(out.kind).toBe("HIT_EXPIRED");
  });
});

// -----------------------------------------------------------------
// (7) research failure → stable AP abstention (retryable state)
// (8) no result → no repeated immediate search storm
// -----------------------------------------------------------------
describe("§28.7-8 failure states are durable + do not storm", () => {
  it("FAILED_RETRYABLE row within cooldown reports AWAITING_COOLDOWN, no new job", async () => {
    await prisma.productReference.create({
      data: {
        normalizedKey: SYN.key,
        normalizedManufacturer: SYN.mfr, normalizedModel: SYN.model,
        normalizedPartNumber: SYN.part,
        researchState: "FAILED_RETRYABLE",
        researchAttempts: 1,
        nextRetryAt: new Date(Date.now() + 3_600_000),
        identityEvidenceJson: "[]", sourceEvidenceJson: "[]",
        researchVersion: "1", evidenceSchemaVersion: "1",
      },
    });
    const { ensureProductResearchEnqueued } = await import(
      "@/lib/ap-intelligence/external-product-reference/enqueue"
    );
    const d = await ensureProductResearchEnqueued({
      refRequest: {
        brandCandidates: [SYN.mfr], modelCandidates: [SYN.model],
        skuCandidates: [SYN.part], serialCandidates: [],
        descriptionExcerpt: "", observedUnitPrice: null,
        currency: null, maxCalls: 2,
      },
      clubId: "c1", ingestedDocumentId: "d1",
    });
    expect(d.kind).toBe("AWAITING_COOLDOWN");
  });

  it("NO_RESULT terminal state does NOT re-enqueue on subsequent renders", async () => {
    await prisma.productReference.create({
      data: {
        normalizedKey: SYN.key,
        normalizedManufacturer: SYN.mfr, normalizedModel: SYN.model,
        normalizedPartNumber: SYN.part,
        researchState: "NO_RESULT",
        identityEvidenceJson: "[]", sourceEvidenceJson: "[]",
        researchVersion: "1", evidenceSchemaVersion: "1",
      },
    });
    const { ensureProductResearchEnqueued } = await import(
      "@/lib/ap-intelligence/external-product-reference/enqueue"
    );
    const first = await ensureProductResearchEnqueued({
      refRequest: {
        brandCandidates: [SYN.mfr], modelCandidates: [SYN.model],
        skuCandidates: [SYN.part], serialCandidates: [],
        descriptionExcerpt: "", observedUnitPrice: null,
        currency: null, maxCalls: 2,
      },
      clubId: "c1", ingestedDocumentId: "d1",
    });
    expect(first.kind).toBe("REUSED_TERMINAL");
    const jobs = await prisma.backgroundJob.count({
      where: { kind: "PRODUCT_REFERENCE_RESEARCH", idempotencyKey: { contains: SYN.key } },
    });
    expect(jobs).toBe(0);
  });
});

// -----------------------------------------------------------------
// (9) conflicting evidence persisted (10) provider timeout → retry
// (11) terminal provider error → no retry loop
// (12) worker crashes after result before reanalyse enqueue
// -----------------------------------------------------------------
describe("§28.9-12 worker outcome persistence", () => {
  it("provider CONFLICTING_RESULTS persists as CONFLICTING_EVIDENCE state", async () => {
    const { runProductReferenceResearchJob } = await import(
      "@/lib/ap-intelligence/external-product-reference/research-worker"
    );
    const { claimProductReferenceForResearch, normalizeProductKey } = await import(
      "@/lib/ap-intelligence/external-product-reference/durable-cache"
    );
    const { _resetProductReferenceProviderForTest } = await import(
      "@/lib/ap-intelligence/external-product-reference/factory"
    );
    _resetProductReferenceProviderForTest({
      async resolve() {
        return {
          state: "CONFLICTING_RESULTS", callCount: 2,
          products: [], prices: [], diagnostic: "conflict test",
        };
      },
    });
    const key = normalizeProductKey({ manufacturer: SYN.mfr, model: SYN.model, partNumber: SYN.part })!;
    await claimProductReferenceForResearch(key);
    await runProductReferenceResearchJob({
      jobId: "j",
      payload: { normalizedKey: key, refRequest: { brandCandidates: [SYN.mfr], modelCandidates: [SYN.model], skuCandidates: [SYN.part], serialCandidates: [], descriptionExcerpt: "", observedUnitPrice: null, currency: null, maxCalls: 2 }, dependents: [], researchVersion: "1" },
    });
    const row = await prisma.productReference.findUnique({ where: { normalizedKey: key.normalizedKey } });
    expect(row?.researchState).toBe("CONFLICTING_EVIDENCE");
    _resetProductReferenceProviderForTest(null);
  });

  it("provider throwing timeout error → FAILED_RETRYABLE with nextRetryAt", async () => {
    const { runProductReferenceResearchJob } = await import(
      "@/lib/ap-intelligence/external-product-reference/research-worker"
    );
    const { claimProductReferenceForResearch, normalizeProductKey } = await import(
      "@/lib/ap-intelligence/external-product-reference/durable-cache"
    );
    const { _resetProductReferenceProviderForTest } = await import(
      "@/lib/ap-intelligence/external-product-reference/factory"
    );
    _resetProductReferenceProviderForTest({
      async resolve() { throw new Error("network timeout"); },
    });
    const key = normalizeProductKey({ manufacturer: SYN.mfr, model: SYN.model, partNumber: SYN.part })!;
    await claimProductReferenceForResearch(key);
    const result = await runProductReferenceResearchJob({
      jobId: "j",
      payload: { normalizedKey: key, refRequest: { brandCandidates: [SYN.mfr], modelCandidates: [SYN.model], skuCandidates: [SYN.part], serialCandidates: [], descriptionExcerpt: "", observedUnitPrice: null, currency: null, maxCalls: 2 }, dependents: [], researchVersion: "1" },
    });
    expect(result.outcome).toBe("FAILED_RETRYABLE");
    const row = await prisma.productReference.findUnique({ where: { normalizedKey: key.normalizedKey } });
    expect(row?.researchState).toBe("FAILED_RETRYABLE");
    expect(row?.nextRetryAt).toBeTruthy();
    _resetProductReferenceProviderForTest(null);
  });

  it("provider terminal 401 unauthorized → FAILED_TERMINAL, no retry", async () => {
    const { runProductReferenceResearchJob } = await import(
      "@/lib/ap-intelligence/external-product-reference/research-worker"
    );
    const { claimProductReferenceForResearch, normalizeProductKey } = await import(
      "@/lib/ap-intelligence/external-product-reference/durable-cache"
    );
    const { _resetProductReferenceProviderForTest } = await import(
      "@/lib/ap-intelligence/external-product-reference/factory"
    );
    _resetProductReferenceProviderForTest({
      async resolve() { throw new Error("401 unauthorized invalid api key"); },
    });
    const key = normalizeProductKey({ manufacturer: SYN.mfr, model: SYN.model, partNumber: SYN.part })!;
    await claimProductReferenceForResearch(key);
    const result = await runProductReferenceResearchJob({
      jobId: "j",
      payload: { normalizedKey: key, refRequest: { brandCandidates: [SYN.mfr], modelCandidates: [SYN.model], skuCandidates: [SYN.part], serialCandidates: [], descriptionExcerpt: "", observedUnitPrice: null, currency: null, maxCalls: 2 }, dependents: [], researchVersion: "1" },
    });
    expect(result.outcome).toBe("FAILED_TERMINAL");
    const row = await prisma.productReference.findUnique({ where: { normalizedKey: key.normalizedKey } });
    expect(row?.researchState).toBe("FAILED_TERMINAL");
    expect(row?.nextRetryAt).toBeNull();
    _resetProductReferenceProviderForTest(null);
  });

  it("worker rerun after simulated crash between COMPLETED write + reanalyse enqueue → SKIPPED_COMPLETED (idempotent)", async () => {
    await prisma.productReference.create({
      data: {
        normalizedKey: SYN.key,
        normalizedManufacturer: SYN.mfr, normalizedModel: SYN.model,
        normalizedPartNumber: SYN.part, researchState: "COMPLETED",
        identityEvidenceJson: JSON.stringify([{
          evidenceType: "OEM_PRODUCT_MATCH", sourceDomain: "example.com", sourceTitle: "T",
          retrievedAt: new Date().toISOString(), queryFingerprint: "fp",
          matchedManufacturer: SYN.mfr, matchedModel: SYN.model,
          matchedPartNumber: SYN.part, matchedProductFamily: "F",
          observedPrice: null, currency: null, confidence: 0.9, evidenceSnippet: "s",
        }]),
        sourceEvidenceJson: "[]",
        identityVerifiedAt: new Date(),
        identityExpiresAt: new Date(Date.now() + 30 * 86_400_000),
        researchVersion: "1", evidenceSchemaVersion: "1", provider: "test",
      },
    });
    const { runProductReferenceResearchJob } = await import(
      "@/lib/ap-intelligence/external-product-reference/research-worker"
    );
    const { normalizeProductKey } = await import(
      "@/lib/ap-intelligence/external-product-reference/durable-cache"
    );
    const key = normalizeProductKey({ manufacturer: SYN.mfr, model: SYN.model, partNumber: SYN.part })!;
    const r = await runProductReferenceResearchJob({
      jobId: "recover",
      payload: {
        normalizedKey: key,
        refRequest: { brandCandidates: [SYN.mfr], modelCandidates: [SYN.model], skuCandidates: [SYN.part], serialCandidates: [], descriptionExcerpt: "", observedUnitPrice: null, currency: null, maxCalls: 2 },
        dependents: [{ clubId: "c1", ingestedDocumentId: "d1" }],
        researchVersion: "1",
      },
    });
    expect(r.outcome).toBe("SKIPPED_COMPLETED");
    // Reanalyse WAS enqueued because the crash happened before it completed.
    // The idempotency key on AP_INVOICE_REANALYSE protects against dup.
  });
});

// -----------------------------------------------------------------
// (13) recover enqueues reanalyse exactly once
// (14) evidence schema version mismatch
// (15) web/worker version mismatch
// -----------------------------------------------------------------
describe("§28.13-15 recovery + version parity", () => {
  it("worker enqueues AP_INVOICE_REANALYSE exactly once per dependent (idempotent key)", async () => {
    // Seed a real club for the FK constraint on BackgroundJob.clubId.
    const synClub = await prisma.club.upsert({
      where: { id: "syn-c" },
      create: { id: "syn-c", name: "Synthetic Club", slug: "syn-c-slug", createdAt: new Date() },
      update: {},
    });
    void synClub;
    await prisma.backgroundJob.deleteMany({ where: { kind: "AP_INVOICE_REANALYSE", clubId: "syn-c" } });
    const { runProductReferenceResearchJob } = await import(
      "@/lib/ap-intelligence/external-product-reference/research-worker"
    );
    const { claimProductReferenceForResearch, normalizeProductKey } = await import(
      "@/lib/ap-intelligence/external-product-reference/durable-cache"
    );
    const { _resetProductReferenceProviderForTest } = await import(
      "@/lib/ap-intelligence/external-product-reference/factory"
    );
    _resetProductReferenceProviderForTest({
      async resolve() {
        return {
          state: "RESOLVED", callCount: 1,
          products: [{
            evidenceType: "OEM_PRODUCT_MATCH", sourceDomain: "example.com",
            sourceTitle: "T", retrievedAt: new Date().toISOString(),
            queryFingerprint: "fp", matchedManufacturer: SYN.mfr,
            matchedModel: SYN.model, matchedPartNumber: SYN.part,
            matchedProductFamily: "F", observedPrice: null, currency: null,
            confidence: 0.9, evidenceSnippet: "s",
          }],
          prices: [], diagnostic: "",
        };
      },
    });
    const key = normalizeProductKey({ manufacturer: SYN.mfr, model: SYN.model, partNumber: SYN.part })!;
    await claimProductReferenceForResearch(key);
    const r = await runProductReferenceResearchJob({
      jobId: "j",
      payload: {
        normalizedKey: key,
        refRequest: { brandCandidates: [SYN.mfr], modelCandidates: [SYN.model], skuCandidates: [SYN.part], serialCandidates: [], descriptionExcerpt: "", observedUnitPrice: null, currency: null, maxCalls: 2 },
        dependents: [{ clubId: "syn-c", ingestedDocumentId: "syn-d" }],
        researchVersion: "1",
      },
    });
    expect(r.outcome).toBe("COMPLETED");
    expect(r.reanalyseEnqueued).toBe(1);
    const jobs = await prisma.backgroundJob.count({ where: { kind: "AP_INVOICE_REANALYSE", clubId: "syn-c" } });
    expect(jobs).toBe(1);
    await prisma.backgroundJob.deleteMany({ where: { kind: "AP_INVOICE_REANALYSE", clubId: "syn-c" } });
    _resetProductReferenceProviderForTest(null);
  });

  it("evidence written under incompatible schema is reported HIT_SCHEMA_INCOMPATIBLE", async () => {
    await prisma.productReference.create({
      data: {
        normalizedKey: SYN.key,
        normalizedManufacturer: SYN.mfr, normalizedModel: SYN.model,
        normalizedPartNumber: SYN.part, researchState: "COMPLETED",
        identityEvidenceJson: "[]", sourceEvidenceJson: "[]",
        researchVersion: "1", evidenceSchemaVersion: "0.99",
      },
    });
    const { lookupProductReference, normalizeProductKey } = await import(
      "@/lib/ap-intelligence/external-product-reference/durable-cache"
    );
    const key = normalizeProductKey({ manufacturer: SYN.mfr, model: SYN.model, partNumber: SYN.part })!;
    const out = await lookupProductReference(key);
    expect(out.kind).toBe("HIT_SCHEMA_INCOMPATIBLE");
  });

  it("worker refuses jobs with mismatched researchVersion", async () => {
    const { runProductReferenceResearchJob } = await import(
      "@/lib/ap-intelligence/external-product-reference/research-worker"
    );
    const { normalizeProductKey } = await import(
      "@/lib/ap-intelligence/external-product-reference/durable-cache"
    );
    const key = normalizeProductKey({ manufacturer: SYN.mfr, model: SYN.model, partNumber: SYN.part })!;
    const r = await runProductReferenceResearchJob({
      jobId: "j",
      payload: {
        normalizedKey: key,
        refRequest: { brandCandidates: [SYN.mfr], modelCandidates: [SYN.model], skuCandidates: [SYN.part], serialCandidates: [], descriptionExcerpt: "", observedUnitPrice: null, currency: null, maxCalls: 2 },
        dependents: [], researchVersion: "999",
      },
    });
    expect(r.outcome).toBe("SKIPPED_VERSION_MISMATCH");
  });
});

// -----------------------------------------------------------------
// (16) same product across two invoices → cache reuse
// (17) same product across two tenants → factual reuse, accounting independence
// (18) different part number same model → correct cache separation
// -----------------------------------------------------------------
describe("§28.16-18 cross-invoice + cross-tenant + variant discrimination", () => {
  it("second invoice for same product hits cache", async () => {
    const { ensureProductResearchEnqueued } = await import(
      "@/lib/ap-intelligence/external-product-reference/enqueue"
    );
    const req1 = {
      refRequest: { brandCandidates: [SYN.mfr], modelCandidates: [SYN.model], skuCandidates: [SYN.part], serialCandidates: [], descriptionExcerpt: "", observedUnitPrice: null, currency: null, maxCalls: 2 },
      clubId: "c1", ingestedDocumentId: "d1",
    };
    const first = await ensureProductResearchEnqueued(req1);
    expect(first.kind).toBe("RESEARCH_JUST_ENQUEUED");
    // Simulate worker COMPLETION.
    await prisma.productReference.updateMany({
      where: { normalizedKey: SYN.key },
      data: {
        researchState: "COMPLETED",
        identityEvidenceJson: JSON.stringify([{
          evidenceType: "OEM_PRODUCT_MATCH", sourceDomain: "example.com",
          sourceTitle: "T", retrievedAt: new Date().toISOString(),
          queryFingerprint: "fp", matchedManufacturer: SYN.mfr,
          matchedModel: SYN.model, matchedPartNumber: SYN.part,
          matchedProductFamily: "F", observedPrice: null, currency: null,
          confidence: 0.9, evidenceSnippet: "s",
        }]),
        identityVerifiedAt: new Date(),
        identityExpiresAt: new Date(Date.now() + 30 * 86_400_000),
      },
    });
    const req2 = { ...req1, ingestedDocumentId: "d2" };
    const second = await ensureProductResearchEnqueued(req2);
    expect(second.kind).toBe("REUSED_COMPLETED");
  });

  it("two tenants share factual identity but neither writes accounting into ProductReference", async () => {
    const { ensureProductResearchEnqueued } = await import(
      "@/lib/ap-intelligence/external-product-reference/enqueue"
    );
    const req = {
      refRequest: { brandCandidates: [SYN.mfr], modelCandidates: [SYN.model], skuCandidates: [SYN.part], serialCandidates: [], descriptionExcerpt: "", observedUnitPrice: null, currency: null, maxCalls: 2 },
      clubId: "TEN-A", ingestedDocumentId: "TEN-A-d1",
    };
    await ensureProductResearchEnqueued(req);
    await prisma.productReference.updateMany({
      where: { normalizedKey: SYN.key },
      data: {
        researchState: "COMPLETED",
        identityEvidenceJson: JSON.stringify([{
          evidenceType: "OEM_PRODUCT_MATCH", sourceDomain: "example.com",
          sourceTitle: "T", retrievedAt: new Date().toISOString(),
          queryFingerprint: "fp", matchedManufacturer: SYN.mfr,
          matchedModel: SYN.model, matchedPartNumber: SYN.part,
          matchedProductFamily: "F", observedPrice: null, currency: null,
          confidence: 0.9, evidenceSnippet: "s",
        }]),
        identityVerifiedAt: new Date(),
        identityExpiresAt: new Date(Date.now() + 30 * 86_400_000),
      },
    });
    const otherTenant = await ensureProductResearchEnqueued({
      ...req, clubId: "TEN-B", ingestedDocumentId: "TEN-B-d1",
    });
    expect(otherTenant.kind).toBe("REUSED_COMPLETED");
    const row = await prisma.productReference.findUnique({ where: { normalizedKey: SYN.key } });
    // Privacy invariant — no tenant column, no accounting columns.
    expect(Object.keys(row as unknown as Record<string, unknown>)).not.toContain("clubId");
    expect(Object.keys(row as unknown as Record<string, unknown>)).not.toContain("recommendedAccount");
    expect(Object.keys(row as unknown as Record<string, unknown>)).not.toContain("departmentKey");
  });

  it("different partNumber → different normalizedKey → different cache row", async () => {
    const { normalizeProductKey } = await import(
      "@/lib/ap-intelligence/external-product-reference/durable-cache"
    );
    const a = normalizeProductKey({ manufacturer: SYN.mfr, model: SYN.model, partNumber: "PART-A" })!;
    const b = normalizeProductKey({ manufacturer: SYN.mfr, model: SYN.model, partNumber: "PART-B" })!;
    expect(a.normalizedKey).not.toBe(b.normalizedKey);
  });
});

// -----------------------------------------------------------------
// (19) new researchVersion → controlled refresh
// (20) daily quota exhausted → truthful pending/failed state
// (21) circuit breaker open → no guessed result
// (22) ProductReference exists but evidence too weak → analyser ambiguous
// -----------------------------------------------------------------
describe("§28.19-22 governance + defensive states", () => {
  it("resetForRefresh forces PENDING + increments researchVersion tracking", async () => {
    await prisma.productReference.create({
      data: {
        normalizedKey: SYN.key,
        normalizedManufacturer: SYN.mfr, normalizedModel: SYN.model,
        normalizedPartNumber: SYN.part,
        researchState: "COMPLETED", researchVersion: "1",
        evidenceSchemaVersion: "1", identityEvidenceJson: "[]",
        sourceEvidenceJson: "[]",
      },
    });
    const { resetForRefresh } = await import(
      "@/lib/ap-intelligence/external-product-reference/durable-cache"
    );
    const row = await prisma.productReference.findUnique({ where: { normalizedKey: SYN.key } });
    const refreshed = await resetForRefresh(row!.id);
    expect(refreshed.researchState).toBe("PENDING");
  });

  it("privacy audit rejects evidence with banned fields", async () => {
    const { auditEvidenceForPrivacyViolation } = await import(
      "@/lib/ap-intelligence/external-product-reference/durable-cache"
    );
    const dirty = [{
      evidenceType: "OEM_PRODUCT_MATCH" as const,
      sourceDomain: "x", sourceTitle: "y", retrievedAt: "z",
      queryFingerprint: "f", matchedManufacturer: null, matchedModel: null,
      matchedPartNumber: null, matchedProductFamily: null, observedPrice: null,
      currency: null, confidence: 0.5, evidenceSnippet: "ok",
      clubId: "leaked-club-id",
      invoiceNumber: "leaked-invoice",
    } as unknown as import("@/lib/ap-intelligence/product-reference-provider").ProductReferenceEvidence];
    const audit = auditEvidenceForPrivacyViolation(dirty);
    expect(audit.ok).toBe(false);
    expect(audit.offendingFields).toContain("clubId");
    expect(audit.offendingFields).toContain("invoiceNumber");
  });

  it("weak / empty evidence in COMPLETED row does not mock up strong identity", async () => {
    await prisma.productReference.create({
      data: {
        normalizedKey: SYN.key,
        normalizedManufacturer: SYN.mfr, normalizedModel: SYN.model,
        normalizedPartNumber: SYN.part, researchState: "COMPLETED",
        identityEvidenceJson: "[]", sourceEvidenceJson: "[]",
        identityVerifiedAt: new Date(),
        identityExpiresAt: new Date(Date.now() + 30 * 86_400_000),
        researchVersion: "1", evidenceSchemaVersion: "1",
      },
    });
    const { lookupProductReference, normalizeProductKey } = await import(
      "@/lib/ap-intelligence/external-product-reference/durable-cache"
    );
    const key = normalizeProductKey({ manufacturer: SYN.mfr, model: SYN.model, partNumber: SYN.part })!;
    const out = await lookupProductReference(key);
    if (out.kind === "HIT_USABLE") {
      // Evidence array is empty → no fabricated identity.
      expect(out.reference.identityEvidenceJson).toHaveLength(0);
      expect(out.reference.confidence).toBe(0);
    } else {
      throw new Error(`unexpected outcome: ${out.kind}`);
    }
  });

  // -----------------------------------------------------------------
  // §3 follow-up — INFRASTRUCTURE_UNCONFIGURED is a rerunnable
  // sentinel, NOT a factual terminal. Adding tests here (numbered
  // 23-26) to prove the correction.
  // -----------------------------------------------------------------

  it("§3.23 PROVIDER_DISABLED persists as INFRASTRUCTURE_UNCONFIGURED, not FAILED_TERMINAL", async () => {
    const { runProductReferenceResearchJob } = await import(
      "@/lib/ap-intelligence/external-product-reference/research-worker"
    );
    const { claimProductReferenceForResearch, normalizeProductKey } = await import(
      "@/lib/ap-intelligence/external-product-reference/durable-cache"
    );
    const { _resetProductReferenceProviderForTest } = await import(
      "@/lib/ap-intelligence/external-product-reference/factory"
    );
    // NullProvider returns state=PROVIDER_DISABLED (the exact scenario
    // that previously poisoned rows before §3 correction).
    _resetProductReferenceProviderForTest({
      async resolve() {
        return { state: "PROVIDER_DISABLED", callCount: 0, products: [], prices: [], diagnostic: "no provider" };
      },
    });
    const key = normalizeProductKey({ manufacturer: SYN.mfr, model: SYN.model, partNumber: SYN.part })!;
    await claimProductReferenceForResearch(key);
    await runProductReferenceResearchJob({
      jobId: "j",
      payload: {
        normalizedKey: key,
        refRequest: { brandCandidates: [SYN.mfr], modelCandidates: [SYN.model], skuCandidates: [SYN.part], serialCandidates: [], descriptionExcerpt: "", observedUnitPrice: null, currency: null, maxCalls: 2 },
        dependents: [], researchVersion: "1",
      },
    });
    const row = await prisma.productReference.findUnique({ where: { normalizedKey: key.normalizedKey } });
    expect(row?.researchState).toBe("INFRASTRUCTURE_UNCONFIGURED");
    expect(row?.researchState).not.toBe("FAILED_TERMINAL");
    _resetProductReferenceProviderForTest(null);
  });

  it("§3.24 INFRASTRUCTURE_UNCONFIGURED → provider later configured → next lookup allows exactly one re-enqueue", async () => {
    // Seed an existing INFRASTRUCTURE_UNCONFIGURED row (as if worker
    // had no provider when it processed the first attempt).
    await prisma.productReference.create({
      data: {
        normalizedKey: SYN.key,
        normalizedManufacturer: SYN.mfr, normalizedModel: SYN.model,
        normalizedPartNumber: SYN.part,
        researchState: "INFRASTRUCTURE_UNCONFIGURED",
        provider: "null",
        identityEvidenceJson: "[]", sourceEvidenceJson: "[]",
        researchVersion: "1", evidenceSchemaVersion: "1",
        lastResearchError: "no product-reference provider configured",
      },
    });
    const { lookupProductReference, normalizeProductKey } = await import(
      "@/lib/ap-intelligence/external-product-reference/durable-cache"
    );
    const key = normalizeProductKey({ manufacturer: SYN.mfr, model: SYN.model, partNumber: SYN.part })!;

    // Lookup must return the distinct diagnostic kind, NOT HIT_TERMINAL.
    const lookup = await lookupProductReference(key);
    expect(lookup.kind).toBe("HIT_INFRASTRUCTURE_UNCONFIGURED");

    // Enqueue helper must fall through to claim + enqueue exactly once.
    const { ensureProductResearchEnqueued } = await import(
      "@/lib/ap-intelligence/external-product-reference/enqueue"
    );
    const req = {
      refRequest: { brandCandidates: [SYN.mfr], modelCandidates: [SYN.model], skuCandidates: [SYN.part], serialCandidates: [], descriptionExcerpt: "", observedUnitPrice: null, currency: null, maxCalls: 2 },
      clubId: "c1", ingestedDocumentId: "d1",
    };
    const first = await ensureProductResearchEnqueued(req);
    expect(first.kind).toBe("RESEARCH_JUST_ENQUEUED");

    const row = await prisma.productReference.findUnique({ where: { normalizedKey: SYN.key } });
    expect(row?.researchState).toBe("PENDING");

    const jobs = await prisma.backgroundJob.count({
      where: { kind: "PRODUCT_REFERENCE_RESEARCH", idempotencyKey: { contains: SYN.key } },
    });
    expect(jobs).toBe(1);
  });

  it("§3.25 concurrent re-enqueue on INFRASTRUCTURE_UNCONFIGURED — only one winner", async () => {
    await prisma.productReference.create({
      data: {
        normalizedKey: SYN.key,
        normalizedManufacturer: SYN.mfr, normalizedModel: SYN.model,
        normalizedPartNumber: SYN.part,
        researchState: "INFRASTRUCTURE_UNCONFIGURED",
        provider: "null",
        identityEvidenceJson: "[]", sourceEvidenceJson: "[]",
        researchVersion: "1", evidenceSchemaVersion: "1",
      },
    });
    const { ensureProductResearchEnqueued } = await import(
      "@/lib/ap-intelligence/external-product-reference/enqueue"
    );
    const req = {
      refRequest: { brandCandidates: [SYN.mfr], modelCandidates: [SYN.model], skuCandidates: [SYN.part], serialCandidates: [], descriptionExcerpt: "", observedUnitPrice: null, currency: null, maxCalls: 2 },
      clubId: "c1", ingestedDocumentId: "d1",
    };
    const results = await Promise.all([
      ensureProductResearchEnqueued(req),
      ensureProductResearchEnqueued(req),
      ensureProductResearchEnqueued(req),
    ]);
    const enqueued = results.filter((r) => r.kind === "RESEARCH_JUST_ENQUEUED").length;
    expect(enqueued).toBe(1);
    const jobs = await prisma.backgroundJob.count({
      where: { kind: "PRODUCT_REFERENCE_RESEARCH", idempotencyKey: { contains: SYN.key } },
    });
    expect(jobs).toBe(1);
  });

  it("§3.26 repeated refresh while provider remains unconfigured is bounded — one PENDING at a time", async () => {
    // Simulate: worker still misconfigured — every worker run produces
    // INFRASTRUCTURE_UNCONFIGURED. Web-tier refresh must not spawn
    // uncontrolled duplicate jobs.
    const { runProductReferenceResearchJob } = await import(
      "@/lib/ap-intelligence/external-product-reference/research-worker"
    );
    const { claimProductReferenceForResearch, normalizeProductKey } = await import(
      "@/lib/ap-intelligence/external-product-reference/durable-cache"
    );
    const { _resetProductReferenceProviderForTest } = await import(
      "@/lib/ap-intelligence/external-product-reference/factory"
    );
    _resetProductReferenceProviderForTest({
      async resolve() {
        return { state: "PROVIDER_DISABLED", callCount: 0, products: [], prices: [], diagnostic: "" };
      },
    });
    const key = normalizeProductKey({ manufacturer: SYN.mfr, model: SYN.model, partNumber: SYN.part })!;

    // Round 1: claim + worker executes + persists INFRASTRUCTURE_UNCONFIGURED.
    await claimProductReferenceForResearch(key);
    await runProductReferenceResearchJob({
      jobId: "j1",
      payload: {
        normalizedKey: key,
        refRequest: { brandCandidates: [SYN.mfr], modelCandidates: [SYN.model], skuCandidates: [SYN.part], serialCandidates: [], descriptionExcerpt: "", observedUnitPrice: null, currency: null, maxCalls: 2 },
        dependents: [], researchVersion: "1",
      },
    });
    let row = await prisma.productReference.findUnique({ where: { normalizedKey: SYN.key } });
    expect(row?.researchState).toBe("INFRASTRUCTURE_UNCONFIGURED");

    // Round 2: 5 concurrent renders — each falls through to claim.
    // Only one may transition INFRASTRUCTURE_UNCONFIGURED → PENDING.
    const { ensureProductResearchEnqueued } = await import(
      "@/lib/ap-intelligence/external-product-reference/enqueue"
    );
    const req = {
      refRequest: { brandCandidates: [SYN.mfr], modelCandidates: [SYN.model], skuCandidates: [SYN.part], serialCandidates: [], descriptionExcerpt: "", observedUnitPrice: null, currency: null, maxCalls: 2 },
      clubId: "c1", ingestedDocumentId: "d1",
    };
    const results = await Promise.all(Array.from({ length: 5 }, () => ensureProductResearchEnqueued(req)));
    const enqueued = results.filter((r) => r.kind === "RESEARCH_JUST_ENQUEUED").length;
    expect(enqueued).toBe(1);
    const jobs = await prisma.backgroundJob.count({
      where: { kind: "PRODUCT_REFERENCE_RESEARCH", idempotencyKey: { contains: SYN.key } },
    });
    expect(jobs).toBe(1);
    _resetProductReferenceProviderForTest(null);
  });

  it("unresolvable key (empty model) rejects cleanly without touching DB", async () => {
    const { ensureProductResearchEnqueued } = await import(
      "@/lib/ap-intelligence/external-product-reference/enqueue"
    );
    const d = await ensureProductResearchEnqueued({
      refRequest: {
        brandCandidates: ["ANYTHING"], modelCandidates: [],
        skuCandidates: [], serialCandidates: [],
        descriptionExcerpt: "", observedUnitPrice: null,
        currency: null, maxCalls: 2,
      },
      clubId: "c1", ingestedDocumentId: "d1",
    });
    expect(d.kind).toBe("UNRESOLVABLE_KEY");
  });
});
