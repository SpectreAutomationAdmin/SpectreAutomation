// Sprint 3 · Checkpoint 15X (2026-07-30) — AWS Textract
// AnalyzeExpense adapter.
//
// Founder decision (approved): use AWS Textract AnalyzeExpense as
// the first OCR strategy because Spectre already has AWS
// infrastructure + KMS integration, and AnalyzeExpense is designed
// for invoice/receipt extraction with document-level summary fields
// and per-line-item groups.
//
// Adapter contract:
//
//   * Input : PDF bytes (Buffer)
//   * Output: Provider raw response (Textract types) OR structured error
//   * Retries: bounded (2 attempts total) with exponential backoff
//   * Timeout: 30s per attempt
//   * Idempotency: caller-controlled (see persistence layer)
//   * Logging: NEVER logs raw text, addresses, tax numbers, bank
//              info, or document contents — only sanitized
//              operational diagnostics (page counts, response sizes,
//              latency, error codes).
//
// This adapter is thin: it does NOT normalize the response. The
// normalizer (textract-to-canonical.ts) converts the raw response
// into the provider-neutral CanonicalDocumentExtraction shape.

import { TextractClient, AnalyzeExpenseCommand, type AnalyzeExpenseCommandOutput } from "@aws-sdk/client-textract";
import { logger } from "@/lib/observability/logger";
import {
  OCR_MAX_ATTEMPTS,
  OCR_MAX_BYTES,
  OCR_MAX_PAGES_SYNC,
  OCR_REQUEST_TIMEOUT_MS,
  OCR_BACKOFF_BASE_MS,
  resolveTextractCredentials,
  resolveTextractRegion,
} from "../ocr/config";

// -----------------------------------------------------------------------------
// Constants — cost + abuse controls (§10). Sourced from ocr/config.ts
// so every consumer reads one canonical value.
// -----------------------------------------------------------------------------

const MAX_BYTES = OCR_MAX_BYTES;
const MAX_PAGES_SYNC = OCR_MAX_PAGES_SYNC;
const REQUEST_TIMEOUT_MS = OCR_REQUEST_TIMEOUT_MS;
const MAX_ATTEMPTS = OCR_MAX_ATTEMPTS;
const BACKOFF_BASE_MS = OCR_BACKOFF_BASE_MS;

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type TextractExpenseSuccess = {
  ok: true;
  response: AnalyzeExpenseCommandOutput;
  latencyMs: number;
  attempts: number;
};

export type TextractExpenseFailure = {
  ok: false;
  code:
    | "PROVIDER_DISABLED"
    | "PROVIDER_UNSUPPORTED_MIME"
    | "PROVIDER_FILE_TOO_LARGE"
    | "PROVIDER_MULTI_PAGE_NOT_SUPPORTED"
    | "PROVIDER_TIMEOUT"
    | "PROVIDER_UNAUTHENTICATED"
    | "PROVIDER_PERMISSION_DENIED"
    | "PROVIDER_RATE_LIMITED"
    | "PROVIDER_INVALID_INPUT"
    | "PROVIDER_INTERNAL_ERROR"
    | "PROVIDER_UNKNOWN_ERROR";
  message: string;
  latencyMs: number;
  attempts: number;
};

export type TextractExpenseResult = TextractExpenseSuccess | TextractExpenseFailure;

export interface TextractExpenseInput {
  bytes: Buffer;
  mimeType: string;
  pageCount: number;
  // Correlation id used for diagnostic logging — never a document id
  // that might identify PII.
  correlationHash: string;
}

// -----------------------------------------------------------------------------
// Public entrypoint
// -----------------------------------------------------------------------------

