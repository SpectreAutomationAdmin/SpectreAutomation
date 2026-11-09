// EP-TRAIN-4Y-U — staging acceptance for the review-interface
// simplification + truthful progress + metadata-on-transcript-ready
// fix. Verifies the §5+§6+§8 changes on live staging without
// triggering any GPU inference.
//
// The founder-reported course `cmw8n6z8f0008z4nxck6uvms9` /
// `cmw8n6z9a000az4nx56vwh02f` is the primary target for the
// visual-state checks: the transcript exists but no generation run
// does, so this is the exact scenario the simplified UI must handle
// truthfully.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
// Founder-reported course from the directive. Verified against
// staging by scripts/4yu-diagnose-chain.mjs.
const COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";
const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";
// Silver Springs (full chain complete — comparison baseline).
const SS_COURSE_ID = "cmvzs3vz9000256qcu7lfysoz";
const SS_VERSION_ID = "cmvzs3w05000456qcgfgps7gy";

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

test.describe("EP-TRAIN-4Y-U acceptance — review simplification + truthful progress", () => {
  test.skip(!stagingCredsAvailable().ready, "staging credentials not set");

  test("§6 Founder course: upload page stays put when generation hasn't produced drafts", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    const page = await loginAsFounder(ctx);
    // Visit the founder course's upload page directly.
    await page.goto(
      `${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/upload`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForTimeout(2000);
    // The page must NOT auto-redirect to /review — it stays on /upload
    // because no drafts exist yet.
    expect(page.url()).toContain(`/${VERSION_ID}/upload`);
    // Preparation progress is visible with a current stage.
    await expect(page.locator('[data-testid="training-prep-progress"]')).toBeVisible({ timeout: 15_000 });
    // Manual GPU-authorisation trigger must be visible because the
    // transcript is ready but the generation run was never queued.
    await expect(page.locator('[data-testid="training-prep-manual-generation"]')).toBeVisible();
    await expect(page.locator('[data-testid="training-prep-run-generation"]')).toBeVisible();
    await page.screenshot({ path: "test-results/4yu-01-founder-upload-truthful.png", fullPage: true });
    await ctx.close();
  });

  test("§6 Founder course: review page shows truthful empty-drafts state", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    const page = await loginAsFounder(ctx);
    await page.goto(
      `${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/review`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForTimeout(2000);
    await expect(page.locator('[data-testid="manager-review-no-drafts"]')).toBeVisible();
    await expect(page.locator('[data-testid="manager-review-return-to-prep"]')).toBeVisible();
    await page.screenshot({ path: "test-results/4yu-02-founder-review-empty-truthful.png", fullPage: true });
    await ctx.close();
  });

  test("§5 Review surface no longer renders the three redundant cards (Silver Springs)", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    const page = await loginAsFounder(ctx);
    await page.goto(
      `${BASE}/app/admin/people/safety-training/${SS_COURSE_ID}/${SS_VERSION_ID}/review`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForTimeout(2500);
    // Approval Status card — REMOVED
    await expect(page.locator('[data-testid="manager-review-approval-status"]')).toHaveCount(0);
    // Pre-publish summary card — REMOVED
    await expect(page.locator('[data-testid="manager-review-prepublish-summary"]')).toHaveCount(0);
    // The standalone "Checkpoints" card below the video is gone; the
    // markers now render inline inside the video card as chips.
    const markers = page.locator('[data-testid="manager-review-timeline-markers"]');
    // 0 OR 1 depending on whether Silver Springs has any checkpoints.
    // Either way, the standalone card section header is gone.
    const standaloneCardHeaders = page.locator(
      'section.card:not([data-testid]) >> h3:has-text("Checkpoints (")',
    );
    await expect(standaloneCardHeaders).toHaveCount(0);
    // Question pane IS present (not removed).
    await expect(page.locator('[data-testid="manager-review-question-pane"]')).toBeVisible();
    await page.screenshot({ path: "test-results/4yu-03-ss-review-simplified.png", fullPage: true });
    await ctx.close();
  });

  test("§8 Metadata endpoint still refuses to overwrite an established course (Silver Springs)", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    const page = await loginAsFounder(ctx);
    const resp = await page.request.post(
      `${BASE}/api/admin/training/versions/${SS_VERSION_ID}/generate-metadata`,
    );
    const body = await resp.json();
    expect(resp.status()).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.applied).toBe(false);
    expect(body.skippedReason).toBe("COURSE_ALREADY_FINALISED");
    await ctx.close();
  });

  test("§8 Metadata endpoint applies to the founder-provisional course (deterministic, no GPU)", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    const page = await loginAsFounder(ctx);
    // On the founder course, the transcript IS present (same sha256
    // as the Silver Springs pilot — shared build row). The route
    // SHOULD apply deterministic metadata because the course is
    // still at AUTO-DRAFT placeholders.
    const resp = await page.request.post(
      `${BASE}/api/admin/training/versions/${VERSION_ID}/generate-metadata`,
    );
    const body = await resp.json();
    console.log(`4YU_FOUNDER_METADATA: ${JSON.stringify(body).slice(0, 400)}`);
    expect(resp.status()).toBe(200);
    expect(body.ok).toBe(true);
    // Idempotent-aware assertion: first run applies deterministic
    // metadata; subsequent runs on the same course return
    // COURSE_ALREADY_FINALISED. Either outcome proves the
    // deterministic path works — we confirm the course is no longer
    // at the "Untitled training course" placeholder by inspecting
    // the server state.
    if (body.applied) {
      expect(body.metadata).toBeTruthy();
      expect(body.metadata.inferenceSource).toBe("deterministic");
      expect(body.metadata.title.length).toBeGreaterThanOrEqual(3);
      expect(body.metadata.description.length).toBeGreaterThan(10);
    } else {
      expect(body.skippedReason).toBe("COURSE_ALREADY_FINALISED");
      // Verify the course is no longer at the provisional placeholder.
      const serverState = await page.request.get(
        `${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}`,
        { headers: { Accept: "text/html" } },
      );
      const html = await serverState.text();
      expect(html).not.toContain("Untitled training course");
    }
    await ctx.close();
  });
});
