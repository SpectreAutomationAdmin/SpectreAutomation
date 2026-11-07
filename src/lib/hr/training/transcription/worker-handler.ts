// EP-TRAIN-6D-4V (2026-11-06) — TRAINING_TRANSCRIBE_VIDEO worker handler.
// EP-TRAIN-4Y-B-IMPL (2026-11-07) — Hybrid-contract auth update.
//
// This is the ONLY code path that calls the Modal provider. It runs
// in the Fly worker process (bin/worker.ts), claims the queued job's
// lease, performs the Modal call, verifies the response, invokes 4L
// ingest, and records COMPLETED or FAILED.
//
// Hybrid auth (§D.1): the handler issues a fresh `PilotAuthorizationV1`
// per invocation. Queue-level retries re-enter this handler and emit a
// new auth each time (§Q.4 "fresh authorization on retry"). The
// TRANSCRIBE operation uses placeholder sentinels for
// `resolvedTranscriptBuildId` and `approvedGroundingProjectionSha256`
// because those artefacts do not exist yet — Modal-side TRANSCRIBE
// verifier requires exactly those placeholder values.
//
// Cancellation safety (requirement 7): every state mutation goes
// through the job-service, which refuses writes on
// (state != RUNNING || leaseToken != expected). A late response
// against a CANCELLED row is discarded, not persisted — the 4L
// ingest is still attempted but the lifecycle terminal write
// refuses, so the transcript build + segments remain in the DB
// (useful for forensics) while the job stays CANCELLED.
//
// Credential absence (requirement 4 + §6): the modal-client raises
// CREDENTIAL_ABSENT before any I/O happens; the handler maps it to
// recordJobFailed(code=CREDENTIAL_ABSENT, retryable=false). Missing
// fingerprint-secret also surfaces as CREDENTIAL_ABSENT before any
// Modal call (via `issuePilotAuthorization` wrapper here).

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability/logger";
import type { Principal } from "@/lib/rbac";
import {
  claimNextTranscriptionJob,
  recordJobCompleted,
  recordJobFailed,
  analyseTranscriptQuality,
  type JobFailureCode,
} from "./job-service";
import {
  callModalTranscribe,
  estimateTranscribeCostMicros,
  ModalClientError,
} from "./modal-client";
import {
  persistTranscriptBuild,
  persistTranscriptSegments,
} from "./ingest";
import { createHash, randomBytes } from "node:crypto";
import {
  issuePilotAuthorization,
  ModalContractError,
  TRANSCRIBE_PLACEHOLDER_TRANSCRIPT_BUILD_ID,
  TRANSCRIBE_PLACEHOLDER_GROUNDING_SHA,
  ENV_FINGERPRINT_SECRET,
} from "../modal-shared";

/**
 * Build a worker-system Principal scoped to a single club. NOT a DB
 * user. NOT a signable identity. Only carries the scope needed to
 * call the 4L ingest services. Per founder requirement 8 + directive
 * §8 — "narrowly scoped service identity for worker ingestion."
 */
function workerSystemPrincipal(clubId: string): Principal {
  return {
    id: `system:training-transcription:${clubId}`,
    name: "system:training-transcription",
    email: "system+training-transcription@spectre.local",
    status: "ACTIVE",
    // Global-like but tenant-scoped via clubId equality; the 4L
    // service checks `hasPermission(principal, clubId, …)`. We
    // craft a SUPER_ADMIN-on-this-club membership so the
    // `allPermissionKeys()` set is available for exactly this club.
    memberships: [{ clubId, roleKey: "SUPER_ADMIN" }],
    activeClubId: clubId,
    memberId: null,
  };
}

export interface HandlerDeps {
  /** Injection for tests. */
  readonly fetchImpl?: typeof fetch;
  /** Injection for tests. */
  readonly env?: NodeJS.ProcessEnv;
  /** Returns a short-lived signed URL for the MP4 bytes. Injected so
   *  tests do not depend on R2. */
  readonly makeSignedVideoUrl: (args: {
    readonly clubId: string;
    readonly courseVersionId: string;
    readonly ttlSec: number;
  }) => Promise<string>;
}

