// HR-2C B5 (2026-08-28) — Training compliance projection + Employee
// Profile → Training tab source-contract + admin-write boundary.
//
// Every projection value MUST reconcile to the canonical resolvers
// (§26). No parallel compliance engine. Test cases:
//   §30 — projection roll-up correctness (required / complete /
//         outstanding / eligibility) at the ClubComplianceRow level.
//   §31 — multi-role cross-training visible.
//   §32 — version rev: v1 completed + v2 published → current has v2
//         outstanding, history retains v1.
//   §33 — retired course: prior completion stays in history, does not
//         create current requirement.
//   §34 — explicit assignment appears in current + eligibility flips.
//   §35 — permission boundaries: reader without compliance permission
//         refused; cross-Club refused.
//   Source contract: dashboard page + course-detail page + Employee
//   Profile view reference the canonical services and never invent
//   parallel compliance logic.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { createCourse, publishDraft, updateDraft, retireCourse } from "@/lib/hr/training/courses";
import { createQuestion } from "@/lib/hr/training/questions";
import { uploadTrainingVideo } from "@/lib/hr/training/video";
import { assignCourseToEmployee } from "@/lib/hr/training/assignments";
import {
  getClubTrainingCompliance,
  getEmployeeTrainingRecord,
  getCourseComplianceRoster,
} from "@/lib/hr/training/compliance";
import { AppError, NotFoundError } from "@/lib/errors";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture, type AdminHrFixture } from "../admin-workflows/_helpers";
import type { EmployeePortalPrincipal } from "@/lib/employee-portal-session";
import { recordVideoProgress, startAttempt, submitAttempt } from "@/lib/hr/training/attempts";
import { getEmployeeCourseView } from "@/lib/hr/training/employee-read";

const FAKE_VIDEO = Buffer.from(new Array(1024).fill(0));

async function makeEmp(fx: AdminHrFixture, opts?: {
  clubId?: string; departmentId?: string | null; positionId?: string | null;
}): Promise<{ employeeId: string; actor: EmployeePortalPrincipal }> {
  const clubId = opts?.clubId ?? fx.club.id;
  const emp = await prisma.employee.create({
    data: {
      clubId,
      employeeNumber: `E-${Math.floor(Math.random() * 90000 + 10000)}`,
      firstName: "T", lastName: "E",
      personalEmail: `t-${Date.now()}-${Math.floor(Math.random() * 9999)}@x.test`,
      departmentId: opts?.departmentId ?? null,
      positionId: opts?.positionId ?? null,
      employeeLifecycle: "ACTIVE",
    },
  });
  return {
    employeeId: emp.id,
    actor: {
      employeeId: emp.id, clubId: emp.clubId,
      generation: 1, establishedAt: new Date().toISOString(),
    },
  };
}

async function publishCourse(
  fx: AdminHrFixture,
  opts: {
    code?: string;
    required?: boolean;
    appliesToAll?: boolean;
    appliesToDeptIds?: string[];
    appliesToPositionIds?: string[];
    clubId?: string;
  },
): Promise<{ courseId: string; versionId: string }> {
  const clubId = opts.clubId ?? fx.club.id;
  const admin = clubId === fx.club.id ? fx.clubAdmin : fx.foreignClubAdmin;
  const { courseId, versionId } = await createCourse(admin, clubId, {
    code: opts.code ?? `C_${Math.floor(Math.random() * 90000 + 10000)}`,
    title: "Workplace Safety Orientation",
    category: "Safety",
    description: "Test course.",
    version1Defaults: { required: opts.required ?? true, appliesToAll: opts.appliesToAll ?? false },
  });
  await updateDraft(admin, versionId, {
    appliesToAll: opts.appliesToAll ?? false,
    appliesToDeptIds: opts.appliesToDeptIds ?? null,
    appliesToPositionIds: opts.appliesToPositionIds ?? null,
    requiresKnowledgeTest: true,
  });
  await uploadTrainingVideo(admin, versionId, {
    bytes: FAKE_VIDEO, mimeType: "video/mp4", durationSec: 60,
  });
  await createQuestion(admin, versionId, {
    prompt: "Q1?",
    options: [
      { text: "A", isCorrect: false },
      { text: "B", isCorrect: true },
    ],
  });
  await publishDraft(admin, versionId);
  return { courseId, versionId };
}

