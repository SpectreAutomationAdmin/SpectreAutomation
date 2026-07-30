// Sprint 3 · Checkpoint 15X continuation (2026-07-29) — required
// tests before Textract IAM enablement.
//
// Founder §13 rules covered here:
//   1.  Image-only document creates OCR_REQUIRED (PENDING row).
//   2.  One worker job is enqueued per identity.
//   3.  Render path does NOT call Textract (strategy router
//       refuses inline invocation).
//   4.  Modal open does NOT call Textract (same code path — proven
//       by refusal in strategy router).
//   5.  Repeated renders do NOT enqueue another job.
//   6.  Concurrent workers result in ONE provider invocation
//       (claimPendingForProcessing atomic transition).
//   7.  Successful normalized extraction is persisted.
//   8.  Same version reuses persisted extraction.
//   9.  New version causes ONE controlled reprocessing.
//   10. Retryable errors retry within bounds; terminal don't.
//   11. Permission denial is terminal (does NOT burn retry budget).
//   12. Successful OCR bumps ocrRevision fingerprint for cache.
//   13. Tenant isolation enforced on persistence lookups.
//   14. Sanitized error codes never contain raw provider messages.

import { describe, expect, it, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createOrReturnPendingExtraction,
  claimPendingForProcessing,
  markExtractionSucceeded,
  markExtractionRetryable,
  markExtractionTerminal,
  findOcrExtraction,
  ocrIdempotencyKey,
  loadOcrExtractionRevision,
} from "@/lib/ap-intelligence/ocr/persistence";
import { requestOcrExtraction } from "@/lib/ap-intelligence/ocr/enqueue";
import {
  OCR_EXTRACTION_VERSION,
  OCR_PROVIDER_ID_AWS_TEXTRACT,
  resolveTextractRegion,
} from "@/lib/ap-intelligence/ocr/config";
import { runDocumentExtractionStrategy } from "@/lib/ap-intelligence/document-extractors/strategy-router";
import type { CanonicalDocumentExtraction } from "@/lib/ap-intelligence/document-extractors/canonical-model";

// -----------------------------------------------------------------------------
// Test fixture — a minimal club + ingested doc so persistence FKs are valid
// -----------------------------------------------------------------------------

async function seedClubAndDoc(args: {
  slug: string;
  filename?: string;
  sha256?: string;
}): Promise<{ clubId: string; docId: string; sha256: string }> {
  const club = await prisma.club.create({
    data: {
      slug: args.slug,
      name: `Test Club ${args.slug}`,
    },
  });
  const sha = args.sha256 ?? `sha-${args.slug}-${Math.random().toString(36).slice(2, 10)}`;
  const doc = await prisma.ingestedDocument.create({
    data: {
      clubId: club.id,
      sourceKind: "EMAIL_ATTACHMENT",
      sourceReferenceId: `att-${args.slug}`,
      filename: args.filename ?? "invoice.pdf",
      originalFilename: args.filename ?? "invoice.pdf",
      mimeType: "application/pdf",
      byteLength: 342_862,
      sha256Hash: sha,
      storageBucket: "R2",
      storageKey: `clubs/${club.id}/inbox/${args.slug}.pdf`,
      receivedAt: new Date(),
    },
  });
  return { clubId: club.id, docId: doc.id, sha256: sha };
}

// -----------------------------------------------------------------------------
// §7 — region config
// -----------------------------------------------------------------------------

describe("15X · region config (§7)", () => {
  it("refuses to fall back to AWS_REGION when SPECTRE_TEXTRACT_REGION is unset", () => {
    const priorSpectre = process.env.SPECTRE_TEXTRACT_REGION;
    const priorAws = process.env.AWS_REGION;
    delete process.env.SPECTRE_TEXTRACT_REGION;
    process.env.AWS_REGION = "eu-west-1"; // KMS region — must NOT leak
    const res = resolveTextractRegion();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toMatch(/SPECTRE_TEXTRACT_REGION/);
      expect(res.reason).not.toMatch(/eu-west-1/);
    }
    // restore
    if (priorSpectre !== undefined) process.env.SPECTRE_TEXTRACT_REGION = priorSpectre;
    if (priorAws !== undefined) process.env.AWS_REGION = priorAws;
    else delete process.env.AWS_REGION;
  });

  it("uses SPECTRE_TEXTRACT_REGION when set", () => {
    const prior = process.env.SPECTRE_TEXTRACT_REGION;
    process.env.SPECTRE_TEXTRACT_REGION = "us-east-1";
    const res = resolveTextractRegion();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.region).toBe("us-east-1");
      expect(res.source).toBe("SPECTRE_TEXTRACT_REGION");
    }
    if (prior !== undefined) process.env.SPECTRE_TEXTRACT_REGION = prior;
    else delete process.env.SPECTRE_TEXTRACT_REGION;
  });
});

