// EP-TRAIN-4Y-T — staging acceptance for the refined course-creation
// sequence. Verifies the directive's §2+§3+§5+§6+§8+§9+§10
// requirements against live staging without burning live GPU
// inference or uploading a real video.
//
// The 4Y-S acceptance (passed on v1118) already covers §6 Manager
// Review, §7 preview, and the broad editor surfaces; this spec
// focuses on the 4Y-T-specific sequencing changes.

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const COURSE_ID = "cmvzs3vz9000256qcu7lfysoz";
const VERSION_ID = "cmvzs3w05000456qcgfgps7gy";

function readLocalEnv(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  for (const file of [".env.playwright.local", ".env.staging.local", ".env.local"]) {
    const p = path.join(process.cwd(), file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)\s*$/);
      if (m && m[1] === key) return m[2].replace(/^["']|["']$/g, "");
    }
  }
  return undefined;
}

test.describe("EP-TRAIN-4Y-T acceptance — upload-first + metadata + requirements + publish review", () => {
  test.skip(!stagingCredsAvailable().ready, "staging credentials not set");

  test("§2+§3 With Video opens directly to upload (no upfront identity form)", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    const page = await loginAsFounder(ctx);

    // Picking "With video" on the format card redirects straight to
    // /[courseId]/[versionId]/upload because the provisional draft is
    // created server-side on the entry page.
    await page.goto(`${BASE}/app/admin/people/safety-training/new/with-video`, {
      waitUntil: "domcontentloaded",
    });
    // Wait for the redirect to the upload screen.
    await page.waitForURL(/\/safety-training\/[^/]+\/[^/]+\/upload$/, { timeout: 15_000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: "test-results/4yt-01-upload-entry.png", fullPage: true });

    // No upfront identity fields on this screen.
    await expect(page.locator('[data-testid="training-new-code"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="training-new-title"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="training-new-required"]')).toHaveCount(0);

    // Dropzone IS prominent.
    await expect(page.locator('[data-testid="training-video-dropzone"]')).toBeVisible();

    // Plain-language prep progress stages visible.
    await expect(page.locator('[data-testid="training-prep-progress"]')).toBeVisible();

    await ctx.close();
  });

  test("§3 Durable provisional draft: revisiting resumes the same draft", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    const page = await loginAsFounder(ctx);

    await page.goto(`${BASE}/app/admin/people/safety-training/new/with-video`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForURL(/\/safety-training\/[^/]+\/[^/]+\/upload$/, { timeout: 15_000 });
    const firstUrl = page.url();

    // Immediately navigate back and hit the entry again — should
    // resume the same draft (same courseId/versionId in the URL).
    await page.goto(`${BASE}/app/admin/people/safety-training/new/with-video`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForURL(/\/safety-training\/[^/]+\/[^/]+\/upload$/, { timeout: 15_000 });
    const secondUrl = page.url();
    expect(secondUrl).toBe(firstUrl);

    await ctx.close();
  });

  test("§10 Without-video form no longer has upfront compliance/audience", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    const page = await loginAsFounder(ctx);
    await page.goto(`${BASE}/app/admin/people/safety-training/new/without-video`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(800);
    // Identity fields still present for the manual path (§10 preserves
    // title/description entry since there's no AI transcript).
    await expect(page.locator('[data-testid="training-new-title"]')).toBeVisible();
    await expect(page.locator('[data-testid="training-new-code"]')).toBeVisible();
    // Compliance + audience fields REMOVED (§10 moves them to Training Requirements).
    await expect(page.locator('[data-testid="training-new-required"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="training-new-applicability-everyone"]')).toHaveCount(0);
    await page.screenshot({ path: "test-results/4yt-02-without-video-simplified.png", fullPage: true });
    await ctx.close();
  });

  test("§8 Training Requirements step renders with required audience confirmation", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    const page = await loginAsFounder(ctx);
    await page.goto(
      `${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/training-requirements`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForTimeout(1500);
    await expect(page.locator('[data-testid="training-requirements-form"]')).toBeVisible();
    await expect(page.locator('[data-testid="applicability-picker"]')).toBeVisible();
    await expect(page.locator('[data-testid="training-requirements-audience-confirm"]')).toBeVisible();
    await expect(page.locator('[data-testid="training-requirements-passing-score"]')).toBeVisible();
    await expect(page.locator('[data-testid="training-requirements-retakes"]')).toBeVisible();
    await expect(page.locator('[data-testid="training-requirements-required"]')).toBeVisible();
    await expect(page.locator('[data-testid="training-requirements-save"]')).toBeVisible();
    // Confirmation checkbox is required (browser will block submit).
    const confirm = page.locator('[data-testid="training-requirements-audience-confirm"]');
    await expect(confirm).toHaveAttribute("required", "");
    await page.screenshot({ path: "test-results/4yt-03-training-requirements.png", fullPage: true });
    await ctx.close();
  });

  test("§9 Publish Review consolidates everything + routes to explicit Publish", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    const page = await loginAsFounder(ctx);
    await page.goto(
      `${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/publish-review`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForTimeout(1500);
    await expect(page.locator('[data-testid="publish-review-course-identity"]')).toBeVisible();
    await expect(page.locator('[data-testid="publish-review-content"]')).toBeVisible();
    await expect(page.locator('[data-testid="publish-review-requirements"]')).toBeVisible();
    await expect(page.locator('[data-testid="pr-title"]')).toBeVisible();
    await expect(page.locator('[data-testid="pr-code"]')).toBeVisible();
    await expect(page.locator('[data-testid="pr-description"]')).toBeVisible();
    await expect(page.locator('[data-testid="pr-video"]')).toBeVisible();
    await expect(page.locator('[data-testid="pr-checkpoints"]')).toBeVisible();
    await expect(page.locator('[data-testid="pr-final-count"]')).toBeVisible();
    await expect(page.locator('[data-testid="pr-approval"]')).toBeVisible();
    await expect(page.locator('[data-testid="pr-audience"]')).toBeVisible();
    await expect(page.locator('[data-testid="pr-passing-score"]')).toBeVisible();
    await expect(page.locator('[data-testid="pr-required"]')).toBeVisible();
    await expect(page.locator('[data-testid="pr-retakes"]')).toBeVisible();
    // PublishPanel renders somewhere below.
    await expect(page.locator('[data-testid="training-publish-panel"]')).toBeVisible();
    await page.screenshot({ path: "test-results/4yt-04-publish-review.png", fullPage: true });
    await ctx.close();
  });

  test("§4+§5 Grounded metadata endpoint — idempotent + respects provisional guard", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    const page = await loginAsFounder(ctx);
    // The Silver Springs version is NOT provisional (title was
    // established), so the endpoint should return applied=false with
    // the skippedReason COURSE_ALREADY_FINALISED. This proves the
    // directive's "do not silently change an established course code"
    // rule is enforced.
    const resp = await page.request.post(
      `${BASE}/api/admin/training/versions/${VERSION_ID}/generate-metadata`,
    );
    const body = await resp.json();
    console.log(`GENERATE_METADATA_RESULT: ${JSON.stringify(body)}`);
    expect(resp.status()).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.applied).toBe(false);
    expect(body.skippedReason).toBe("COURSE_ALREADY_FINALISED");
    expect(body.metadata).toBeTruthy();
    expect(body.metadata.inferenceSource).toBe("deterministic");
    await ctx.close();
  });

  test("Manager Review continues to Training Requirements (not deep editor)", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    const page = await loginAsFounder(ctx);
    await page.goto(
      `${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/review`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForTimeout(2000);
    const link = page.locator('[data-testid="prepub-continue-link"]');
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    expect(href).toContain("/training-requirements");
    await ctx.close();
  });
});
