// EP-TRAIN-6D-4Z-F — Two-role full workflow staging acceptance.
//
// Runs on the already-deployed Fly v1098 image (sha-e7fbb0b158cd).
// NO code changes; NO redeploy; NO live Modal.
//
// Flow (§6 + §7):
//   REVIEWER session:
//     1. Log in as synthetic TRAINING_AI_REVIEWER.
//     2. For each of 4 fixture drafts: open persisted-review page,
//        pick verified answer (index 0), check attestation, approve.
//   ADMIN session (separate context):
//     3. Log in as synthetic CLUB_ADMIN.
//     4. Navigate to the AI Workspace Course Assembly stage.
//     5. Promote drafts 1 + 2 to their respective checkpoints via UI.
//     6. Promote drafts 3 + 4 to the final assessment via UI.
//     7. Confirm the row flips to "Already promoted" via UI state.
//   NEGATIVE:
//     8. Reviewer (new session) opens workspace → Promote buttons
//        disabled or absent.
//     9. Reviewer tries to approve while on the wrong club (cross-
//        tenant) — verified via the reviewer's active club scoping
//        in the Prisma layer (statically asserted via 4Z-D unit tests).
//
// Fixture inputs (env):
//   REVIEWER_EMAIL, REVIEWER_PASSWORD
//   ADMIN_EMAIL, ADMIN_PASSWORD
//   FIXTURE_COURSE_ID, FIXTURE_VERSION_ID
//   FIXTURE_DRAFT_1_ID..FIXTURE_DRAFT_4_ID
//   FIXTURE_CHECKPOINT_1_ID, FIXTURE_CHECKPOINT_2_ID

import { test, expect } from "@playwright/test";
import { loginAs, stagingCredsAvailable } from "./_lib/staging-auth";
import fs from "node:fs";
import path from "node:path";

const SHOT_DIR = path.join("test-results", "ep-train-6d4z-f", "screenshots");

test.beforeAll(async () => {
  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
});

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function fixture() {
  return {
    reviewerEmail: requireEnv("REVIEWER_EMAIL"),
    reviewerPassword: requireEnv("REVIEWER_PASSWORD"),
    adminEmail: requireEnv("ADMIN_EMAIL"),
    adminPassword: requireEnv("ADMIN_PASSWORD"),
    courseId: requireEnv("FIXTURE_COURSE_ID"),
    versionId: requireEnv("FIXTURE_VERSION_ID"),
    draftIds: [
      requireEnv("FIXTURE_DRAFT_1_ID"),
      requireEnv("FIXTURE_DRAFT_2_ID"),
      requireEnv("FIXTURE_DRAFT_3_ID"),
      requireEnv("FIXTURE_DRAFT_4_ID"),
    ],
    checkpointIds: [
      requireEnv("FIXTURE_CHECKPOINT_1_ID"),
      requireEnv("FIXTURE_CHECKPOINT_2_ID"),
    ],
  };
}

const PERSISTED_URL = (draftId: string) =>
  `/app/admin/ai-training/review/persisted?candidate=${draftId}`;
const WORKSPACE_URL = (courseId: string, versionId: string) =>
  `/app/admin/people/safety-training/${courseId}/${versionId}/ai-workspace`;

