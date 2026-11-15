/**
 * EP-TRAIN-4Y-BF §1 — fail-closed test boundary.
 *
 * Proves, with the provider replaced by a spy that fails the test if it
 * is ever called:
 *
 *   1. no provider client can be reached unless the environment has
 *      explicitly enabled billable inference;
 *   2. a version touched by a server-listed test principal is
 *      non-billable — resolved from durable state, with NO request
 *      marker involved — and stays so across queue dispatch and retries;
 *   3. the negative cases: the mock marker is deliberately absent (the
 *      authorization even says LIVE), billable inference is enabled and
 *      credentials are present — and still nothing reaches the provider;
 *   4. a real manager's upload stays automatic where billable inference
 *      is enabled, and is refused (never simulated) where it is not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import {
  ModalContractError,
  assertBillableInferenceEnabled,
  isBillableInferenceEnabled,
  issuePilotAuthorization,
} from "@/lib/hr/training/modal-shared";
import { callModalGenerate } from "@/lib/hr/training/generation/modal-client";
import { callModalTranscribe } from "@/lib/hr/training/transcription/modal-client";
import { callModalMetadata } from "@/lib/hr/training/ai-metadata/metadata-modal-client";
import {
  isTestExecutionPrincipal,
  isTrainingTestPrincipal,
  markVersionNonBillable,
  resolveProcessingIdentity,
  resolveTestScope,
  trainingTestPrincipalIds,
} from "@/lib/hr/training/generation/test-execution-identity";
import {
  recordProcessingAuthorization,
  resolveInferenceModeForVersion,
} from "@/lib/hr/training/generation/processing-authorization";
import { BuildAndEnqueueRejected, buildPlanAndRequestGeneration } from "@/lib/hr/training/generation/enqueue-helper";
import { handleGenerateJob } from "@/lib/hr/training/generation/worker-handler";
import { handleTranscribeJob } from "@/lib/hr/training/transcription/worker-handler";
import { JobRejectedError, requestTranscription, markQueued } from "@/lib/hr/training/transcription/job-service";
import {
  buildMockTranscriptSegments,
  MOCK_TRANSCRIPT_MODEL_VARIANT,
} from "@/lib/hr/training/transcription/mock-transcript";
import { advancePreparation } from "@/lib/hr/training/preparation-orchestrator";
import type { Principal } from "@/lib/rbac";

const CREDENTIALS = {
  MODAL_KEY: "k",
  MODAL_SECRET: "s",
  MODAL_SPECTRE_HMAC_KEY: "test-hmac-key-32-bytes-0000000000",
  SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET: "test-fingerprint-secret-00000000",
  MODAL_SPECTRE_RESPONSE_HMAC_KEY: "test-response-hmac-key-0000000000",
  MODAL_TRANSCRIBE_URL: "https://modal.example/transcribe",
  MODAL_GENERATE_URL: "https://modal.example/generate",
};
const SHA = "c9".repeat(32);
const DURATION_SEC = 643;

/** The provider. Any call is a billable event and fails the assertion. */
function providerSpy() {
  return vi.fn(async () => new Response("{}", { status: 500 }));
}

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...CREDENTIALS, ...extra } as unknown as NodeJS.ProcessEnv;
}

const MANAGED_ENV = [
  "TRAINING_BILLABLE_INFERENCE",
  "TRAINING_MOCK_INFERENCE_ALLOWED",
  "TRAINING_TEST_PRINCIPAL_USER_IDS",
  "MODAL_HYBRID_ENABLED",
] as const;
const savedEnv: Record<string, string | undefined> = {};

interface World {
  readonly clubId: string;
  readonly manager: Principal;
  readonly testPrincipal: Principal;
}

async function world(): Promise<World> {
  const stamp = Date.now() + Math.floor(Math.random() * 1_000_000);
  const club = await prisma.club.create({
    data: { name: `BF Isolation ${stamp}`, slug: `bf-iso-${stamp}`, region: "Test", salesTaxRegion: "GST", foundedYear: 2000 },
  });
  await makeUser({ email: `manager-${stamp}@t.local`, role: "CLUB_ADMIN", clubId: club.id });
  await makeUser({ email: `e2e-${stamp}@t.local`, role: "CLUB_ADMIN", clubId: club.id });
  const manager = (await principalFor(`manager-${stamp}@t.local`)) as Principal;
  const testPrincipal = (await principalFor(`e2e-${stamp}@t.local`)) as Principal;
  return { clubId: club.id, manager, testPrincipal };
}

