// EP-TRAIN-4Y-BE — one-time administrative recovery for a course that
// was uploaded BEFORE automatic preparation existed (so nothing ever
// authorized its pipeline).
//
// It writes exactly one AuditLog row — the same authorization a video
// upload writes today, with source ADMIN_RECOVERY, attributed to the
// manager who uploaded the video. The worker watchdog then prepares the
// course automatically from the last completed stage (the existing
// video and transcript are reused). Nothing else is modified.
//
// EP-TRAIN-4Y-BF — MODE=LIVE additionally needs the environment to have
// billable inference enabled (TRAINING_BILLABLE_INFERENCE=enabled on
// BOTH the web app and the worker). Staging keeps it locked, so a LIVE
// recovery written while locked simply halts ("billable inference is not
// enabled") without contacting any provider: enable it first, and only
// for a founder-authorized run; remove it again afterwards.
//
// Operator tool. Run inside the staging web container:
//   VERSION_ID=<id> MODE=LIVE|MOCK node scripts/ep-train-4y-be-admin-recover.mjs
// Dry run by default. To write:
//   CONFIRM=write
//   MODE=LIVE additionally requires LIVE_AUTHORIZED_BY="<who approved real processing>"
//   MODE=MOCK additionally requires MOCK_TEST_VERSION=yes (mock is sticky:
//   a version recovered in MOCK can never run real processing afterwards)

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const versionId = process.env.VERSION_ID ?? "";
const mode = process.env.MODE ?? "";
const write = process.env.CONFIRM === "write";

function fail(message) {
  console.error(`REFUSED: ${message}`);
  process.exitCode = 2;
}

async function main() {
  if (!versionId) return fail("VERSION_ID is required.");
  if (mode !== "LIVE" && mode !== "MOCK") return fail("MODE must be LIVE or MOCK.");
  if (write && mode === "LIVE" && !process.env.LIVE_AUTHORIZED_BY) {
    return fail("MODE=LIVE needs LIVE_AUTHORIZED_BY (who approved real processing).");
  }
  if (write && mode === "MOCK" && process.env.MOCK_TEST_VERSION !== "yes") {
    return fail("MODE=MOCK needs MOCK_TEST_VERSION=yes (never use MOCK on a real course).");
  }

  const version = await prisma.trainingCourseVersion.findUnique({
    where: { id: versionId },
    select: {
      id: true, state: true, videoSha256: true, videoDurationSec: true,
      course: { select: { id: true, clubId: true, code: true } },
    },
  });
  if (!version) return fail("Version not found.");
  if (version.state !== "DRAFT") return fail(`Version is ${version.state}, not DRAFT.`);
  if (!version.videoSha256) return fail("Version has no uploaded video.");
  const clubId = version.course.clubId;

  const upload = await prisma.auditLog.findFirst({
    where: { clubId, action: "hr.training.video.upload", entityId: versionId },
    orderBy: { createdAt: "desc" },
    select: { userId: true, createdAt: true },
  });
  if (!upload?.userId) return fail("Cannot identify the manager who uploaded the video.");

  const priorAuth = await prisma.auditLog.findMany({
    where: { clubId, action: "hr.training.generation.authorize", entityId: versionId },
    select: { afterJson: true },
  });
  if (mode === "LIVE" && priorAuth.some((a) => (a.afterJson ?? "").includes('"inferenceMode":"MOCK"'))) {
    return fail("This version was authorized for MOCK before; it can never run real processing.");
  }

  const build = await prisma.trainingTranscriptBuild.findFirst({
    where: { clubId, sourceVideoSha256: version.videoSha256 },
    select: { id: true },
  });
  const runs = await prisma.trainingQuestionAiGenerationRun.groupBy({
    by: ["executionStatus"],
    where: { clubId, courseVersionId: versionId },
    _count: { _all: true },
  });
  const drafts = await prisma.trainingQuestionAiDraft.count({ where: { clubId, courseVersionId: versionId } });

  console.log(JSON.stringify({
    versionId,
    courseCode: version.course.code,
    clubId,
    videoDurationSec: version.videoDurationSec,
    transcriptAvailable: !!build,
    uploadedByUserId: upload.userId,
    uploadedAt: upload.createdAt,
    existingRuns: Object.fromEntries(runs.map((r) => [r.executionStatus, r._count._all])),
    existingDrafts: drafts,
    mode,
    willWrite: write,
  }, null, 2));

  if (!write) {
    console.log("DRY RUN — nothing written. Set CONFIRM=write to authorize recovery.");
    return;
  }

  const row = await prisma.auditLog.create({
    data: {
      clubId,
      userId: upload.userId,
      action: "hr.training.generation.authorize",
      entityType: "TrainingCourseVersion",
      entityId: versionId,
      afterJson: JSON.stringify({
        operation: "GENERATE_FULL",
        authorizedAt: new Date().toISOString(),
        source: "ADMIN_RECOVERY",
        inferenceMode: mode,
        ...(mode === "MOCK" ? { mockDelayMs: 0, mockFault: "NONE" } : {}),
        operator: "spectre-operator",
        liveAuthorizedBy: mode === "LIVE" ? process.env.LIVE_AUTHORIZED_BY : null,
        reference: "EP-TRAIN-4Y-BE one-time administrative recovery",
      }),
    },
    select: { id: true, createdAt: true },
  });
  console.log(`WRITTEN authorization ${row.id} at ${row.createdAt.toISOString()}.`);
  console.log("The worker watchdog will resume this course automatically within about 30 seconds.");
}

main()
  .catch((err) => { console.error("FATAL:", err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
