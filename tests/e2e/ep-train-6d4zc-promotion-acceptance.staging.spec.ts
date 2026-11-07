// EP-TRAIN-6D-4Z-C — Promotion staging acceptance.
//
// Drives the manager-facing promote flow on staging end-to-end:
//   1. Navigate to the AI workspace course assembly stage.
//   2. Click "Promote to checkpoint" on draft #1 (escalation).
//   3. Click "Promote to final" on draft #2 (food-safety).
//   4. Verify success state in the UI.
//   5. Programmatic replay via the authenticated session — proves
//      idempotency (200 + replay=true) and conflicting-destination
//      refusal (409 + ALREADY_PROMOTED_DIFFERENT_DESTINATION).
//
// The manager (founder, CLUB_ADMIN) carries `hr:training:write`,
// which is the ONLY permission the promote endpoint requires. No
// permission grant occurred during this acceptance.
//
// Fixture inputs (env vars):
//   FIXTURE_COURSE_ID
//   FIXTURE_VERSION_ID
//   FIXTURE_URL_PATH
//   FIXTURE_DRAFT_ESCALATION_ID
//   FIXTURE_DRAFT_ESCALATION_HASH
//   FIXTURE_DRAFT_ESCALATION_VALIDATION_ID
//   FIXTURE_DRAFT_FOODSAFETY_ID
//   FIXTURE_DRAFT_FOODSAFETY_HASH
//   FIXTURE_DRAFT_FOODSAFETY_VALIDATION_ID
//   FIXTURE_CHECKPOINT_ID

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";
import fs from "node:fs";
import path from "node:path";

const SHOT_DIR = path.join("test-results", "ep-train-6d4z-c", "screenshots");

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
    courseId: requireEnv("FIXTURE_COURSE_ID"),
    versionId: requireEnv("FIXTURE_VERSION_ID"),
    urlPath: requireEnv("FIXTURE_URL_PATH"),
    escalation: {
      id: requireEnv("FIXTURE_DRAFT_ESCALATION_ID"),
      hash: requireEnv("FIXTURE_DRAFT_ESCALATION_HASH"),
      validationId: requireEnv("FIXTURE_DRAFT_ESCALATION_VALIDATION_ID"),
    },
    foodSafety: {
      id: requireEnv("FIXTURE_DRAFT_FOODSAFETY_ID"),
      hash: requireEnv("FIXTURE_DRAFT_FOODSAFETY_HASH"),
      validationId: requireEnv("FIXTURE_DRAFT_FOODSAFETY_VALIDATION_ID"),
    },
    checkpointId: requireEnv("FIXTURE_CHECKPOINT_ID"),
  };
}

test.describe("4Z-C manager promote (desktop 1440×900)", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test("manager promotes escalation to CHECKPOINT + food-safety to FINAL", async ({ context }) => {
    test.skip(!stagingCredsAvailable().ready, "staging credentials missing");
    const f = fixture();
    const page = await loginAsFounder(context, { landing: f.urlPath });
    await page.setViewportSize({ width: 1440, height: 900 });

    // Go to course assembly stage.
    await page.getByTestId("ai-workspace-stage-assemble").click();
    const panel = page.getByTestId("ai-workspace-assemble-panel");
    await expect(panel).toBeVisible();

    // Both draft rows visible.
    const escRow = page.getByTestId(`ai-workspace-assemble-row-${f.escalation.id}`);
    const fsRow = page.getByTestId(`ai-workspace-assemble-row-${f.foodSafety.id}`);
    await expect(escRow).toBeVisible();
    await expect(fsRow).toBeVisible();

    await page.screenshot({ path: path.join(SHOT_DIR, "01-pre-promote--desktop-1440x900.png") });

    // --- Promote escalation to CHECKPOINT ---
    const escCheckpointBtn = escRow.getByTestId("ai-workspace-assemble-promote-checkpoint");
    await expect(escCheckpointBtn).toBeEnabled();
    await escCheckpointBtn.click();

    // Wait for success text.
    const escSuccess = page.getByTestId(`ai-workspace-assemble-success-${f.escalation.id}`);
    await expect(escSuccess).toBeVisible({ timeout: 15_000 });
    await expect(escSuccess).toContainText(/Promoted/);

    // --- Promote food-safety to FINAL ---
    const fsFinalBtn = fsRow.getByTestId("ai-workspace-assemble-promote-final");
    await expect(fsFinalBtn).toBeEnabled();
    await fsFinalBtn.click();

    const fsSuccess = page.getByTestId(`ai-workspace-assemble-success-${f.foodSafety.id}`);
    await expect(fsSuccess).toBeVisible({ timeout: 15_000 });
    await expect(fsSuccess).toContainText(/Promoted/);

    await page.screenshot({ path: path.join(SHOT_DIR, "02-post-promote--desktop-1440x900.png") });

    // Reload the page and confirm the rows now show "Already promoted"
    // (persisted via the TrainingQuestionAiDraftPromotion sidecar read
    // on page render).
    await page.reload();
    await page.getByTestId("ai-workspace-stage-assemble").click();
    await expect(page.getByTestId("ai-workspace-assemble-panel")).toBeVisible();
    await expect(page.getByText(/Already promoted/).first()).toBeVisible();
    await page.screenshot({ path: path.join(SHOT_DIR, "03-reload-already-promoted--desktop-1440x900.png") });
  });

  test("programmatic idempotency replay + conflicting-destination refusal", async ({ context }) => {
    test.skip(!stagingCredsAvailable().ready, "staging credentials missing");
    const f = fixture();
    // Prime the session cookie by logging in; use page.request from
    // the authenticated context for the API calls.
    const page = await loginAsFounder(context, { landing: f.urlPath });

    const promoteUrl = `/api/admin/ai-training/drafts/${f.escalation.id}/promote`;

    // Replay: same destination → 200 + replay=true.
    const replay = await page.request.post(promoteUrl, {
      data: {
        destination: { kind: "CHECKPOINT", checkpointId: f.checkpointId },
        expectedDraftContentHash: f.escalation.hash,
        expectedValidationId: f.escalation.validationId,
      },
    });
    const replayText = await replay.text();
    if (replay.status() !== 200) {
      console.log("REPLAY_FAIL_STATUS:" + replay.status());
      console.log("REPLAY_FAIL_BODY:" + replayText);
    }
    expect(replay.status()).toBe(200);
    const replayBody = await replay.json();
    expect(replayBody.ok).toBe(true);
    expect(replayBody.replay).toBe(true);
    expect(replayBody.destinationKind).toBe("CHECKPOINT");

    // Conflict: same draft to a DIFFERENT destination → 409.
    const conflict = await page.request.post(promoteUrl, {
      data: {
        destination: { kind: "FINAL_ASSESSMENT" },
        expectedDraftContentHash: f.escalation.hash,
        expectedValidationId: f.escalation.validationId,
      },
    });
    expect(conflict.status()).toBe(409);
    const conflictBody = await conflict.json();
    expect(conflictBody.error).toBe("promotion_rejected");
    expect(conflictBody.rejectionCode).toBe("ALREADY_PROMOTED_DIFFERENT_DESTINATION");
  });
});