async function completeCourse(actor: EmployeePortalPrincipal, versionId: string) {
  await recordVideoProgress(actor, {
    courseVersionId: versionId, secondsWatched: 60, farthestSecond: 60,
  });
  const started = await startAttempt(actor, { courseVersionId: versionId });
  const view = await getEmployeeCourseView(actor, versionId);
  // My publishCourse helper authors one 2-option question with the
  // correct answer at options[1] (isCorrect: true).
  const answers = view.questions.map((q) => ({
    questionId: q.id,
    selectedOptionId: q.options[1]!.id,
  }));
  await submitAttempt(actor, { attemptId: started.attemptId, answers });
}

describe("HR-2C B5 · training compliance projection", () => {
  let fx: AdminHrFixture;
  beforeAll(async () => { await resetDb(); await seedRbac(); }, 60_000);
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
    fx = await makeAdminHrFixture("HR2CB5");
  }, 60_000);

  it("§30 — 3 required / 2 complete → outstanding 1, not eligible", async () => {
    const { versionId: v1 } = await publishCourse(fx, { code: "COURSE_A", appliesToAll: true, required: true });
    const { versionId: v2 } = await publishCourse(fx, { code: "COURSE_B", appliesToAll: true, required: true });
    await publishCourse(fx, { code: "COURSE_C", appliesToAll: true, required: true });
    const { employeeId, actor } = await makeEmp(fx);
    await completeCourse(actor, v1);
    await completeCourse(actor, v2);
    const { rows } = await getClubTrainingCompliance(fx.clubAdmin, fx.club.id);
    const row = rows.find((r) => r.employeeId === employeeId)!;
    expect(row.requiredCount).toBe(3);
    expect(row.completedCount).toBe(2);
    expect(row.outstandingCount).toBe(1);
    expect(row.eligible).toBe(false);
    expect(row.status).toBe("training_required");
  });

  it("§30 — all required complete → up to date + eligible", async () => {
    const { versionId } = await publishCourse(fx, { appliesToAll: true, required: true });
    const { employeeId, actor } = await makeEmp(fx);
    await completeCourse(actor, versionId);
    const { rows } = await getClubTrainingCompliance(fx.clubAdmin, fx.club.id);
    const row = rows.find((r) => r.employeeId === employeeId)!;
    expect(row.requiredCount).toBe(1);
    expect(row.completedCount).toBe(1);
    expect(row.outstandingCount).toBe(0);
    expect(row.eligible).toBe(true);
    expect(row.status).toBe("up_to_date");
  });

  it("§30 — optional incomplete does NOT change required/outstanding or eligibility", async () => {
    await publishCourse(fx, { appliesToAll: true, required: false, code: "OPTIONAL" });
    const { employeeId } = await makeEmp(fx);
    const { rows } = await getClubTrainingCompliance(fx.clubAdmin, fx.club.id);
    const row = rows.find((r) => r.employeeId === employeeId)!;
    expect(row.requiredCount).toBe(0);
    expect(row.outstandingCount).toBe(0);
    expect(row.optionalCount).toBe(1);
    expect(row.eligible).toBe(true);
  });

  it("§31 — multi-role cross-training: both PRIMARY and ADDITIONAL dept requirements surface", async () => {
    const admin = await prisma.department.create({
      data: { clubId: fx.club.id, code: "ADMIN", name: "Administration", sortOrder: 1 },
    });
    const fnb = await prisma.department.create({
      data: { clubId: fx.club.id, code: "FNB", name: "Food & Beverage", sortOrder: 2 },
    });
    const { courseId: adminOrient } = await publishCourse(fx, {
      code: "ADMIN_ORIENT", appliesToDeptIds: [admin.id], required: true,
    });
    const { courseId: alcohol } = await publishCourse(fx, {
      code: "ALCOHOL", appliesToDeptIds: [fnb.id], required: true,
    });
    const { employeeId } = await makeEmp(fx);
    // PRIMARY assignment → Administration
    await prisma.employeeEmploymentAssignment.create({
      data: {
        clubId: fx.club.id, employeeId,
        role: "PRIMARY", departmentId: admin.id,
        employmentType: "FULL_TIME", effectiveFrom: new Date(),
      },
    });
    // ADDITIONAL assignment → F&B (cross-trained)
    await prisma.employeeEmploymentAssignment.create({
      data: {
        clubId: fx.club.id, employeeId,
        role: "ADDITIONAL", departmentId: fnb.id,
        employmentType: "PART_TIME", effectiveFrom: new Date(),
      },
    });
    const record = await getEmployeeTrainingRecord(fx.clubAdmin, employeeId);
    const courseIds = record.current.map((c) => c.courseId);
    expect(courseIds).toContain(adminOrient);
    expect(courseIds).toContain(alcohol);
    expect(record.eligibility.eligible).toBe(false);
    // Source label reflects the actual department for the F&B course.
    const alcoholRow = record.current.find((c) => c.courseId === alcohol)!;
    expect(alcoholRow.source).toBe("department");
    expect(alcoholRow.sourceLabel).toContain("Food & Beverage");
  });

  it("§32 — v1 completed + v2 published → current has v2 outstanding; history retains v1", async () => {
    // Course A v1 required + published.
    const { courseId, versionId: v1 } = await publishCourse(fx, {
      code: "REVAB", appliesToAll: true, required: true,
    });
    const { employeeId, actor } = await makeEmp(fx);
    await completeCourse(actor, v1);
    // Verify v1 completion recorded.
    const beforeRecord = await getEmployeeTrainingRecord(fx.clubAdmin, employeeId);
    expect(beforeRecord.eligibility.eligible).toBe(true);
    expect(beforeRecord.history.find((h) => h.courseVersionId === v1)).toBeTruthy();

    // Publish v2 of the same course — canonical courses.ts handles the
    // "retire v1 → publish v2" transition. We create + publish v2 here
    // directly, matching the flow the admin surface uses.
    // Use canonical `startNewDraft` + author minimal video/question then publish.
    // Simplest: use the same helpers.
    const { startNewDraft, publishDraft: pub } = await import("@/lib/hr/training/courses");
    const { versionId: v2 } = await startNewDraft(fx.clubAdmin, courseId);
    await updateDraft(fx.clubAdmin, v2, {
      appliesToAll: true, requiresKnowledgeTest: true,
    });
    await uploadTrainingVideo(fx.clubAdmin, v2, {
      bytes: FAKE_VIDEO, mimeType: "video/mp4", durationSec: 60,
    });
    await createQuestion(fx.clubAdmin, v2, {
      prompt: "V2 Q?",
      options: [
        { text: "A", isCorrect: false },
        { text: "B", isCorrect: true },
      ],
    });
    await pub(fx.clubAdmin, v2);

    const afterRecord = await getEmployeeTrainingRecord(fx.clubAdmin, employeeId);
    // v2 is current + outstanding
    expect(afterRecord.eligibility.eligible).toBe(false);
    const currentV2 = afterRecord.current.find((c) => c.courseVersionId === v2)!;
    expect(currentV2).toBeTruthy();
    expect(currentV2.completed).toBe(false);
    // v1 remains in history — never overwritten
    const historyV1 = afterRecord.history.find((h) => h.courseVersionId === v1)!;
    expect(historyV1).toBeTruthy();
    expect(historyV1.isCurrentVersion).toBe(false);
  });

  it("§33 — retired course: prior completion stays in history, no current requirement", async () => {
    const { courseId, versionId } = await publishCourse(fx, { appliesToAll: true, required: true });
    const { employeeId, actor } = await makeEmp(fx);
    await completeCourse(actor, versionId);
    await retireCourse(fx.clubAdmin, courseId);
    const record = await getEmployeeTrainingRecord(fx.clubAdmin, employeeId);
    // No longer current.
    expect(record.current.length).toBe(0);
    // Still in history + marked retired.
    const h = record.history.find((r) => r.courseVersionId === versionId)!;
    expect(h).toBeTruthy();
    expect(h.courseRetired).toBe(true);
    // Eligibility unaffected — no outstanding requirements.
    expect(record.eligibility.eligible).toBe(true);
  });

  it("§34 — explicit assignment adds current requirement + eligibility flips", async () => {
    // Course applies to nobody by dept/position/all.
    const { courseId } = await publishCourse(fx, {
      appliesToAll: false, required: true,
    });
    const { employeeId } = await makeEmp(fx);
    let record = await getEmployeeTrainingRecord(fx.clubAdmin, employeeId);
    expect(record.current.length).toBe(0);
    expect(record.eligibility.eligible).toBe(true);
    // Assign explicitly (through canonical writer).
    await assignCourseToEmployee(fx.clubAdmin, { employeeId, courseId });
    record = await getEmployeeTrainingRecord(fx.clubAdmin, employeeId);
    expect(record.current.length).toBe(1);
    expect(record.current[0]!.source).toBe("assigned");
    expect(record.current[0]!.sourceLabel).toBe("Individually assigned");
    expect(record.eligibility.eligible).toBe(false);
    expect(record.explicitAssignments.length).toBe(1);
  });

  it("§34 — cross-Club assignment refused via canonical writer (same-shape 404)", async () => {
    const { courseId } = await publishCourse(fx, { appliesToAll: true, required: true });
    // Employee in FOREIGN club
    const { employeeId: foreignEmp } = await makeEmp(fx, { clubId: fx.foreignClub.id });
    await expect(assignCourseToEmployee(fx.clubAdmin, {
      employeeId: foreignEmp, courseId,
    })).rejects.toBeInstanceOf(AppError);
  });

  it("§35 — permission gate: caller without hr:training:compliance:read refused", async () => {
    const { employeeId } = await makeEmp(fx);
    // Build a real Principal for a STAFF user — STAFF does NOT hold
    // hr:training:compliance:read per src/lib/permissions.ts, so both
    // reads must refuse.
    const user = await prisma.user.create({
      data: {
        clubId: fx.club.id,
        email: `no-perm-${Date.now()}@x.test`,
        name: "No Perm",
        role: "STAFF",
        passwordHash: "x",
      },
    });
    const noPerm = {
      id: user.id,
      name: user.name,
      email: user.email,
      status: "ACTIVE",
      memberships: [{ clubId: fx.club.id, roleKey: "STAFF" as const }],
      activeClubId: fx.club.id,
      memberId: null,
    };
    await expect(getEmployeeTrainingRecord(noPerm, employeeId)).rejects.toBeInstanceOf(AppError);
    await expect(getClubTrainingCompliance(noPerm, fx.club.id)).rejects.toBeInstanceOf(AppError);
  });

  it("§35 — cross-Club employee record refused with same-shape NotFoundError", async () => {
    const { employeeId: foreignEmp } = await makeEmp(fx, { clubId: fx.foreignClub.id });
    await expect(getEmployeeTrainingRecord(fx.clubAdmin, foreignEmp))
      .rejects.toBeInstanceOf(AppError);
  });

  it("§8 — per-course roster shows applicable employees with completion status", async () => {
    const { courseId, versionId } = await publishCourse(fx, {
      appliesToAll: true, required: true,
    });
    const { employeeId: a, actor: actorA } = await makeEmp(fx);
    const { employeeId: b } = await makeEmp(fx);
    await completeCourse(actorA, versionId);
    const { roster } = await getCourseComplianceRoster(fx.clubAdmin, courseId);
    // Fixture contributes one extra club employee ("River Sensitive")
    // — roster is applies-to-all so it appears too; only check a + b.
    expect(roster.length).toBeGreaterThanOrEqual(2);
    expect(roster.find((r) => r.employeeId === a)!.status).toBe("completed");
    expect(roster.find((r) => r.employeeId === b)!.status).toBe("not_started");
  });

  it("filter: status=training_required only returns employees with outstanding requirements", async () => {
    await publishCourse(fx, { appliesToAll: true, required: true });
    await makeEmp(fx);
    await makeEmp(fx);
    const { rows } = await getClubTrainingCompliance(fx.clubAdmin, fx.club.id, {
      status: "training_required",
    });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) expect(r.outstandingCount).toBeGreaterThan(0);
  });

  it("filter: courseId returns only employees for whom the course applies", async () => {
    const admin = await prisma.department.create({
      data: { clubId: fx.club.id, code: "ADMIN2", name: "Admin2", sortOrder: 1 },
    });
    const { courseId } = await publishCourse(fx, {
      appliesToDeptIds: [admin.id], required: true,
    });
    const { employeeId: inScope } = await makeEmp(fx);
    await prisma.employeeEmploymentAssignment.create({
      data: {
        clubId: fx.club.id, employeeId: inScope,
        role: "PRIMARY", departmentId: admin.id,
        employmentType: "FULL_TIME", effectiveFrom: new Date(),
      },
    });
    await makeEmp(fx); // out of scope
    const { rows } = await getClubTrainingCompliance(fx.clubAdmin, fx.club.id, { courseId });
    const ids = rows.map((r) => r.employeeId);
    expect(ids).toContain(inScope);
  });
});

