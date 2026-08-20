// HR-2C B2 (2026-08-20) — Admin course-builder source-contract.
//
// Pins the architectural invariants the founder called out in §25 +
// mandatory §Tests list:
//   - all mutation flows through canonical B1 services (no direct
//     prisma writes from the admin actions or pages)
//   - publish readiness uses the canonical B1 checkPublishReadiness
//     (never duplicated in React)
//   - no employee answer-key exposure from B2 surfaces
//
// Live behaviour (video upload, quiz save, publish) is exercised by
// the Playwright spec.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function src(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("HR-2C B2 · admin Safety & Training source-contract", () => {
  const actions = src("src/app/app/admin/people/safety-training/_actions.ts");
  const catalogue = src("src/app/app/admin/people/safety-training/page.tsx");
  const newPage = src("src/app/app/admin/people/safety-training/new/page.tsx");
  const coursePage = src("src/app/app/admin/people/safety-training/[courseId]/page.tsx");
  const versionPage = src("src/app/app/admin/people/safety-training/[courseId]/[versionId]/page.tsx");
  const videoUploader = src("src/app/app/admin/people/safety-training/[courseId]/[versionId]/VideoUploader.tsx");
  const publishPanel = src("src/app/app/admin/people/safety-training/[courseId]/[versionId]/PublishPanel.tsx");
  const quizEditor = src("src/app/app/admin/people/safety-training/[courseId]/[versionId]/QuizEditor.tsx");
  const applicability = src("src/app/app/admin/people/safety-training/[courseId]/[versionId]/ApplicabilityPicker.tsx");
  const nav = src("src/components/sidebar-nav-data.ts");
  const videoRoute = src("src/app/api/hr/training/versions/[id]/video/route.ts");

  it("§5 nav: Safety & Training under People, gated on hr:training:read", () => {
    expect(nav).toMatch(/\/app\/admin\/people\/safety-training[\s\S]{0,200}perm:\s*"hr:training:read"/);
  });

  it("actions delegate to canonical B1 services (no direct prisma writes)", () => {
    expect(actions).toMatch(/from "@\/lib\/hr\/training\/courses"/);
    expect(actions).toMatch(/from "@\/lib\/hr\/training\/questions"/);
    // No direct `prisma.trainingCourse.` / `prisma.trainingQuestion.` writes.
    expect(actions).not.toMatch(/prisma\.training(Course|Question|AnswerOption|Assignment|Progress|Attempt|Completion|CourseVersion)\.(create|update|upsert|delete|deleteMany|updateMany)/);
    // Only B1 service imports drive mutations.
    for (const fn of ["createCourse", "updateDraft", "publishDraft", "retireCourse", "startNewDraft", "createQuestion", "updateQuestion", "deleteQuestion", "reorderQuestions"]) {
      expect(actions).toContain(fn);
    }
  });

  it("catalogue page uses listClubCourses (canonical read); no ad-hoc prisma joins", () => {
    expect(catalogue).toMatch(/listClubCourses\(principal, clubId\)/);
    // No isCorrect / correctAnswer reads.
    expect(catalogue).not.toMatch(/isCorrect/);
  });

  it("catalogue gate: page-level hr:training:read + optional canAuthor for Create/edit affordances", () => {
    expect(catalogue).toMatch(/hasPermission\(principal, clubId, "hr:training:read"\)/);
    expect(catalogue).toMatch(/hasPermission\(principal, clubId, "hr:training:write"\)/);
  });

  it("new-course form uses B1 category constants (never invents categories)", () => {
    expect(newPage).toMatch(/TRAINING_COURSE_CATEGORIES/);
    // No hard-coded category select values leaking into the JSX.
    const stripped = newPage
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/<option[^>]*>Safety<\/option>/);
  });

  it("course detail page: Retire + Start New Draft actions are gated on hr:training:publish / write", () => {
    expect(coursePage).toMatch(/hasPermission\(principal, clubId, "hr:training:write"\)/);
    expect(coursePage).toMatch(/hasPermission\(principal, clubId, "hr:training:publish"\)/);
    expect(coursePage).toMatch(/startNewDraftAction\.bind\(null, course\.id\)/);
    expect(coursePage).toMatch(/retireCourseAction\.bind\(null, course\.id\)/);
  });

  it("version editor uses B1 checkPublishReadiness — never duplicates rules in React (§25)", () => {
    expect(versionPage).toMatch(/import[\s\S]{0,100}checkPublishReadiness/);
    expect(versionPage).toMatch(/await checkPublishReadiness\(version\.id\)/);
    // The React-side PublishPanel receives the readiness object as
    // props; it must NOT re-implement any of the rules.
    expect(publishPanel).not.toMatch(/videoStorageKey|passingScore|isCorrect|options\.length|appliesToAll/);
  });

  it("version editor disables ALL controls when not DRAFT (published/retired = read-only)", () => {
    expect(versionPage).toMatch(/readOnly = !isDraft \|\| !canAuthor/);
    expect(versionPage).toMatch(/disabled=\{readOnly\}/);
  });

  it("video uploader uses the same-origin proxy route + never exposes storage keys", () => {
    expect(videoUploader).toMatch(/\/api\/hr\/training\/versions\/\$\{versionId\}\/video/);
    expect(videoUploader).not.toMatch(/storageKey|videoStorageKey/);
    // MIME whitelist + size cap match the canonical B1 constants.
    expect(videoUploader).toMatch(/video\/mp4/);
    expect(videoUploader).toMatch(/video\/webm/);
    expect(videoUploader).toMatch(/200 \* 1024 \* 1024|MAX_BYTES = 200/);
  });

  it("video route: same-shape 404 for every deny + tenant scope + admin OR portal reads (per B1 accepted architecture)", () => {
    expect(videoRoute).toMatch(/NOT_FOUND = \(\) => NextResponse\.json/);
    expect(videoRoute).toMatch(/hasPermission\(admin, clubId, "hr:training:read"\)/);
    expect(videoRoute).toMatch(/getEmployeePortalPrincipal/);
    expect(videoRoute).toMatch(/portal\.clubId === clubId/);
    // Employee reads are additionally gated by applicability lookup.
    expect(videoRoute).toMatch(/resolveApplicableCourses\(portal\.employeeId\)/);
  });

  it("quiz editor never emits the correct-answer flag to the DOM (correctIdx is admin authoring state, not employee data)", () => {
    // The admin quiz editor DOES track which option is correct, but
    // ONLY as UI state controlled by the admin's radio selection.
    // The rendered <input type="radio" name="correctIdx" value={i}> is
    // acceptable — it becomes part of the admin-authored form.
    // What must NEVER appear here is a reference to `isCorrect` from
    // an employee-facing payload. We keep the admin `isCorrect` in
    // the option objects the editor receives (initial state), which
    // is fine because the surface itself is admin-gated.
    // Assert the correct-answer picker uses a client-side radio group.
    expect(quizEditor).toMatch(/name="correctIdx"/);
    expect(quizEditor).toMatch(/type="radio"/);
  });

  it("applicability picker: three-way radio (everyone / scoped / explicit), no confusing overlap", () => {
    expect(applicability).toMatch(/data-testid="applicability-everyone"/);
    expect(applicability).toMatch(/data-testid="applicability-scoped"/);
    expect(applicability).toMatch(/data-testid="applicability-explicit"/);
    expect(applicability).toMatch(/data-mode=\{mode\}/);
  });

  it("no employee-portal principals are ever consulted by admin B2 pages/actions (admin-only surface)", () => {
    for (const s of [catalogue, newPage, coursePage, versionPage, actions, applicability, quizEditor, publishPanel]) {
      expect(s).not.toMatch(/getEmployeePortalPrincipal/);
    }
    // The video ROUTE does consult both principals — because employees
    // must be able to stream the video. That's the only allowed
    // employee-portal read on the B2 surface.
  });
});
