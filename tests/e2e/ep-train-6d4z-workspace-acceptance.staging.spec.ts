// EP-TRAIN-6D-4Z — Manager workflow staging acceptance (authenticated
// Playwright). Executes the §5 12-step manager journey on staging
// and captures the §8 eight screenshot surfaces at 1440×900 +
// 390×844.
//
// Precondition: the synthetic workflow fixture
// (scripts/ep-train-6d4z-synthetic-fixture.mjs) has been seeded to
// staging. The fixture's console output lines are the only inputs
// this spec needs — they're injected via env vars:
//
//   FIXTURE_COURSE_ID=...
//   FIXTURE_VERSION_ID=...
//   FIXTURE_URL_PATH=/app/admin/people/safety-training/.../ai-workspace
//
// The spec does NOT publish or assign employees. It verifies the
// workspace surfaces state truthfully and never fabricates a success.
//
// NEVER runs against production — the staging-auth helper's baseURL
// defaults to staging.spectreautomation.com.

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";
import fs from "node:fs";
import path from "node:path";

const SCREENSHOT_DIR = path.join(
  "test-results",
  "ep-train-6d4z",
  "screenshots",
);

test.beforeAll(async () => {
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }
});

function requireFixture() {
  const p = process.env.FIXTURE_URL_PATH;
  const course = process.env.FIXTURE_COURSE_ID;
  const version = process.env.FIXTURE_VERSION_ID;
  if (!p || !course || !version) {
    throw new Error(
      "Fixture env vars missing: set FIXTURE_URL_PATH, FIXTURE_COURSE_ID, FIXTURE_VERSION_ID before running this spec.",
    );
  }
  return { path: p, course, version };
}

function shotName(name: string, viewport: string): string {
  return path.join(SCREENSHOT_DIR, `${name}--${viewport}.png`);
}

const VIEWPORTS: Array<{ name: string; width: number; height: number }> = [
  { name: "desktop-1440x900", width: 1440, height: 900 },
  { name: "mobile-390x844", width: 390, height: 844 },
];

for (const vp of VIEWPORTS) {
  test.describe(`4Z workspace acceptance (${vp.name})`, () => {
    test("8 workspace surfaces", async ({ context }) => {
      test.skip(!stagingCredsAvailable().ready, "staging credentials missing");
      const { path: url, course, version } = requireFixture();
      const page = await loginAsFounder(context, { landing: url });
      await page.setViewportSize({ width: vp.width, height: vp.height });

      // 01 — workspace overview + stepper.
      await expect(page.getByTestId("ai-workspace-stepper")).toBeVisible();
      for (const key of [
        "video", "transcription", "plan", "generate",
        "review", "assemble", "preview", "publish",
      ]) {
        await expect(page.getByTestId(`ai-workspace-stage-${key}`)).toBeVisible();
      }
      await page.screenshot({ path: shotName("01-workspace-overview", vp.name) });

      // 02 — video stage.
      await page.getByTestId("ai-workspace-stage-video").click();
      await expect(page.getByTestId("ai-workspace-video-panel")).toBeVisible();
      await page.screenshot({ path: shotName("02-video-stage", vp.name) });

      // 03 — transcription stage (fixture seeds COMPLETED).
      await page.getByTestId("ai-workspace-stage-transcription").click();
      const tp = page.getByTestId("ai-workspace-transcription-panel");
      await expect(tp).toBeVisible();
      await expect(tp).toHaveAttribute("data-state", "COMPLETED");
      await page.screenshot({ path: shotName("03-transcription", vp.name) });

      // 04 — assessment plan stage.
      await page.getByTestId("ai-workspace-stage-plan").click();
      await expect(page.getByTestId("ai-workspace-plan-panel")).toBeVisible();
      await page.screenshot({ path: shotName("04-assessment-plan", vp.name) });

      // 05 — generation status.
      await page.getByTestId("ai-workspace-stage-generate").click();
      const gp = page.getByTestId("ai-workspace-generate-panel");
      await expect(gp).toBeVisible();
      await expect(page.getByTestId("ai-workspace-generate-breakdown")).toBeVisible();
      await page.screenshot({ path: shotName("05-generation-status", vp.name) });

      // 06 — review stage.
      await page.getByTestId("ai-workspace-stage-review").click();
      await expect(page.getByTestId("ai-workspace-review-panel")).toBeVisible();
      await page.screenshot({ path: shotName("06-review", vp.name) });

      // 07 — course assembly stage (one APPROVED_DRAFT row from fixture).
      await page.getByTestId("ai-workspace-stage-assemble").click();
      await expect(page.getByTestId("ai-workspace-assemble-panel")).toBeVisible();
      await page.screenshot({ path: shotName("07-course-assembly", vp.name) });

      // 08 — publication readiness stage.
      await page.getByTestId("ai-workspace-stage-publish").click();
      await expect(page.getByTestId("ai-workspace-publish-panel")).toBeVisible();
      await page.screenshot({ path: shotName("08-publication-readiness", vp.name) });
    });
  });
}

test.describe("4Z workspace workflow usability (desktop 1440x900)", () => {
  test("editor ↔ workspace context navigation", async ({ context }) => {
    test.skip(!stagingCredsAvailable().ready, "staging credentials missing");
    const { course, version } = requireFixture();
    const editorUrl = `/app/admin/people/safety-training/${course}/${version}`;
    const page = await loginAsFounder(context, { landing: editorUrl });
    await page.setViewportSize({ width: 1440, height: 900 });

    const link = page.getByTestId("training-editor-ai-workspace-link");
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(new RegExp(`${version}/ai-workspace$`));

    const back = page.locator('a:has-text("Back to version editor")').first();
    await expect(back).toBeVisible();
    await back.click();
    await expect(page).toHaveURL(new RegExp(`${version}/?$`));
  });
});