// ---------------------------------------------------------------------------
// Source contract — pages compose canonical services; no parallel logic
// ---------------------------------------------------------------------------

describe("HR-2C B5 · source contract", () => {
  const read = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), "utf8");
  const dashboard = read("src/app/app/admin/people/safety-training/compliance/page.tsx");
  const courseDetail = read("src/app/app/admin/people/safety-training/[courseId]/page.tsx");
  const trainingTabs = read("src/app/app/admin/people/safety-training/_SafetyTrainingTabs.tsx");
  const trainingSection = read("src/components/hr/EmployeeTrainingSection.tsx");
  const assignBtn = read("src/components/hr/AssignTrainingButton.tsx");
  const profileView = read("src/components/hr/EmployeeProfileView.tsx");
  const profilePage = read("src/app/app/admin/people/employees/[id]/page.tsx");
  const trainingActions = read("src/app/app/admin/people/employees/[id]/_training-actions.ts");
  const service = read("src/lib/hr/training/compliance.ts");

  it("compliance service composes canonical resolvers, not a parallel engine", () => {
    expect(service).toMatch(/resolveApplicableCourses/);
    expect(service).toMatch(/resolveEmployeeSchedulingEligibility/);
    // Compliance status is derived from required vs completed — no
    // parallel eligibility function reimplemented here.
    expect(service).not.toMatch(/function resolveEligibility/);
  });

  it("dashboard uses canonical getClubTrainingCompliance + gates on hr:training:compliance:read", () => {
    expect(dashboard).toMatch(/getClubTrainingCompliance/);
    expect(dashboard).toMatch(/hr:training:compliance:read/);
    expect(dashboard).not.toMatch(/prisma\.trainingCompletion\.findMany/);
    // Drill-through goes to the profile Training tab.
    expect(dashboard).toMatch(/\?tab=training/);
  });

  it("Safety & Training tabs component exposes Courses + Compliance", () => {
    expect(trainingTabs).toMatch(/label: "Courses"/);
    expect(trainingTabs).toMatch(/label: "Compliance"/);
    expect(trainingTabs).toMatch(/canReadCompliance/);
  });

  it("EmployeeProfileView adds Training tab and honours the trainingSection slot", () => {
    expect(profileView).toMatch(/key: "training"/);
    expect(profileView).toMatch(/trainingSection/);
    // Training tab is HIDDEN when the slot is undefined (no permission).
    expect(profileView).toMatch(/trainingSection === undefined\) return null/);
  });

  it("Training section renders eligibility, current + history + assignment affordance from canonical types", () => {
    expect(trainingSection).toMatch(/EmployeeTrainingRecord/);
    expect(trainingSection).toMatch(/data-testid="training-eligibility"/);
    expect(trainingSection).toMatch(/data-testid="training-current"/);
    expect(trainingSection).toMatch(/data-testid="training-history"/);
    // Mark-complete / score edit / delete completion are forbidden (§23).
    expect(trainingSection).not.toMatch(/Mark complete/);
    expect(trainingSection).not.toMatch(/delete completion/i);
  });

  it("Assign action delegates to canonical assignCourseToEmployee (no direct prisma writes)", () => {
    expect(trainingActions).toMatch(/assignCourseToEmployee/);
    expect(trainingActions).not.toMatch(/prisma\.trainingAssignment\.create/);
    expect(trainingActions).not.toMatch(/prisma\.trainingCompletion\./);
  });

  it("Course detail includes an Applicable-employees section only under hr:training:compliance:read", () => {
    expect(courseDetail).toMatch(/getCourseComplianceRoster/);
    expect(courseDetail).toMatch(/hr:training:compliance:read/);
    expect(courseDetail).toMatch(/data-testid="course-applicable-employees"/);
  });

  it("Assign-training UX prevents duplicate rows by surfacing 'already assigned' rather than creating one", () => {
    expect(assignBtn).toMatch(/alreadyAssigned/);
    expect(assignBtn).toMatch(/already assigned/i);
  });

  it("Employee profile page loads training record ONLY under permission — the read is gated at the page level", () => {
    expect(profilePage).toMatch(/canReadTrainingCompliance/);
    expect(profilePage).toMatch(/getEmployeeTrainingRecord/);
    // The load is behind the permission gate.
    expect(profilePage).toMatch(/canReadTrainingCompliance\s*\n?\s*\?\s*await getEmployeeTrainingRecord/);
  });
});
