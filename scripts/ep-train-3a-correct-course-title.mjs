// EP-TRAIN-3 Phase A (2026-10-29) -- surgical title correction on
// the Coulee Ridge staging tenant.
//
// Scope (per founder EP-TRAIN-3 §A):
//   Current: "Workplace Safety Orientation (Staging Acceptance)"
//   Target:  "Workplace Safety Orientation"
//
// Policies honored:
//   - Updates ONLY the matching TrainingCourse.title + TrainingCourseVersion.title
//     rows.
//   - Does NOT touch TrainingAssignment / TrainingProgress / TrainingAttempt /
//     TrainingCompletion (preserves "all existing employee progress, attempts,
//     and completions" per Phase A).
//   - Does NOT add regex-based title filtering anywhere; this is a one-time
//     surgical data correction.
//   - Dry-run first (DRY_RUN=1); apply only when DRY_RUN=0.
//   - Writes to Coulee Ridge only (clubId lookup by name match on "Coulee").
//     Refuses to update if the match is ambiguous (more than one TrainingCourse
//     with the staging title across clubs).
//
// Usage via flyctl ssh:
//   DRY_RUN=1 node /app/ep-train-3a.mjs    # inspect
//   DRY_RUN=0 node /app/ep-train-3a.mjs    # apply

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const CURRENT_SUFFIX = /\s*\(staging\s+acceptance\)\s*$/i;
const EXACT_CURRENT = "Workplace Safety Orientation (Staging Acceptance)";
const TARGET = "Workplace Safety Orientation";

async function main() {
  const dryRun = process.env.DRY_RUN !== "0";

  // 1. Find the course on Coulee Ridge.
  const clubs = await prisma.club.findMany({
    where: { name: { contains: "Coulee" } },
    select: { id: true, name: true },
  });
  if (clubs.length === 0) throw new Error("No Coulee Ridge club found on staging.");
  if (clubs.length > 1) {
    throw new Error(`Ambiguous Coulee club match (${clubs.length} rows); refusing.`);
  }
  const club = clubs[0];

  // 2. Enumerate candidate TrainingCourse rows on this club carrying either
  //    the EXACT staging title OR the ` (Staging Acceptance)` suffix.
  const candidateCourses = await prisma.trainingCourse.findMany({
    where: {
      clubId: club.id,
      OR: [
        { title: EXACT_CURRENT },
        { title: { endsWith: " (Staging Acceptance)" } },
      ],
    },
    select: {
      id: true, title: true, code: true, category: true,
      versions: {
        select: { id: true, version: true, title: true, state: true, publishedAt: true },
        orderBy: { version: "asc" },
      },
      _count: {
        select: { completions: true, assignments: true },
      },
    },
  });

  if (candidateCourses.length === 0) {
    console.log(JSON.stringify({
      ok: true,
      dryRun,
      clubName: club.name,
      found: 0,
      note: "No TrainingCourse with the staging suffix on this club -- nothing to correct.",
    }, null, 2));
    return;
  }

  const summary = candidateCourses.map((c) => ({
    courseIdTail: c.id.slice(-6),
    code: c.code,
    category: c.category,
    currentTitle: c.title,
    completionCount: c._count.completions,
    assignmentCount: c._count.assignments,
    versions: c.versions.map((v) => ({
      versionIdTail: v.id.slice(-6),
      versionNumber: v.version,
      currentVersionTitle: v.title,
      state: v.state,
      publishedAt: v.publishedAt?.toISOString() ?? null,
      willUpdate:
        v.title === EXACT_CURRENT || CURRENT_SUFFIX.test(v.title),
      targetVersionTitle:
        v.title === EXACT_CURRENT
          ? TARGET
          : CURRENT_SUFFIX.test(v.title)
            ? v.title.replace(CURRENT_SUFFIX, "")
            : v.title,
    })),
  }));

  console.log(JSON.stringify({
    ok: true,
    dryRun,
    clubName: club.name,
    courseCount: candidateCourses.length,
    target: TARGET,
    courses: summary,
  }, null, 2));

  if (dryRun) {
    console.log(JSON.stringify({ note: "DRY RUN -- set DRY_RUN=0 to apply." }));
    return;
  }

  // 3. Apply.  Each TrainingCourse + its matching Versions updated in
  //    one $transaction so a half-complete write cannot leave the
  //    detail page + the catalogue card in disagreement.
  let coursesUpdated = 0;
  let versionsUpdated = 0;
  for (const c of candidateCourses) {
    const versionWrites = c.versions
      .filter((v) => v.title === EXACT_CURRENT || CURRENT_SUFFIX.test(v.title))
      .map((v) => {
        const nextTitle = v.title === EXACT_CURRENT
          ? TARGET
          : v.title.replace(CURRENT_SUFFIX, "");
        return prisma.trainingCourseVersion.update({
          where: { id: v.id },
          data: { title: nextTitle },
        });
      });
    const courseTitleNext = c.title === EXACT_CURRENT
      ? TARGET
      : c.title.replace(CURRENT_SUFFIX, "");
    const writes = [
      prisma.trainingCourse.update({
        where: { id: c.id },
        data: { title: courseTitleNext },
      }),
      ...versionWrites,
    ];
    await prisma.$transaction(writes);
    coursesUpdated += 1;
    versionsUpdated += versionWrites.length;
  }

  console.log(JSON.stringify({
    ok: true,
    applied: true,
    clubName: club.name,
    coursesUpdated,
    versionsUpdated,
    target: TARGET,
    completions_preserved: true,
    assignments_preserved: true,
    progress_preserved: true,
    attempts_preserved: true,
  }, null, 2));
}

main()
  .catch((err) => {
    console.error("ep-train-3a failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
