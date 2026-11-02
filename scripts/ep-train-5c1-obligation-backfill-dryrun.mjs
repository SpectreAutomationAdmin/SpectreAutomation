#!/usr/bin/env node
// EP-TRAIN-5C-1 (2026-11-02) — Obligation backfill dry-run report.
//
// Produces a structured JSON classification for EVERY (employee ×
// applicable course) pair across EVERY club on staging.  Reports
// which employees would receive a new INITIAL obligation under the
// 5C-4 live backfill, which already have an OUTSTANDING obligation
// (and should NOT get a duplicate INITIAL), and which pairs would
// cause a compliance-state flip when the obligation-aware resolver
// activates.
//
// SAFE: no DB writes.  Any attempt to disable DRY_RUN is refused.
// The live backfill is a separate script that will be authored +
// authorized in EP-TRAIN-5C-4.
//
// Usage via flyctl ssh:
//   flyctl ssh console --app spectre-staging -C \
//     "sh -c 'cd /app && node scripts/ep-train-5c1-obligation-backfill-dryrun.mjs'"

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

if (process.env.DRY_RUN === "0") {
  console.error(JSON.stringify({
    ok: false,
    refused: "DRY_RUN=0 is not supported in this script.  EP-TRAIN-5C-1 is report-only.  The live backfill is a separate script authored in 5C-4 and requires founder authorization per directive §3.",
  }));
  process.exit(2);
}

function parseIds(raw) {
  if (!raw) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a.filter((v) => typeof v === "string") : []; }
  catch { return []; }
}

async function resolveApplicableForEmployee(employeeId) {
  // Replicates src/lib/hr/training/applicability.ts resolveApplicableCourses
  // without importing TS -- the script runs under /app's compiled node_modules.
  const emp = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, clubId: true, departmentId: true, positionId: true },
  });
  if (!emp) return [];

  const now = new Date();
  const assignments = await prisma.employeeEmploymentAssignment.findMany({
    where: {
      employeeId: emp.id,
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    select: { departmentId: true, positionId: true },
  });
  const deptIds = new Set();
  const positionIds = new Set();
  for (const a of assignments) {
    if (a.departmentId) deptIds.add(a.departmentId);
    if (a.positionId) positionIds.add(a.positionId);
  }
  if (emp.departmentId) deptIds.add(emp.departmentId);
  if (emp.positionId) positionIds.add(emp.positionId);

  const [publishedVersions, explicitAssignments] = await Promise.all([
    prisma.trainingCourseVersion.findMany({
      where: {
        state: "PUBLISHED",
        course: { clubId: emp.clubId, retiredAt: null },
      },
      include: { course: { select: { id: true, code: true, title: true, category: true } } },
      orderBy: [{ course: { title: "asc" } }, { version: "desc" }],
    }),
    prisma.trainingAssignment.findMany({
      where: { clubId: emp.clubId, employeeId: emp.id },
      select: { courseId: true },
    }),
  ]);
  const assignedCourseIds = new Set(explicitAssignments.map((a) => a.courseId));
  const out = [];
  const seenCourseIds = new Set();
  for (const v of publishedVersions) {
    if (seenCourseIds.has(v.course.id)) continue;
    let reason = null;
    if (assignedCourseIds.has(v.course.id)) reason = "assigned";
    else if (v.appliesToAll) reason = "all";
    else if (parseIds(v.appliesToDeptIds).some((id) => deptIds.has(id))) reason = "department";
    else if (parseIds(v.appliesToPositionIds).some((id) => positionIds.has(id))) reason = "position";
    if (reason === null) continue;
    seenCourseIds.add(v.course.id);
    out.push({
      courseId: v.course.id, courseCode: v.course.code, courseTitle: v.course.title,
      category: v.course.category,
      versionId: v.id, versionNumber: v.version,
      required: v.required,
      reason,
    });
  }
  return out;
}

