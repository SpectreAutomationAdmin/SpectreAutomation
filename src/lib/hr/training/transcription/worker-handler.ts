// EP-TRAIN-6D-4V (2026-11-06) — TRAINING_TRANSCRIBE_VIDEO worker handler.
//
// This is the ONLY code path that calls the Modal provider. It runs
// in the Fly worker process (bin/worker.ts), claims the queued job's
// lease, performs the Modal call, verifies the response, invokes 4L
// ingest, and records COMPLETED or FAILED.
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
// recordJobFailed(code=CREDENTIAL_ABSENT, retryable=false).

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
import { createHash } from "node:crypto";

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

  // Call Modal.
  const now = new Date();
  let modalResponse;
  try {
    modalResponse = await callModalTranscribe(
      {
        requestId: claim.jobId,
        audioUrl,
        languageCode: "en",
        modelVariant: "faster-whisper-large-v3",
        schemaVersion: "transcribe-v1",
      },
      {
        fetchImpl: deps.fetchImpl,
        env: deps.env,
      },
    );
  } catch (err) {
    const code: JobFailureCode =
      err instanceof ModalClientError && err.code !== "MODAL_BODY_INVALID"
        ? (err.code as JobFailureCode)
        : "MODAL_HTTP_ERROR";
    await recordJobFailed({
      jobId: claim.jobId,
      leaseToken: claim.leaseToken,
      failureCode: code,
      failureMessage: (err as Error)?.message ?? String(err),
      // CREDENTIAL_ABSENT + HMAC are not retryable; others are.
      retryable: code !== "CREDENTIAL_ABSENT" && code !== "MODAL_HMAC_INVALID",
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