export async function runTextractExpense(input: TextractExpenseInput): Promise<TextractExpenseResult> {
  const started = Date.now();

  // Provider-level gates. Fail fast and do NOT count toward the
  // retry budget.
  if (input.bytes.length > MAX_BYTES) {
    logger.warn("ap-intelligence.textract.rejected", {
      correlation: input.correlationHash,
      reason: "file_too_large",
      byteLength: input.bytes.length,
    });
    return { ok: false, code: "PROVIDER_FILE_TOO_LARGE", message: `Document exceeds ${MAX_BYTES}-byte AnalyzeExpense sync limit`, latencyMs: 0, attempts: 0 };
  }
  if (input.mimeType !== "application/pdf" && !input.mimeType.startsWith("image/")) {
    return { ok: false, code: "PROVIDER_UNSUPPORTED_MIME", message: `Unsupported MIME type: ${input.mimeType}`, latencyMs: 0, attempts: 0 };
  }
  if (input.pageCount > MAX_PAGES_SYNC) {
    return { ok: false, code: "PROVIDER_MULTI_PAGE_NOT_SUPPORTED", message: `Sync AnalyzeExpense supports single-page documents; this document has ${input.pageCount} pages`, latencyMs: 0, attempts: 0 };
  }

  // Region — §7 rule: explicit SPECTRE_TEXTRACT_REGION, NEVER
  // inherit from AWS_REGION which drives the KMS provider.
  const regionRes = resolveTextractRegion();
  if (!regionRes.ok) {
    return { ok: false, code: "PROVIDER_UNAUTHENTICATED", message: regionRes.reason, latencyMs: Date.now() - started, attempts: 0 };
  }
  // Credential — §8 rule: prefer dedicated Textract credentials over
  // shared KMS credentials. Both are permitted; the "shared" case is
  // logged as suboptimal so ops can spot it.
  const credRes = resolveTextractCredentials();
  if (!credRes.ok) {
    return { ok: false, code: "PROVIDER_UNAUTHENTICATED", message: credRes.reason, latencyMs: Date.now() - started, attempts: 0 };
  }
  if (credRes.source === "shared_with_kms") {
    logger.warn("ap-intelligence.textract.shared_credential", {
      correlation: input.correlationHash,
      hint: "Textract is using AWS_* credentials shared with KMS; migrate to SPECTRE_TEXTRACT_ACCESS_KEY_ID / SECRET for least-privilege.",
    });
  }

  const client = new TextractClient({
    region: regionRes.region,
    credentials: {
      accessKeyId: credRes.accessKeyId,
      secretAccessKey: credRes.secretAccessKey,
    },
    requestHandler: {
      requestTimeout: REQUEST_TIMEOUT_MS,
      connectionTimeout: 5_000,
    } as unknown as never,
  });

  let lastError: unknown = null;
  let attempts = 0;
  for (attempts = 1; attempts <= MAX_ATTEMPTS; attempts++) {
    try {
      const cmd = new AnalyzeExpenseCommand({ Document: { Bytes: input.bytes } });
      const response = await client.send(cmd);
      const latencyMs = Date.now() - started;
      logger.info("ap-intelligence.textract.ok", {
        correlation: input.correlationHash,
        latencyMs,
        attempts,
        expenseDocumentCount: response.ExpenseDocuments?.length ?? 0,
      });
      return { ok: true, response, latencyMs, attempts };
    } catch (err) {
      lastError = err;
      const classified = classifyError(err);
      if (classified.retryable && attempts < MAX_ATTEMPTS) {
        const backoff = BACKOFF_BASE_MS * Math.pow(2, attempts - 1);
        logger.warn("ap-intelligence.textract.retry", {
          correlation: input.correlationHash,
          attempt: attempts,
          code: classified.code,
          backoffMs: backoff,
        });
        await sleep(backoff);
        continue;
      }
      const latencyMs = Date.now() - started;
      logger.error("ap-intelligence.textract.failed", {
        correlation: input.correlationHash,
        latencyMs,
        attempts,
        code: classified.code,
        // Message is sanitized to error class only — never the raw
        // provider message which could include document snippets.
        message: classified.code,
      });
      return { ok: false, code: classified.code, message: classified.code, latencyMs, attempts };
    }
  }

  // Unreachable — retained for exhaustiveness.
  return {
    ok: false,
    code: "PROVIDER_UNKNOWN_ERROR",
    message: (lastError as { name?: string })?.name ?? "unknown",
    latencyMs: Date.now() - started,
    attempts,
  };
}

// -----------------------------------------------------------------------------
// Error classification
// -----------------------------------------------------------------------------

interface ClassifiedError {
  code: TextractExpenseFailure["code"];
  retryable: boolean;
}

function classifyError(err: unknown): ClassifiedError {
  const name = (err as { name?: string })?.name ?? "";
  const httpStatus = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode ?? 0;
  if (name === "InvalidParameterException" || name === "InvalidS3ObjectException" || name === "UnsupportedDocumentException") {
    return { code: "PROVIDER_INVALID_INPUT", retryable: false };
  }
  if (name === "AccessDeniedException" || httpStatus === 403) {
    return { code: "PROVIDER_PERMISSION_DENIED", retryable: false };
  }
  if (name === "UnrecognizedClientException" || name === "MissingAuthenticationTokenException" || httpStatus === 401) {
    return { code: "PROVIDER_UNAUTHENTICATED", retryable: false };
  }
  if (name === "ProvisionedThroughputExceededException" || name === "ThrottlingException" || httpStatus === 429) {
    return { code: "PROVIDER_RATE_LIMITED", retryable: true };
  }
  if (name === "InternalServerError" || httpStatus >= 500) {
    return { code: "PROVIDER_INTERNAL_ERROR", retryable: true };
  }
  if (name === "TimeoutError" || (err as { code?: string })?.code === "ETIMEDOUT") {
    return { code: "PROVIDER_TIMEOUT", retryable: true };
  }
  return { code: "PROVIDER_UNKNOWN_ERROR", retryable: false };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
