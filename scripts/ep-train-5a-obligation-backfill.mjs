#!/usr/bin/env node
// EP-TRAIN-5A (2026-11-01) — Training obligation backfill (DRY-RUN only).
//
// NOT YET AUTHORIZED FOR LIVE RUN.  This script is checked in with
// EP-TRAIN-5A so the 5C slice can execute it against staging the
// moment the obligation-authoritative resolver is ready to consume
// the resulting rows.  Running this against staging BEFORE the
// resolver swap has no effect on behavior (the resolver still looks
// at TrainingCompletion rows directly) but populates the obligation
// stream so 5C can flip over atomically.
//
// Logic (per docs/ep-train-5a-obligation-foundation.md §3):
//
//   For every (employee, course) pair where the course is applicable
//   to the employee today (via all / department / position / assigned):
//
//     - If a TrainingCompletion exists for the currently-published
//       versionId → create a SATISFIED obligation with
//       reason=INITIAL, issuedAt=completedAt, satisfiedByCompletionId.
//
//     - If no completion AND version.required=true → create an
//       OUTSTANDING obligation with reason=INITIAL.
//
//     - If no completion AND version.required=false → no obligation.
//
// Safe to re-run (idempotent per Invariant 1 on OUTSTANDING, and
// skips any (employee, versionId, INITIAL) with an existing SATISFIED
// obligation).
//
// Usage via flyctl ssh:
//   DRY_RUN=1 flyctl ssh console --app spectre-staging -C \
//     "sh -c 'cd /app && node scripts/ep-train-5a-obligation-backfill.mjs'"
//
// DRY_RUN=0 to apply (requires founder authorization — EP-TRAIN-5A
// deploys with DRY_RUN=1 as the default, no automated 0 run).

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DRY_RUN = process.env.DRY_RUN !== "0";

function parseIds(raw) {
  if (!raw) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a.filter((v) => typeof v === "string") : []; }
  catch { return []; }
}

function outstandingKey(employeeId, versionId, reason) {
  return `${employeeId}|${versionId}|${reason}`;
}

async function run() {
  const clubs = await prisma.club.findMany({ select: { id: true, name: true } });
  const grandTotals = { satisfied: 0, outstanding: 0, skipped: 0, optional: 0 };
  const perClub = [];

  for (const club of clubs) {
    const [employees, publishedVersions, assignments] = await Promise.all([
      prisma.employee.findMany({
        where: { clubId: club.id },
        select: { id: true, departmentId: true, positionId: true },
      }),
      prisma.trainingCourseVersion.findMany({
        where: {
          state: "PUBLISHED",
          course: { clubId: club.id, retiredAt: null },
        },
        include: { course: { select: { id: true } } },
      }),
      prisma.trainingAssignment.findMany({
        where: { clubId: club.id },
        select: { employeeId: true, courseId: true },
      }),
    ]);
    const assignedByEmp = new Map();
    for (const a of assignments) {
      if (!assignedByEmp.has(a.employeeId)) assignedByEmp.set(a.employeeId, new Set());
      assignedByEmp.get(a.employeeId).add(a.courseId);
    }

    // Collect active (dept, position) context per employee from
    // employment assignments + legacy fields.  Mirror applicability.ts.
    const now = new Date();
    const empAssignments = await prisma.employeeEmploymentAssignment.findMany({
      where: {
        employeeId: { in: employees.map((e) => e.id) },
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      },
      select: { employeeId: true, departmentId: true, positionId: true },
    });
    const empContext = new Map();
    for (const e of employees) {
      empContext.set(e.id, { deptIds: new Set(), positionIds: new Set() });
    }
    for (const a of empAssignments) {
      const ctx = empContext.get(a.employeeId);
      if (a.departmentId) ctx.deptIds.add(a.departmentId);
      if (a.positionId) ctx.positionIds.add(a.positionId);
    }
    for (const e of employees) {
      const ctx = empContext.get(e.id);
      if (e.departmentId) ctx.deptIds.add(e.departmentId);
      if (e.positionId) ctx.positionIds.add(e.positionId);
    }

    let satisfied = 0, outstanding = 0, skipped = 0, optional = 0;

    for (const v of publishedVersions) {
      const deptIds = parseIds(v.appliesToDeptIds);
      const positionIds = parseIds(v.appliesToPositionIds);
      for (const emp of employees) {
        const empAssigned = assignedByEmp.get(emp.id)?.has(v.course.id) ?? false;
        const ctx = empContext.get(emp.id);
        const applicable = empAssigned
          || v.appliesToAll
          || deptIds.some((d) => ctx.deptIds.has(d))
          || positionIds.some((p) => ctx.positionIds.has(p));
        if (!applicable) continue;

        const existing = await prisma.trainingObligation.findFirst({
          where: {
            clubId: club.id, employeeId: emp.id, courseVersionId: v.id, reason: "INITIAL",
          },
          select: { id: true, status: true },
        });
        if (existing) { skipped++; continue; }

        const completion = await prisma.trainingCompletion.findUnique({
          where: { employeeId_courseVersionId: { employeeId: emp.id, courseVersionId: v.id } },
          select: { id: true, completedAt: true },
        });

        if (completion) {
          if (DRY_RUN) satisfied++;
          else {
            // SATISFIED path: outstandingUniqueKey stays NULL.
            await prisma.trainingObligation.create({
              data: {
                clubId: club.id, employeeId: emp.id, courseId: v.course.id,
                courseVersionId: v.id, reason: "INITIAL",
                issuedByUserId: null, issuedAt: completion.completedAt,
                status: "SATISFIED",
                satisfiedByCompletionId: completion.id,
                satisfiedAt: completion.completedAt,
                outstandingUniqueKey: null,
              },
            });
            satisfied++;
          }
        } else if (v.required) {
          if (DRY_RUN) outstanding++;
          else {
            await prisma.trainingObligation.create({
              data: {
                clubId: club.id, employeeId: emp.id, courseId: v.course.id,
                courseVersionId: v.id, reason: "INITIAL",
                issuedByUserId: null, issuedAt: new Date(),
                status: "OUTSTANDING",
                outstandingUniqueKey: outstandingKey(emp.id, v.id, "INITIAL"),
              },
            });
            outstanding++;
          }
        } else {
          optional++;
        }
      }
    }

    perClub.push({ clubId: club.id, clubName: club.name, satisfied, outstanding, skipped, optional });
    grandTotals.satisfied += satisfied;
    grandTotals.outstanding += outstanding;
    grandTotals.skipped += skipped;
    grandTotals.optional += optional;
  }

  console.log(JSON.stringify({ ok: true, dryRun: DRY_RUN, grandTotals, perClub }, null, 2));
}

run()
  .catch((e) => { console.error("backfill failed:", e.stack ?? e.message ?? String(e)); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
