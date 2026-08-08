// Sprint 3 · Checkpoint 15X continuation (2026-07-29) — persistence
// for canonical OCR extractions.
//
// Founder §3 rule: extraction must be persisted with document class,
// strategy, provider, extraction version, status, warnings, and
// bounded retry state so the projection layer can read the stored
// result instead of re-invoking the paid provider on every render.
//
// Founder §4 idempotency rule: the durable identity of an OCR run
// is (clubId, documentSha256, provider, extractionVersion). At most
// one SUCCEEDED row can exist per identity; the underlying Prisma
// unique constraint enforces this at the database level, safe under
// concurrent worker races.

import { prisma } from "@/lib/prisma";
import type { CanonicalDocumentExtraction } from "../document-extractors/canonical-model";
import type { DocumentClass } from "../document-class";
import {
  OCR_EXTRACTION_VERSION,
  OCR_NORMALIZED_SCHEMA_VERSION,
  OCR_PROVIDER_ID_AWS_TEXTRACT,
  OCR_PROVIDER_API_ANALYZE_EXPENSE,
} from "./config";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type OcrExtractionStatus =
  | "PENDING"
  | "PROCESSING"
  | "SUCCEEDED"
  | "FAILED_RETRYABLE"
  | "FAILED_TERMINAL";

export interface OcrExtractionRow {
  id: string;
  clubId: string;
  ingestedDocumentId: string;
  documentSha256: string;
  documentClass: string;
  provider: string;
  providerApi: string;
  providerRegion: string | null;
  extractionVersion: number;
  normalizedSchemaVersion: number;
  strategy: string;
  status: OcrExtractionStatus;
  normalizedExtractionJson: string | null;
  confidenceSummaryJson: string | null;
  warningsJson: string | null;
  sanitizedErrorCode: string | null;
  attemptCount: number;
  nextRetryAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Sprint 3 · Phase 4 Slice 5.1 (2026-08-08) — page-level identity
   *  extension. `0` = whole-document extraction (pre-5.1 semantics
   *  and the default for image-only single-page documents). `≥1` =
   *  specific page. */
  pageNumber: number;
  /** Reserved for a future deterministic region identifier. Nullable
   *  now; when populated, participates in identity. */
  regionKey: string | null;
}

// -----------------------------------------------------------------------------
// Idempotency + lookup
// -----------------------------------------------------------------------------

/**
 * Canonical identity of an OCR extraction row.
 * §4 rule: (tenant + document hash + provider + extraction version)
 * uniquely identifies at most one successful paid OCR operation.
 */
export interface OcrIdentity {
  clubId: string;
  documentSha256: string;
  provider: string;
  extractionVersion: number;
  /** Sprint 3 · Phase 4 Slice 5.1 (2026-08-08) — page-level identity.
   *  Default `0` preserves the pre-5.1 whole-document semantics. */
  pageNumber?: number;
}

/**
 * The idempotency key used by the queue enqueue path AND the DB
 * unique constraint. Both layers must agree on the identity string
 * so a concurrent enqueue + insert cannot deadlock into two rows.
 */
export function ocrIdempotencyKey(identity: OcrIdentity): string {
  const page = identity.pageNumber ?? 0;
  return `ap-doc-ocr:${identity.clubId}:${identity.documentSha256}:${identity.provider}:${identity.extractionVersion}:p${page}`;
}

/**
 * Find the persisted OCR row for the given identity, or null.
 * Used by the strategy router before deciding to enqueue.
 */
export async function findOcrExtraction(identity: OcrIdentity): Promise<OcrExtractionRow | null> {
  const page = identity.pageNumber ?? 0;
  return prisma.documentOcrExtraction.findFirst({
    where: {
      clubId: identity.clubId,
      documentSha256: identity.documentSha256,
      provider: identity.provider,
      extractionVersion: identity.extractionVersion,
      pageNumber: page,
    },
    orderBy: { createdAt: "desc" },
  }) as Promise<OcrExtractionRow | null>;
}

/**
 * Find the latest OCR row for a given document, regardless of
 * version. Used by controlled reprocessing decisions and by the
 * projection when it wants to know "any extraction, any version".
 */
export async function findLatestOcrExtractionForDocument(args: {
  clubId: string;
  ingestedDocumentId: string;
}): Promise<OcrExtractionRow | null> {
  return prisma.documentOcrExtraction.findFirst({
    where: {
      clubId: args.clubId,
      ingestedDocumentId: args.ingestedDocumentId,
    },
    orderBy: { createdAt: "desc" },
  }) as Promise<OcrExtractionRow | null>;
}

