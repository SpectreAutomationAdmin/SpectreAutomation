// EP-TRAIN-6D-4Z-E — reviewer-acceptance fixture TEARDOWN.
//
// Removes every row created by `ep-train-6d4ze-reviewer-fixture.mjs`:
// synthetic courses + versions + drafts + reviews + validations +
// run + job + checkpoint + segments + build + projection + reviewer
// user + UserClubRole row.
//
// Anchored on the `4ZE-SYN-` course-code prefix + reviewer email
// prefix. Safe to re-run.
//
// Preserves authoritative audit records: TrainingQuestionAiReview
// rows that were attributed to the synthetic reviewer DO get deleted
// because the reviewer identity itself is being removed (an
// orphaned reviewerId would be a bigger problem than deleting the
// review row — and the review is tied to the synthetic draft, which
// is also going away).

import { PrismaClient } from "/app/node_modules/@prisma/client/default.js";

const prisma = new PrismaClient();
const PREFIX = "4ZE-SYN-";
const REVIEWER_EMAIL_PREFIX = "4ze-syn-reviewer-";

async function main() {
  const courses = await prisma.trainingCourse.findMany({
    where: { code: { startsWith: PREFIX } },
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

  // Delete synthetic reviewer user(s) + their UserClubRole rows
  // (UserClubRole has ON DELETE CASCADE).
  let deletedReviewers = 0, deletedUserClubRoles = 0;
  const reviewers = await prisma.user.findMany({
    where: { email: { startsWith: REVIEWER_EMAIL_PREFIX } },
    select: { id: true, email: true },
  });
  for (const r of reviewers) {
    const uDel = await prisma.userClubRole.deleteMany({ where: { userId: r.id } });
    deletedUserClubRoles += uDel.count;
    try {
      await prisma.user.delete({ where: { id: r.id } });
      deletedReviewers++;
    } catch (e) {
      console.warn("Could not delete synthetic reviewer " + r.email + ": " + e.message);
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
  console.log("  userClubRoles=" + deletedUserClubRoles);
  console.log("  syntheticReviewers=" + deletedReviewers);

  // Residue check.
  const residueCourses = await prisma.trainingCourse.count({ where: { code: { startsWith: PREFIX } } });
  const residueReviewers = await prisma.user.count({ where: { email: { startsWith: REVIEWER_EMAIL_PREFIX } } });
  const residueUCR = await prisma.userClubRole.count({
    where: { user: { email: { startsWith: REVIEWER_EMAIL_PREFIX } } },
  });
  if (residueCourses !== 0 || residueReviewers !== 0 || residueUCR !== 0) {
    console.error("RESIDUE_CHECK_FAIL: courses=" + residueCourses + " reviewers=" + residueReviewers + " ucr=" + residueUCR);
    process.exit(1);
  }
  console.log("RESIDUE_CHECK: clean (0 synthetic courses, 0 reviewers, 0 UCR)");
  console.log("CLEANUP COMPLETE");
}

main()
  .catch((err) => { console.error("FATAL:", err); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
