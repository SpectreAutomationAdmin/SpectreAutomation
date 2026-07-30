// Sprint 3 · Checkpoint 15X continuation (2026-07-29) — OCR
// telemetry counters.
//
// Founder §12 rule: before IAM activation, add per-tenant + per-
// document-class + per-outcome counters plus provider latency and
// byte/page counts. Never include document content.
//
// Implementation: a lightweight logger.info emission with structured
// fields so an ops dashboard can aggregate without ingesting content.
// A future checkpoint may add a persistent OcrCallLog table if
// aggregation via logs proves insufficient.

import { logger } from "@/lib/observability/logger";

export interface OcrCallTelemetry {
  clubId: string;
  extractionRowIdTail: string;
  documentClass: string;
  outcome: "SUCCESS" | "SKIPPED_DUPLICATE" | "TERMINAL_FAIL" | "RETRYABLE_FAIL" | "PENDING";
  sanitizedErrorCode: string | null;
  attempt: number;
  latencyMs: number;
  byteLength: number;
  pageCount: number;
  providerRegion: string | null;
  strategy: string;
}

export function recordOcrCallTelemetry(t: OcrCallTelemetry): void {
  // Content-free by design — only counters, durations, and sanitized
  // error codes.
  logger.info("ap-intelligence.ocr.telemetry", {
    clubId: t.clubId,
    extractionRowIdTail: t.extractionRowIdTail,
    documentClass: t.documentClass,
    outcome: t.outcome,
    sanitizedErrorCode: t.sanitizedErrorCode,
    attempt: t.attempt,
    latencyMs: t.latencyMs,
    byteLength: t.byteLength,
    pageCount: t.pageCount,
    providerRegion: t.providerRegion,
    strategy: t.strategy,
  });
}

export interface OcrDuplicatePreventedTelemetry {
  clubId: string;
  extractionRowIdTail: string;
  reason: "already_persisted" | "already_pending" | "ocr_disabled";
}

export function recordOcrDuplicatePrevented(t: OcrDuplicatePreventedTelemetry): void {
  logger.info("ap-intelligence.ocr.duplicate-prevented", {
    clubId: t.clubId,
    extractionRowIdTail: t.extractionRowIdTail,
    reason: t.reason,
  });
}