// -----------------------------------------------------------------------------
// Insert / claim / update
// -----------------------------------------------------------------------------

/**
 * Idempotent create: try to insert a PENDING row for this identity.
 * If the row already exists (concurrent race), return the existing
 * row. Never overwrites SUCCEEDED / FAILED_TERMINAL rows.
 *
 * §4 invariant: the DB unique constraint on
 * (clubId, documentSha256, provider, extractionVersion) means at
 * most one row exists per identity. Concurrent workers racing to
 * enqueue result in one PENDING row + one queued job.
 */
export async function createOrReturnPendingExtraction(args: {
  clubId: string;
  ingestedDocumentId: string;
  documentSha256: string;
  documentClass: DocumentClass;
  strategy: string;
  provider?: string;
  providerApi?: string;
  providerRegion?: string | null;
  /** Sprint 3 · Phase 4 Slice 5.1 (2026-08-08) — page-level dispatch. */
  pageNumber?: number;
  regionKey?: string | null;
}): Promise<{ row: OcrExtractionRow; created: boolean }> {
  const provider = args.provider ?? OCR_PROVIDER_ID_AWS_TEXTRACT;
  const providerApi = args.providerApi ?? OCR_PROVIDER_API_ANALYZE_EXPENSE;
  const pageNumber = args.pageNumber ?? 0;
  const identity: OcrIdentity = {
    clubId: args.clubId,
    documentSha256: args.documentSha256,
    provider,
    extractionVersion: OCR_EXTRACTION_VERSION,
    pageNumber,
  };
  const existing = await findOcrExtraction(identity);
  if (existing) return { row: existing, created: false };
  try {
    const row = (await prisma.documentOcrExtraction.create({
      data: {
        clubId: args.clubId,
        ingestedDocumentId: args.ingestedDocumentId,
        documentSha256: args.documentSha256,
        documentClass: args.documentClass,
        provider,
        providerApi,
        providerRegion: args.providerRegion ?? null,
        extractionVersion: OCR_EXTRACTION_VERSION,
        normalizedSchemaVersion: OCR_NORMALIZED_SCHEMA_VERSION,
        strategy: args.strategy,
        status: "PENDING" satisfies OcrExtractionStatus,
        attemptCount: 0,
        pageNumber,
        regionKey: args.regionKey ?? null,
      },
    })) as OcrExtractionRow;
    return { row, created: true };
  } catch (err) {
    // Unique-constraint race — another writer beat us. Re-read.
    const raced = await findOcrExtraction(identity);
    if (raced) return { row: raced, created: false };
    throw err;
  }
}

/**
 * Atomically transition PENDING → PROCESSING and increment attemptCount.
 * Returns null if the row is no longer PENDING (another worker got it,
 * or a terminal state was written). Callers MUST treat null as
 * "another actor owns this run; do nothing".
 *
 * §4 concurrency guarantee: the transactional read-then-updateMany
 * with the status precondition prevents two workers from both moving
 * PENDING → PROCESSING for the same row.
 */
export async function claimPendingForProcessing(args: {
  id: string;
  workerId: string;
}): Promise<OcrExtractionRow | null> {
  const now = new Date();
  const updated = await prisma.documentOcrExtraction.updateMany({
    where: { id: args.id, status: { in: ["PENDING", "FAILED_RETRYABLE"] } },
    data: {
      status: "PROCESSING",
      startedAt: now,
      attemptCount: { increment: 1 },
      updatedAt: now,
    },
  });
  if (updated.count === 0) return null;
  return (await prisma.documentOcrExtraction.findUnique({
    where: { id: args.id },
  })) as OcrExtractionRow | null;
}

/**
 * Persist a successful extraction. The canonical extraction JSON is
 * stored as text; downstream readers deserialize it back into a
 * CanonicalDocumentExtraction. Warnings are stored as their own
 * JSON blob so they can be indexed / searched later without parsing
 * the whole extraction.
 *
 * §9 rule: the persisted normalized extraction contains extracted
 * document field values (supplier name, amounts, etc.). It is NOT
 * committed to logs; the field is written directly to the DB.
 * Additional encryption at rest is provided by the underlying
 * Postgres cluster's encryption; a KMS-envelope wrap of this
 * column is deferred to a follow-up checkpoint (§9 note).
 */
