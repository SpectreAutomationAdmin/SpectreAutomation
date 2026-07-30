// Sprint 3 · Checkpoint 15X continuation (2026-07-29) — OCR provider
// configuration.
//
// Founder §7 rule: the Textract region MUST be explicitly configured
// via SPECTRE_TEXTRACT_REGION, not silently inherited from AWS_REGION
// (which is the KMS region). §8 rule: prefer dedicated Textract
// credentials over reusing the KMS credentials.
//
// This module is the single place where every OCR-related env var,
// version, and gate is read. Every consumer (adapter, worker,
// telemetry) imports from here — no other file reads process.env
// for Textract configuration.

// -----------------------------------------------------------------------------
// Extraction + normalized-schema versions
// -----------------------------------------------------------------------------

// Bump when the Textract → canonical normalizer changes semantics OR
// when the strategy router changes which strategy wins for which
// document class. This value is the canonical part of the
// idempotency key — bumping it forces a controlled reprocessing of
// every persisted extraction (see §5 controlled reprocessing).
export const OCR_EXTRACTION_VERSION = 1;

// Bump when CanonicalDocumentExtraction shape changes in a way that
// breaks readers of persisted rows. Separate from
// OCR_EXTRACTION_VERSION because a shape change and an algorithm
// change reason about invalidation differently.
export const OCR_NORMALIZED_SCHEMA_VERSION = 1;

// -----------------------------------------------------------------------------
// Provider gate
// -----------------------------------------------------------------------------

export type OcrProvider = "aws-textract" | "disabled";

export function ocrProvider(): OcrProvider {
  const raw = (process.env.SPECTRE_OCR_PROVIDER ?? "").trim().toLowerCase();
  if (raw === "aws-textract") return "aws-textract";
  return "disabled";
}

export function isOcrEnabled(): boolean {
  return ocrProvider() !== "disabled";
}

// -----------------------------------------------------------------------------
// Textract region — §7 rule: explicit, never inherit from AWS_REGION
// -----------------------------------------------------------------------------

export type TextractRegionResolution =
  | { ok: true; region: string; source: "SPECTRE_TEXTRACT_REGION" }
  | { ok: false; reason: string };

export function resolveTextractRegion(): TextractRegionResolution {
  const explicit = (process.env.SPECTRE_TEXTRACT_REGION ?? "").trim();
  if (explicit.length > 0) {
    return { ok: true, region: explicit, source: "SPECTRE_TEXTRACT_REGION" };
  }
  return {
    ok: false,
    reason:
      "SPECTRE_TEXTRACT_REGION is not set. The OCR provider refuses to fall back to AWS_REGION because that variable configures the KMS provider and the two subsystems must be independently configurable.",
  };
}

// -----------------------------------------------------------------------------
// Textract credential resolution — prefer dedicated, fall back to shared
// -----------------------------------------------------------------------------
//
// §8 preference: dedicated Textract principal (least-privilege,
// separately rotatable, distinct CloudTrail actor). Shared fallback
// is permitted only during staging bring-up and is logged as
// insecure.

export type TextractCredentialResolution =
  | {
      ok: true;
      accessKeyId: string;
      secretAccessKey: string;
      source: "dedicated" | "shared_with_kms";
    }
  | { ok: false; reason: string };

export function resolveTextractCredentials(): TextractCredentialResolution {
  const dedicatedAccess = (process.env.SPECTRE_TEXTRACT_ACCESS_KEY_ID ?? "").trim();
  const dedicatedSecret = (process.env.SPECTRE_TEXTRACT_SECRET_ACCESS_KEY ?? "").trim();
  if (dedicatedAccess.length > 0 && dedicatedSecret.length > 0) {
    return {
      ok: true,
      accessKeyId: dedicatedAccess,
      secretAccessKey: dedicatedSecret,
      source: "dedicated",
    };
  }
  const sharedAccess = (process.env.AWS_ACCESS_KEY_ID ?? "").trim();
  const sharedSecret = (process.env.AWS_SECRET_ACCESS_KEY ?? "").trim();
  if (sharedAccess.length > 0 && sharedSecret.length > 0) {
    return {
      ok: true,
      accessKeyId: sharedAccess,
      secretAccessKey: sharedSecret,
      source: "shared_with_kms",
    };
  }
  return {
    ok: false,
    reason:
      "Neither SPECTRE_TEXTRACT_ACCESS_KEY_ID/SECRET nor AWS_ACCESS_KEY_ID/SECRET are set. OCR cannot invoke Textract without credentials.",
  };
}

// -----------------------------------------------------------------------------
// Provider identity strings — persisted with every extraction row so
// audit + reprocessing can distinguish call generations
// -----------------------------------------------------------------------------

export const OCR_PROVIDER_ID_AWS_TEXTRACT = "AWS_TEXTRACT";
export const OCR_PROVIDER_API_ANALYZE_EXPENSE = "ANALYZE_EXPENSE";

// -----------------------------------------------------------------------------
// Cost + abuse ceilings — §10 + §12
// -----------------------------------------------------------------------------

// AnalyzeExpense sync-mode PDF limit is 10 MB (AWS documented).
export const OCR_MAX_BYTES = 10 * 1024 * 1024;
// AnalyzeExpense sync accepts a single-page PDF; multi-page requires
// StartExpenseAnalysis (async). Not implemented this checkpoint.
export const OCR_MAX_PAGES_SYNC = 1;
// Per-attempt HTTP timeout; total wall-clock bounded by attempts × this.
export const OCR_REQUEST_TIMEOUT_MS = 30_000;
// Bounded retry — §10.
export const OCR_MAX_ATTEMPTS = 3;
// Exponential backoff base (attempt N delay = base × 2^(N-1)).
export const OCR_BACKOFF_BASE_MS = 5_000;
// Cap so a single doc can never wait longer than this before giving up.
export const OCR_BACKOFF_MAX_MS = 5 * 60_000;
