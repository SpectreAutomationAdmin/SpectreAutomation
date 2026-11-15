/**
 * EP-TRAIN-4Y-BF §2 — one generation workflow per course version.
 *
 * The incident this guards against: a second upload arrived while the
 * first upload's run was still working, and a second full run was
 * created beside it (12 final-assessment questions instead of 8).
 *
 * Enforcement is in the database-backed request path, not in a browser
 * or in process memory. These tests drive it with concurrent requests,
 * different plans, repeated uploads, abandoned runs and repeated queue
 * deliveries. No provider is involved: jobs are requested and queued,
 * and where a worker runs it is the simulated (non-billable) path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import {
  claimNextGenerationRun,
  retireStalledGenerationRuns,
} from "@/lib/hr/training/generation/generation-service";
import { buildPlanAndRequestGeneration } from "@/lib/hr/training/generation/enqueue-helper";
import { recordProcessingAuthorization } from "@/lib/hr/training/generation/processing-authorization";
import { handleGenerateJob } from "@/lib/hr/training/generation/worker-handler";
import {
  claimNextTranscriptionJob,
  markQueued,
  requestTranscription,
  retireStalledTranscriptionJobs,
} from "@/lib/hr/training/transcription/job-service";
import {
  buildMockTranscriptSegments,
  MOCK_TRANSCRIPT_MODEL_VARIANT,
} from "@/lib/hr/training/transcription/mock-transcript";
import { advancePreparation } from "@/lib/hr/training/preparation-orchestrator";
import { HARD_QUEUE_WAIT_MS, MAX_QUEUE_WAIT_MS } from "@/lib/hr/training/generation/stall-policy";
import type { Principal } from "@/lib/rbac";

const DURATION_SEC = 643;
const MANAGED_ENV = [
  "TRAINING_BILLABLE_INFERENCE",
  "TRAINING_MOCK_INFERENCE_ALLOWED",
  "TRAINING_TEST_PRINCIPAL_USER_IDS",
  "MODAL_HYBRID_ENABLED",
] as const;
const savedEnv: Record<string, string | undefined> = {};

interface World { readonly clubId: string; readonly manager: Principal; readonly testPrincipal: Principal }

async function world(): Promise<World> {
  const stamp = Date.now() + Math.floor(Math.random() * 1_000_000);
  const club = await prisma.club.create({
    data: { name: `BF Flight ${stamp}`, slug: `bf-flight-${stamp}`, region: "Test", salesTaxRegion: "GST", foundedYear: 2000 },
  });
  await makeUser({ email: `manager-${stamp}@t.local`, role: "CLUB_ADMIN", clubId: club.id });
  await makeUser({ email: `e2e-${stamp}@t.local`, role: "CLUB_ADMIN", clubId: club.id });
  return {
    clubId: club.id,
    manager: (await principalFor(`manager-${stamp}@t.local`)) as Principal,
    testPrincipal: (await principalFor(`e2e-${stamp}@t.local`)) as Principal,
  };
}

let shaCounter = 0;
function nextSha(): string {
  shaCounter++;
  return shaCounter.toString(16).padStart(2, "0").repeat(32).slice(0, 64);
}

async function makeVersion(w: World, createdBy: Principal, sha: string): Promise<string> {
  const stamp = Date.now() + Math.floor(Math.random() * 1_000_000);
  const course = await prisma.trainingCourse.create({
    data: { clubId: w.clubId, code: `BF-${stamp}`, title: "Course", category: "ORIENTATION", createdByUserId: createdBy.id },
  });
  const version = await prisma.trainingCourseVersion.create({
    data: { courseId: course.id, version: 1, state: "DRAFT", title: "V1", videoSha256: sha, videoStorageKey: `k/${stamp}`, videoDurationSec: DURATION_SEC },
  });
  return version.id;
}

async function seedTranscript(w: World, sha: string, kind: "REAL" | "SIMULATED"): Promise<void> {
  const build = await prisma.trainingTranscriptBuild.create({
    data: {
      clubId: w.clubId,
      sourceVideoSha256: sha,
      resolvedTranscriptBuildId: (kind === "REAL" ? "5" : "6").repeat(64),
      transcriberName: kind === "REAL" ? "faster-whisper" : "spectre-simulated",
      transcriberVersion: "1",
      transcriberModelName: kind === "REAL" ? "faster-whisper-large-v3" : MOCK_TRANSCRIPT_MODEL_VARIANT,
      transcriberModelVersion: "1",
      transcriberConfigSha256: "c".repeat(64),
      producedAt: new Date(),
    },
  });
  await prisma.trainingTranscriptSegment.createMany({
    data: buildMockTranscriptSegments(DURATION_SEC).map((s) => ({
      clubId: w.clubId,
      transcriptBuildId: build.id,
      segmentIndex: s.id,
      text: s.text,
      startSec: s.startSec,
      endSec: s.endSec,
    })),
  });
}

async function authorizeUpload(w: World, by: Principal, versionId: string): Promise<void> {
  await recordProcessingAuthorization(by, { clubId: w.clubId, courseVersionId: versionId, operation: "GENERATE_FULL", source: "UPLOAD", inferenceMode: "LIVE" });
}

const LIVE = ["REQUESTED", "QUEUED", "RUNNING"];
/** Make a queued run look as if it has been waiting for `ms`. */
async function ageQueuedRun(runId: string, ms: number): Promise<void> {
  const when = new Date(Date.now() - ms);
  await prisma.trainingQuestionAiGenerationRun.update({ where: { id: runId }, data: { requestedAt: when, queuedAt: when } });
}
async function runs(versionId: string) {
  return prisma.trainingQuestionAiGenerationRun.findMany({
    where: { courseVersionId: versionId },
    orderBy: { requestedAt: "asc" },
    select: { id: true, executionStatus: true, executionErrorMessage: true, leaseToken: true },
  });
}

