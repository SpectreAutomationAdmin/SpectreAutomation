// EP-TRAIN-6D-4Z-F — two-role workflow-acceptance fixture TEARDOWN.
//
// Removes everything created by ep-train-6d4zf-workflow-fixture.mjs,
// including any TrainingQuestion rows the admin promoted via UI.
// Also removes both synthetic users (reviewer + admin) and their
// UserClubRole grants.
//
// Prefix-anchored (`4ZF-SYN-` course codes + `4zf-syn-` user emails).

import { PrismaClient } from "/app/node_modules/@prisma/client/default.js";

const prisma = new PrismaClient();
const COURSE_PREFIX = "4ZF-SYN-";
const USER_EMAIL_PREFIX = "4zf-syn-";

async function main() {
  const courses = await prisma.trainingCourse.findMany({
    where: { code: { startsWith: COURSE_PREFIX } },
    select: { id: true, clubId: true, code: true },
  });
  console.log("COURSES TO DELETE:", courses.length);

  let deletedQuestions = 0, deletedAnswerOptions = 0, deletedPromotions = 0;
  let deletedDrafts = 0, deletedRuns = 0, deletedTranscriptions = 0;
  let deletedCheckpoints = 0, deletedSegments = 0, deletedBuilds = 0;
  let deletedProjections = 0, deletedCourses = 0, deletedVersions = 0;

  for (const course of courses) {
    const versions = await prisma.trainingCourseVersion.findMany({
      where: { courseId: course.id },
      select: { id: true, videoSha256: true },
    });
    for (const v of versions) {
      const promotions = await prisma.trainingQuestionAiDraftPromotion.findMany({
        where: { draft: { courseVersionId: v.id, clubId: course.clubId } },
        select: { id: true, questionId: true },
      });
      for (const p of promotions) {
        await prisma.trainingQuestionAiDraftPromotion.delete({ where: { id: p.id } });
        deletedPromotions++;
        const opts = await prisma.trainingAnswerOption.deleteMany({ where: { questionId: p.questionId } });
        deletedAnswerOptions += opts.count;
        const q = await prisma.trainingQuestion.deleteMany({ where: { id: p.questionId } });
        deletedQuestions += q.count;
      }

      const drafts = await prisma.trainingQuestionAiDraft.findMany({
        where: { courseVersionId: v.id, clubId: course.clubId },
        select: { id: true },
      });
      for (const d of drafts) {
        await prisma.trainingQuestionAiStateTransition.deleteMany({ where: { draftId: d.id } });
        await prisma.trainingQuestionAiOperationKey.deleteMany({ where: { draftId: d.id } });
        await prisma.trainingQuestionAiReview.deleteMany({ where: { draftId: d.id } });
        await prisma.trainingQuestionAiValidation.deleteMany({ where: { draftId: d.id } });
      }
      const dDel = await prisma.trainingQuestionAiDraft.deleteMany({
        where: { courseVersionId: v.id, clubId: course.clubId },
      });
      deletedDrafts += dDel.count;

      const rDel = await prisma.trainingQuestionAiGenerationRun.deleteMany({
        where: { courseVersionId: v.id, clubId: course.clubId },
      });
      deletedRuns += rDel.count;

      const tDel = await prisma.trainingTranscriptionJob.deleteMany({
        where: { courseVersionId: v.id, clubId: course.clubId },
      });
      deletedTranscriptions += tDel.count;

      const cpDel = await prisma.trainingCheckpoint.deleteMany({
        where: { courseVersionId: v.id },
      });
      deletedCheckpoints += cpDel.count;

      if (v.videoSha256) {
        const builds = await prisma.trainingTranscriptBuild.findMany({
          where: { clubId: course.clubId, sourceVideoSha256: v.videoSha256 },
          select: { id: true },
        });
        for (const b of builds) {
          const sDel = await prisma.trainingTranscriptSegment.deleteMany({ where: { transcriptBuildId: b.id } });
          deletedSegments += sDel.count;
        }
        const bDel = await prisma.trainingTranscriptBuild.deleteMany({
          where: { clubId: course.clubId, sourceVideoSha256: v.videoSha256 },
        });
        deletedBuilds += bDel.count;
        const pDel = await prisma.trainingGroundingProjection.deleteMany({
          where: { clubId: course.clubId, courseVersionId: v.id },
        });
        deletedProjections += pDel.count;
      }
    }
    const vDel = await prisma.trainingCourseVersion.deleteMany({ where: { courseId: course.id } });
    deletedVersions += vDel.count;
    const cDel = await prisma.trainingCourse.deleteMany({ where: { id: course.id } });
    deletedCourses += cDel.count;
  }

  // Delete synthetic users (reviewer + admin) + UserClubRole grants.
  let deletedUsers = 0, deletedUCR = 0;
  const users = await prisma.user.findMany({
    where: { email: { startsWith: USER_EMAIL_PREFIX } },
    select: { id: true, email: true },
  });
  for (const u of users) {
    const uDel = await prisma.userClubRole.deleteMany({ where: { userId: u.id } });
    deletedUCR += uDel.count;
    try {
      await prisma.user.delete({ where: { id: u.id } });
      deletedUsers++;
    } catch (e) {
      console.warn("Could not delete synthetic user " + u.email + ": " + e.message);
    }
  }

  console.log("DELETED:");
  console.log("  courses=" + deletedCourses);
  console.log("  versions=" + deletedVersions);
  console.log("  questions=" + deletedQuestions);
  console.log("  answerOptions=" + deletedAnswerOptions);
  console.log("  promotions=" + deletedPromotions);
  console.log("  drafts=" + deletedDrafts);
  console.log("  runs=" + deletedRuns);
  console.log("  transcriptionJobs=" + deletedTranscriptions);
  console.log("  checkpoints=" + deletedCheckpoints);
  console.log("  segments=" + deletedSegments);
  console.log("  builds=" + deletedBuilds);
  console.log("  projections=" + deletedProjections);
  console.log("  userClubRoles=" + deletedUCR);
  console.log("  syntheticUsers=" + deletedUsers);

  const residueCourses = await prisma.trainingCourse.count({ where: { code: { startsWith: COURSE_PREFIX } } });
  const residueUsers = await prisma.user.count({ where: { email: { startsWith: USER_EMAIL_PREFIX } } });
  const residueUCR = await prisma.userClubRole.count({
    where: { user: { email: { startsWith: USER_EMAIL_PREFIX } } },
  });
  if (residueCourses !== 0 || residueUsers !== 0 || residueUCR !== 0) {
    console.error("RESIDUE_CHECK_FAIL: courses=" + residueCourses + " users=" + residueUsers + " ucr=" + residueUCR);
    process.exit(1);
  }
  console.log("RESIDUE_CHECK: clean (0 synthetic courses, 0 users, 0 UCR)");
  console.log("CLEANUP COMPLETE");
}

main()
  .catch((err) => { console.error("FATAL:", err); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
