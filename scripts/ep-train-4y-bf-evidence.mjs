// EP-TRAIN-4Y-BF — READ-ONLY database evidence for the staging
// acceptance run. Writes nothing.
//
//   VERSION_IDS   comma-separated course-version ids to describe
//   SINCE         ISO timestamp; everything created at or after it is
//                 checked for billable provider time, across ALL clubs
//
// Usage (from the repo root):
//   B64=$(base64 -w0 scripts/ep-train-4y-bf-evidence.mjs)
//   flyctl ssh console -a spectre-staging -C "sh -c 'echo $B64 | base64 -d > /app/e.mjs \
//     && cd /app && VERSION_IDS=a,b SINCE=2026-11-15T00:00:00Z node e.mjs; rm -f e.mjs'"

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const ids = (process.env.VERSION_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const since = process.env.SINCE ? new Date(process.env.SINCE) : null;
const TEST_IDS = (process.env.TRAINING_TEST_PRINCIPAL_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

function parse(json) {
  try { return JSON.parse(json ?? "null"); } catch { return null; }
}

async function describeVersion(versionId) {
  const version = await prisma.trainingCourseVersion.findUnique({
    where: { id: versionId },
    select: { id: true, state: true, videoSha256: true, videoDurationSec: true, course: { select: { id: true, clubId: true, createdByUserId: true } } },
  });
  if (!version) return { versionId, missing: true };
  const clubId = version.course.clubId;

  const audits = await prisma.auditLog.findMany({
    where: {
      clubId,
      entityType: "TrainingCourseVersion",
      entityId: versionId,
      action: { in: ["hr.training.generation.authorize", "hr.training.test_isolation.mark", "hr.training.preparation.halted", "hr.training.preparation.completed"] },
    },
    orderBy: { createdAt: "asc" },
    select: { action: true, createdAt: true, userId: true, afterJson: true },
  });
  const authorizations = audits.filter((a) => a.action === "hr.training.generation.authorize").map((a) => {
    const after = parse(a.afterJson) ?? {};
    return { at: a.createdAt.toISOString(), byTestPrincipal: TEST_IDS.includes(a.userId ?? ""), source: after.source, inferenceMode: after.inferenceMode, mockFault: after.mockFault ?? null, mockDelayMs: after.mockDelayMs ?? null };
  });

  const jobs = await prisma.trainingTranscriptionJob.findMany({
    where: { clubId, courseVersionId: versionId },
    orderBy: { requestedAt: "asc" },
    select: { id: true, state: true, modelVariant: true, attempts: true, elapsedMsTotal: true, estimatedCostUsdMicros: true, failureCode: true, requestedAt: true, completedAt: true },
  });
  const builds = version.videoSha256
    ? await prisma.trainingTranscriptBuild.findMany({
        where: { clubId, sourceVideoSha256: version.videoSha256 },
        select: { transcriberModelName: true, _count: { select: { segments: true } } },
      })
    : [];

  const runs = await prisma.trainingQuestionAiGenerationRun.findMany({
    where: { clubId, courseVersionId: versionId },
    orderBy: { requestedAt: "asc" },
    select: { id: true, executionStatus: true, executionErrorCode: true, executionErrorMessage: true, attempts: true, inferenceMs: true, promptTokenCount: true, outputTokenCount: true, requestedAt: true, startedAt: true, completedAt: true, shortfallReasonJson: true, assessmentPlanJson: true, _count: { select: { drafts: true } } },
  });
  const groupOfHash = new Map();
  const runSummaries = runs.map((r) => {
    const shortfall = parse(r.shortfallReasonJson) ?? {};
    const plan = parse(r.assessmentPlanJson) ?? {};
    for (const d of shortfall.dedupDecisions ?? []) if (d.kept && !groupOfHash.has(d.candidateContentHash)) groupOfHash.set(d.candidateContentHash, d.group);
    const traces = (shortfall.perGroupDiagnostics ?? []).flatMap((g) => g.normalisationTrace ?? []);
    return {
      id: r.id,
      status: r.executionStatus,
      error: r.executionErrorCode,
      message: (r.executionErrorMessage ?? "").slice(0, 120) || null,
      attempts: r.attempts,
      inferenceMs: r.inferenceMs ?? 0,
      tokens: (r.promptTokenCount ?? 0) + (r.outputTokenCount ?? 0),
      requestedAt: r.requestedAt.toISOString(),
      startedAt: r.startedAt?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
      planned: {
        checkpoints: (plan.proposedCheckpointGroups ?? []).map((g) => `${g.id}@${Math.round(g.atSec)}`),
        final: plan.proposedFinalAssessment?.targetQuestionCount ?? null,
      },
      perGroup: (shortfall.perGroupDiagnostics ?? []).map((g) => `${g.group}:returned${g.proposalCountFromModal}/kept${g.persistedCount}/rejected${g.sanitizerDroppedCount}`),
      normalised: traces.filter((t) => (t.proposalTransforms ?? []).length > 0).length,
      normalisationRefused: traces.filter((t) => t.refusedForSafety).length,
      drafts: r._count.drafts,
    };
  });

  const drafts = await prisma.trainingQuestionAiDraft.findMany({
    where: { clubId, courseVersionId: versionId },
    select: { contentHash: true, state: true, draftJson: true },
  });
  let checkpointDrafts = 0;
  let finalDrafts = 0;
  let simulated = 0;
  let defectsLeft = 0;
  for (const d of drafts) {
    const group = groupOfHash.get(d.contentHash) ?? "";
    if (group.startsWith("cg-")) checkpointDrafts++;
    else if (group.startsWith("fa-") || group === "final") finalDrafts++;
    if (/MOCK INFERENCE/.test(d.draftJson)) simulated++;
    if (/according to the training material|Correct Answer:|aligns with segment/i.test(d.draftJson)) defectsLeft++;
  }

  const checkpoints = await prisma.trainingCheckpoint.findMany({
    where: { courseVersionId: versionId },
    orderBy: { atSecond: "asc" },
    select: { id: true, atSecond: true },
  });

  const runIds = runs.map((r) => r.id);
  const queue = await prisma.backgroundJob.findMany({
    where: { clubId, kind: { in: ["TRAINING_TRANSCRIBE_VIDEO", "TRAINING_GENERATE_QUESTIONS"] } },
    orderBy: { createdAt: "asc" },
    select: { kind: true, status: true, attempts: true, payloadJson: true },
  });
  const jobIds = jobs.map((j) => j.id);
  const queueEntries = queue
    .map((q) => ({ ...q, payload: parse(q.payloadJson) ?? {} }))
    .filter((q) => runIds.includes(q.payload.generationRunId) || jobIds.includes(q.payload.jobId))
    .map((q) => ({ kind: q.kind, status: q.status, attempts: q.attempts, nonBillable: q.payload.nonBillable ?? null }));

  const normalisationAudits = runIds.length
    ? await prisma.auditLog.count({ where: { action: "hr.training.generation.normalisation_applied", entityId: { in: runIds } } })
    : 0;

  return {
    versionId,
    state: version.state,
    videoDurationSec: version.videoDurationSec,
    createdByTestPrincipal: TEST_IDS.includes(version.course.createdByUserId ?? ""),
    authorizations,
    nonBillableMarkers: audits.filter((a) => a.action === "hr.training.test_isolation.mark").length,
    halts: audits.filter((a) => a.action === "hr.training.preparation.halted").map((a) => (parse(a.afterJson) ?? {}).code),
    completedRecords: audits.filter((a) => a.action === "hr.training.preparation.completed").length,
    transcriptionJobs: jobs.map((j) => ({ state: j.state, model: j.modelVariant, attempts: j.attempts, providerMs: j.elapsedMsTotal ?? 0, costMicros: j.estimatedCostUsdMicros ?? 0, failure: j.failureCode })),
    transcripts: builds.map((b) => ({ model: b.transcriberModelName, segments: b._count.segments })),
    generationRuns: runSummaries,
    liveRunsNow: runSummaries.filter((r) => ["REQUESTED", "QUEUED", "RUNNING"].includes(r.status)).length,
    drafts: { total: drafts.length, checkpoint: checkpointDrafts, final: finalDrafts, simulated, withFormattingDefects: defectsLeft },
    checkpointEvents: checkpoints.map((c) => ({ id: c.id, atSecond: c.atSecond })),
    queueEntries,
    normalisationAuditRows: normalisationAudits,
    providerMsTotal: runSummaries.reduce((sum, r) => sum + r.inferenceMs, 0) + jobs.reduce((sum, j) => sum + (j.elapsedMsTotal ?? 0), 0),
  };
}

const out = { env: { app: process.env.FLY_APP_NAME ?? null, billableInference: process.env.TRAINING_BILLABLE_INFERENCE === "enabled" ? "ENABLED" : "LOCKED", simulationAllowed: process.env.TRAINING_MOCK_INFERENCE_ALLOWED === "true", testPrincipals: TEST_IDS.length }, versions: [] };
for (const id of ids) out.versions.push(await describeVersion(id));

if (since) {
  // Across EVERY club: any provider time at all since the cut-off.
  const billableRuns = await prisma.trainingQuestionAiGenerationRun.findMany({
    where: { requestedAt: { gte: since }, inferenceMs: { gt: 0 } },
    select: { id: true, courseVersionId: true, inferenceMs: true },
  });
  const billableJobs = await prisma.trainingTranscriptionJob.findMany({
    where: { requestedAt: { gte: since }, OR: [{ elapsedMsTotal: { gt: 0 } }, { estimatedCostUsdMicros: { gt: 0 } }] },
    select: { id: true, courseVersionId: true, elapsedMsTotal: true },
  });
  out.sinceCutoff = {
    since: since.toISOString(),
    runsCreated: await prisma.trainingQuestionAiGenerationRun.count({ where: { requestedAt: { gte: since } } }),
    transcriptionJobsCreated: await prisma.trainingTranscriptionJob.count({ where: { requestedAt: { gte: since } } }),
    runsWithProviderTime: billableRuns,
    transcriptionJobsWithProviderTime: billableJobs,
    liveAuthorizationsSince: await prisma.auditLog.count({ where: { action: "hr.training.generation.authorize", createdAt: { gte: since }, afterJson: { contains: '"inferenceMode":"LIVE"' } } }),
  };
}
out.liveNow = {
  generationRuns: await prisma.trainingQuestionAiGenerationRun.count({ where: { executionStatus: { in: ["REQUESTED", "QUEUED", "RUNNING"] } } }),
  transcriptionJobs: await prisma.trainingTranscriptionJob.count({ where: { state: { in: ["REQUESTED", "QUEUED", "RUNNING"] } } }),
};
console.log("<<<JSON");
console.log(JSON.stringify(out));
console.log("JSON>>>");
await prisma.$disconnect();