export async function markExtractionSucceeded(args: {
  id: string;
  canonical: CanonicalDocumentExtraction;
}): Promise<OcrExtractionRow> {
  const now = new Date();
  const confidenceSummary = {
    overall: args.canonical.confidence,
    hasSupplier: !!args.canonical.fields.supplierName,
    hasPayableReference: !!args.canonical.fields.payableReference,
    hasTotal: !!args.canonical.fields.total,
    hasSubtotal: !!args.canonical.fields.subtotal,
    hasTax: !!args.canonical.fields.tax,
    lineItemCount: args.canonical.lineItems.length,
  };
  const row = (await prisma.documentOcrExtraction.update({
    where: { id: args.id },
    data: {
      status: "SUCCEEDED",
      normalizedExtractionJson: JSON.stringify(args.canonical),
      confidenceSummaryJson: JSON.stringify(confidenceSummary),
      warningsJson: JSON.stringify(args.canonical.warnings),
      sanitizedErrorCode: null,
      completedAt: now,
      updatedAt: now,
      nextRetryAt: null,
    },
  })) as OcrExtractionRow;
  return row;
}

/**
 * Persist a retryable failure. Sets nextRetryAt using exponential
 * backoff. If attemptCount has reached the ceiling, transitions to
 * FAILED_TERMINAL instead (caller supplies the ceiling).
 *
 * §10 retry rule: retryable failures back off; terminal failures
 * do not retry. Permission / configuration errors are terminal.
 */
export async function markExtractionRetryable(args: {
  id: string;
  sanitizedErrorCode: string;
  nextRetryAt: Date;
  currentAttempt: number;
  maxAttempts: number;
}): Promise<OcrExtractionRow> {
  const now = new Date();
  const status: OcrExtractionStatus =
    args.currentAttempt >= args.maxAttempts ? "FAILED_TERMINAL" : "FAILED_RETRYABLE";
  const row = (await prisma.documentOcrExtraction.update({
    where: { id: args.id },
    data: {
      status,
      sanitizedErrorCode: args.sanitizedErrorCode,
      nextRetryAt: status === "FAILED_RETRYABLE" ? args.nextRetryAt : null,
      completedAt: status === "FAILED_TERMINAL" ? now : null,
      updatedAt: now,
    },
  })) as OcrExtractionRow;
  return row;
}

/**
 * Persist a terminal failure (permission denied, unsupported doc,
 * corrupt PDF). Never retries.
 */
export async function markExtractionTerminal(args: {
  id: string;
  sanitizedErrorCode: string;
}): Promise<OcrExtractionRow> {
  const now = new Date();
  const row = (await prisma.documentOcrExtraction.update({
    where: { id: args.id },
    data: {
      status: "FAILED_TERMINAL",
      sanitizedErrorCode: args.sanitizedErrorCode,
      completedAt: now,
      nextRetryAt: null,
      updatedAt: now,
    },
  })) as OcrExtractionRow;
  return row;
}

// -----------------------------------------------------------------------------
// Readers
// -----------------------------------------------------------------------------

/**
 * Deserialize the persisted canonical extraction. Returns null if
 * the row has no extraction (still pending, or terminal failure).
 */
export function readCanonicalFromRow(
  row: OcrExtractionRow,
): CanonicalDocumentExtraction | null {
  if (!row.normalizedExtractionJson) return null;
  try {
    return JSON.parse(row.normalizedExtractionJson) as CanonicalDocumentExtraction;
  } catch {
    return null;
  }
}

/**
 * Per-club aggregate revision fingerprint. Consumed by the AP-card
 * projection cache so a SUCCEEDED extraction bumps the cache key
 * and the next projection reads the fresh result. Same shape as
 * loadCoaRevision / loadVendorRevision in intelligence-review-intakes.ts.
 *
 * §11 rule: no browser refresh should be required to see the
 * projection update after OCR completes. The revision bump is the
 * signal.
 */
export async function loadOcrExtractionRevision(clubId: string): Promise<string> {
  const [count, latest] = await Promise.all([
    prisma.documentOcrExtraction.count({ where: { clubId } }),
    prisma.documentOcrExtraction.findFirst({
      where: { clubId },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    }),
  ]);
  return `${count}@${latest?.updatedAt.getTime() ?? 0}`;
}
