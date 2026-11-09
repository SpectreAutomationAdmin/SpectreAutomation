// EP-TRAIN-4Y-U §2 — diagnostic chain tracer for a specific course.
//
// Reports (in order):
//   1. Course + Version (tenant, title, code, state, video fields)
//   2. ProvisionalGuard — is the course still at AUTO-DRAFT placeholders?
//   3. TranscriptionJob (state, error, requested/completed)
//   4. TranscriptBuild (whether it landed in the DB)
//   5. AssessmentPlan (whether the plan was synthesised + its segment coverage)
//   6. TrainingQuestionAiGenerationRun (state, attempts, error)
//   7. TrainingQuestionAiDraft rows (per-state counts + a sample)
//   8. TrainingGroundingProjection (if any)
//   9. TrainingQuestion rows (promoted) + Checkpoints
//  10. CoursePrepProgress-visible state (what the manager's /review would load)
//
// Read-only. Never writes. Never copies data between courses.
import { PrismaClient } from "/app/node_modules/@prisma/client/default.js";
const p = new PrismaClient();
const COURSE_ID = process.argv[2] || "cmw8n6z8f0008z4nxck6uvms9";
const VERSION_ID = process.argv[3] || "cmw8n6z9a000az4nx56vwh02f";

function hdr(n) { console.log(`\n═══ ${n} ═══`); }
function j(o) { return JSON.stringify(o, null, 2); }