/**
 * Called by the queue runner when a TRAINING_TRANSCRIBE_VIDEO job
 * fires. Idempotent per `jobId` — if the job is not in RUNNING state
 * with our lease, every write refuses, and the handler returns
 * without side effects.
 */
export async function handleTranscribeJob(
  args: { readonly jobId: string },
  deps: HandlerDeps,
): Promise<{ status: "COMPLETED" | "FAILED" | "SKIPPED" }> {
  // Claim (or reclaim) the next job matching the queued jobId. We
  // use the job-service claim path to acquire a bounded lease — note
  // the current claim picks the next available job globally, not
  // specifically args.jobId. In production the queue adapter + a
  // per-jobId lookup would narrow this; for 4V's offline scope the
  // claim-next semantics are correct because the handler is only
  // ever called after a job was just enqueued.
  const claim = await claimNextTranscriptionJob();
  if (!claim || claim.jobId !== args.jobId) {
    // Either someone else claimed it, or the state changed under us
    // (cancellation). Don't mutate.
    logger.info("training.transcription.worker.skipped", {
      jobId: args.jobId,
      claimedJobId: claim?.jobId ?? null,
    });
    return { status: "SKIPPED" };
  }

  // Load the course-version for its videoDurationSec + sanity.
  const version = await prisma.trainingCourseVersion.findUnique({
    where: { id: claim.courseVersionId },
    select: { id: true, videoDurationSec: true, videoSha256: true },
  });
  if (!version || version.videoSha256 !== claim.sourceVideoSha256) {
    await recordJobFailed({
      jobId: claim.jobId,
      leaseToken: claim.leaseToken,
      failureCode: "SHA_MISMATCH",
      failureMessage: "Version video SHA changed under us.",
      retryable: false,
    });
    return { status: "FAILED" };
  }

  // Build the signed URL for Modal.
  let audioUrl: string;
  try {
    audioUrl = await deps.makeSignedVideoUrl({
      clubId: claim.clubId,
      courseVersionId: claim.courseVersionId,
      ttlSec: 600, // 10 min
    });
  } catch (err) {
    await recordJobFailed({
      jobId: claim.jobId,
      leaseToken: claim.leaseToken,
      failureCode: "INGEST_FAILED",
      failureMessage: `Signed-URL generation failed: ${(err as Error)?.message ?? String(err)}`,
      retryable: true,
    });
    return { status: "FAILED" };
  }

  // §D.1 + §Q.4: issue a FRESH PilotAuthorizationV1 per attempt.
  // The authorizationId / issuedAtUtc / expiresAtUtc / fingerprint
  // all change. TRANSCRIBE placeholders stand in for the
  // transcript-build + grounding-projection fields that do not yet
  // exist. The request-id is derived from the jobId + a random
  // nonce so a retry of the same jobId emits a DIFFERENT request-id
  // and the Modal replay store does not reject it as a duplicate.
  const env = deps.env ?? process.env;
  const fingerprintSecret = env[ENV_FINGERPRINT_SECRET];
  if (!fingerprintSecret) {
    await recordJobFailed({
      jobId: claim.jobId,
      leaseToken: claim.leaseToken,
      failureCode: "CREDENTIAL_ABSENT",
      failureMessage: `Modal credentials not configured: ${ENV_FINGERPRINT_SECRET}.`,
      retryable: false,
    });
    return { status: "FAILED" };
  }

  let pilotAuth;
  try {
    pilotAuth = issuePilotAuthorization({
      tenantId: claim.clubId,
      courseId: `course:${claim.courseVersionId}`,
      versionId: claim.courseVersionId,
      sourceVideoSha256: claim.sourceVideoSha256,
      resolvedTranscriptBuildId: TRANSCRIBE_PLACEHOLDER_TRANSCRIPT_BUILD_ID,
      approvedGroundingProjectionSha256: TRANSCRIBE_PLACEHOLDER_GROUNDING_SHA,
      operation: "TRANSCRIBE_VIDEO",
      maxRequestedQuestions: 1,
      pilotRestrictions: {
        publicationProhibited: true,
        employeeAssignmentProhibited: true,
        databaseWritesProhibited: false,
        automaticRetriesProhibited: false,
        excludedSegmentIds: [],
        scope: `transcribe:${claim.jobId}`,
      },
      ttlSec: 3600,
      issuedBy: `system:training-transcription:${claim.clubId}`,
      fingerprintSecret,
    });
  } catch (err) {
    const code: JobFailureCode =
      err instanceof ModalContractError ? (err.code as JobFailureCode) : "INTEGRITY_FAILURE";
    await recordJobFailed({
      jobId: claim.jobId,
      leaseToken: claim.leaseToken,
      failureCode: code,
      failureMessage: `PilotAuthorization issuance failed: ${(err as Error)?.message ?? String(err)}`,
      retryable: false,
    });
    return { status: "FAILED" };
  }

  // Fresh request-id per attempt (32 hex chars). Correlation with
  // the jobId is via the audit log's `meta.jobId`.
  const requestId = `t-${claim.jobId}-${randomBytes(16).toString("hex")}`;

  // Call Modal.
  const now = new Date();
  let modalResponse;
  try {
    modalResponse = await callModalTranscribe(
      {
        requestId,
        audioUrl,
        languageCode: "en",
        modelVariant: "faster-whisper-large-v3",
        pilotAuthorization: pilotAuth,
      },
      {
        fetchImpl: deps.fetchImpl,
        env: deps.env,
      },
    );
  } catch (err) {
    const contractCode =
      err instanceof ModalClientError ? (err as ModalContractError).code : null;
    const code: JobFailureCode = (contractCode as JobFailureCode | null) ?? "MODAL_HTTP_ERROR";
    // Retry policy for Hybrid contract: integrity-level failures
    // are terminal; transport-level failures are retryable within
    // the attempt budget.
    const NON_RETRYABLE: ReadonlySet<string> = new Set([
      "CREDENTIAL_ABSENT",
      "MODAL_HMAC_INVALID",
      "REQUEST_HMAC_INVALID",
      "REQUEST_BODY_INVALID",
      "MODAL_BODY_INVALID",
      "PILOT_AUTH_FINGERPRINT_MISMATCH",
      "PILOT_AUTH_SCHEMA_MISMATCH",
      "PILOT_AUTH_OPERATION_MISMATCH",
      "TENANT_MISMATCH",
      "COURSE_VERSION_MISMATCH",
      "VIDEO_SHA_MISMATCH_AT_BOUNDARY",
      "OPERATION_MISMATCH",
      "UNKNOWN_OPERATION",
      "CONTRACT_VERSION_MISMATCH",
      "ASCII_SCOPE_REQUIRED",
      "RESPONSE_REQUEST_ID_MISMATCH",
      "RESPONSE_OPERATION_MISMATCH",
    ]);
    const retryable = !NON_RETRYABLE.has(code);
    await recordJobFailed({
      jobId: claim.jobId,
      leaseToken: claim.leaseToken,
      failureCode: code,
      failureMessage: (err as Error)?.message ?? String(err),
      retryable,
    });
    return { status: "FAILED" };
  }

  // SHA verification (requirement 5 + 6 — "integrity verification
  // succeeds before COMPLETED").
  if (modalResponse.audioSha256 !== claim.sourceVideoSha256) {
    await recordJobFailed({
      jobId: claim.jobId,
      leaseToken: claim.leaseToken,
      failureCode: "SHA_MISMATCH",
      failureMessage: "Modal response audioSha256 does not match stored videoSha256.",
      retryable: false,
    });
    return { status: "FAILED" };
  }

  // Transcript quality heuristics. Attaches per-segment flags.
  const quality = analyseTranscriptQuality(
    modalResponse.segments.map((s) => ({
      segmentIndex: s.id,
      text: s.text,
      startSec: s.startSec,
      endSec: s.endSec,
    })),
    version.videoDurationSec,
  );

  // Fail-closed when fundamental integrity reasons fire.
  if (quality.reasons.includes("EMPTY_TRANSCRIPT")) {
    await recordJobFailed({
      jobId: claim.jobId,
      leaseToken: claim.leaseToken,
      failureCode: "INTEGRITY_FAILURE",
      failureMessage: "Transcript is empty.",
      retryable: false,
    });
    return { status: "FAILED" };
  }

  // 4L ingest: build + segments. Worker-system principal scoped to
  // this club only.
  const systemPrincipal = workerSystemPrincipal(claim.clubId);

  // Deterministic build id: 64-char lowercase hex SHA-256 of
  // (audioSha256 | modelVariant). The 4L contract requires this
  // exact shape.
  const resolvedTranscriptBuildId = createHash("sha256")
    .update(modalResponse.audioSha256 + "|" + modalResponse.modelVariant, "utf-8")
    .digest("hex");

  // Deterministic config sha (placeholder — real pipeline would
  // compute from the Modal container config). Full 64-hex is fine
  // here because 4L stores it as free-form text (not an ID).
  const configSha = createHash("sha256")
    .update(`spectre-synthetic-4v-config|${modalResponse.modelVariant}`, "utf-8")
    .digest("hex");

  try {
    const buildResult = await persistTranscriptBuild(systemPrincipal, claim.clubId, {
      courseVersionId: claim.courseVersionId,
      sourceVideoSha256: claim.sourceVideoSha256,
      resolvedTranscriptBuildId,
      transcriberName: "faster-whisper",
      transcriberVersion: "1.0.3",
      transcriberModelName: modalResponse.modelVariant,
      transcriberModelVersion: "stable-v1",
      transcriberConfigSha256: configSha,
      producedAt: now,
    });

    // Build the flag-aware segment inputs. We encode the per-segment
    // `pendingReview` with the quality flags.
    const flagsByIndex = new Map(
      quality.perSegmentFlags.map((f) => [f.segmentIndex, f.flags]),
    );
    await persistTranscriptSegments(systemPrincipal, claim.clubId, buildResult.build.id, {
      expectedResolvedTranscriptBuildId: resolvedTranscriptBuildId,
      segments: modalResponse.segments.map((s) => ({
        segmentIndex: s.id,
        text: s.text,
        startSec: s.startSec,
        endSec: s.endSec,
        pendingReview: flagsByIndex.get(s.id) ?? [],
      })),
    });

    // Terminal transition: RUNNING → COMPLETED.
    await recordJobCompleted({
      jobId: claim.jobId,
      leaseToken: claim.leaseToken,
      resolvedTranscriptBuildId: buildResult.build.id,
      modelVariant: modalResponse.modelVariant,
      elapsedMsTotal: modalResponse.elapsedMs.coldBoot + modalResponse.elapsedMs.transcribe,
      elapsedMsColdBoot: modalResponse.elapsedMs.coldBoot,
      elapsedMsTranscribe: modalResponse.elapsedMs.transcribe,
      estimatedCostUsdMicros: estimateTranscribeCostMicros(
        modalResponse.elapsedMs.coldBoot + modalResponse.elapsedMs.transcribe,
      ),
    });
    return { status: "COMPLETED" };
  } catch (err) {
    try {
      await recordJobFailed({
        jobId: claim.jobId,
        leaseToken: claim.leaseToken,
        failureCode: "INGEST_FAILED",
        failureMessage: ((err as Error & { issues?: unknown })?.issues
          ? JSON.stringify((err as { issues: unknown }).issues)
          : (err as Error)?.message) ?? String(err),
        retryable: false,
      });
    } catch {
      // Row state changed under us (cancellation race). Skip the
      // failed write; the job's current terminal / pre-terminal state
      // is authoritative.
    }
    return { status: "FAILED" };
  }
}