async function makeVersion(w: World, createdBy: Principal, opts: { sha?: string } = {}): Promise<string> {
  const stamp = Date.now() + Math.floor(Math.random() * 1_000_000);
  const course = await prisma.trainingCourse.create({
    data: { clubId: w.clubId, code: `BF-${stamp}`, title: "Course", category: "ORIENTATION", createdByUserId: createdBy.id },
  });
  const version = await prisma.trainingCourseVersion.create({
    data: {
      courseId: course.id,
      version: 1,
      state: "DRAFT",
      title: "V1",
      videoSha256: opts.sha ?? SHA,
      videoStorageKey: `k/${stamp}`,
      videoDurationSec: DURATION_SEC,
    },
  });
  return version.id;
}

async function seedTranscript(w: World, sha: string, kind: "REAL" | "SIMULATED"): Promise<void> {
  const build = await prisma.trainingTranscriptBuild.create({
    data: {
      clubId: w.clubId,
      sourceVideoSha256: sha,
      resolvedTranscriptBuildId: (kind === "REAL" ? "3" : "4").repeat(64),
      transcriberName: kind === "REAL" ? "faster-whisper" : "spectre-simulated",
      transcriberVersion: "1",
      transcriberModelName: kind === "REAL" ? "faster-whisper-large-v3" : MOCK_TRANSCRIPT_MODEL_VARIANT,
      transcriberModelVersion: "1",
      transcriberConfigSha256: "c".repeat(64),
      producedAt: new Date(),
    },
  });
  for (const s of buildMockTranscriptSegments(DURATION_SEC)) {
    await prisma.trainingTranscriptSegment.create({
      data: {
        clubId: w.clubId,
        transcriptBuildId: build.id,
        segmentIndex: s.id,
        text: s.text,
        startSec: s.startSec,
        endSec: s.endSec,
      },
    });
  }
}

