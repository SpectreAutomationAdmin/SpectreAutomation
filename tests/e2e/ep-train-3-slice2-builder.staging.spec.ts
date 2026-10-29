// EP-TRAIN-3 Slice 2 + 2A (2026-10-29) -- authenticated staging
// acceptance for the Training Builder.
//
// This spec is STRICT: it fails if any of the Builder's required
// sections do not render on the Coulee Ridge Safety & Training admin
// surface.  It does NOT redirect-tolerate -- a session landed on the
// wrong page is a failure.
//
// It uses whichever identity the SPECTRE_STAGING_BUILDER_* envs
// provide (falling back to SPECTRE_STAGING_*).  The identity MUST
// hold hr:training:read + hr:training:write on Coulee Ridge; the
// founder's existing c.s.turcato@gmail.com account currently holds
// PAYROLL_ADMIN only, which fails least-privilege and routes to the
// Employee Directory.  The spec documents that failure clearly rather
// than silently passing on a different page.

import { test, expect } from "@playwright/test";
import path from "node:path";
import { loginAs, loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const outDir = path.resolve(process.cwd(), "test-results/ep-train-3-slice2");

async function loginAsBuilderIdentity(browser: import("@playwright/test").Browser, viewport?: { width: number; height: number }) {
  const email = process.env.SPECTRE_STAGING_BUILDER_EMAIL;
  const password = process.env.SPECTRE_STAGING_BUILDER_PASSWORD;
  const context = await browser.newContext(viewport ? { viewport } : undefined);
  if (email && password) {
    const page = await loginAs(context, email, password);
    return page;
  }
  // Fall back to the founder identity (will reveal perm failures).
  return loginAsFounder(context);
}

test.describe("EP-TRAIN-3 Slice 2 + 2A :: manager training builder (STRICT)", () => {
  test.beforeAll(() => {
    const avail = stagingCredsAvailable();
    if (!avail.ready) test.skip(true, avail.reason!);
  });

  test("Training Builder renders required sections at 1440x900", async ({ browser }) => {
    const page = await loginAsBuilderIdentity(browser, { width: 1440, height: 900 });
    await page.goto(
      "https://staging.spectreautomation.com/app/admin/people/safety-training",
      { waitUntil: "networkidle" },
    );
    // STRICT: must land on the Safety & Training admin, not a redirect.
    expect(page.url(), "must land on safety-training admin index").toContain("/app/admin/people/safety-training");
    await expect(page.getByRole("heading", { name: "Safety & Training" })).toBeVisible();

    // Enter the first course that has a DRAFT version (if any) --
    // if none, the test records the state and fails with a clear
    // message rather than silently passing on an empty catalogue.
    const draftLink = page.locator('a:has-text("Draft")').first();
    const anyLink = page.locator('a[href*="/app/admin/people/safety-training/"]').first();
    if (await draftLink.count() > 0) {
      await draftLink.click();
    } else if (await anyLink.count() > 0) {
      await anyLink.click();
    } else {
      throw new Error("No training courses found on Coulee Ridge; cannot verify Builder.");
    }
    await page.waitForLoadState("networkidle");

    // On the course-detail page, click into any DRAFT version row.
    const draftVersion = page.locator('a:has-text("Draft")').first();
    if (await draftVersion.count() > 0) {
      await draftVersion.click();
      await page.waitForLoadState("networkidle");
    }

    // STRICT assertions on the Builder.
    await expect(page.getByText("Training video", { exact: true })).toBeVisible();
    await expect(page.getByText("Final assessment", { exact: true })).toBeVisible();
    // Interactive checkpoints section is conditional on video presence.
    // If a video is uploaded, the timeline + track MUST render.
    const videoSection = page.getByTestId("training-editor-video-section");
    await expect(videoSection).toBeVisible();
    const checkpointsSection = page.getByTestId("training-editor-checkpoints-section");
    if (await checkpointsSection.count() > 0) {
      await expect(checkpointsSection).toBeVisible();
      await expect(page.getByTestId("training-timeline-track")).toBeVisible();
      await expect(page.getByTestId("training-timeline-video")).toBeVisible();
    }

    await page.screenshot({ path: path.join(outDir, "builder-desktop-1440.png"), fullPage: true });
  });

  for (const [label, w, h] of [["desktop-1920", 1920, 1080], ["mobile-390", 390, 844]] as const) {
    test(`Training Builder screenshot ${label}`, async ({ browser }) => {
      const page = await loginAsBuilderIdentity(browser, { width: w, height: h });
      await page.goto(
        "https://staging.spectreautomation.com/app/admin/people/safety-training",
        { waitUntil: "networkidle" },
      );
      expect(page.url()).toContain("/app/admin/people/safety-training");
      const draftLink = page.locator('a:has-text("Draft")').first();
      const anyLink = page.locator('a[href*="/app/admin/people/safety-training/"]').first();
      if (await draftLink.count() > 0) {
        await draftLink.click();
      } else if (await anyLink.count() > 0) {
        await anyLink.click();
      } else {
        throw new Error("No training courses on Coulee Ridge; cannot screenshot Builder.");
      }
      await page.waitForLoadState("networkidle");
      const draftVersion = page.locator('a:has-text("Draft")').first();
      if (await draftVersion.count() > 0) {
        await draftVersion.click();
        await page.waitForLoadState("networkidle");
      }
      await expect(page.getByText("Final assessment", { exact: true })).toBeVisible();
      await page.screenshot({ path: path.join(outDir, `builder-${label}.png`), fullPage: true });
    });
  }
});