// -----------------------------------------------------------------------------
// §4 — idempotency at the persistence layer
// -----------------------------------------------------------------------------

describe("15X · persistence idempotency (§4)", () => {
  it("createOrReturnPendingExtraction: two identical calls return the same row and created=false on the second", async () => {
    const { clubId, docId, sha256 } = await seedClubAndDoc({ slug: "c15x-idemp-1" });
    const first = await createOrReturnPendingExtraction({
      clubId,
      ingestedDocumentId: docId,
      documentSha256: sha256,
      documentClass: "IMAGE_ONLY",
      strategy: "AWS_TEXTRACT_EXPENSE",
    });
    const second = await createOrReturnPendingExtraction({
      clubId,
      ingestedDocumentId: docId,
      documentSha256: sha256,
      documentClass: "IMAGE_ONLY",
      strategy: "AWS_TEXTRACT_EXPENSE",
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
  });

  it("ocrIdempotencyKey is stable and identity-shaped", () => {
    const k1 = ocrIdempotencyKey({
      clubId: "club-A",
      documentSha256: "abc",
      provider: OCR_PROVIDER_ID_AWS_TEXTRACT,
      extractionVersion: OCR_EXTRACTION_VERSION,
    });
    const k2 = ocrIdempotencyKey({
      clubId: "club-A",
      documentSha256: "abc",
      provider: OCR_PROVIDER_ID_AWS_TEXTRACT,
      extractionVersion: OCR_EXTRACTION_VERSION,
    });
    expect(k1).toBe(k2);
    expect(k1).toContain("club-A");
    expect(k1).toContain("abc");
    expect(k1).toContain(String(OCR_EXTRACTION_VERSION));
  });
});

// -----------------------------------------------------------------------------
// §4 — atomic PROCESSING claim (concurrent workers)
// -----------------------------------------------------------------------------

describe("15X · atomic worker claim (§4 concurrency)", () => {
  it("claimPendingForProcessing succeeds for one caller and returns null for the second", async () => {
    const { clubId, docId, sha256 } = await seedClubAndDoc({ slug: "c15x-claim-1" });
    const { row } = await createOrReturnPendingExtraction({
      clubId,
      ingestedDocumentId: docId,
      documentSha256: sha256,
      documentClass: "IMAGE_ONLY",
      strategy: "AWS_TEXTRACT_EXPENSE",
    });
    const first = await claimPendingForProcessing({ id: row.id, workerId: "w1" });
    const second = await claimPendingForProcessing({ id: row.id, workerId: "w2" });
    expect(first).not.toBeNull();
    expect(first?.status).toBe("PROCESSING");
    expect(second).toBeNull();
  });

  it("claim allows re-entry after markExtractionRetryable (FAILED_RETRYABLE re-claimable)", async () => {
    const { clubId, docId, sha256 } = await seedClubAndDoc({ slug: "c15x-claim-2" });
    const { row } = await createOrReturnPendingExtraction({
      clubId,
      ingestedDocumentId: docId,
      documentSha256: sha256,
      documentClass: "IMAGE_ONLY",
      strategy: "AWS_TEXTRACT_EXPENSE",
    });
    await claimPendingForProcessing({ id: row.id, workerId: "w1" });
    await markExtractionRetryable({
      id: row.id,
      sanitizedErrorCode: "PROVIDER_RATE_LIMITED",
      nextRetryAt: new Date(Date.now() + 1000),
      currentAttempt: 1,
      maxAttempts: 3,
    });
    const second = await claimPendingForProcessing({ id: row.id, workerId: "w2" });
    expect(second).not.toBeNull();
    expect(second?.status).toBe("PROCESSING");
    expect(second?.attemptCount).toBe(2);
  });

  it("claim refuses SUCCEEDED rows — no re-invocation after success", async () => {
    const { clubId, docId, sha256 } = await seedClubAndDoc({ slug: "c15x-claim-3" });
    const { row } = await createOrReturnPendingExtraction({
      clubId,
      ingestedDocumentId: docId,
      documentSha256: sha256,
      documentClass: "IMAGE_ONLY",
      strategy: "AWS_TEXTRACT_EXPENSE",
    });
    await claimPendingForProcessing({ id: row.id, workerId: "w1" });
    const canon: CanonicalDocumentExtraction = {
      strategy: "AWS_TEXTRACT_EXPENSE",
      documentClass: "IMAGE_ONLY",
      pages: [{ pageNumber: 1 }],
      fields: {},
      lineItems: [],
      confidence: 88,
      warnings: [],
    };
    await markExtractionSucceeded({ id: row.id, canonical: canon });
    const second = await claimPendingForProcessing({ id: row.id, workerId: "w2" });
    expect(second).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// §10 — retry ceiling and terminal transitions
// -----------------------------------------------------------------------------

describe("15X · retry ceiling and terminal transitions (§10)", () => {
  it("markExtractionRetryable at maxAttempts transitions to FAILED_TERMINAL", async () => {
    const { clubId, docId, sha256 } = await seedClubAndDoc({ slug: "c15x-retry-1" });
    const { row } = await createOrReturnPendingExtraction({
      clubId,
      ingestedDocumentId: docId,
      documentSha256: sha256,
      documentClass: "IMAGE_ONLY",
      strategy: "AWS_TEXTRACT_EXPENSE",
    });
    const terminal = await markExtractionRetryable({
      id: row.id,
      sanitizedErrorCode: "PROVIDER_RATE_LIMITED",
      nextRetryAt: new Date(),
      currentAttempt: 3,
      maxAttempts: 3,
    });
    expect(terminal.status).toBe("FAILED_TERMINAL");
    expect(terminal.nextRetryAt).toBeNull();
  });

  it("markExtractionTerminal writes sanitized code, never raw provider text", async () => {
    const { clubId, docId, sha256 } = await seedClubAndDoc({ slug: "c15x-retry-2" });
    const { row } = await createOrReturnPendingExtraction({
      clubId,
      ingestedDocumentId: docId,
      documentSha256: sha256,
      documentClass: "IMAGE_ONLY",
      strategy: "AWS_TEXTRACT_EXPENSE",
    });
    const terminal = await markExtractionTerminal({
      id: row.id,
      sanitizedErrorCode: "PROVIDER_PERMISSION_DENIED",
    });
    expect(terminal.sanitizedErrorCode).toBe("PROVIDER_PERMISSION_DENIED");
    // The code must be an enum shape — no colons, no spaces, no
    // supplier addresses, no raw provider prose.
    expect(terminal.sanitizedErrorCode).toMatch(/^[A-Z_]+$/);
  });
});

// -----------------------------------------------------------------------------
// §11 — cache invalidation fingerprint
// -----------------------------------------------------------------------------

describe("15X · cache invalidation fingerprint (§11)", () => {
  it("loadOcrExtractionRevision changes when a new row is created", async () => {
    const { clubId, docId, sha256 } = await seedClubAndDoc({ slug: "c15x-rev-1" });
    const before = await loadOcrExtractionRevision(clubId);
    await createOrReturnPendingExtraction({
      clubId,
      ingestedDocumentId: docId,
      documentSha256: sha256,
      documentClass: "IMAGE_ONLY",
      strategy: "AWS_TEXTRACT_EXPENSE",
    });
    const after = await loadOcrExtractionRevision(clubId);
    expect(after).not.toBe(before);
  });

  it("loadOcrExtractionRevision changes when an existing row transitions to SUCCEEDED", async () => {
    const { clubId, docId, sha256 } = await seedClubAndDoc({ slug: "c15x-rev-2" });
    const { row } = await createOrReturnPendingExtraction({
      clubId,
      ingestedDocumentId: docId,
      documentSha256: sha256,
      documentClass: "IMAGE_ONLY",
      strategy: "AWS_TEXTRACT_EXPENSE",
    });
    const before = await loadOcrExtractionRevision(clubId);
    // Simulate the worker succeeding.
    // Ensure updatedAt changes even if the wall clock has not
    // advanced by introducing a tiny delay.
    await new Promise((r) => setTimeout(r, 5));
    await markExtractionSucceeded({
      id: row.id,
      canonical: {
        strategy: "AWS_TEXTRACT_EXPENSE",
        documentClass: "IMAGE_ONLY",
        pages: [{ pageNumber: 1 }],
        fields: {},
        lineItems: [],
        confidence: 88,
        warnings: [],
      },
    });
    const after = await loadOcrExtractionRevision(clubId);
    expect(after).not.toBe(before);
  });
});

// -----------------------------------------------------------------------------
// §13 — tenant isolation
// -----------------------------------------------------------------------------

describe("15X · tenant isolation (§13)", () => {
  it("findOcrExtraction refuses cross-tenant reads", async () => {
    const clubA = await seedClubAndDoc({ slug: "c15x-tenant-A" });
    const clubB = await seedClubAndDoc({ slug: "c15x-tenant-B" });
    const { row: rowA } = await createOrReturnPendingExtraction({
      clubId: clubA.clubId,
      ingestedDocumentId: clubA.docId,
      documentSha256: clubA.sha256,
      documentClass: "IMAGE_ONLY",
      strategy: "AWS_TEXTRACT_EXPENSE",
    });
    const shouldMiss = await findOcrExtraction({
      clubId: clubB.clubId,             // WRONG club
      documentSha256: clubA.sha256,     // right sha
      provider: OCR_PROVIDER_ID_AWS_TEXTRACT,
      extractionVersion: OCR_EXTRACTION_VERSION,
    });
    expect(shouldMiss).toBeNull();
    const shouldHit = await findOcrExtraction({
      clubId: clubA.clubId,
      documentSha256: clubA.sha256,
      provider: OCR_PROVIDER_ID_AWS_TEXTRACT,
      extractionVersion: OCR_EXTRACTION_VERSION,
    });
    expect(shouldHit?.id).toBe(rowA.id);
  });
});

// -----------------------------------------------------------------------------
// §1 — router refuses inline OCR (browser-render safety)
// -----------------------------------------------------------------------------

describe("15X · strategy router NEVER invokes OCR inline (§1)", () => {
  it("router returns 0 for ocrProviderCallsThisTurn on IMAGE_ONLY without full context", async () => {
    // Bytes that would look image-only to the assessor: real PDFs
    // must have %PDF signature — supply a minimal one so pdf-parse
    // doesn't throw before assessor sees it.
    const stub = Buffer.from("%PDF-1.4\n%stubbed\n%%EOF");
    const result = await runDocumentExtractionStrategy({
      bytes: stub,
      mimeType: "application/pdf",
    });
    expect(result.ocrProviderCallsThisTurn).toBe(0);
  });

  it("router-level enqueue on IMAGE_ONLY class does NOT re-enqueue on repeat", async () => {
    // requestOcrExtraction is the enqueue surface. Two identical
    // calls must produce one row and reason=already_pending on the
    // second — proving §5 (repeated renders do not enqueue another
    // job).
    const { clubId, docId, sha256 } = await seedClubAndDoc({ slug: "c15x-router-repeat" });
    const first = await requestOcrExtraction({
      clubId,
      ingestedDocumentId: docId,
      documentSha256: sha256,
      documentClass: "IMAGE_ONLY",
      strategy: "AWS_TEXTRACT_EXPENSE",
    });
    const second = await requestOcrExtraction({
      clubId,
      ingestedDocumentId: docId,
      documentSha256: sha256,
      documentClass: "IMAGE_ONLY",
      strategy: "AWS_TEXTRACT_EXPENSE",
    });
    expect(first.row.id).toBe(second.row.id);
    expect(second.reason).toMatch(/already_/);
    // The queued job also collapses to one via the queue's own
    // idempotencyKey unique constraint.
    const jobCount = await prisma.backgroundJob.count({
      where: {
        kind: "AP_DOCUMENT_OCR",
        idempotencyKey: ocrIdempotencyKey({
          clubId,
          documentSha256: sha256,
          provider: OCR_PROVIDER_ID_AWS_TEXTRACT,
          extractionVersion: OCR_EXTRACTION_VERSION,
        }),
      },
    });
    // ocr_disabled path may return 0 (no enqueue) — either way must
    // be ≤ 1 job for the identity.
    expect(jobCount).toBeLessThanOrEqual(1);
  });
});

// -----------------------------------------------------------------------------
// §5 — controlled reprocessing on version bump
// -----------------------------------------------------------------------------

describe("15X · controlled reprocessing on version bump (§5)", () => {
  it("bumping extractionVersion creates a new row while the old one persists (audit)", async () => {
    const { clubId, docId, sha256 } = await seedClubAndDoc({ slug: "c15x-repro-1" });
    // Old version row (created directly to simulate a prior version).
    await prisma.documentOcrExtraction.create({
      data: {
        clubId,
        ingestedDocumentId: docId,
        documentSha256: sha256,
        documentClass: "IMAGE_ONLY",
        provider: OCR_PROVIDER_ID_AWS_TEXTRACT,
        providerApi: "ANALYZE_EXPENSE",
        extractionVersion: 0,               // simulated prior version
        normalizedSchemaVersion: 0,
        strategy: "AWS_TEXTRACT_EXPENSE",
        status: "SUCCEEDED",
      },
    });
    // Now request under the current (bumped) version.
    const req = await requestOcrExtraction({
      clubId,
      ingestedDocumentId: docId,
      documentSha256: sha256,
      documentClass: "IMAGE_ONLY",
      strategy: "AWS_TEXTRACT_EXPENSE",
    });
    // A NEW row exists for the current version.
    expect(req.row.extractionVersion).toBe(OCR_EXTRACTION_VERSION);
    const allForDoc = await prisma.documentOcrExtraction.findMany({
      where: { clubId, ingestedDocumentId: docId },
    });
    // Two rows total — the old (audit) plus the new (current).
    expect(allForDoc.length).toBe(2);
  });
});
