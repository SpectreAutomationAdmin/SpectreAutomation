// HR-2C §27, §42 (2026-08-20) — Employee-safe training reads.
//
// Every field an EmployeePortalPrincipal can see is projected here
// with `isCorrect` STRIPPED from every answer option. If a future
// column exposes correctness or scoring keys, add it to the exclusion
// list.
//
// Discipline: no `select: { isCorrect: true }` anywhere in this file.
// No consumer of this file should ever join back through prisma to
// look up isCorrect.

import { prisma } from "../../prisma";
import { NotFoundError } from "../../errors";
import type { EmployeePortalPrincipal } from "../../employee-portal-session";

export interface EmployeeCourseView {
  courseId: string;
  code: string;
  title: string;
  category: string;
  description: string | null;
  version: {
    id: string;
    version: number;
    passingScore: number;
    retakesAllowed: boolean;
    requiresKnowledgeTest: boolean;
    hasVideo: boolean;
    videoDurationSec: number | null;
  };
  questions: Array<{
    id: string;
    prompt: string;
    // Options WITHOUT any isCorrect flag.
    options: Array<{ id: string; text: string; displayOrder: number }>;
  }>;
}

/**
 * Employee-safe view of a PUBLISHED course. Refuses if the version
 * isn't published, retired, or doesn't belong to the actor's Club.
 * Never returns `isCorrect` on any option (§27).
 */
export async function getEmployeeCourseView(
  actor: EmployeePortalPrincipal,
  courseVersionId: string,
): Promise<EmployeeCourseView> {
  const v = await prisma.trainingCourseVersion.findFirst({
    where: {
      id: courseVersionId,
      state: "PUBLISHED",
      course: { clubId: actor.clubId, retiredAt: null },
    },
    select: {
      id: true,
      version: true,
      passingScore: true,
      retakesAllowed: true,
      requiresKnowledgeTest: true,
      videoStorageKey: true,
      videoDurationSec: true,
      course: { select: { id: true, code: true, title: true, category: true, description: true } },
      questions: {
        where: { active: true },
        orderBy: { displayOrder: "asc" },
        select: {
          id: true,
          prompt: true,
          options: {
            orderBy: { displayOrder: "asc" },
            select: { id: true, text: true, displayOrder: true },
          },
        },
      },
    },
  });
  if (!v) throw new NotFoundError("TrainingCourseVersion", courseVersionId);
  return {
    courseId: v.course.id,
    code: v.course.code,
    title: v.course.title,
    category: v.course.category,
    description: v.course.description,
    version: {
      id: v.id,
      version: v.version,
      passingScore: v.passingScore,
      retakesAllowed: v.retakesAllowed,
      requiresKnowledgeTest: v.requiresKnowledgeTest,
      hasVideo: !!v.videoStorageKey,
      videoDurationSec: v.videoDurationSec,
    },
    questions: v.questions,
  };
}

/** Employee attempt history for a version (for the "Results" panel). */
export async function getEmployeeAttemptHistory(
  actor: EmployeePortalPrincipal,
  courseVersionId: string,
): Promise<Array<{ id: string; attemptNumber: number; score: number; passed: boolean; submittedAt: Date | null }>> {
  return prisma.trainingAttempt.findMany({
    where: { employeeId: actor.employeeId, courseVersionId, clubId: actor.clubId },
    orderBy: { attemptNumber: "desc" },
    select: { id: true, attemptNumber: true, score: true, passed: true, submittedAt: true },
  });
}