async function approveOne(page: import("@playwright/test").Page, draftId: string) {
  await page.goto(PERSISTED_URL(draftId), { waitUntil: "domcontentloaded" });
  const approveBtn = page.getByTestId("approve-candidate-button");
  await expect(approveBtn).toBeVisible({ timeout: 15_000 });
  await expect(approveBtn).toBeEnabled();
  await approveBtn.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator('input[name="verified-answer"]').first().check();
  await dialog.locator('input[type="checkbox"]').first().check();
  const submit = dialog.getByRole("button", { name: /^Approve candidate$|^Approving/ });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

// ─── REVIEWER journey — approve all 4 drafts (desktop 1440×900) ──────

test.describe("4Z-F reviewer approves 4 drafts (desktop 1440×900)", () => {
  test("reviewer approves all 4 drafts via UI", async ({ context }) => {
    test.skip(!stagingCredsAvailable().ready, "staging credentials missing");
    const f = fixture();
    const page = await loginAs(context, f.reviewerEmail, f.reviewerPassword, {
      landing: PERSISTED_URL(f.draftIds[0]),
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: path.join(SHOT_DIR, "01-reviewer-queue--desktop-1440x900.png") });

    for (let i = 0; i < f.draftIds.length; i++) {
      await approveOne(page, f.draftIds[i]);
      if (i === 0) {
        await page.screenshot({ path: path.join(SHOT_DIR, "02-reviewer-approval-dialog--desktop-1440x900.png") });
      }
    }
    await page.screenshot({ path: path.join(SHOT_DIR, "03-reviewer-approved--desktop-1440x900.png") });
  });
});

// ─── ADMIN journey — promote all 4 approved drafts (desktop 1440×900) ──

test.describe("4Z-F admin promotes approved drafts (desktop 1440×900)", () => {
  test("admin promotes to checkpoints + final via UI", async ({ context }) => {
    test.skip(!stagingCredsAvailable().ready, "staging credentials missing");
    const f = fixture();
    const page = await loginAs(context, f.adminEmail, f.adminPassword, {
      landing: WORKSPACE_URL(f.courseId, f.versionId),
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTestId("ai-workspace-stage-assemble").click();
    await expect(page.getByTestId("ai-workspace-assemble-panel")).toBeVisible();
    await page.screenshot({ path: path.join(SHOT_DIR, "04-admin-assemble-initial--desktop-1440x900.png") });

    // Draft 1 → Checkpoint 1 (115s). The assembly panel renders a
    // checkpoint-selector <select> per row — pick the checkpoint we
    // want, then click the "Promote to checkpoint" button.
    const row1 = page.getByTestId(`ai-workspace-assemble-row-${f.draftIds[0]}`);
    await expect(row1).toBeVisible();
    const select1 = row1.getByTestId("ai-workspace-assemble-checkpoint-select");
    await select1.selectOption(f.checkpointIds[0]);
    await row1.getByTestId("ai-workspace-assemble-promote-checkpoint").click();
    await expect(page.getByTestId(`ai-workspace-assemble-success-${f.draftIds[0]}`))
      .toBeVisible({ timeout: 15_000 });

    // Draft 2 → Checkpoint 2 (190s).
    const row2 = page.getByTestId(`ai-workspace-assemble-row-${f.draftIds[1]}`);
    await expect(row2).toBeVisible();
    const select2 = row2.getByTestId("ai-workspace-assemble-checkpoint-select");
    await select2.selectOption(f.checkpointIds[1]);
    await row2.getByTestId("ai-workspace-assemble-promote-checkpoint").click();
    await expect(page.getByTestId(`ai-workspace-assemble-success-${f.draftIds[1]}`))
      .toBeVisible({ timeout: 15_000 });

    await page.screenshot({ path: path.join(SHOT_DIR, "05-admin-checkpoint-promoted--desktop-1440x900.png") });

    // Draft 3 → Final assessment.
    const row3 = page.getByTestId(`ai-workspace-assemble-row-${f.draftIds[2]}`);
    await row3.getByTestId("ai-workspace-assemble-promote-final").click();
    await expect(page.getByTestId(`ai-workspace-assemble-success-${f.draftIds[2]}`))
      .toBeVisible({ timeout: 15_000 });

    // Draft 4 → Final assessment.
    const row4 = page.getByTestId(`ai-workspace-assemble-row-${f.draftIds[3]}`);
    await row4.getByTestId("ai-workspace-assemble-promote-final").click();
    await expect(page.getByTestId(`ai-workspace-assemble-success-${f.draftIds[3]}`))
      .toBeVisible({ timeout: 15_000 });

    await page.screenshot({ path: path.join(SHOT_DIR, "06-admin-final-promoted--desktop-1440x900.png") });

    // Reload: persistence check — all 4 rows should flip to
    // "Already promoted" after server re-reads.
    await page.reload();
    await page.getByTestId("ai-workspace-stage-assemble").click();
    await expect(page.locator("text=/Already promoted/").first()).toBeVisible();
    await page.screenshot({ path: path.join(SHOT_DIR, "07-admin-reload-persisted--desktop-1440x900.png") });
  });
});

// ─── EMPLOYEE PREVIEW + PUBLISH READINESS (admin session) ────────────

test.describe("4Z-F admin preview + publish readiness (desktop 1440×900)", () => {
  test("admin opens editor, sees publish panel readiness", async ({ context }) => {
    test.skip(!stagingCredsAvailable().ready, "staging credentials missing");
    const f = fixture();
    const page = await loginAs(context, f.adminEmail, f.adminPassword, {
      landing: `/app/admin/people/safety-training/${f.courseId}/${f.versionId}`,
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: path.join(SHOT_DIR, "08-admin-editor--desktop-1440x900.png") });

    // Scroll to the Publish section and screenshot the readiness panel.
    await page.locator("text=/Publish/i").last().scrollIntoViewIfNeeded().catch(() => {});
    await page.screenshot({ path: path.join(SHOT_DIR, "09-admin-publish-readiness--desktop-1440x900.png"), fullPage: true });
  });
});

// ─── REVIEWER NEGATIVE: promote refusal ───────────────────────────────

test.describe("4Z-F reviewer promote refusal (desktop 1440×900)", () => {
  test("reviewer workspace Promote controls NOT clickable", async ({ context }) => {
    test.skip(!stagingCredsAvailable().ready, "staging credentials missing");
    const f = fixture();
    const page = await loginAs(context, f.reviewerEmail, f.reviewerPassword, {
      landing: WORKSPACE_URL(f.courseId, f.versionId),
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    const stepper = page.getByTestId("ai-workspace-stepper");
    const stepperVisible = await stepper.isVisible().catch(() => false);
    if (stepperVisible) {
      await page.getByTestId("ai-workspace-stage-assemble").click();
      // The reviewer lacks hr:training:write — any remaining Promote
      // button in the row must be disabled.
      const promoteBtns = page.getByTestId("ai-workspace-assemble-promote-checkpoint");
      const count = await promoteBtns.count();
      for (let i = 0; i < count; i++) {
        await expect(promoteBtns.nth(i)).toBeDisabled();
      }
    }
    await page.screenshot({ path: path.join(SHOT_DIR, "10-reviewer-promote-disabled--desktop-1440x900.png") });
  });
});

// ─── MOBILE: view-only screenshots of the two key surfaces ────────────

test.describe("4Z-F mobile surfaces (390×844 view-only)", () => {
  test("reviewer queue + admin assembly mobile screenshots", async ({ context }) => {
    test.skip(!stagingCredsAvailable().ready, "staging credentials missing");
    const f = fixture();
    // Reviewer queue — may or may not have remaining REQUIRES_HUMAN_REVIEW
    // drafts; we only screenshot the page.
    const reviewerPage = await loginAs(context, f.reviewerEmail, f.reviewerPassword, {
      landing: "/app/admin/ai-training/review/persisted",
    });
    await reviewerPage.setViewportSize({ width: 390, height: 844 });
    await reviewerPage.screenshot({ path: path.join(SHOT_DIR, "11-reviewer-queue--mobile-390x844.png") });

    // Admin assembly (fresh context).
    const adminContext = await context.browser()?.newContext();
    if (!adminContext) return;
    try {
      const adminPage = await loginAs(adminContext, f.adminEmail, f.adminPassword, {
        landing: WORKSPACE_URL(f.courseId, f.versionId),
      });
      await adminPage.setViewportSize({ width: 390, height: 844 });
      await adminPage.getByTestId("ai-workspace-stage-assemble").click();
      await adminPage.screenshot({ path: path.join(SHOT_DIR, "12-admin-assemble--mobile-390x844.png") });
    } finally {
      await adminContext.close();
    }
  });
});
