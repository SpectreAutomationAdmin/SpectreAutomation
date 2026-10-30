// EP-TRAIN-3 (2026-10-30) — Teardown for the founder-review disposable
// demonstration fixture.  Deletes ONLY the records created by
// scripts/ep-train-3-review-fixture.mjs; legitimate employees, courses,
// completions, payroll data, and historical training evidence are
// never touched.
//
// Run on staging via Fly SSH:
//   base64 -w0 scripts/ep-train-3-review-fixture-teardown.mjs | ssh console --

import { createRequire } from "node:module";
const require = createRequire("/app/.next/standalone/node_modules/@prisma/client/");
const { PrismaClient } = require("@prisma/client");

const CLUB_ID = "cmrvdeny7000144372ktmmg9c";
const EMPLOYEE_NUMBER = "E-FOUNDER-DEMO";
const COURSE_CODE = "DEMO_FR_SAFETY";

const p = new PrismaClient();
async function main() {
  const emp = await p.employee.findFirst({ where: { clubId: CLUB_ID, employeeNumber: EMPLOYEE_NUMBER } });
  const course = await p.trainingCourse.findFirst({ where: { clubId: CLUB_ID, code: COURSE_CODE }, include: { versions: { select: { id: true } } } });
  const summary = { employeeDeleted: false, courseDeleted: false, versionIds: [], attempts: 0, progress: 0, completions: 0, responses: 0 };
  if (course) {
    for (const v of course.versions) {
      summary.versionIds.push(v.id);
      // FK ordering: TrainingCompletion → QuestionResponse → Attempt → Progress → Question → Checkpoint.
      const cp = await p.trainingCompletion.deleteMany({ where: { courseVersionId: v.id } });
      summary.completions += cp.count;
      const r = await p.trainingQuestionResponse.deleteMany({ where: { attempt: { courseVersionId: v.id } } });
      summary.responses += r.count;
      const a = await p.trainingAttempt.deleteMany({ where: { courseVersionId: v.id } });
      summary.attempts += a.count;
      const pr = await p.trainingProgress.deleteMany({ where: { courseVersionId: v.id } });
      summary.progress += pr.count;
      await p.trainingQuestion.deleteMany({ where: { courseVersionId: v.id } });
      await p.trainingCheckpoint.deleteMany({ where: { courseVersionId: v.id } });
    }
    await p.trainingCourse.update({ where: { id: course.id }, data: { currentVersionId: null } });
    await p.trainingCourseVersion.deleteMany({ where: { courseId: course.id } });
    await p.trainingCourse.delete({ where: { id: course.id } });
    summary.courseDeleted = true;
  }
  if (emp) {
    await p.employeePortalCredential.deleteMany({ where: { employeeId: emp.id } });
    await p.trainingAssignment.deleteMany({ where: { employeeId: emp.id } });
    await p.trainingCompletion.deleteMany({ where: { employeeId: emp.id } });
    await p.trainingAttempt.deleteMany({ where: { employeeId: emp.id } });
    await p.trainingProgress.deleteMany({ where: { employeeId: emp.id } });
    await p.employee.delete({ where: { id: emp.id } });
    summary.employeeDeleted = true;
  }
  await p.auditLog.create({ data: { clubId: CLUB_ID, userId: "cmrvdenz700034437agp7gqs5", action: "hr.training.teardown.disposable.review-fixture", entityType: "Employee", entityId: emp?.id ?? "unknown", beforeJson: JSON.stringify({ employeeNumber: EMPLOYEE_NUMBER, courseCode: COURSE_CODE, summary, reason: "EP-TRAIN-3 Slice 3 founder-review teardown" }) } });
  console.log(JSON.stringify({ ok: true, summary }));
  await p.$disconnect();
}
main().catch((e) => { console.error("ERR", e); process.exit(1); });