beforeEach(async () => {
  for (const key of MANAGED_ENV) savedEnv[key] = process.env[key];
  await resetDb();
  await seedRbac();
  process.env.MODAL_HYBRID_ENABLED = "1";
  delete process.env.TRAINING_BILLABLE_INFERENCE;
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

describe("EP-TRAIN-4Y-BF §1 — provider boundary is closed unless explicitly enabled", () => {
  it("is closed for every value except the exact word 'enabled'", () => {
    for (const value of [undefined, "", "true", "1", "ENABLED", "enable", "yes", "disabled"]) {
      const e = { TRAINING_BILLABLE_INFERENCE: value } as unknown as NodeJS.ProcessEnv;
      expect(isBillableInferenceEnabled(e)).toBe(false);
      expect(() => assertBillableInferenceEnabled("x", e)).toThrow(ModalContractError);
    }
    expect(isBillableInferenceEnabled({ TRAINING_BILLABLE_INFERENCE: "enabled" } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });

  function pilotAuthorization() {
    return issuePilotAuthorization({
      tenantId: "club",
      courseId: "course",
      versionId: "version",
      sourceVideoSha256: SHA,
      resolvedTranscriptBuildId: "1".repeat(64),
      approvedGroundingProjectionSha256: "2".repeat(64),
      operation: "GENERATE_DRAFT_QUESTIONS",
      maxRequestedQuestions: 1,
      pilotRestrictions: {
        publicationProhibited: true,
        employeeAssignmentProhibited: true,
        databaseWritesProhibited: false,
        automaticRetriesProhibited: false,
        excludedSegmentIds: [],
        scope: "test",
      },
      ttlSec: 600,
      issuedBy: "test",
      fingerprintSecret: CREDENTIALS.SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET,
    });
  }

  it("question generation: full credentials, flag absent → refused before any network call", async () => {
    const spy = providerSpy();
    await expect(
      callModalGenerate(
        {
          requestId: "r1",
          pilotAuthorization: pilotAuthorization(),
          modelVariant: "qwen-2.5-7b-instruct-awq",
          systemPrompt: "s",
          transcript: "t",
          constraints: { proposalKind: "QUESTION_FINAL_ASSESSMENT", maxQuestions: 1, allowedQuestionTypes: ["SINGLE_CHOICE"], jsonSchema: {} },
        },
        { fetchImpl: spy as unknown as typeof fetch, env: env() },
      ),
    ).rejects.toMatchObject({ code: "BILLABLE_INFERENCE_LOCKED" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("transcription: full credentials, flag absent → refused before any network call", async () => {
    const spy = providerSpy();
    await expect(
      callModalTranscribe(
        {
          requestId: "r2",
          audioUrl: "https://signed.example/v.mp4",
          languageCode: "en",
          modelVariant: "faster-whisper-large-v3",
          pilotAuthorization: pilotAuthorization(),
        },
        { fetchImpl: spy as unknown as typeof fetch, env: env() },
      ),
    ).rejects.toMatchObject({ code: "BILLABLE_INFERENCE_LOCKED" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("course metadata: full credentials, flag absent → refused before any network call", async () => {
    const spy = providerSpy();
    await expect(
      callModalMetadata(
        { pilotAuthorization: pilotAuthorization(), systemPrompt: "s", transcript: "t" },
        { fetchImpl: spy as unknown as typeof fetch, env: env() },
      ),
    ).rejects.toThrow(/Billable inference is not enabled/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("with the flag enabled the same call does go out (so the gate is the only thing stopping it)", async () => {
    const spy = providerSpy();
    await expect(
      callModalTranscribe(
        {
          requestId: "r3",
          audioUrl: "https://signed.example/v.mp4",
          languageCode: "en",
          modelVariant: "faster-whisper-large-v3",
          pilotAuthorization: pilotAuthorization(),
        },
        { fetchImpl: spy as unknown as typeof fetch, env: env({ TRAINING_BILLABLE_INFERENCE: "enabled" }) },
      ),
    ).rejects.toMatchObject({ code: "MODAL_HTTP_ERROR" });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("EP-TRAIN-4Y-BF §1 — test execution identity is resolved from durable state", () => {
  it("the test-principal list comes only from the server environment", () => {
    const e = { TRAINING_TEST_PRINCIPAL_USER_IDS: " a , b,, " } as unknown as NodeJS.ProcessEnv;
    expect([...trainingTestPrincipalIds(e)]).toEqual(["a", "b"]);
    expect(isTrainingTestPrincipal("a", e)).toBe(true);
    expect(isTrainingTestPrincipal("c", e)).toBe(false);
    expect(isTrainingTestPrincipal(null, e)).toBe(false);
    expect(trainingTestPrincipalIds({} as NodeJS.ProcessEnv).size).toBe(0);
  });

  it("a real manager's version is billable; nothing marks it otherwise", async () => {
    const w = await world();
    const versionId = await makeVersion(w, w.manager);
    await recordProcessingAuthorization(w.manager, { clubId: w.clubId, courseVersionId: versionId, operation: "GENERATE_FULL", source: "UPLOAD", inferenceMode: "LIVE" });
    const e = env({ TRAINING_TEST_PRINCIPAL_USER_IDS: w.testPrincipal.id });
    expect(await resolveProcessingIdentity({ clubId: w.clubId, courseVersionId: versionId }, { env: e })).toEqual({ nonBillable: false, reasons: [] });
    expect(await resolveInferenceModeForVersion({ clubId: w.clubId, courseVersionId: versionId }, { env: e })).toBe("LIVE");
  });

  it("a course CREATED by a test principal is non-billable with no marker and no header at all", async () => {
    const w = await world();
    const versionId = await makeVersion(w, w.testPrincipal);
    const e = env({ TRAINING_TEST_PRINCIPAL_USER_IDS: w.testPrincipal.id });
    const identity = await resolveProcessingIdentity({ clubId: w.clubId, courseVersionId: versionId }, { env: e });
    expect(identity.nonBillable).toBe(true);
    expect(identity.reasons).toEqual(["COURSE_CREATED_BY_TEST_PRINCIPAL"]);
  });

  it("an authorization written by a test principal is non-billable even when it SAYS live", async () => {
    const w = await world();
    const versionId = await makeVersion(w, w.manager);
    await recordProcessingAuthorization(w.testPrincipal, { clubId: w.clubId, courseVersionId: versionId, operation: "GENERATE_FULL", source: "UPLOAD", inferenceMode: "LIVE" });
    const e = env({ TRAINING_TEST_PRINCIPAL_USER_IDS: w.testPrincipal.id });
    const identity = await resolveProcessingIdentity({ clubId: w.clubId, courseVersionId: versionId }, { env: e });
    expect(identity.reasons).toEqual(["AUTHORIZED_BY_TEST_PRINCIPAL"]);
    expect(await resolveInferenceModeForVersion({ clubId: w.clubId, courseVersionId: versionId }, { env: e })).toBe("MOCK");
  });

  it("the durable marker is sticky: a later real authorization cannot make the version billable again", async () => {
    const w = await world();
    const versionId = await makeVersion(w, w.manager);
    await markVersionNonBillable(w.testPrincipal, { clubId: w.clubId, courseVersionId: versionId, reason: "test" });
    await recordProcessingAuthorization(w.manager, { clubId: w.clubId, courseVersionId: versionId, operation: "GENERATE_FULL", source: "UPLOAD", inferenceMode: "LIVE" });
    // Even with the test-principal list EMPTY, the marker alone decides.
    const identity = await resolveProcessingIdentity({ clubId: w.clubId, courseVersionId: versionId }, { env: env() });
    expect(identity.nonBillable).toBe(true);
    expect(identity.reasons).toContain("TEST_ISOLATION_MARKER");
  });

  it("the configured list tolerates spaces, semicolons, newlines and quotes", () => {
    for (const raw of ["id-01 id-02", "id-01;id-02", "id-01\nid-02", '"id-01","id-02"', " id-01 , id-02 "]) {
      const ids = trainingTestPrincipalIds({ TRAINING_TEST_PRINCIPAL_USER_IDS: raw } as unknown as NodeJS.ProcessEnv);
      expect([...ids].sort()).toEqual(["id-01", "id-02"]);
    }
  });

  it("an account in the reserved e-mail domain is a test principal even when NO list is configured", async () => {
    const w = await world();
    const stamp = Date.now() + Math.floor(Math.random() * 1_000_000);
    await makeUser({ email: `e2e-${stamp}@example.test`, role: "CLUB_ADMIN", clubId: w.clubId });
    const reserved = (await principalFor(`e2e-${stamp}@example.test`)) as Principal;
    const noList = env();
    expect(isTestExecutionPrincipal(reserved, noList)).toBe(true);
    expect(isTestExecutionPrincipal(w.manager, noList)).toBe(false);
    expect(isTestExecutionPrincipal({ id: "x", email: "someone@example.test.evil.com" }, noList)).toBe(false);
    // Durable resolution needs no configuration either: the worker
    // reads the creator's address from the database.
    const versionId = await makeVersion(w, reserved);
    const identity = await resolveProcessingIdentity({ clubId: w.clubId, courseVersionId: versionId }, { env: noList });
    expect(identity.nonBillable).toBe(true);
    expect(identity.reasons).toEqual(["COURSE_CREATED_BY_TEST_PRINCIPAL"]);
  });

  it("the two worlds are kept apart", async () => {
    const w = await world();
    const e = env({ TRAINING_TEST_PRINCIPAL_USER_IDS: w.testPrincipal.id });
    const realVersion = await makeVersion(w, w.manager);
    const testVersion = await makeVersion(w, w.testPrincipal);
    const scope = (who: Principal, versionId: string) =>
      resolveTestScope(who, { clubId: w.clubId, courseVersionId: versionId }, { env: e });
    expect(await scope(w.manager, realVersion)).toBe("REAL");
    expect(await scope(w.testPrincipal, testVersion)).toBe("TEST");
    expect(await scope(w.testPrincipal, realVersion)).toBe("TEST_PRINCIPAL_ON_REAL_COURSE");
    expect(await scope(w.manager, testVersion)).toBe("REAL_PRINCIPAL_ON_TEST_COURSE");
  });

  it("a test principal cannot request work on a real manager's course — and leaves no trace on it", async () => {
    const w = await world();
    process.env.TRAINING_TEST_PRINCIPAL_USER_IDS = w.testPrincipal.id;
    const versionId = await makeVersion(w, w.manager);
    await seedTranscript(w, SHA, "REAL");

    await expect(
      buildPlanAndRequestGeneration(w.testPrincipal, { clubId: w.clubId, courseVersionId: versionId }),
    ).rejects.toMatchObject({ rejectionCode: "TEST_PRINCIPAL_SCOPE" });
    await expect(
      buildPlanAndRequestGeneration(w.testPrincipal, { clubId: w.clubId, courseVersionId: versionId }),
    ).rejects.toBeInstanceOf(BuildAndEnqueueRejected);
    await expect(requestTranscription(w.testPrincipal, w.clubId, { courseVersionId: versionId })).rejects.toBeInstanceOf(
      JobRejectedError,
    );
    expect(await prisma.trainingQuestionAiGenerationRun.count()).toBe(0);
    expect(await prisma.trainingTranscriptionJob.count()).toBe(0);
    expect(await prisma.backgroundJob.count()).toBe(0);
    // The real course is still a real, billable course.
    const identity = await resolveProcessingIdentity({ clubId: w.clubId, courseVersionId: versionId });
    expect(identity).toEqual({ nonBillable: false, reasons: [] });
  }, 60_000);

  it("the marker is tenant-scoped: another club's marker for the same id does nothing", async () => {
    const w = await world();
    const other = await world();
    const versionId = await makeVersion(w, w.manager);
    await markVersionNonBillable(other.testPrincipal, { clubId: other.clubId, courseVersionId: versionId, reason: "test" });
    const identity = await resolveProcessingIdentity({ clubId: w.clubId, courseVersionId: versionId }, { env: env() });
    expect(identity.nonBillable).toBe(false);
  });
});

describe("EP-TRAIN-4Y-BF §1 — negative tests: the mock marker is deliberately absent", () => {
  it("question generation: test-created course, authorization says LIVE, billing enabled, credentials present → simulated; provider never called", async () => {
    const w = await world();
    process.env.TRAINING_TEST_PRINCIPAL_USER_IDS = w.testPrincipal.id;
    const versionId = await makeVersion(w, w.testPrincipal);
    await seedTranscript(w, SHA, "SIMULATED");
    // No mock marker anywhere: the only authorization explicitly says LIVE.
    await recordProcessingAuthorization(w.testPrincipal, { clubId: w.clubId, courseVersionId: versionId, operation: "GENERATE_FULL", source: "UPLOAD", inferenceMode: "LIVE" });
    const requested = await buildPlanAndRequestGeneration(w.testPrincipal, { clubId: w.clubId, courseVersionId: versionId });

    // The queue entry carries the non-billable verdict.
    const queued = await prisma.backgroundJob.findFirstOrThrow({ where: { kind: "TRAINING_GENERATE_QUESTIONS" } });
    expect(JSON.parse(queued.payloadJson ?? "{}")).toMatchObject({ generationRunId: requested.generationRunId, nonBillable: true });

    const spy = providerSpy();
    const result = await handleGenerateJob(
      { runId: requested.generationRunId },
      {
        fetchImpl: spy as unknown as typeof fetch,
        env: env({
          TRAINING_BILLABLE_INFERENCE: "enabled",
          TRAINING_MOCK_INFERENCE_ALLOWED: "true",
          TRAINING_TEST_PRINCIPAL_USER_IDS: w.testPrincipal.id,
        }),
      },
    );
    expect(spy).not.toHaveBeenCalled();
    expect(result.status).toBe("COMPLETED");
    const run = await prisma.trainingQuestionAiGenerationRun.findUniqueOrThrow({ where: { id: requested.generationRunId } });
    expect(run.inferenceMs ?? 0).toBe(0);
    const drafts = await prisma.trainingQuestionAiDraft.findMany({ where: { generationRunId: requested.generationRunId }, select: { draftJson: true } });
    // The simulated transcript yields the full plan: 5 checkpoint + 8 final.
    expect(drafts.length).toBe(13);
    expect(drafts.every((d) => /MOCK INFERENCE/.test(d.draftJson))).toBe(true);
  }, 120_000);

  it("the same run with simulation NOT allowed is refused — it does not fall through to the provider", async () => {
    const w = await world();
    process.env.TRAINING_TEST_PRINCIPAL_USER_IDS = w.testPrincipal.id;
    const versionId = await makeVersion(w, w.testPrincipal);
    await seedTranscript(w, SHA, "SIMULATED");
    const requested = await buildPlanAndRequestGeneration(w.testPrincipal, { clubId: w.clubId, courseVersionId: versionId });
    const spy = providerSpy();
    const result = await handleGenerateJob(
      { runId: requested.generationRunId },
      {
        fetchImpl: spy as unknown as typeof fetch,
        env: env({ TRAINING_BILLABLE_INFERENCE: "enabled", TRAINING_TEST_PRINCIPAL_USER_IDS: w.testPrincipal.id }),
      },
    );
    expect(spy).not.toHaveBeenCalled();
    expect(result.status).toBe("FAILED");
    expect(await prisma.trainingQuestionAiDraft.count({ where: { generationRunId: requested.generationRunId } })).toBe(0);
  }, 60_000);

  it("the queue entry's own flag is enough: a job marked non-billable never reaches the provider even if the database says nothing", async () => {
    const w = await world();
    const versionId = await makeVersion(w, w.manager);
    await seedTranscript(w, SHA, "SIMULATED");
    process.env.TRAINING_TEST_PRINCIPAL_USER_IDS = w.manager.id; // so planning accepts the simulated transcript
    const requested = await buildPlanAndRequestGeneration(w.manager, { clubId: w.clubId, courseVersionId: versionId });
    const spy = providerSpy();
    const result = await handleGenerateJob(
      { runId: requested.generationRunId, nonBillable: true },
      {
        fetchImpl: spy as unknown as typeof fetch,
        // The worker's own environment lists NO test principals.
        env: env({ TRAINING_BILLABLE_INFERENCE: "enabled", TRAINING_MOCK_INFERENCE_ALLOWED: "true" }),
      },
    );
    expect(spy).not.toHaveBeenCalled();
    expect(result.status).toBe("COMPLETED");
  }, 120_000);

  it("a retry of a non-billable run is still non-billable", async () => {
    const w = await world();
    process.env.TRAINING_TEST_PRINCIPAL_USER_IDS = w.testPrincipal.id;
    const versionId = await makeVersion(w, w.testPrincipal);
    await seedTranscript(w, SHA, "SIMULATED");
    const requested = await buildPlanAndRequestGeneration(w.testPrincipal, { clubId: w.clubId, courseVersionId: versionId });
    // Simulate a worker that died mid-run: RUNNING with an expired lease.
    await prisma.trainingQuestionAiGenerationRun.update({
      where: { id: requested.generationRunId },
      data: { executionStatus: "RUNNING", attempts: 1, leaseToken: "dead-worker", leaseExpiresAt: new Date(Date.now() - 60_000), startedAt: new Date(Date.now() - 600_000) },
    });
    const spy = providerSpy();
    const result = await handleGenerateJob(
      { runId: requested.generationRunId },
      {
        fetchImpl: spy as unknown as typeof fetch,
        env: env({
          TRAINING_BILLABLE_INFERENCE: "enabled",
          TRAINING_MOCK_INFERENCE_ALLOWED: "true",
          TRAINING_TEST_PRINCIPAL_USER_IDS: w.testPrincipal.id,
        }),
      },
    );
    expect(spy).not.toHaveBeenCalled();
    expect(result.status).toBe("COMPLETED");
    const run = await prisma.trainingQuestionAiGenerationRun.findUniqueOrThrow({ where: { id: requested.generationRunId } });
    expect(run.attempts).toBe(2);
  }, 120_000);

  it("transcription: test-created course, billing enabled, credentials present → simulated transcript; provider never called", async () => {
    const w = await world();
    process.env.TRAINING_TEST_PRINCIPAL_USER_IDS = w.testPrincipal.id;
    const versionId = await makeVersion(w, w.testPrincipal);
    const job = await requestTranscription(w.testPrincipal, w.clubId, { courseVersionId: versionId });
    await markQueued(w.clubId, job.jobId);
    const spy = providerSpy();
    const signedUrl = vi.fn(async () => "https://signed.example/v.mp4");
    const result = await handleTranscribeJob(
      { jobId: job.jobId },
      {
        fetchImpl: spy as unknown as typeof fetch,
        env: env({
          TRAINING_BILLABLE_INFERENCE: "enabled",
          TRAINING_MOCK_INFERENCE_ALLOWED: "true",
          TRAINING_TEST_PRINCIPAL_USER_IDS: w.testPrincipal.id,
        }),
        makeSignedVideoUrl: signedUrl,
      },
    );
    expect(spy).not.toHaveBeenCalled();
    expect(signedUrl).not.toHaveBeenCalled();
    expect(result.status).toBe("COMPLETED");
    const row = await prisma.trainingTranscriptionJob.findUniqueOrThrow({ where: { id: job.jobId } });
    expect(row.state).toBe("COMPLETED");
    expect(row.estimatedCostUsdMicros ?? 0).toBe(0);
    const build = await prisma.trainingTranscriptBuild.findFirstOrThrow({ where: { clubId: w.clubId, sourceVideoSha256: SHA } });
    expect(build.transcriberModelName).toBe(MOCK_TRANSCRIPT_MODEL_VARIANT);
    expect(await prisma.trainingTranscriptSegment.count({ where: { transcriptBuildId: build.id } })).toBeGreaterThan(100);
  }, 60_000);

  it("transcription: test identity where simulation is not allowed → refused, provider never called", async () => {
    const w = await world();
    process.env.TRAINING_TEST_PRINCIPAL_USER_IDS = w.testPrincipal.id;
    const versionId = await makeVersion(w, w.testPrincipal);
    const job = await requestTranscription(w.testPrincipal, w.clubId, { courseVersionId: versionId });
    await markQueued(w.clubId, job.jobId);
    const spy = providerSpy();
    const result = await handleTranscribeJob(
      { jobId: job.jobId },
      {
        fetchImpl: spy as unknown as typeof fetch,
        env: env({ TRAINING_BILLABLE_INFERENCE: "enabled", TRAINING_TEST_PRINCIPAL_USER_IDS: w.testPrincipal.id }),
        makeSignedVideoUrl: async () => "https://signed.example/v.mp4",
      },
    );
    expect(spy).not.toHaveBeenCalled();
    expect(result.status).toBe("FAILED");
    expect(await prisma.trainingTranscriptBuild.count({ where: { clubId: w.clubId } })).toBe(0);
  });
});

describe("EP-TRAIN-4Y-BF §1 — a real manager's course where billable inference is not enabled", () => {
  it("question generation is refused (never simulated) and the provider is never called", async () => {
    const w = await world();
    const versionId = await makeVersion(w, w.manager);
    await seedTranscript(w, SHA, "REAL");
    const requested = await buildPlanAndRequestGeneration(w.manager, { clubId: w.clubId, courseVersionId: versionId });
    const queued = await prisma.backgroundJob.findFirstOrThrow({ where: { kind: "TRAINING_GENERATE_QUESTIONS" } });
    expect(JSON.parse(queued.payloadJson ?? "{}")).toMatchObject({ nonBillable: false });
    const spy = providerSpy();
    const result = await handleGenerateJob(
      { runId: requested.generationRunId },
      { fetchImpl: spy as unknown as typeof fetch, env: env({ TRAINING_MOCK_INFERENCE_ALLOWED: "true" }) },
    );
    expect(spy).not.toHaveBeenCalled();
    expect(result.status).toBe("FAILED");
    const run = await prisma.trainingQuestionAiGenerationRun.findUniqueOrThrow({ where: { id: requested.generationRunId } });
    expect(run.executionErrorCode).toBe("BILLABLE_INFERENCE_LOCKED");
    expect(await prisma.trainingQuestionAiDraft.count({ where: { generationRunId: requested.generationRunId } })).toBe(0);
  }, 60_000);

  it("transcription is refused and the provider is never called", async () => {
    const w = await world();
    const versionId = await makeVersion(w, w.manager);
    const job = await requestTranscription(w.manager, w.clubId, { courseVersionId: versionId });
    await markQueued(w.clubId, job.jobId);
    const spy = providerSpy();
    const result = await handleTranscribeJob(
      { jobId: job.jobId },
      {
        fetchImpl: spy as unknown as typeof fetch,
        env: env({ TRAINING_MOCK_INFERENCE_ALLOWED: "true" }),
        makeSignedVideoUrl: async () => "https://signed.example/v.mp4",
      },
    );
    expect(spy).not.toHaveBeenCalled();
    expect(result.status).toBe("FAILED");
    const row = await prisma.trainingTranscriptionJob.findUniqueOrThrow({ where: { id: job.jobId } });
    expect(row.failureCode).toBe("BILLABLE_INFERENCE_LOCKED");
  });
});

describe("EP-TRAIN-4Y-BF §1 + §4 — the orchestrator decides from identity, and stays automatic", () => {
  async function authorizeUpload(w: World, by: Principal, versionId: string, inferenceMode: "LIVE" | "MOCK" = "LIVE") {
    await recordProcessingAuthorization(by, { clubId: w.clubId, courseVersionId: versionId, operation: "GENERATE_FULL", source: "UPLOAD", inferenceMode });
  }

  it("test principal upload with NO mock marker → queued as non-billable", async () => {
    const w = await world();
    process.env.TRAINING_TEST_PRINCIPAL_USER_IDS = w.testPrincipal.id;
    process.env.TRAINING_MOCK_INFERENCE_ALLOWED = "true";
    const versionId = await makeVersion(w, w.testPrincipal);
    await authorizeUpload(w, w.testPrincipal, versionId, "LIVE");
    const advanced = await advancePreparation({ clubId: w.clubId, courseVersionId: versionId, trigger: "UPLOAD" });
    expect(advanced.action).toBe("TRANSCRIPTION_ENQUEUED");
    const queued = await prisma.backgroundJob.findFirstOrThrow({ where: { kind: "TRAINING_TRANSCRIBE_VIDEO" } });
    expect(JSON.parse(queued.payloadJson ?? "{}")).toMatchObject({ nonBillable: true });
  });

  it("test principal upload where simulation is not allowed → halted before anything is queued", async () => {
    const w = await world();
    process.env.TRAINING_TEST_PRINCIPAL_USER_IDS = w.testPrincipal.id;
    process.env.TRAINING_BILLABLE_INFERENCE = "enabled";
    const versionId = await makeVersion(w, w.testPrincipal);
    await authorizeUpload(w, w.testPrincipal, versionId);
    const advanced = await advancePreparation({ clubId: w.clubId, courseVersionId: versionId, trigger: "UPLOAD" });
    expect(advanced.action).toBe("HALTED");
    expect(advanced.detail).toMatch(/TEST_ISOLATION_UNAVAILABLE/);
    expect(await prisma.backgroundJob.count()).toBe(0);
    expect(await prisma.trainingTranscriptionJob.count()).toBe(0);
  });

  it("real manager upload where billable inference is not enabled → nothing queued; the worker's pass halts it", async () => {
    const w = await world();
    process.env.TRAINING_MOCK_INFERENCE_ALLOWED = "true";
    const versionId = await makeVersion(w, w.manager);
    await authorizeUpload(w, w.manager, versionId);
    // The process that received the upload dispatches nothing and
    // decides nothing: the worker owns the provider lock.
    const atUpload = await advancePreparation({ clubId: w.clubId, courseVersionId: versionId, trigger: "UPLOAD" });
    expect(atUpload.action).toBe("DEFERRED");
    expect(await prisma.backgroundJob.count()).toBe(0);
    // The worker's pass (its lock is closed too) halts — still without
    // queueing anything.
    const atWorker = await advancePreparation({ clubId: w.clubId, courseVersionId: versionId, trigger: "WATCHDOG" });
    expect(atWorker.action).toBe("HALTED");
    expect(atWorker.detail).toMatch(/BILLABLE_INFERENCE_LOCKED/);
    expect(await prisma.backgroundJob.count()).toBe(0);
    expect(await prisma.trainingTranscriptionJob.count()).toBe(0);
    expect(await prisma.trainingQuestionAiGenerationRun.count()).toBe(0);
  });

  it("real manager upload where billable inference IS enabled → starts automatically, as a billable job", async () => {
    const w = await world();
    process.env.TRAINING_BILLABLE_INFERENCE = "enabled";
    const versionId = await makeVersion(w, w.manager);
    await authorizeUpload(w, w.manager, versionId);
    const advanced = await advancePreparation({ clubId: w.clubId, courseVersionId: versionId, trigger: "UPLOAD" });
    expect(advanced.action).toBe("TRANSCRIPTION_ENQUEUED");
    const queued = await prisma.backgroundJob.findFirstOrThrow({ where: { kind: "TRAINING_TRANSCRIBE_VIDEO" } });
    expect(JSON.parse(queued.payloadJson ?? "{}")).toMatchObject({ nonBillable: false });
  });

  it("a real course never builds on a simulated transcript of the same video", async () => {
    const w = await world();
    process.env.TRAINING_BILLABLE_INFERENCE = "enabled";
    await seedTranscript(w, SHA, "SIMULATED");
    const versionId = await makeVersion(w, w.manager);
    await authorizeUpload(w, w.manager, versionId);
    const advanced = await advancePreparation({ clubId: w.clubId, courseVersionId: versionId, trigger: "UPLOAD" });
    // It asks for a real transcription instead of generating questions
    // from the simulated text.
    expect(advanced.action).toBe("TRANSCRIPTION_ENQUEUED");
    expect(await prisma.trainingQuestionAiGenerationRun.count()).toBe(0);
  });
});

describe("EP-TRAIN-4Y-BF §2 — a retryable transcription failure is really retried", () => {
  it("the queue entry is rescheduled (the handler throws) and its retry claims the same job", async () => {
    const w = await world();
    const versionId = await makeVersion(w, w.manager);
    const job = await requestTranscription(w.manager, w.clubId, { courseVersionId: versionId });
    await markQueued(w.clubId, job.jobId);
    // The provider answers 500 (a local stub; nothing leaves the process).
    const failing = vi.fn(async () => new Response("{}", { status: 500 }));
    const deps = {
      fetchImpl: failing as unknown as typeof fetch,
      env: env({ TRAINING_BILLABLE_INFERENCE: "enabled" }),
      makeSignedVideoUrl: async () => "https://signed.example/v.mp4",
    };

    // First delivery: the failure is retryable, so the job goes back to
    // QUEUED and the handler THROWS — which is what makes the queue
    // reschedule the entry instead of marking it done.
    await expect(handleTranscribeJob({ jobId: job.jobId }, deps)).rejects.toThrow(/retryable/i);
    let row = await prisma.trainingTranscriptionJob.findUniqueOrThrow({ where: { id: job.jobId } });
    expect(row.state).toBe("QUEUED");
    expect(row.attempts).toBe(1);

    // Second delivery of the SAME entry claims the same job again; with
    // its attempts used up the failure is now final.
    const second = await handleTranscribeJob({ jobId: job.jobId }, deps);
    expect(second.status).toBe("FAILED");
    row = await prisma.trainingTranscriptionJob.findUniqueOrThrow({ where: { id: job.jobId } });
    expect(row.state).toBe("FAILED");
    expect(row.attempts).toBe(2);
    expect(failing).toHaveBeenCalledTimes(2);
  });
});
