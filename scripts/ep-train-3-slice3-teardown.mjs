// EP-TRAIN-3 Slice 3 (2026-10-30) -- disposable records teardown.
//
// Removes: E-SLICE3-TEST + portal credential + disposable published
// course (SLICE3_TEST) + its version + checkpoints + questions +
// attempts + progress + completions.  Preserves AUDIT rows (per
// founder "preserve test evidence and audit records" §7).
//
// Idempotent -- can be run multiple times safely.

import { createRequire } from "node:module";
const require = createRequire("/app/.next/standalone/node_modules/@prisma/client/");
const { PrismaClient } = require("@prisma/client");

const CLUB_ID = "cmrvdeny7000144372ktmmg9c";
const EMPLOYEE_NUMBER = "E-SLICE3-TEST";
const COURSE_CODE = "SLICE3_TEST";

const p = new PrismaClient();

async function main() {
  const emp = await p.employee.findFirst({ where: { clubId: CLUB_ID, employeeNumber: EMPLOYEE_NUMBER } });
  const course = await p.trainingCourse.findFirst({ where: { clubId: CLUB_ID, code: COURSE_CODE }, include: { versions: { select: { id: true } } } });

  const summary = { employeeDeleted: false, courseDeleted: false, versionIds: [] };

  if (course) {
    // Delete all version-dependent records then the course.
    for (const v of course.versions) {
      summary.versionIds.push(v.id);
      await p.trainingQuestionResponse.deleteMany({ where: { attempt: { courseVersionId: v.id } } });
      await p.trainingAttempt.deleteMany({ where: { courseVersionId: v.id } });
      await p.trainingProgress.deleteMany({ where: { courseVersionId: v.id } });
      await p.trainingCompletion.deleteMany({ where: { courseVersionId: v.id } });
      await p.trainingQuestion.deleteMany({ where: { courseVersionId: v.id } });
      await p.trainingCheckpoint.deleteMany({ where: { courseVersionId: v.id } });
    }
    // Null out currentVersionId before deleting versions.
    await p.trainingCourse.update({ where: { id: course.id }, data: { currentVersionId: null } });
    await p.trainingCourseVersion.deleteMany({ where: { courseId: course.id } });
    await p.trainingCourse.delete({ where: { id: course.id } });
    summary.courseDeleted = true;
  }

  if (emp) {
    // Portal credential cascades via the employeeId FK.
    await p.employeePortalCredential.deleteMany({ where: { employeeId: emp.id } });
    await p.trainingAssignment.deleteMany({ where: { employeeId: emp.id } });
    await p.trainingAttempt.deleteMany({ where: { employeeId: emp.id } });
    await p.trainingProgress.deleteMany({ where: { employeeId: emp.id } });
    await p.trainingCompletion.deleteMany({ where: { employeeId: emp.id } });
    await p.employee.delete({ where: { id: emp.id } });
    summary.employeeDeleted = true;
  }

  // Audit the teardown.
  await p.auditLog.create({
    data: {
      clubId: CLUB_ID,
      userId: "cmrvdenz700034437agp7gqs5",
      action: "hr.training.teardown.disposable",
      entityType: "Employee",
      entityId: emp?.id ?? "unknown",
      beforeJson: JSON.stringify({
        employeeNumber: EMPLOYEE_NUMBER,
        courseCode: COURSE_CODE,
        summary,
        reason: "EP-TRAIN-3 Slice 3 teardown per founder directive §7",
      }),
    },
  });

  console.log(JSON.stringify({ ok: true, summary }));
  await p.$disconnect();
}

main().catch((e) => { console.error("ERR", e); process.exit(1); });