async function run() {
  const clubs = await prisma.club.findMany({ select: { id: true, name: true } });
  const grandTotals = {
    clubs: clubs.length,
    employees: 0,
    coursesApplied: 0,
    previouslyCompletedCompliant: 0,
    applicableNotCompleted: 0,
    previouslyCompletedRevisionRequired: 0,
    previouslyCompletedManualReinstateRequired: 0,
    noApplicableRequired: 0,
    potentialConflicts: 0,
  };
  let proposedNewInitialObligations = 0;
  let existingRevisionObligations = 0;
  let existingManualReinstateObligations = 0;
  const willFlipFromCompliantToOutstanding = [];
  const willFlipFromOutstandingToCompliant = [];
  const potentialConflictsDetail = [];
  const perClub = [];

  for (const club of clubs) {
    const employees = await prisma.employee.findMany({
      where: { clubId: club.id, employeeLifecycle: { in: ["ACTIVE", "PRE_HIRE", "LEAVE"] } },
      select: { id: true, employeeNumber: true, firstName: true, lastName: true },
    });

    const clubRow = {
      clubId: club.id, clubName: club.name, employees: employees.length,
      pairs: 0,
      categories: {
        previouslyCompletedCompliant: 0,
        applicableNotCompleted: 0,
        previouslyCompletedRevisionRequired: 0,
        previouslyCompletedManualReinstateRequired: 0,
        noApplicableRequired: 0,
      },
      proposedNewInitialObligations: 0,
    };

    for (const emp of employees) {
      grandTotals.employees += 1;
      const applicable = await resolveApplicableForEmployee(emp.id);
      if (applicable.length === 0) {
        grandTotals.noApplicableRequired += 1;
        clubRow.categories.noApplicableRequired += 1;
        continue;
      }

      // Snapshot completions + obligations for every applicable course.
      const applicableCourseIds = applicable.map((a) => a.courseId);
      const [completions, obligations] = await Promise.all([
        prisma.trainingCompletion.findMany({
          where: { clubId: club.id, employeeId: emp.id, courseId: { in: applicableCourseIds } },
          select: { courseId: true, courseVersionId: true },
        }),
        prisma.trainingObligation.findMany({
          where: { clubId: club.id, employeeId: emp.id, courseId: { in: applicableCourseIds }, status: "OUTSTANDING" },
          select: { courseId: true, courseVersionId: true, reason: true },
        }),
      ]);
      const completedOnCurrentByCourse = new Set();
      for (const c of completions) {
        const app = applicable.find((a) => a.courseId === c.courseId);
        if (app && c.courseVersionId === app.versionId) completedOnCurrentByCourse.add(c.courseId);
      }
      const outstandingByCourse = new Map();
      for (const o of obligations) {
        const arr = outstandingByCourse.get(o.courseId) ?? [];
        arr.push(o);
        outstandingByCourse.set(o.courseId, arr);
      }

      for (const app of applicable) {
        grandTotals.coursesApplied += 1;
        clubRow.pairs += 1;
        if (!app.required) continue; // optional courses never produce an INITIAL

        const outstanding = outstandingByCourse.get(app.courseId) ?? [];
        const hasRevision = outstanding.some((o) => o.reason === "REVISION");
        const hasManualReinstate = outstanding.some((o) => o.reason === "MANUAL_REINSTATE");
        const hasInitialOutstanding = outstanding.some((o) => o.reason === "INITIAL");
        const completedCurrent = completedOnCurrentByCourse.has(app.courseId);

        if (hasRevision) {
          existingRevisionObligations += 1;
          grandTotals.previouslyCompletedRevisionRequired += 1;
          clubRow.categories.previouslyCompletedRevisionRequired += 1;
          if (completedCurrent) {
            // Pre-5C the dashboard shows this employee as compliant.
            // Post-5C the resolver reports UPDATED_REQUIRED.
            willFlipFromCompliantToOutstanding.push({
              employeeId: emp.id, employeeNumber: emp.employeeNumber,
              courseId: app.courseId, courseCode: app.courseCode,
              reason: "existing OUTSTANDING REVISION already in place",
            });
          }
          continue;
        }
        if (hasManualReinstate) {
          existingManualReinstateObligations += 1;
          grandTotals.previouslyCompletedManualReinstateRequired += 1;
          clubRow.categories.previouslyCompletedManualReinstateRequired += 1;
          if (completedCurrent) {
            willFlipFromCompliantToOutstanding.push({
              employeeId: emp.id, employeeNumber: emp.employeeNumber,
              courseId: app.courseId, courseCode: app.courseCode,
              reason: "existing OUTSTANDING MANUAL_REINSTATE already in place",
            });
          }
          continue;
        }
        if (hasInitialOutstanding) {
          // An INITIAL already exists for the current version id.
          // Backfill is a no-op per invariant 1 (same issuanceKey).
          grandTotals.applicableNotCompleted += 1;
          clubRow.categories.applicableNotCompleted += 1;
          continue;
        }
        if (completedCurrent) {
          grandTotals.previouslyCompletedCompliant += 1;
          clubRow.categories.previouslyCompletedCompliant += 1;
          continue;
        }
        // Required, applicable, not completed on current version, no OUTSTANDING.
        // This is where the live backfill would issue an INITIAL.
        proposedNewInitialObligations += 1;
        clubRow.proposedNewInitialObligations += 1;
        grandTotals.applicableNotCompleted += 1;
        clubRow.categories.applicableNotCompleted += 1;
      }

      // Flag orphan obligations: OUTSTANDING on a version id that is
      // not currently published or applicable.
      const orphan = obligations.filter((o) => !applicable.some((a) => a.versionId === o.courseVersionId));
      if (orphan.length > 0) {
        grandTotals.potentialConflicts += orphan.length;
        for (const o of orphan) {
          potentialConflictsDetail.push({
            employeeId: emp.id, employeeNumber: emp.employeeNumber,
            courseId: o.courseId, courseVersionId: o.courseVersionId,
            note: `OUTSTANDING ${o.reason} on a non-current / non-applicable version id`,
          });
        }
      }
    }
    perClub.push(clubRow);
  }

  console.log(JSON.stringify({
    ok: true,
    dryRun: true,
    runAt: new Date().toISOString(),
    grandTotals,
    proposedNewInitialObligations,
    existingRevisionObligations,
    existingManualReinstateObligations,
    complianceStateChangesOnActivation: {
      willFlipFromCompliantToOutstanding,
      willFlipFromOutstandingToCompliant, // expected: []
    },
    perClub,
    potentialConflictsDetail,
  }, null, 2));
}

run()
  .catch((e) => { console.error("dry-run failed:", e.stack ?? e.message ?? String(e)); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
