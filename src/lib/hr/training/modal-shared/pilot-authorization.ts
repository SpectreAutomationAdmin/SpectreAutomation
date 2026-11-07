// EP-TRAIN-4Y-B-IMPL (2026-11-07) — PilotAuthorizationV1 issuer.
//
// Issues a per-call authorisation envelope binding seven identifiers
// (tenant, course, version, videoSha256, resolvedTranscriptBuildId,
// approvedGroundingProjectionSha256, operation) plus pilot
// restrictions, TTL and a fingerprint. Modal server-side verifies
// the fingerprint using the SAME `fingerprintSecret`.
//
// Shape inherited from `ep-train-6c-10b:src/lib/training/ai-generation/types.ts`
// with `operation` widened to also include `TRANSCRIBE_VIDEO` (§Q.2).
//
// FRESH authorization per retry (§Q.4) — every call to `issue(...)`
// produces a new `authorizationId` + `issuedAtUtc` + `expiresAtUtc`
// + fingerprint. There is no cache.
//
// §D.4 TTL cap: `ttlSec` MUST be ≤ 3600 (one hour). Caller may pass
// a shorter TTL; issuer refuses anything longer.

import { createHmac, randomUUID } from "node:crypto";
import { canonicalise, assertPrintableAscii } from "./canonicalise";
import {
  type Clock,
  SYSTEM_CLOCK,
  type PilotAuthorizationOperation,
  type PilotAuthorizationV1,
  type PilotRestrictions,
  DEFAULT_AUTH_TTL_SEC,
} from "./types";
import { ModalContractError } from "./errors";

export interface IssuePilotAuthorizationInput {
  readonly tenantId: string;
  readonly courseId: string;
  readonly versionId: string;
  readonly sourceVideoSha256: string;
  readonly resolvedTranscriptBuildId: string;
  readonly approvedGroundingProjectionSha256: string;
  readonly operation: PilotAuthorizationOperation;
  readonly maxRequestedQuestions: number;
  readonly pilotRestrictions: PilotRestrictions;
  readonly ttlSec?: number;
  readonly issuedBy: string;
  readonly fingerprintSecret: string;
  readonly clock?: Clock;
  readonly authorizationId?: string;
}

/**
 * Issue a PilotAuthorizationV1.
 *
 * Fingerprint = base64url(HMAC-SHA-256(fingerprintSecret,
 *   canonicalise(bodyWithoutFingerprint))). The fingerprint field is
 * excluded from its own signing input to avoid circularity.
 */
export function issuePilotAuthorization(
  input: IssuePilotAuthorizationInput,
): PilotAuthorizationV1 {
  const clock = input.clock ?? SYSTEM_CLOCK;
  const ttl = input.ttlSec ?? DEFAULT_AUTH_TTL_SEC;

  if (ttl <= 0 || ttl > DEFAULT_AUTH_TTL_SEC) {
    throw new ModalContractError(
      "PILOT_AUTH_SCHEMA_MISMATCH",
      `PilotAuthorizationV1 TTL out of range: ${ttl} (0 < ttl <= ${DEFAULT_AUTH_TTL_SEC}).`,
    );
  }

  const authorizationId = input.authorizationId ?? randomUUID();

  // ASCII-only on identity fields that cross the Python boundary.
  assertPrintableAscii("authorizationId", authorizationId);
  assertPrintableAscii("tenantId", input.tenantId);
  assertPrintableAscii("courseId", input.courseId);
  assertPrintableAscii("versionId", input.versionId);
  assertPrintableAscii("sourceVideoSha256", input.sourceVideoSha256);
  assertPrintableAscii("resolvedTranscriptBuildId", input.resolvedTranscriptBuildId);
  assertPrintableAscii("approvedGroundingProjectionSha256", input.approvedGroundingProjectionSha256);
  assertPrintableAscii("operation", input.operation);
  assertPrintableAscii("pilotRestrictions.scope", input.pilotRestrictions.scope);
  assertPrintableAscii("issuedBy", input.issuedBy);

  if (!/^[a-f0-9]{64}$/.test(input.sourceVideoSha256)) {
    throw new ModalContractError(
      "PILOT_AUTH_SCHEMA_MISMATCH",
      "sourceVideoSha256 must be 64-char lower-case hex.",
    );
  }
  if (!/^[a-f0-9]{64}$/.test(input.resolvedTranscriptBuildId)) {
    throw new ModalContractError(
      "PILOT_AUTH_SCHEMA_MISMATCH",
      "resolvedTranscriptBuildId must be 64-char lower-case hex.",
    );
  }
  if (!/^[a-f0-9]{64}$/.test(input.approvedGroundingProjectionSha256)) {
    throw new ModalContractError(
      "PILOT_AUTH_SCHEMA_MISMATCH",
      "approvedGroundingProjectionSha256 must be 64-char lower-case hex.",
    );
  }
  if (!Number.isInteger(input.maxRequestedQuestions) || input.maxRequestedQuestions < 1) {
    throw new ModalContractError(
      "PILOT_AUTH_SCHEMA_MISMATCH",
      `maxRequestedQuestions must be a positive integer (got ${input.maxRequestedQuestions}).`,
    );
  }

  const issuedAtMs = clock.nowMs();
  const expiresAtMs = issuedAtMs + ttl * 1000;
  const issuedAtUtc = new Date(issuedAtMs).toISOString();
  const expiresAtUtc = new Date(expiresAtMs).toISOString();

  const bodyWithoutFingerprint = {
    schemaVersion: "pilot-generation-authorization-v1" as const,
    authorizationId,
    tenantId: input.tenantId,
    courseId: input.courseId,
    versionId: input.versionId,
    sourceVideoSha256: input.sourceVideoSha256,
    resolvedTranscriptBuildId: input.resolvedTranscriptBuildId,
    approvedGroundingProjectionSha256: input.approvedGroundingProjectionSha256,
    operation: input.operation,
    maxRequestedQuestions: input.maxRequestedQuestions,
    pilotRestrictions: input.pilotRestrictions,
    issuedAtUtc,
    expiresAtUtc,
    issuedBy: input.issuedBy,
  };

  const fingerprint = createHmac("sha256", input.fingerprintSecret)
    .update(canonicalise(bodyWithoutFingerprint), "utf-8")
    .digest("base64url");

  return { ...bodyWithoutFingerprint, fingerprint };
}

/** Server-side verification helper used by the Modal function (and
 *  the TypeScript tests that mock a Modal function). Recomputes the
 *  fingerprint over the body without the `fingerprint` field and
 *  constant-time compares. */
export function verifyPilotAuthorizationFingerprint(
  auth: PilotAuthorizationV1,
  fingerprintSecret: string,
): boolean {
  const { fingerprint, ...rest } = auth;
  const expected = createHmac("sha256", fingerprintSecret)
    .update(canonicalise(rest), "utf-8")
    .digest("base64url");
  return constantTimeEqualAscii(fingerprint, expected);
}

/** Check if the authorization has expired. */
export function isPilotAuthorizationExpired(
  auth: PilotAuthorizationV1,
  clock: Clock = SYSTEM_CLOCK,
): boolean {
  const expiresAtMs = Date.parse(auth.expiresAtUtc);
  if (Number.isNaN(expiresAtMs)) return true;
  return clock.nowMs() >= expiresAtMs;
}

function constantTimeEqualAscii(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
