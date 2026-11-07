// EP-TRAIN-6D-4Z — synthetic workflow fixture TEARDOWN.
//
// Deletes every row created by `ep-train-6d4z-synthetic-fixture.mjs`.
// Safe to re-run — anchored on the `4Z-SYN-` prefix.
//
// Usage on staging:
//   flyctl ssh console -a spectre-staging -C \
//     "sh -c 'cat > /tmp/cleanup.mjs && node /tmp/cleanup.mjs'" < scripts/ep-train-6d4z-synthetic-cleanup.mjs

import { PrismaClient } from "/app/node_modules/@prisma/client/default.js";

const prisma = new PrismaClient();
const PREFIX = "4Z-SYN-";

async function main() {
  const courses = await prisma.trainingCourse.findMany({
    where: { code: { startsWith: PREFIX } },
    select: { id: true, clubId: true, code: true },
  });
  console.log("COURSES TO DELETE:", courses.length);

  let deletedDrafts = 0, deletedRuns = 0, deletedTranscriptions = 0, deletedCheckpoints = 0, deletedSegments = 0, deletedBuilds = 0, deletedProjections = 0, deletedCourses = 0, deletedVersions = 0;

  for (const course of courses) {
    const versions = await prisma.trainingCourseVersion.findMany({
      where: { courseId: course.id },
      select: { id: true, videoSha256: true },
    });

    for (const v of versions) {
      // Promotions (if any created during the workflow).
      const promotions = await prisma.trainingQuestionAiDraftPromotion.findMany({
        where: {
          draft: { courseVersionId: v.id, clubId: course.clubId },
        },
        select: { id: true, draftId: true, questionId: true },
      });

      // Questions created by promotion.
      for (const p of promotions) {
        await prisma.trainingAnswerOption.deleteMany({
          where: { questionId: p.questionId },
        });
        await prisma.trainingQuestion.deleteMany({ where: { id: p.questionId } });
        await prisma.trainingQuestionAiDraftPromotion.delete({ where: { id: p.id } });
      }

      // AI review + validation + state transitions + operation keys per draft.
      const drafts = await prisma.trainingQuestionAiDraft.findMany({
        where: { courseVersionId: v.id, clubId: course.clubId },
        select: { id: true },
      });
      for (const d of drafts) {
        await prisma.trainingQuestionAiStateTransition.deleteMany({
          where: { draftId: d.id },
        });
        await prisma.trainingQuestionAiOperationKey.deleteMany({
          where: { draftId: d.id },
        });
        await prisma.trainingQuestionAiReview.deleteMany({
          where: { draftId: d.id },
        });
        await prisma.trainingQuestionAiValidation.deleteMany({
          where: { draftId: d.id },
        });
      }

      const draftDel = await prisma.trainingQuestionAiDraft.deleteMany({
        where: { courseVersionId: v.id, clubId: course.clubId },
      });
      deletedDrafts += draftDel.count;

      const runDel = await prisma.trainingQuestionAiGenerationRun.deleteMany({
        where: { courseVersionId: v.id, clubId: course.clubId },
      });
      deletedRuns += runDel.count;

      const tDel = await prisma.trainingTranscriptionJob.deleteMany({
        where: { courseVersionId: v.id, clubId: course.clubId },
      });
      deletedTranscriptions += tDel.count;

      const cpDel = await prisma.trainingCheckpoint.deleteMany({
        where: { courseVersionId: v.id },
      });
      deletedCheckpoints += cpDel.count;

      // Delete transcript segments + build + projection tied to this
      // synthetic video sha (safe: the sha is synthetic).
      if (v.videoSha256) {
        const builds = await prisma.trainingTranscriptBuild.findMany({
          where: { clubId: course.clubId, sourceVideoSha256: v.videoSha256 },
          select: { id: true },
        });
        for (const b of builds) {
          const segDel = await prisma.trainingTranscriptSegment.deleteMany({
            where: { transcriptBuildId: b.id },
          });
          deletedSegments += segDel.count;
        }
        const bDel = await prisma.trainingTranscriptBuild.deleteMany({
          where: { clubId: course.clubId, sourceVideoSha256: v.videoSha256 },
        });
        deletedBuilds += bDel.count;
        const pDel = await prisma.trainingGroundingProjection.deleteMany({
          where: { clubId: course.clubId, sourceVideoSha256: v.videoSha256 },
        });
        deletedProjections += pDel.count;
      }
    }

    const vDel = await prisma.trainingCourseVersion.deleteMany({
      where: { courseId: course.id },
    });
    deletedVersions += vDel.count;

    const cDel = await prisma.trainingCourse.deleteMany({ where: { id: course.id } });
    deletedCourses += cDel.count;
  }

  console.log("DELETED:");
  console.log("  courses=" + deletedCourses);
  console.log("  versions=" + deletedVersions);
  console.log("  drafts=" + deletedDrafts);
  console.log("  runs=" + deletedRuns);
  console.log("  transcriptionJobs=" + deletedTranscriptions);
  console.log("  checkpoints=" + deletedCheckpoints);
  console.log("  segments=" + deletedSegments);
  console.log("  builds=" + deletedBuilds);
  console.log("  projections=" + deletedProjections);
  console.log("\nCLEANUP COMPLETE");

  // Confirm no residue.
  const residue = await prisma.trainingCourse.count({
    where: { code: { startsWith: PREFIX } },
  });
  if (residue !== 0) {
    console.error("RESIDUE_CHECK_FAIL: still have", residue, "synthetic courses");
    process.exit(1);
  }
  console.log("RESIDUE_CHECK: clean (0 synthetic courses remain)");
}

main()
  .catch((err) => { console.error("FATAL:", err); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
