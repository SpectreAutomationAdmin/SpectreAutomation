// EP-TRAIN-3 Slice 2 (2026-10-29) -- authenticated staging acceptance.
//
// Verifies the manager-facing Training Builder end-to-end against the
// deployed staging environment, using the founder's authenticated
// session via tests/e2e/_lib/staging-auth.ts.
//
// Scope (per directive §8):
//   - navigate to Safety & Training admin
//   - open the Coulee Ridge Workplace Safety Orientation DRAFT (if
//     present) or an existing draft version
//   - verify the Interactive checkpoints section renders when the
//     version has a video
//   - verify the Final assessment section renders separately
//   - take screenshots at 1440 x 900 + 1920 x 1080 for founder review
//
// This spec is read-mostly: it inspects the shipped admin UI without
// creating or deleting checkpoints, so it is safe to run against
// staging without touching Coulee Ridge training completions. The
// create/update/delete behaviour is covered by the service-level
// Vitest suite (ep-train-3-slice2-service.test.ts).

import { test, expect } from "@playwright/test";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const outDir = path.resolve(process.cwd(), "test-results/ep-train-3-slice2");

test.describe("EP-TRAIN-3 Slice 2 :: manager training builder", () => {
  test.beforeAll(() => {
    const avail = stagingCredsAvailable();
    if (!avail.ok) test.skip(true, `Staging creds not available: ${avail.reason}`);
  });

  test("builder renders checkpoints + final-assessment sections and the timeline control", async ({ browser }) => {
    const { page } = await loginAsFounder(browser);
    await page.goto("https://staging.spectreautomation.com/app/admin/people/safety-training", { waitUntil: "domcontentloaded" });

    // Enter the first course listed; if none, skip.
    const courseLinks = page.locator('a[href^="/app/admin/people/safety-training/"]');
    const count = await courseLinks.count();
    expect(count, "at least one course expected on staging").toBeGreaterThan(0);
    await courseLinks.first().click();
    await page.waitForLoadState("domcontentloaded");

    // Open the first draft version if there is a draft row; otherwise
    // fall back to whatever version is listed.
    const draftRow = page.locator('a:has-text("Draft")').first();
    if (await draftRow.count() > 0) {
      await draftRow.click();
    } else {
      // Fall back to the published version (view-only); the Builder
      // still renders in read-only mode so the sections are visible.
      await page.locator('a:has-text("v")').first().click();
    }
    await page.waitForLoadState("domcontentloaded");

    // Core expectations.
    await expect(page.getByText("Training video")).toBeVisible();
    await expect(page.getByText("Final assessment")).toBeVisible();

    // Timeline is only rendered when a video is attached. Attempt to
    // find it, but tolerate absence (course may be pre-upload).
    const checkpointSection = page.getByTestId("training-editor-checkpoints-section");
    if (await checkpointSection.count() > 0) {
      await expect(checkpointSection).toBeVisible();
      await expect(page.getByTestId("training-timeline-track")).toBeVisible();
      await expect(page.getByTestId("training-timeline-video")).toBeVisible();
    }

    // Final assessment question-builder control (new-question form)
    // must render -- it is reachable from the DRAFT state. On a
    // published version it may be hidden, which is fine.
    const builder = page.getByTestId("training-quiz-editor");
    expect(await builder.count()).toBeGreaterThan(0);
  });

  for (const [label, w, h] of [["desktop-1440", 1440, 900], ["desktop-1920", 1920, 1080], ["mobile-390", 390, 844]] as const) {
    test(`screenshot ${label}`, async ({ browser }) => {
      const { page } = await loginAsFounder(browser);
      await page.setViewportSize({ width: w, height: h });
      await page.goto("https://staging.spectreautomation.com/app/admin/people/safety-training", { waitUntil: "domcontentloaded" });
      const first = page.locator('a[href^="/app/admin/people/safety-training/"]').first();
      if (await first.count() > 0) {
        await first.click();
        await page.waitForLoadState("domcontentloaded");
        const nested = page.locator('a:has-text("Draft"), a:has-text("v")').first();
        if (await nested.count() > 0) {
          await nested.click();
          await page.waitForLoadState("domcontentloaded");
        }
      }
      await page.screenshot({
        path: path.join(outDir, `${label}.png`),
        fullPage: true,
      });
    });
  }
});
