// EP-TRAIN-4Y-B-IMPL (2026-11-07) — shared types for the Hybrid Modal
// auth contract (Contract C).
//
// This file is the TypeScript authority for every type that crosses
// the Spectre ↔ Modal boundary. The Modal Python side has a parallel
// definition in `modal/shared/auth.py`; the two MUST be kept in sync.
//
// Contract version is pinned at module-scope: both sides refuse any
// unknown version.

/** Pinned contract version. Both sides refuse other versions. */
export const CONTRACT_VERSION = "4yb-v1" as const;

/** Signed-message prefix for request-side HMAC. */
export const SIG_VERSION = "v1" as const;

/** Operation identifiers (§D.5). */
export const OPERATION_TRANSCRIBE = "spectre.training.transcribe.v1" as const;
export const OPERATION_GENERATE = "spectre.training.generate.v1" as const;

export type OperationId = typeof OPERATION_TRANSCRIBE | typeof OPERATION_GENERATE;

/** TTLs (§D.4). All in seconds. */
export const DEFAULT_AUTH_TTL_SEC = 3600;        // 1 h PilotAuthorizationV1 max
export const DEFAULT_TIMESTAMP_SKEW_SEC = 300;   // ±300 s request timestamp tolerance
export const DEFAULT_R2_URL_TTL_SEC = 600;       // 600 s signed R2 URL lifetime
export const DEFAULT_REPLAY_WINDOW_SEC = 900;    // 2 × timestamp skew + buffer

/** Placeholder values used in the auth envelope when the operation
 *  is TRANSCRIBE_VIDEO and the post-transcribe artefacts do not yet
 *  exist. Modal-side TRANSCRIBE verifier accepts only these exact
 *  values; GENERATE rejects them. Chosen as 64 zero characters so
 *  they pass the `^[a-f0-9]{64}$` regex while being trivially
 *  distinguishable from any real SHA. */
export const TRANSCRIBE_PLACEHOLDER_TRANSCRIPT_BUILD_ID = "0".repeat(64);
export const TRANSCRIBE_PLACEHOLDER_GROUNDING_SHA = "0".repeat(64);

/** Request-side signing headers (what the Spectre client sends). */
export interface RequestSigningHeaders {
  readonly "x-spectre-sig-version": typeof SIG_VERSION;
  readonly "x-spectre-operation": OperationId;
  readonly "x-spectre-request-id": string;
  readonly "x-spectre-timestamp": string;
  readonly "x-spectre-body-digest": string;
  readonly "x-spectre-signature": string;
  readonly "x-spectre-contract-version": typeof CONTRACT_VERSION;
}

/** Response-side signing headers (what the Modal function returns). */
export interface ResponseSigningHeaders {
  readonly "x-spectre-response-signature": string;
  readonly "x-spectre-response-operation": OperationId;
  readonly "x-spectre-response-request-id": string;
  readonly "x-spectre-contract-version": typeof CONTRACT_VERSION;
}

/** Restrictions carried in the auth envelope. Modal server-side
 *  honours these and refuses anything that would violate them. */
export interface PilotRestrictions {
  readonly publicationProhibited: boolean;
  readonly employeeAssignmentProhibited: boolean;
  readonly databaseWritesProhibited: boolean;
  readonly automaticRetriesProhibited: boolean;
  readonly excludedSegmentIds: readonly number[];
  readonly scope: string;
}

/** Widened operation union for the auth envelope (§Q.2). */
export type PilotAuthorizationOperation =
  | "GENERATE_DRAFT_QUESTIONS"
  | "TRANSCRIBE_VIDEO";

/** Fully bound tenant/course/version/video/transcript/grounding +
 *  TTL + restrictions + fingerprint. Verified server-side via the
 *  shared fingerprint secret. Lifted from
 *  `ep-train-6c-10b:src/lib/training/ai-generation/types.ts:140-154`
 *  with the operation field widened per §Q.2. */
export interface PilotAuthorizationV1 {
  readonly schemaVersion: "pilot-generation-authorization-v1";
  readonly authorizationId: string;
  readonly tenantId: string;
  readonly courseId: string;
  readonly versionId: string;
  readonly sourceVideoSha256: string;
  readonly resolvedTranscriptBuildId: string;
  readonly approvedGroundingProjectionSha256: string;
  readonly operation: PilotAuthorizationOperation;
  readonly maxRequestedQuestions: number;
  readonly pilotRestrictions: PilotRestrictions;
  readonly issuedAtUtc: string;
  readonly expiresAtUtc: string;
  readonly issuedBy: string;
  readonly fingerprint: string;
}

/** The full request-body shape sent to either Modal endpoint.
 *  Both operations share the envelope; operation-specific fields
 *  go in `payload`. */
export interface ModalRequestBody<P extends object = object> {
  readonly contractVersion: typeof CONTRACT_VERSION;
  readonly operation: OperationId;
  readonly requestId: string;
  readonly timestamp: string;
  readonly pilotAuthorization: PilotAuthorizationV1;
  readonly payload: P;
}

/** Transcribe-specific request payload. */
export interface TranscribePayload {
  readonly audioUrl: string;
  readonly languageCode: string;
  readonly modelVariant: string;
}

/** Generate-specific request payload. */
export interface GeneratePayload {
  readonly modelVariant: string;
  readonly systemPrompt: string;
  readonly transcript: string;
  readonly constraints: {
    readonly proposalKind: "QUESTION_CHECKPOINT_BOUND" | "QUESTION_FINAL_ASSESSMENT";
    readonly maxQuestions: number;
    readonly allowedQuestionTypes: readonly ("SINGLE_CHOICE" | "MULTI_ANSWER" | "TRUE_FALSE")[];
    readonly jsonSchema: Readonly<Record<string, unknown>>;
  };
}

/** Transcribe response envelope. */
export interface TranscribeResponseBody {
  readonly contractVersion: typeof CONTRACT_VERSION;
  readonly operation: typeof OPERATION_TRANSCRIBE;
  readonly requestId: string;
  readonly modelVariant: string;
  readonly durationSec: number;
  readonly audioSha256: string;
  readonly segments: readonly {
    readonly id: number;
    readonly startSec: number;
    readonly endSec: number;
    readonly text: string;
    readonly avgConfidence: number;
  }[];
  readonly elapsedMs: { readonly coldBoot: number; readonly transcribe: number };
}

/** Generate response envelope. */
export interface GenerateResponseBody {
  readonly contractVersion: typeof CONTRACT_VERSION;
  readonly operation: typeof OPERATION_GENERATE;
  readonly requestId: string;
  readonly modelVariant: string;
  readonly proposals: readonly {
    readonly questionType: "SINGLE_CHOICE" | "MULTI_ANSWER" | "TRUE_FALSE";
    readonly questionText: string;
    readonly options: readonly { readonly text: string; readonly isCorrect: boolean }[];
    readonly explanation: string;
    readonly sourceSegmentIds: readonly number[];
  }[];
  readonly elapsedMs: { readonly coldBoot: number; readonly generate: number };
  readonly tokenCounts: { readonly prompt: number; readonly output: number };
}

/** Compact clock interface for test-injected time. */
export interface Clock {
  nowMs(): number;
  nowUtcIso(): string;
}

export const SYSTEM_CLOCK: Clock = {
  nowMs: () => Date.now(),
  nowUtcIso: () => new Date().toISOString(),
};
