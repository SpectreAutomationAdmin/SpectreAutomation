// PAY-1B/1 (2026-09-27) — Provider Contract v2.
//
// Hardens the PAY-1A `PaymentProvider` interface into a contract
// suitable for a real Canadian payment rail. Every future adapter
// MUST implement this interface AND pass the conformance suite in
// ./conformance.ts.
//
// Design axes:
//   • Explicit CAPABILITY model — the core Payments engine queries
//     capabilities instead of assuming every adapter supports every
//     operation. No `if provider === TD` branches in the domain.
//   • Normalized SUBMISSION RESULT and STATUS — a network timeout
//     stays UNKNOWN, HTTP 200 does not mean "settled", and every
//     future rail folds into the same eight status buckets.
//   • Normalized ERROR TAXONOMY — retryable technical, non-retryable
//     technical/config, business/rejection, and unknown. The domain
//     decides retry policy from the taxonomy; adapters never leak
//     raw error strings into financial decisions.
//   • RAW EVIDENCE reference — every adapter response carries a
//     protected reference to raw provider evidence for support /
//     reconciliation / disputes / incident reconstruction. Raw
//     payloads never enter `PaymentEvent.metaJson` verbatim.

import type { ProviderCapabilityDeclaration } from "../kill-switch";

// ------------------------------------------------------------------
// Capabilities — the Payments engine consults `provider.capabilities`
// before invoking optional operations.
// ------------------------------------------------------------------
export interface ProviderCapabilities {
  readonly supportsSubmission: boolean;
  readonly supportsStatusLookup: boolean;
  readonly supportsCancellation: boolean;
  readonly supportsAsyncEvents: boolean;
  readonly supportsReturns: boolean;
  readonly supportsBatchSubmission: boolean;
  readonly supportsPerInstructionStatus: boolean;
  readonly supportsScheduledExecution: boolean;
  readonly supportsRealTimePayments: boolean;
  readonly supportsBatchEft: boolean;
}

// ------------------------------------------------------------------
// Normalized submission result. Distinct from "provider status" —
// a submission has one of three synchronous outcomes:
//   ACKNOWLEDGED — the provider accepted the submission for processing.
//                  No settlement conclusion yet.
//   REJECTED     — the provider refused the submission with a
//                  documented reason.
//   UNKNOWN      — the outcome cannot be determined (timeout, malformed
//                  response, network failure, provider unavailable).
//                  MUST NOT be mapped to accepted or rejected.
// ------------------------------------------------------------------
export type ProviderSubmissionOutcome = "ACKNOWLEDGED" | "REJECTED" | "UNKNOWN";

// ------------------------------------------------------------------
// Normalized processing status. Covers every meaningful stage a
// payment can be in from the provider's perspective. Adapters are
// responsible for mapping their provider-specific vocabulary into
// this set. Anything the adapter cannot map MUST be UNKNOWN — never
// a false best-guess.
// ------------------------------------------------------------------
export type ProviderProcessingStatus =
  | "RECEIVED"
  | "ACCEPTED"
  | "PROCESSING"
  | "SETTLED"
  | "REJECTED"
  | "RETURNED"
  | "CANCELLED"
  | "UNKNOWN";

// ------------------------------------------------------------------
// Normalized error taxonomy. `category` decides retry policy; the
// domain never inspects raw error strings when deciding retryability.
// `provider*` fields preserve the raw evidence for support/audit.
// ------------------------------------------------------------------
export type ProviderErrorCategory =
  | "TIMEOUT"                          // Retryable technical (timeout).
  | "TRANSIENT_NETWORK"                // Retryable technical (temp network).
  | "PROVIDER_UNAVAILABLE"             // Retryable technical (upstream down).
  | "RATE_LIMITED"                     // Retryable technical (throttled).
  | "AUTHENTICATION_FAILURE"           // Non-retryable technical/config.
  | "INVALID_CERTIFICATE"              // Non-retryable technical/config.
  | "UNSUPPORTED_CAPABILITY"           // Non-retryable technical/config.
  | "INVALID_CONFIGURATION"            // Non-retryable technical/config.
  | "INVALID_DESTINATION"              // Financial/business rejection.
  | "CLOSED_ACCOUNT"                   // Financial/business rejection.
  | "INSUFFICIENT_FUNDS"               // Financial/business rejection.
  | "AUTHORIZATION_PROBLEM"            // Financial/business rejection.
  | "AMOUNT_LIMIT_REJECTION"           // Financial/business rejection.
  | "INVALID_EXECUTION_DATE"           // Financial/business rejection.
  | "UNKNOWN";                         // Provider response uninterpretable.