try {
  hdr("1. Course + Version");
  const version = await p.trainingCourseVersion.findUnique({
    where: { id: VERSION_ID },
    include: {
      course: {
        select: {
          id: true, clubId: true, code: true, title: true, description: true,
          category: true, createdAt: true, createdByUserId: true,
        },
      },
    },
  });
  if (!version) {
    console.log("VERSION_NOT_FOUND");
    process.exit(1);
  }
  console.log(j({
    courseId: version.course.id,
    expectedCourseId: COURSE_ID,
    courseIdMatches: version.course.id === COURSE_ID,
    clubId: version.course.clubId,
    courseCode: version.course.code,
    courseTitle: version.course.title,
    courseDescription: version.course.description,
    versionId: version.id,
    versionNumber: version.version,
    state: version.state,
    videoSha256: version.videoSha256,
    videoStorageKey: version.videoStorageKey,
    videoMimeType: version.videoMimeType,
    videoSizeBytes: version.videoSizeBytes ? String(version.videoSizeBytes) : null,
    videoDurationSec: version.videoDurationSec,
    passingScore: version.passingScore,
    appliesToAll: version.appliesToAll,
    required: version.required,
    courseCreatedAt: version.course.createdAt,
    versionCreatedAt: version.createdAt,
    versionUpdatedAt: version.updatedAt,
  }));

  hdr("2. ProvisionalGuard");
  const PROVISIONAL_TITLE = "Untitled training course";
  const PROVISIONAL_CODE_PREFIX = "AUTO-DRAFT";
  const isProvisional =
    version.course.title === PROVISIONAL_TITLE &&
    version.course.code.startsWith(PROVISIONAL_CODE_PREFIX);
  console.log(j({
    isProvisional,
    titleMatchesProvisional: version.course.title === PROVISIONAL_TITLE,
    codeStartsWithPrefix: version.course.code.startsWith(PROVISIONAL_CODE_PREFIX),
  }));

  hdr("3. TranscriptionJob");
  const jobs = await p.trainingTranscriptionJob.findMany({
    where: { clubId: version.course.clubId, courseVersionId: VERSION_ID },
    orderBy: { requestedAt: "desc" },
  });
  console.log(`Found ${jobs.length} transcription job(s)`);
  for (const job of jobs.slice(0, 3)) {
    console.log(j({
      id: job.id,
      state: job.state,
      sourceVideoSha256: job.sourceVideoSha256,
      requestedAt: job.requestedAt,
      queuedAt: job.queuedAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      attempts: job.attempts,
      lastError: job.lastError?.slice(0, 200) ?? null,
    }));
  }

  hdr("4. TranscriptBuild");
  if (version.videoSha256) {
    const builds = await p.trainingTranscriptBuild.findMany({
      where: { clubId: version.course.clubId, sourceVideoSha256: version.videoSha256 },
      orderBy: { producedAt: "desc" },
      take: 3,
    });
    console.log(`Found ${builds.length} transcript build(s) for this video`);
    for (const b of builds) {
      const segCount = await p.trainingTranscriptSegment.count({
        where: { transcriptBuildId: b.id },
      });
      console.log(j({
        id: b.id,
        producedAt: b.producedAt,
        segmentCount: segCount,
      }));
    }
  } else {
    console.log("NO_VIDEO_SHA256_ON_VERSION — transcription cannot have run");
  }

  hdr("5. AssessmentPlan");
  // Assessment plans are embedded on generation runs — no separate table.
  // Skip to section 6.
  console.log("(embedded on TrainingQuestionAiGenerationRun.assessmentPlanJson)");

  hdr("6. TrainingQuestionAiGenerationRun");
  const runs = await p.trainingQuestionAiGenerationRun.findMany({
    where: { clubId: version.course.clubId, courseVersionId: VERSION_ID },
    orderBy: { requestedAt: "desc" },
  });
  console.log(`Found ${runs.length} AI generation run(s)`);
  for (const run of runs.slice(0, 3)) {
    console.log(j({
      id: run.id,
      executionStatus: run.executionStatus,
      sourceVideoSha256: run.sourceVideoSha256,
      requestedAt: run.requestedAt,
      queuedAt: run.queuedAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      attempts: run.attempts,
      hasPlan: !!run.assessmentPlanJson,
      planFirst200: run.assessmentPlanJson?.slice(0, 200) ?? null,
    }));
  }

  hdr("7. TrainingQuestionAiDraft rows");
  const drafts = await p.trainingQuestionAiDraft.findMany({
    where: { clubId: version.course.clubId, courseVersionId: VERSION_ID },
  });
  const byState = {};
  for (const d of drafts) byState[d.state] = (byState[d.state] || 0) + 1;
  console.log(`Found ${drafts.length} draft(s). By state: ${j(byState)}`);
  for (const d of drafts.slice(0, 2)) {
    let body = {};
    try { body = JSON.parse(d.draftJson || "{}"); } catch {}
    console.log(j({
      id: d.id,
      state: d.state,
      generationRunId: d.generationRunId,
      groundingProjectionId: d.groundingProjectionId,
      promotedQuestionId: d.promotion?.questionId ?? null,
      questionTextFirst80: String(body.questionText ?? "").slice(0, 80),
      sourceSegmentIds: body.sourceSegmentIds ?? null,
    }));
  }

  hdr("8. TrainingGroundingProjection");
  const projs = await p.trainingGroundingProjection.findMany({
    where: { clubId: version.course.clubId, courseVersionId: VERSION_ID },
    take: 3,
    orderBy: { authoredAt: "desc" },
  });
  console.log(`Found ${projs.length} projection(s)`);
  for (const pr of projs) {
    console.log(j({
      id: pr.id,
      sha256First12: pr.sha256.slice(0, 12),
      sourceVideoSha256: pr.sourceVideoSha256,
      authoredAt: pr.authoredAt,
    }));
  }

  hdr("9. TrainingQuestion + Checkpoints");
  const questions = await p.trainingQuestion.count({
    where: { courseVersionId: VERSION_ID },
  });
  const checkpointQs = await p.trainingQuestion.count({
    where: { courseVersionId: VERSION_ID, NOT: { checkpointId: null } },
  });
  const finalQs = questions - checkpointQs;
  const checkpoints = await p.trainingCheckpoint.count({
    where: { courseVersionId: VERSION_ID },
  });
  console.log(j({
    totalQuestions: questions,
    checkpointQuestions: checkpointQs,
    finalAssessmentQuestions: finalQs,
    checkpoints,
  }));

  hdr("10. Review-page state summary");
  console.log(j({
    videoPresent: !!version.videoSha256,
    transcriptJobsCount: jobs.length,
    latestTranscriptJobState: jobs[0]?.state ?? null,
    transcriptBuildsCount: version.videoSha256
      ? (await p.trainingTranscriptBuild.count({
          where: { clubId: version.course.clubId, sourceVideoSha256: version.videoSha256 },
        }))
      : 0,
    generationRunsCount: runs.length,
    latestGenerationRunState: runs[0]?.executionStatus ?? null,
    draftsCount: drafts.length,
    checkpointsCount: checkpoints,
    finalAssessmentQuestionsCount: finalQs,
    isProvisional,
  }));
} finally {
  await p.$disconnect();
}
