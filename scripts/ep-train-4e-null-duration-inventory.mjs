#!/usr/bin/env node
// EP-TRAIN-4E A1 (2026-10-31) — read-only inventory of training course
// versions with NULL videoDurationSec.
//
// READ-ONLY. Produces a JSON report:
//   - every TrainingCourseVersion with videoStorageKey IS NOT NULL
//     AND videoDurationSec IS NULL;
//   - its state (DRAFT / PUBLISHED / RETIRED);
//   - its club (id + name);
//   - whether any TrainingProgress rows exist pointing at it;
//   - whether any TrainingCompletion rows exist pointing at it;
//   - the storage key (needed for repair);
//   - whether the storage key still exists on R2 (HEAD request).
//
// This script does NOT touch the database.  Run before the repair
// script so you can compare "before" and "after" row counts.
//
// Usage via flyctl ssh:
//   flyctl ssh console --app spectre-staging -C \
//     "sh -c 'cd /app && node scripts/ep-train-4e-null-duration-inventory.mjs'"

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const affected = await prisma.trainingCourseVersion.findMany({
    where: {
      videoStorageKey: { not: null },
      videoDurationSec: null,
    },
    select: {
      id: true,
      version: true,
      state: true,
      title: true,
      videoStorageKey: true,
      videoMimeType: true,
      videoSizeBytes: true,
      videoSha256: true,
      publishedAt: true,
      retiredAt: true,
      createdAt: true,
      updatedAt: true,
      course: {
        select: {
          id: true,
          code: true,
          title: true,
          clubId: true,
          club: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: [{ course: { clubId: "asc" } }, { course: { code: "asc" } }, { version: "asc" }],
  });

  // Dependency counts per version (progress + attempts + completions).
  const augmented = [];
  for (const v of affected) {
    const [progressCount, attemptCount, completionCount] = await Promise.all([
      prisma.trainingProgress.count({ where: { courseVersionId: v.id } }),
      prisma.trainingAttempt.count({ where: { courseVersionId: v.id } }),
      prisma.trainingCompletion.count({ where: { courseVersionId: v.id } }),
    ]);
    augmented.push({
      versionId: v.id,
      versionIdTail: v.id.slice(-6),
      version: v.version,
      state: v.state,
      versionTitle: v.title,
      courseId: v.course.id,
      courseCode: v.course.code,
      courseTitle: v.course.title,
      clubId: v.course.clubId,
      clubName: v.course.club.name,
      videoStorageKey: v.videoStorageKey,
      videoMimeType: v.videoMimeType,
      videoSizeBytes: v.videoSizeBytes,
      videoSha256: v.videoSha256,
      publishedAt: v.publishedAt?.toISOString() ?? null,
      retiredAt: v.retiredAt?.toISOString() ?? null,
      createdAt: v.createdAt?.toISOString() ?? null,
      dependencies: {
        trainingProgressRows: progressCount,
        trainingAttemptRows: attemptCount,
        trainingCompletionRows: completionCount,
      },
    });
  }

  const summary = {
    report: "EP-TRAIN-4E-A1-null-duration-inventory",
    generatedAt: new Date().toISOString(),
    affectedVersionCount: augmented.length,
    byState: {
      DRAFT: augmented.filter((r) => r.state === "DRAFT").length,
      PUBLISHED: augmented.filter((r) => r.state === "PUBLISHED").length,
      RETIRED: augmented.filter((r) => r.state === "RETIRED").length,
    },
    byClub: Object.fromEntries(
      Object.entries(augmented.reduce((acc, r) => {
        acc[r.clubName] = (acc[r.clubName] ?? 0) + 1;
        return acc;
      }, {})),
    ),
    rows: augmented,
  };

  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((err) => {
    console.error("ep-train-4e-inventory failed:", err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
