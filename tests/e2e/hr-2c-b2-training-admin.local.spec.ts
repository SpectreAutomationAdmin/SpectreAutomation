// HR-2C B2 (2026-08-20) — Admin Safety & Training Playwright acceptance.
//
// Walks the founder-mandated admin path:
//   People → Safety & Training → Create course → configure
//   applicability → upload short synthetic MP4 → add 3 questions →
//   choose correct answers → set passing score → Publish
//
// Uses the seed admin (`admin@silversprings.club`) via the dev-only
// quick-login form. All mutations flow through the real B1 services
// via the B2 server actions (§25). No direct DB writes from this spec.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/hr-2c-b2");
fs.mkdirSync(OUT, { recursive: true });

// Tiny valid MP4 (bytes for the "ftyp isom" atom + zero payload).
// Not playable but passes the MIME + size validation.
const TINY_MP4 = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
  0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
]);

async function loginAsAdmin(page: import("@playwright/test").Page) {
  await page.goto("http://localhost:3000/login");
  await page
    .locator('form:has(input[name="email"][value="admin@silversprings.club"]) button')
    .first()
    .click();
  await page.waitForURL(/\/app/, { timeout: 30_000 });
}

test.describe("HR-2C B2 · Admin Safety & Training", () => {
  test.describe.configure({ mode: "serial" });
  test.slow();

  test("catalogue renders + Create button reachable", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("http://localhost:3000/app/admin/people/safety-training");
    await expect(page.locator("h1")).toContainText("Safety & Training");
    await expect(page.locator('[data-testid="training-create-course"]')).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "01-catalogue-empty.png"), fullPage: true });
  });

  test("create course → configure applicability → upload video → add 3 questions → publish", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("http://localhost:3000/app/admin/people/safety-training");
    await Promise.all([
      page.waitForURL(/\/safety-training\/new/, { timeout: 20_000 }),
      page.locator('[data-testid="training-create-course"]').click(),
    ]);

    // Fill Create Course form.
    const suffix = String(Date.now()).slice(-8);
    const code = `HR2C_B2_${suffix}`;
    await page.locator('[data-testid="training-new-code"]').fill(code);
    await page.locator('[data-testid="training-new-category"]').selectOption("Safety");
    await page.locator('[data-testid="training-new-title"]').fill("Workplace Safety Orientation");
    await page.locator('[data-testid="training-new-applicability-everyone"]').check();
    await Promise.all([
      page.waitForURL(/\/safety-training\/[^/]+\/[^/]+$/, { timeout: 20_000 }),
      page.locator('[data-testid="training-new-submit"]').click(),
    ]);

    // Editor renders as DRAFT.
    await expect(page.locator('[data-testid="training-version-state"]')).toContainText("Draft");
    await expect(page.locator('[data-testid="training-editor-title"]')).toHaveValue("Workplace Safety Orientation");
    await page.screenshot({ path: path.join(OUT, "02-editor-draft-fresh.png"), fullPage: true });

    // Save draft with description + passing score.
    await page.locator('[data-testid="training-editor-description"]').fill(
      "Everyone must complete this before scheduling.",
    );
    await page.locator('[data-testid="training-editor-passing-score"]').fill("80");
    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      page.locator('[data-testid="training-editor-save"]').click(),
    ]);

    // Upload video.
    const videoPath = path.join(OUT, "tiny-fixture.mp4");
    fs.writeFileSync(videoPath, TINY_MP4);
    await page.locator('[data-testid="training-video-input"]').setInputFiles(videoPath);
    // Wait for the video-preview <video> element to appear.
    await expect(page.locator('[data-testid="training-video-preview"]')).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: path.join(OUT, "03-video-uploaded.png"), fullPage: true });

    // Add 3 questions.
    for (let i = 1; i <= 3; i++) {
      await page.locator('[data-testid="training-question-new-prompt"]').fill(`Question ${i}: pick option ${i}?`);
      // Ensure enough options exist (default 2, we need 3 for later coverage).
      const addBtn = page.locator('[data-testid="training-question-new-add-option"]');
      await addBtn.click();
      const opt0 = page.locator('[data-testid="training-question-new-option-0"]');
      const opt1 = page.locator('[data-testid="training-question-new-option-1"]');
      const opt2 = page.locator('[data-testid="training-question-new-option-2"]');
      await opt0.fill(`Wrong A ${i}`);
      await opt1.fill(`Wrong B ${i}`);
      await opt2.fill(`Correct ${i}`);
      // Mark option 2 (index 2) correct.
      await page.locator('[data-testid="training-question-new-correct-2"]').check();
      await Promise.all([
        page.waitForLoadState("domcontentloaded"),
        page.locator('[data-testid="training-question-new-submit"]').click(),
      ]);
    }
    // 3 question cards render.
    const questionCards = page.locator('[data-testid^="training-question-"][data-testid$=""]').locator('form');
    // Simpler: count the delete buttons — one per persisted question.
    await expect(page.locator('[data-testid$="-delete"]')).toHaveCount(3);
    await page.screenshot({ path: path.join(OUT, "04-quiz-3-questions.png"), fullPage: true });

    // Publish panel reports ready.
    await expect(page.locator('[data-testid="training-publish-panel"]')).toHaveAttribute("data-ready", "true");
    // Publish!
    await Promise.all([
      page.waitForURL(new RegExp(`/safety-training/[^/]+$`), { timeout: 20_000 }),
      page.locator('[data-testid="training-publish-submit"]').click(),
    ]);

    // Course detail now shows a PUBLISHED version.
    await expect(page.locator('[data-testid^="training-version-"]')).toContainText(/PUBLISHED/i);
    await page.screenshot({ path: path.join(OUT, "05-published-course-detail.png"), fullPage: true });

    // Catalogue reflects the published course.
    await page.goto("http://localhost:3000/app/admin/people/safety-training");
    await expect(page.locator('[data-testid="training-active-courses"]')).toContainText("Workplace Safety Orientation");
    await expect(page.locator('[data-testid="training-active-courses"]')).toContainText("Published");
    await page.screenshot({ path: path.join(OUT, "06-catalogue-published.png"), fullPage: true });
  });

  test("readiness list is shown when a draft is incomplete", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("http://localhost:3000/app/admin/people/safety-training");
    await Promise.all([
      page.waitForURL(/\/safety-training\/new/, { timeout: 20_000 }),
      page.locator('[data-testid="training-create-course"]').click(),
    ]);
    // Create with no video/questions — publish should be gated.
    const code = `HR2C_B2_INCOMPLETE_${String(Date.now()).slice(-8)}`;
    await page.locator('[data-testid="training-new-code"]').fill(code);
    await page.locator('[data-testid="training-new-category"]').selectOption("Safety");
    await page.locator('[data-testid="training-new-title"]').fill("Incomplete Draft");
    await page.locator('[data-testid="training-new-applicability-explicit"]').check();
    await Promise.all([
      page.waitForURL(/\/safety-training\/[^/]+\/[^/]+$/, { timeout: 20_000 }),
      page.locator('[data-testid="training-new-submit"]').click(),
    ]);
    // Publish panel says NOT ready + lists reasons from the canonical service.
    await expect(page.locator('[data-testid="training-publish-panel"]')).toHaveAttribute("data-ready", "false");
    await expect(page.locator('[data-testid="training-publish-readiness-reasons"]')).toContainText("Training video is required");
    await expect(page.locator('[data-testid="training-publish-readiness-reasons"]')).toContainText(/knowledge test.*at least one active question/i);
    await page.screenshot({ path: path.join(OUT, "07-publish-not-ready.png"), fullPage: true });
  });
});