export interface ProviderError {
  category: ProviderErrorCategory;
  /** Is this category safe to retry against the SAME idempotency key? */
  retryable: boolean;
  /** Adapter-friendly short label (safe for logs and Work Intake). */
  message: string;
  /** Provider-native error code, verbatim. Preserve for support. */
  providerCode?: string;
  /** Provider-native error description, verbatim. Preserve for support. */
  providerMessage?: string;
  /** Opaque reference to raw provider evidence (KMS-stored blob, S3
   *  object, log correlation id). Never a raw payload. */
  providerEvidenceRef?: string;
}

// ------------------------------------------------------------------
// Result shapes returned to the Payments engine.
// ------------------------------------------------------------------
export interface ProviderSubmissionInput {
  clubId: string;
  runId: string;
  instructionId: string;
  amount: string;                // Decimal-safe string
  currency: string;
  requestedExecutionDate: Date;
  idempotencyKey: string;
  destinationRef: string;        // opaque adapter-side handle
  fundingRef: string;            // opaque adapter-side handle
}

export interface ProviderSubmissionResultV2 {
  outcome: ProviderSubmissionOutcome;
  providerInstructionId?: string;
  providerReference?: string;
  processingStatus?: ProviderProcessingStatus;
  error?: ProviderError;
  /** Opaque KMS/blob reference to the raw submission response, if any. */
  providerEvidenceRef?: string;
}

export interface ProviderStatusResultV2 {
  providerInstructionId: string;
  status: ProviderProcessingStatus;
  providerReference?: string;
  settledAt?: Date;
  returnedAt?: Date;
  amount?: string;               // Decimal-safe — for mismatch detection
  currency?: string;             // for currency mismatch detection
  returnCode?: string;
  returnDescription?: string;
  providerEvidenceRef?: string;
  error?: ProviderError;
}

export interface ProviderCancelResultV2 {
  providerInstructionId: string;
  outcome: "REQUESTED" | "ACCEPTED" | "REJECTED" | "TOO_LATE" | "UNKNOWN";
  providerReference?: string;
  providerEvidenceRef?: string;
}

// ------------------------------------------------------------------
// External event envelope (§12). Any adapter that supports async
// events emits normalized `ExternalPaymentEventEnvelope` values that
// the ingestion pipeline verifies + replays safely.
// ------------------------------------------------------------------
export type ExternalPaymentEventType =
  | "SUBMISSION_ACKNOWLEDGED"
  | "STATUS_UPDATED"
  | "SETTLED"
  | "RETURNED"
  | "CANCELLED"
  | "REJECTED"
  | "UNKNOWN";

export interface ExternalPaymentEventEnvelope {
  provider: string;
  providerEventId: string;         // MUST be stable across delivery attempts
  providerInstructionId?: string;
  providerReference?: string;
  eventType: ExternalPaymentEventType;
  providerTimestamp?: Date;
  status?: ProviderProcessingStatus;
  amount?: string;
  currency?: string;
  returnCode?: string;
  returnDescription?: string;
  /** SHA-256 (hex) of the exact raw payload — replay-detection key. */
  payloadHash: string;
  /** Opaque KMS/blob reference to the raw payload. Never the payload itself. */
  rawPayloadReference?: string;
  /** Adapter-side outcome of signature/certificate verification. */
  verificationStatus: "VERIFIED" | "UNVERIFIED" | "FAILED";
}

// ------------------------------------------------------------------
// The v2 provider interface. `movesRealMoney` from v1 is preserved
// through `ProviderCapabilityDeclaration` (kill-switch compatibility).
// ------------------------------------------------------------------
export interface PaymentProviderV2 extends ProviderCapabilityDeclaration {
  readonly capabilities: ProviderCapabilities;

  /** SUBMISSION — every adapter that has supportsSubmission=true
   *  MUST implement this. Idempotency: same idempotencyKey always
   *  resolves to the same economic payment. */
  submit(input: ProviderSubmissionInput): Promise<ProviderSubmissionResultV2>;

  /** STATUS LOOKUP — only required if supportsStatusLookup=true. */
  getStatus?(providerInstructionId: string): Promise<ProviderStatusResultV2>;

  /** CANCELLATION — only required if supportsCancellation=true. */
  cancel?(providerInstructionId: string, reason?: string): Promise<ProviderCancelResultV2>;

  /** External event verification — only required if
   *  supportsAsyncEvents=true. Unverified events MUST NOT mutate
   *  financial state; verifyExternalEvent is the boundary that
   *  enforces this at the adapter layer. */
  verifyExternalEvent?(payload: unknown, headers: Record<string, string>): Promise<ExternalPaymentEventEnvelope>;
}

// ------------------------------------------------------------------
// Small helpers used by adapters + the engine.
// ------------------------------------------------------------------
export function isRetryable(err: ProviderError): boolean {
  return err.retryable === true;
}

export function retryableCategories(): readonly ProviderErrorCategory[] {
  return [
    "TIMEOUT", "TRANSIENT_NETWORK", "PROVIDER_UNAVAILABLE", "RATE_LIMITED",
  ] as const;
}
