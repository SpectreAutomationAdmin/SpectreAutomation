// EP-TRAIN-2 §4 (2026-10-29) -- Employee Portal training
// recommendations rail.
//
// Pure RENDER-LAYER selection: reuses `resolveApplicableCourses`
// (which already enforces tenant isolation + publication state +
// retirement + applicability-via-assignment-or-role) and layers
// a priority ordering on top for the right-rail feed.  No new DB
// writes.  No fabricated titles, durations, or thumbnails.
//
// Priority (per founder EP-TRAIN-2 §4):
//   1. Assigned + incomplete + overdue + REQUIRED (no due-date field
//      currently exists on TrainingAssignment, so overdue folds into
//      priority 2 for now; §4 explicitly says "if insufficient
//      recommendations exist, display only available items").
//   2. Assigned + incomplete + REQUIRED.
//   3. Assigned + incomplete + OPTIONAL.
//   4. Other applicable published (not assigned) + incomplete.
//   5. Previously completed, only if useful (currently excluded by
//      default; a completed course is "useful" if a NEWER version
//      is available but we don't have a version-newer-than
//      comparator here, so category 5 stays empty for now).
//
// Current course is always excluded.

import { prisma } from "@/lib/prisma";
import {
  resolveApplicableCourses,
  type ApplicableCourse,
} from "./applicability";

export type RecommendationBucket =
  | "ASSIGNED_REQUIRED"
  | "ASSIGNED_OPTIONAL"
  | "OTHER_APPLICABLE"
  | "COMPLETED_FOR_REFERENCE";

export interface TrainingRecommendation {
  courseId: string;
  versionId: string;
  title: string;
  category: string;
  required: boolean;
  completed: boolean;
  completedAt: Date | null;
  progressPercent: number;
  videoDurationSec: number | null;
  bucket: RecommendationBucket;
  href: string;
}

export interface RecommendationsResult {
  recommendations: TrainingRecommendation[];
  truncated: boolean;
}

export async function getEmployeeTrainingRecommendations(args: {
  employeeId: string;
  excludeVersionId: string;
  limit?: number;
}): Promise<RecommendationsResult> {
  const limit = Math.max(1, Math.min(10, args.limit ?? 6));

  const applicable = await resolveApplicableCourses(args.employeeId);
  const filtered = applicable.filter((c) => c.version.id !== args.excludeVersionId);

  if (filtered.length === 0) {
    return { recommendations: [], truncated: false };
  }

  // Pull progress + completion state for all applicable version ids in one shot.
  const versionIds = filtered.map((c) => c.version.id);
  const [progressRows, completionRows] = await Promise.all([
    prisma.trainingProgress.findMany({
      where: { employeeId: args.employeeId, courseVersionId: { in: versionIds } },
      select: { courseVersionId: true, percentComplete: true },
    }),
    prisma.trainingCompletion.findMany({
      where: { employeeId: args.employeeId, courseVersionId: { in: versionIds } },
      select: { courseVersionId: true, completedAt: true },
    }),
  ]);

  const progressBy = new Map(progressRows.map((p) => [p.courseVersionId, p.percentComplete]));
  const completionBy = new Map(completionRows.map((c) => [c.courseVersionId, c.completedAt]));

  const toRec = (c: ApplicableCourse, bucket: RecommendationBucket): TrainingRecommendation => ({
    courseId: c.courseId,
    versionId: c.version.id,
    title: c.title,
    category: c.category,
    required: c.version.required,
    completed: completionBy.has(c.version.id),
    completedAt: completionBy.get(c.version.id) ?? null,
    progressPercent: progressBy.get(c.version.id) ?? 0,
    videoDurationSec: c.version.videoDurationSec,
    bucket,
    href: `/employee/safety-training/${c.version.id}`,
  });

  const assignedRequired: TrainingRecommendation[] = [];
  const assignedOptional: TrainingRecommendation[] = [];
  const otherApplicable: TrainingRecommendation[] = [];
  const completedForReference: TrainingRecommendation[] = [];

  for (const c of filtered) {
    const completed = completionBy.has(c.version.id);
    const assigned = c.reason === "assigned";
    if (completed) {
      completedForReference.push(toRec(c, "COMPLETED_FOR_REFERENCE"));
      continue;
    }
    if (assigned && c.version.required) {
      assignedRequired.push(toRec(c, "ASSIGNED_REQUIRED"));
      continue;
    }
    if (assigned && !c.version.required) {
      assignedOptional.push(toRec(c, "ASSIGNED_OPTIONAL"));
      continue;
    }
    otherApplicable.push(toRec(c, "OTHER_APPLICABLE"));
  }

  // Secondary ordering within each bucket: in-progress (percent > 0) first,
  // then by title (stable, alpha).
  const sortBucket = (b: TrainingRecommendation[]): TrainingRecommendation[] =>
    [...b].sort((a, z) => {
      const aStarted = a.progressPercent > 0 && a.progressPercent < 100;
      const zStarted = z.progressPercent > 0 && z.progressPercent < 100;
      if (aStarted !== zStarted) return aStarted ? -1 : 1;
      return a.title.localeCompare(z.title);
    });

  // Priority 5 (completed for reference) stays empty by default --
  // see service header comment.  Preserved as a slot for a future
  // "newer version available" surfacing without changing the service
  // shape.
  void completedForReference;

  const flat = [
    ...sortBucket(assignedRequired),
    ...sortBucket(assignedOptional),
    ...sortBucket(otherApplicable),
  ];
  const truncated = flat.length > limit;
  return { recommendations: flat.slice(0, limit), truncated };
}

/** Pure helper used by the employee-facing render layer to strip
 *  staging-fixture copy from course text that happens to leak
 *  internal acceptance instructions.  Does NOT modify the DB. */
const STAGING_PREFIXES = [
  /^founder[\s-]+acceptance[\s-]+walk/i,
  /^staging[\s-]+acceptance/i,
  /^test[\s-]+only:?[\s-]+/i,
  /^fixture:?[\s-]+/i,
];
export function isLikelyStagingFixtureText(text: string | null | undefined): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  return STAGING_PREFIXES.some((rx) => rx.test(trimmed));
}