beforeEach(async () => {
  for (const key of MANAGED_ENV) savedEnv[key] = process.env[key];
  await resetDb();
  await seedRbac();
  process.env.MODAL_HYBRID_ENABLED = "1";
  process.env.TRAINING_BILLABLE_INFERENCE = "enabled";
  delete process.env.TRAINING_MOCK_INFERENCE_ALLOWED;
  delete process.env.TRAINING_TEST_PRINCIPAL_USER_IDS;
});

afterEach(() => {
  for (const key of MANAGED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
});

describe("EP-TRAIN-4Y-BF §2 — single flight at the request boundary", () => {
  it("two simultaneous requests with DIFFERENT plans create exactly one run and one queue entry", async () => {
    const w = await world();
    const sha = nextSha();
    const versionId = await makeVersion(w, w.manager, sha);
    await seedTranscript(w, sha, "REAL");

    const [a, b] = await Promise.all([
      buildPlanAndRequestGeneration(w.manager, { clubId: w.clubId, courseVersionId: versionId }),
      buildPlanAndRequestGeneration(w.manager, { clubId: w.clubId, courseVersionId: versionId, checkpointCount: 3, finalCount: 4 }),
    ]);
    // Both callers were handed the SAME active workflow.
    expect(a.generationRunId).toBe(b.generationRunId);
    expect([a.idempotent, b.idempotent].sort()).toEqual([false, true]);

    const rows = await runs(versionId);
    expect(rows.length).toBe(1);
    expect(rows[0].executionStatus).toBe("QUEUED");
    expect(await prisma.backgroundJob.count({ where: { kind: "TRAINING_GENERATE_QUESTIONS" } })).toBe(1);
  }, 60_000);

  it("five simultaneous requests still create exactly one run", async () => {
    const w = await world();
    const sha = nextSha();
    const versionId = await makeVersion(w, w.manager, sha);
    await seedTranscript(w, sha, "REAL");
    const results = await Promise.all(
      [undefined, 2, 3, 4, 5].map((checkpointCount) =>
        buildPlanAndRequestGeneration(w.manager, {
          clubId: w.clubId,
          courseVersionId: versionId,
          ...(checkpointCount ? { checkpointCount, finalCount: 4 } : {}),
        }),
      ),
    );
    expect(new Set(results.map((r) => r.generationRunId)).size).toBe(1);
    expect(results.filter((r) => !r.idempotent).length).toBe(1);
    expect((await runs(versionId)).length).toBe(1);
    expect(await prisma.backgroundJob.count({ where: { kind: "TRAINING_GENERATE_QUESTIONS" } })).toBe(1);
  }, 60_000);

  it("a later request with another plan resolves to the run already in flight", async () => {
    const w = await world();
    const sha = nextSha();
    const versionId = await makeVersion(w, w.manager, sha);
    await seedTranscript(w, sha, "REAL");
    const first = await buildPlanAndRequestGeneration(w.manager, { clubId: w.clubId, courseVersionId: versionId });
    const second = await buildPlanAndRequestGeneration(w.manager, { clubId: w.clubId, courseVersionId: versionId, checkpointCount: 2, finalCount: 3 });
    expect(second.generationRunId).toBe(first.generationRunId);
    expect(second.idempotent).toBe(true);
    expect((await runs(versionId)).length).toBe(1);
  }, 60_000);

  it("different course versions are independent: each gets its own run", async () => {
    const w = await world();
    const shaA = nextSha();
    const shaB = nextSha();
    const versionA = await makeVersion(w, w.manager, shaA);
    const versionB = await makeVersion(w, w.manager, shaB);
    await seedTranscript(w, shaA, "REAL");
    await prisma.trainingTranscriptBuild.deleteMany({ where: { sourceVideoSha256: shaB } });
    const buildB = await prisma.trainingTranscriptBuild.create({
      data: {
        clubId: w.clubId, sourceVideoSha256: shaB, resolvedTranscriptBuildId: "7".repeat(64),
        transcriberName: "faster-whisper", transcriberVersion: "1", transcriberModelName: "faster-whisper-large-v3",
        transcriberModelVersion: "1", transcriberConfigSha256: "c".repeat(64), producedAt: new Date(),
      },
    });
    await prisma.trainingTranscriptSegment.createMany({
      data: buildMockTranscriptSegments(DURATION_SEC).map((s) => ({
        clubId: w.clubId, transcriptBuildId: buildB.id, segmentIndex: s.id, text: s.text, startSec: s.startSec, endSec: s.endSec,
      })),
    });
    const [a, b] = await Promise.all([
      buildPlanAndRequestGeneration(w.manager, { clubId: w.clubId, courseVersionId: versionA }),
      buildPlanAndRequestGeneration(w.manager, { clubId: w.clubId, courseVersionId: versionB }),
    ]);
    expect(a.generationRunId).not.toBe(b.generationRunId);
    expect(a.idempotent).toBe(false);
    expect(b.idempotent).toBe(false);
  }, 60_000);
});

describe("EP-TRAIN-4Y-BF §2 — abandoned runs: lease expiry, retirement, fencing", () => {
  it("a run that is only WAITING behind another job is not abandoned: it is never retired or replaced", async () => {
    const w = await world();
    const sha = nextSha();
    const versionId = await makeVersion(w, w.manager, sha);
    await seedTranscript(w, sha, "REAL");
    const first = await buildPlanAndRequestGeneration(w.manager, { clubId: w.clubId, courseVersionId: versionId });
    // Twenty minutes in the queue — the worker is busy with a long job —
    // and its queue entry is still there, waiting its turn.
    await ageQueuedRun(first.generationRunId, 20 * 60_000);
    expect((await retireStalledGenerationRuns({ clubId: w.clubId, courseVersionId: versionId })).retiredRunIds).toEqual([]);
    const again = await buildPlanAndRequestGeneration(w.manager, { clubId: w.clubId, courseVersionId: versionId, checkpointCount: 3, finalCount: 4 });
    expect(again.generationRunId).toBe(first.generationRunId);
    expect(again.idempotent).toBe(true);
    const rows = await runs(versionId);
    expect(rows.map((r) => r.executionStatus)).toEqual(["QUEUED"]);
    // Nothing was burned: the orchestrator still counts one pass.
    expect(await prisma.backgroundJob.count({ where: { kind: "TRAINING_GENERATE_QUESTIONS", status: "QUEUED" } })).toBe(1);
  }, 60_000);

  it("a run re-queued for a retry is not abandoned either (the wait is measured from when it was re-queued)", async () => {
    const w = await world();
    const sha = nextSha();
    const versionId = await makeVersion(w, w.manager, sha);
    await seedTranscript(w, sha, "REAL");
    const first = await buildPlanAndRequestGeneration(w.manager, { clubId: w.clubId, courseVersionId: versionId });
    // Requested long ago, failed late, re-queued just now for its retry.
    await prisma.trainingQuestionAiGenerationRun.update({
      where: { id: first.generationRunId },
      data: { requestedAt: new Date(Date.now() - 12 * 60_000), queuedAt: new Date(), attempts: 1 },
    });
    expect((await retireStalledGenerationRuns({ clubId: w.clubId, courseVersionId: versionId })).retiredRunIds).toEqual([]);
  }, 60_000);

  it("a queued run whose queue entry is GONE is retired, and exactly one replacement is created", async () => {
    const w = await world();
    const sha = nextSha();
    const versionId = await makeVersion(w, w.manager, sha);
    await seedTranscript(w, sha, "REAL");
    const first = await buildPlanAndRequestGeneration(w.manager, { clubId: w.clubId, courseVersionId: versionId });
    await ageQueuedRun(first.generationRunId, MAX_QUEUE_WAIT_MS + 60_000);
    // The queue entry was lost (finished without ever running the run).
    await prisma.backgroundJob.updateMany({
      where: { idempotencyKey: `training-generate:${first.generationRunId}` },
      data: { status: "COMPLETED", finishedAt: new Date() },
    });
    const second = await buildPlanAndRequestGeneration(w.manager, { clubId: w.clubId, courseVersionId: versionId, checkpointCount: 3, finalCount: 4 });
    expect(second.generationRunId).not.toBe(first.generationRunId);
    expect(second.idempotent).toBe(false);

    const rows = await runs(versionId);
    expect(rows.map((r) => r.executionStatus)).toEqual(["FAILED", "QUEUED"]);
    expect(rows[0].executionErrorMessage).toMatch(/superseded/i);
    expect(rows.filter((r) => LIVE.includes(r.executionStatus)).length).toBe(1);
    const entries = await prisma.backgroundJob.findMany({ where: { kind: "TRAINING_GENERATE_QUESTIONS" }, select: { idempotencyKey: true, status: true } });
    expect(entries.find((e) => e.idempotencyKey === `training-generate:${second.generationRunId}`)?.status).toBe("QUEUED");
  }, 60_000);

  it("a queue entry stuck RUNNING on a dead worker does not keep a queued run alive", async () => {
    const w = await world();
    const sha = nextSha();
    const versionId = await makeVersion(w, w.manager, sha);
    await seedTranscript(w, sha, "REAL");
    const first = await buildPlanAndRequestGeneration(w.manager, { clubId: w.clubId, courseVersionId: versionId });
    await ageQueuedRun(first.generationRunId, 20 * 60_000);
    // The worker marked the entry RUNNING and died before claiming the run.
    await prisma.backgroundJob.updateMany({
      where: { idempotencyKey: `training-generate:${first.generationRunId}` },
      data: { status: "RUNNING", startedAt: new Date(Date.now() - 19 * 60_000) },
    });
    const retired = await retireStalledGenerationRuns({ clubId: w.clubId, courseVersionId: versionId });
    expect(retired.retiredRunIds).toEqual([first.generationRunId]);
    const entry = await prisma.backgroundJob.findFirstOrThrow({ where: { idempotencyKey: `training-generate:${first.generationRunId}` } });
    expect(entry.status).toBe("CANCELLED");
  }, 60_000);

  it("beyond the hard limit a queued run is retired even if a queue entry still exists", async () => {
    const w = await world();
    const sha = nextSha();
    const versionId = await makeVersion(w, w.manager, sha);
    await seedTranscript(w, sha, "REAL");
    const first = await buildPlanAndRequestGeneration(w.manager, { clubId: w.clubId, courseVersionId: versionId });
    await ageQueuedRun(first.generationRunId, HARD_QUEUE_WAIT_MS + 60_000);
    const retired = await retireStalledGenerationRuns({ clubId: w.clubId, courseVersionId: versionId });
    expect(retired.retiredRunIds).toEqual([first.generationRunId]);
  }, 60_000);
  it("a healthy queued or running run is never retired", async () => {
    const w = await world();
    const sha = nextSha();
    const versionId = await makeVersion(w, w.manager, sha);
    await seedTranscript(w, sha, "REAL");
    const first = await buildPlanAndRequestGeneration(w.manager, { clubId: w.clubId, courseVersionId: versionId });
    expect((await retireStalledGenerationRuns({ clubId: w.clubId, courseVersionId: versionId })).retiredRunIds).toEqual([]);
    const claim = await claimNextGenerationRun({ runId: first.generationRunId });
    expect(claim?.runId).toBe(first.generationRunId);
    expect((await retireStalledGenerationRuns({ clubId: w.clubId, courseVersionId: versionId })).retiredRunIds).toEqual([]);
    expect((await runs(versionId))[0].executionStatus).toBe("RUNNING");
  }, 60_000);

  it("a run whose worker died is retired after its lease expires; the dead worker is fenced out", async () => {
    const w = await world();
    const sha = nextSha();
    const versionId = await makeVersion(w, w.manager, sha);
    await seedTranscript(w, sha, "REAL");
    const first = await buildPlanAndRequestGeneration(w.manager, { clubId: w.clubId, courseVersionId: versionId });
    const claim = await claimNextGenerationRun({ runId: first.generationRunId });
    expect(claim).not.toBeNull();
    await prisma.trainingQuestionAiGenerationRun.update({
      where: { id: first.generationRunId },
      data: { leaseExpiresAt: new Date(Date.now() - 10 * 60_000) },
    });
    const retired = await retireStalledGenerationRuns({ clubId: w.clubId, courseVersionId: versionId });
    expect(retired.retiredRunIds).toEqual([first.generationRunId]);
    const row = (await runs(versionId))[0];
    expect(row.executionStatus).toBe("FAILED");
    // The lease token is gone, so any write the old worker attempts with
    // its token matches nothing.
    expect(row.leaseToken).toBeNull();
    const lateWrite = await prisma.trainingQuestionAiGenerationRun.updateMany({
      where: { id: first.generationRunId, executionStatus: "RUNNING", leaseToken: claim!.leaseToken },
      data: { executionStatus: "COMPLETED" },
    });
    expect(lateWrite.count).toBe(0);
  }, 60_000);

  it("a queue entry claims only its own run, never another version's", async () => {
    const w = await world();
    const shaA = nextSha();
    const versionA = await makeVersion(w, w.manager, shaA);
    await seedTranscript(w, shaA, "REAL");
    const a = await buildPlanAndRequestGeneration(w.manager, { clubId: w.clubId, courseVersionId: versionA });
    const other = await world();
    const shaB = nextSha();
    const versionB = await makeVersion(other, other.manager, shaB);
    await seedTranscript(other, shaB, "REAL");
    const b = await buildPlanAndRequestGeneration(other.manager, { clubId: other.clubId, courseVersionId: versionB });

    // B's queue entry runs first. It must claim B and leave A queued.
    const claim = await claimNextGenerationRun({ runId: b.generationRunId });
    expect(claim?.runId).toBe(b.generationRunId);
    expect((await runs(versionA))[0].executionStatus).toBe("QUEUED");
    // A second delivery of B's entry finds nothing to claim.
    expect(await claimNextGenerationRun({ runId: b.generationRunId })).toBeNull();
    expect((await claimNextGenerationRun({ runId: a.generationRunId }))?.runId).toBe(a.generationRunId);
  }, 60_000);

  it("the same for transcription: with two jobs queued, an entry claims only its own", async () => {
    const w = await world();
    const versionA = await makeVersion(w, w.manager, nextSha());
    const versionB = await makeVersion(w, w.manager, nextSha());
    const a = await requestTranscription(w.manager, w.clubId, { courseVersionId: versionA });
    await markQueued(w.clubId, a.jobId);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const b = await requestTranscription(w.manager, w.clubId, { courseVersionId: versionB });
    await markQueued(w.clubId, b.jobId);
    // A is first in line; B's entry must still claim B.
    const claim = await claimNextTranscriptionJob({ jobId: b.jobId });
    expect(claim?.jobId).toBe(b.jobId);
    expect((await prisma.trainingTranscriptionJob.findUniqueOrThrow({ where: { id: a.jobId } })).state).toBe("QUEUED");
    expect(await claimNextTranscriptionJob({ jobId: b.jobId })).toBeNull();
    expect((await claimNextTranscriptionJob({ jobId: a.jobId }))?.jobId).toBe(a.jobId);
  }, 60_000);

  it("an abandoned transcription job is retired on the next request instead of being reported as in progress forever", async () => {
    const w = await world();
    const versionId = await makeVersion(w, w.manager, nextSha());
    const first = await requestTranscription(w.manager, w.clubId, { courseVersionId: versionId });
    await markQueued(w.clubId, first.jobId);
    // Claimed by a worker that then died: RUNNING, lease long expired.
    await claimNextTranscriptionJob({ jobId: first.jobId });
    await prisma.trainingTranscriptionJob.update({
      where: { id: first.jobId },
      data: { leaseExpiresAt: new Date(Date.now() - 10 * 60_000) },
    });
    const second = await requestTranscription(w.manager, w.clubId, { courseVersionId: versionId });
    expect(second.idempotent).toBe(false);
    expect(second.jobId).not.toBe(first.jobId);
    const old = await prisma.trainingTranscriptionJob.findUniqueOrThrow({ where: { id: first.jobId } });
    expect(old.state).toBe("CANCELLED");
    expect(old.leaseToken).toBeNull();
    // A healthy one is left alone.
    expect((await retireStalledTranscriptionJobs({ clubId: w.clubId, courseVersionId: versionId })).retiredJobIds).toEqual([]);
  }, 60_000);
});

describe("EP-TRAIN-4Y-BF §2 — the orchestrator: repeated uploads, refreshes and deliveries", () => {
  it("REGRESSION: a second upload while the first run is still live does not start a second run", async () => {
    const w = await world();
    const sha = nextSha();
    const versionId = await makeVersion(w, w.manager, sha);
    await seedTranscript(w, sha, "REAL");

    await authorizeUpload(w, w.manager, versionId);
    const first = await advancePreparation({ clubId: w.clubId, courseVersionId: versionId, trigger: "UPLOAD" });
    expect(first.action).toBe("GENERATION_ENQUEUED");

    // A worker picks the run up; then the manager uploads again.
    await claimNextGenerationRun({ runId: first.generationRunId! });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await authorizeUpload(w, w.manager, versionId);
    const second = await advancePreparation({ clubId: w.clubId, courseVersionId: versionId, trigger: "UPLOAD" });

    expect(second.action).toBe("GENERATION_IN_PROGRESS");
    expect(second.generationRunId).toBe(first.generationRunId);
    expect((await runs(versionId)).length).toBe(1);
    expect(await prisma.backgroundJob.count({ where: { kind: "TRAINING_GENERATE_QUESTIONS" } })).toBe(1);
  }, 60_000);

  it("REGRESSION: the run a second upload waited for is not thrown away — only what is missing is asked for", async () => {
    const w = await world();
    process.env.TRAINING_TEST_PRINCIPAL_USER_IDS = w.testPrincipal.id;
    process.env.TRAINING_MOCK_INFERENCE_ALLOWED = "true";
    const sha = nextSha();
    const versionId = await makeVersion(w, w.testPrincipal, sha);
    await seedTranscript(w, sha, "SIMULATED");
    const workerEnv = {
      ...process.env,
      MODAL_KEY: "k",
      MODAL_SECRET: "s",
      MODAL_SPECTRE_HMAC_KEY: "test-hmac-key-32-bytes-0000000000",
      SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET: "test-fingerprint-secret-00000000",
      MODAL_GENERATE_URL: "https://modal.example/generate",
    } as NodeJS.ProcessEnv;
    // Simulated first pass leaves the first checkpoint empty.
    const upload = () =>
      recordProcessingAuthorization(w.testPrincipal, {
        clubId: w.clubId,
        courseVersionId: versionId,
        operation: "GENERATE_FULL",
        source: "UPLOAD",
        inferenceMode: "MOCK",
        mockFault: "DROP_FIRST_CHECKPOINT",
      });

    await upload();
    const first = await advancePreparation({ clubId: w.clubId, courseVersionId: versionId, trigger: "UPLOAD" });
    expect(first.action).toBe("GENERATION_ENQUEUED");
    // A second upload arrives while the first run is still queued.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await upload();
    const second = await advancePreparation({ clubId: w.clubId, courseVersionId: versionId, trigger: "UPLOAD" });
    expect(second.action).toBe("GENERATION_IN_PROGRESS");
    expect(second.generationRunId).toBe(first.generationRunId);

    // The first run finishes: 4 of 5 checkpoint questions, 8 of 8 final.
    const done = await handleGenerateJob({ runId: first.generationRunId!, nonBillable: true }, { env: workerEnv });
    expect(done.status).toBe("COMPLETED");
    expect(await prisma.trainingQuestionAiDraft.count({ where: { courseVersionId: versionId } })).toBe(12);

    // What follows is a REPAIR for the one missing question — not a
    // second full run.
    const next = await advancePreparation({ clubId: w.clubId, courseVersionId: versionId, trigger: "GENERATION_FINISHED" });
    expect(next.action).toBe("REPAIR_ENQUEUED");
    const repair = await prisma.trainingQuestionAiGenerationRun.findUniqueOrThrow({ where: { id: next.generationRunId! } });
    const repairPlan = JSON.parse(repair.assessmentPlanJson ?? "{}") as {
      proposedCheckpointGroups: unknown[];
      totalTargetQuestionCount: number;
    };
    expect(repairPlan.proposedCheckpointGroups.length).toBe(1);
    expect(repairPlan.totalTargetQuestionCount).toBe(1);

    const repaired = await handleGenerateJob({ runId: next.generationRunId!, nonBillable: true }, { env: workerEnv });
    expect(repaired.status).toBe("COMPLETED");
    const final = await advancePreparation({ clubId: w.clubId, courseVersionId: versionId, trigger: "GENERATION_FINISHED" });
    expect(final.action).toBe("COMPLETE");
    // Exactly the planned 5 + 8 — not 22.
    expect(await prisma.trainingQuestionAiDraft.count({ where: { courseVersionId: versionId } })).toBe(13);
    expect((await runs(versionId)).length).toBe(2);
  }, 240_000);

  it("a replaced video is a new recording: questions from the old one do not count towards it", async () => {
    const w = await world();
    process.env.TRAINING_TEST_PRINCIPAL_USER_IDS = w.testPrincipal.id;
    process.env.TRAINING_MOCK_INFERENCE_ALLOWED = "true";
    const oldSha = nextSha();
    const versionId = await makeVersion(w, w.testPrincipal, oldSha);
    await seedTranscript(w, oldSha, "SIMULATED");
    const workerEnv = {
      ...process.env,
      MODAL_KEY: "k",
      MODAL_SECRET: "s",
      MODAL_SPECTRE_HMAC_KEY: "test-hmac-key-32-bytes-0000000000",
      SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET: "test-fingerprint-secret-00000000",
      MODAL_GENERATE_URL: "https://modal.example/generate",
    } as NodeJS.ProcessEnv;
    await authorizeUpload(w, w.testPrincipal, versionId);
    const first = await advancePreparation({ clubId: w.clubId, courseVersionId: versionId, trigger: "UPLOAD" });
    await handleGenerateJob({ runId: first.generationRunId!, nonBillable: true }, { env: workerEnv });
    expect(await prisma.trainingQuestionAiDraft.count({ where: { courseVersionId: versionId } })).toBe(13);

    // The manager replaces the video with a different recording.
    const newSha = nextSha();
    await prisma.trainingCourseVersion.update({ where: { id: versionId }, data: { videoSha256: newSha } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await authorizeUpload(w, w.testPrincipal, versionId);
    const afterReplace = await advancePreparation({ clubId: w.clubId, courseVersionId: versionId, trigger: "UPLOAD" });
    // It starts from the top for the new recording (transcription
    // first) rather than declaring the course complete on the strength
    // of the old recording's questions.
    expect(afterReplace.action).toBe("TRANSCRIPTION_ENQUEUED");
  }, 240_000);

  it("upload, watchdog and a duplicate upload arriving together start one run", async () => {
    const w = await world();
    const sha = nextSha();
    const versionId = await makeVersion(w, w.manager, sha);
    await seedTranscript(w, sha, "REAL");
    await authorizeUpload(w, w.manager, versionId);
    const results = await Promise.all([
      advancePreparation({ clubId: w.clubId, courseVersionId: versionId, trigger: "UPLOAD" }),
      advancePreparation({ clubId: w.clubId, courseVersionId: versionId, trigger: "WATCHDOG" }),
      advancePreparation({ clubId: w.clubId, courseVersionId: versionId, trigger: "UPLOAD" }),
    ]);
    expect(new Set(results.map((r) => r.generationRunId)).size).toBe(1);
    expect((await runs(versionId)).length).toBe(1);
    expect(await prisma.backgroundJob.count({ where: { kind: "TRAINING_GENERATE_QUESTIONS" } })).toBe(1);
  }, 60_000);

  it("two simultaneous upload completions with no transcript yet start one transcription job", async () => {
    const w = await world();
    const versionId = await makeVersion(w, w.manager, nextSha());
    await authorizeUpload(w, w.manager, versionId);
    const results = await Promise.all([
      advancePreparation({ clubId: w.clubId, courseVersionId: versionId, trigger: "UPLOAD" }),
      advancePreparation({ clubId: w.clubId, courseVersionId: versionId, trigger: "UPLOAD" }),
    ]);
    expect(new Set(results.map((r) => r.transcriptionJobId)).size).toBe(1);
    expect(await prisma.trainingTranscriptionJob.count({ where: { courseVersionId: versionId } })).toBe(1);
    expect(await prisma.backgroundJob.count({ where: { kind: "TRAINING_TRANSCRIBE_VIDEO" } })).toBe(1);
  }, 60_000);

  it("a queue entry delivered twice does the work once; finished questions are not regenerated or overwritten", async () => {
    const w = await world();
    process.env.TRAINING_TEST_PRINCIPAL_USER_IDS = w.testPrincipal.id;
    process.env.TRAINING_MOCK_INFERENCE_ALLOWED = "true";
    const sha = nextSha();
    const versionId = await makeVersion(w, w.testPrincipal, sha);
    await seedTranscript(w, sha, "SIMULATED");
    await authorizeUpload(w, w.testPrincipal, versionId);
    const started = await advancePreparation({ clubId: w.clubId, courseVersionId: versionId, trigger: "UPLOAD" });
    expect(started.action).toBe("GENERATION_ENQUEUED");

    // The worker has provider credentials configured (as on staging); the
    // run is non-billable, so they are never used.
    const workerEnv = {
      ...process.env,
      MODAL_KEY: "k",
      MODAL_SECRET: "s",
      MODAL_SPECTRE_HMAC_KEY: "test-hmac-key-32-bytes-0000000000",
      SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET: "test-fingerprint-secret-00000000",
      MODAL_GENERATE_URL: "https://modal.example/generate",
    } as NodeJS.ProcessEnv;
    const provider = vi.fn(async () => new Response("{}", { status: 500 }));
    const firstDelivery = await handleGenerateJob(
      { runId: started.generationRunId!, nonBillable: true },
      { env: workerEnv, fetchImpl: provider as unknown as typeof fetch },
    );
    expect(firstDelivery.status).toBe("COMPLETED");
    const before = await prisma.trainingQuestionAiDraft.findMany({
      where: { courseVersionId: versionId },
      orderBy: { id: "asc" },
      select: { id: true, draftJson: true, contentHash: true, state: true, generationRunId: true },
    });
    expect(before.length).toBe(13);

    // The same queue entry is delivered again (worker restart, redelivery).
    const secondDelivery = await handleGenerateJob(
      { runId: started.generationRunId!, nonBillable: true },
      { env: workerEnv, fetchImpl: provider as unknown as typeof fetch },
    );
    expect(secondDelivery.status).toBe("SKIPPED");

    // The orchestrator sees a complete course: it records completion and
    // never asks for another pass, however often it is triggered.
    for (const trigger of ["GENERATION_FINISHED", "WATCHDOG", "UPLOAD", "WATCHDOG"] as const) {
      const again = await advancePreparation({ clubId: w.clubId, courseVersionId: versionId, trigger });
      expect(again.action).toBe("COMPLETE");
    }
    expect((await runs(versionId)).length).toBe(1);
    const after = await prisma.trainingQuestionAiDraft.findMany({
      where: { courseVersionId: versionId },
      orderBy: { id: "asc" },
      select: { id: true, draftJson: true, contentHash: true, state: true, generationRunId: true },
    });
    expect(after).toEqual(before);
    expect(provider).not.toHaveBeenCalled();
  }, 180_000);
});
