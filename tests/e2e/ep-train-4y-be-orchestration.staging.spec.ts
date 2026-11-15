/**
 * EP-TRAIN-4Y-BE — real-browser acceptance on staging.
 *
 * The product rule under test: a manager uploads a video and does
 * nothing else. Spectre prepares the course and the review screen
 * appears. No test below clicks, confirms, resumes or refreshes to make
 * processing happen.
 *
 * NO BILLABLE PROCESSING. Every upload carries the staging-only
 * `x-spectre-training-inference: mock` header; the server refuses the
 * upload outright if mock mode is not enabled, so a test can never fall
 * through to real processing. Mock questions are labelled
 * "MOCK INFERENCE". These tests prove the automatic workflow; they do
 * NOT prove that real AI generation works. The video is the already
 * transcribed staging video, so no transcription call is made either.
 *
 * The real, previously blocked course is only LOOKED AT (test 5).
 */
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";
import fs from "node:fs";

const REAL_BLOCKED_COURSE_ID = "cmwgxzh6j000e54dnh62vwznu";
const REAL_BLOCKED_VERSION_ID = "cmwgxzh7e000g54dn2btx5kfp";
const OUT = "test-results/4ybe";

/** Words a club manager must never see on these screens. */
const FORBIDDEN = /\$\s?\d|\bcosts?\b|\bbudget|\bGPU\b|\bModal\b|authoriz|\binference\b|Continue preparation|Confirm and continue|\bResume\b/i;

interface StageJson { id: string; status: string; blockedReason: string | null; failureReason: string | null }
interface StatusJson {
  overall: { outcome: string; weightedPercent: number; generationShortfall: unknown };
  stages: StageJson[];
}

async function readStatus(ctx: BrowserContext, base: string, versionId: string): Promise<StatusJson> {
  const r = await ctx.request.get(`${base}/api/admin/training/versions/${versionId}/preparation-status`);
  expect(r.status()).toBe(200);
  return (await r.json()) as StatusJson;
}

async function videoBytes(ctx: BrowserContext, base: string): Promise<Buffer> {
  const video = await ctx.request.get(
    `${base}/api/hr/training/versions/${REAL_BLOCKED_VERSION_ID}/video`,
    { timeout: 120_000 },
  );
  expect(video.ok()).toBe(true);
  const bytes = await video.body();
  expect(bytes.length).toBeGreaterThan(1_000_000);
  return bytes;
}

/** Create a With-Video course through the real UI and upload once. */
async function uploadOnce(
  ctx: BrowserContext,
  page: Page,
  base: string,
  bytes: Buffer,
  testHeaders: Record<string, string>,
): Promise<{ courseId: string; versionId: string; uploadUrl: string; upload: { status: number; body: { preparation?: { action: string } | null } | null } }> {
  let uploadResult: { status: number; body: { preparation?: { action: string } | null } | null } | null = null;
  await ctx.unroute("**/api/hr/training/versions/*/video").catch(() => undefined);
  await ctx.route("**/api/hr/training/versions/*/video", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const resp = await route.fetch({
      headers: { ...route.request().headers(), "x-spectre-training-inference": "mock", ...testHeaders },
      timeout: 180_000,
    });
    let body = null;
    try { body = await resp.json(); } catch { /* non-JSON */ }
    uploadResult = { status: resp.status(), body };
    await route.fulfill({ response: resp });
  });
  await page.goto(`${base}/app/admin/people/safety-training/new/with-video`, { waitUntil: "domcontentloaded" });
  await page.waitForURL(/\/safety-training\/[^/]+\/[^/]+\/upload$/, { timeout: 30_000 });
  const m = page.url().match(/safety-training\/([^/]+)\/([^/]+)\/upload$/)!;
  const uploadUrl = page.url();
  await page.locator('[data-testid="training-video-uploader"] input[type="file"]').setInputFiles({
    name: "be-acceptance-mock.mp4",
    mimeType: "video/mp4",
    buffer: bytes,
  });
  await expect.poll(() => uploadResult, { timeout: 180_000, intervals: [1000] }).not.toBeNull();
  expect(uploadResult!.status).toBe(201);
  return { courseId: m[1], versionId: m[2], uploadUrl, upload: uploadResult! };
}

async function expectReviewReady(page: Page): Promise<{ markers: number; checkpointTab: string; finalTab: string }> {
  await expect(page.getByTestId("manager-review-mode-checkpoints")).toBeVisible({ timeout: 30_000 });
  const checkpointTab = (await page.getByTestId("manager-review-mode-checkpoints").innerText()).replace(/\s+/g, " ");
  const finalTab = (await page.getByTestId("manager-review-mode-final").innerText()).replace(/\s+/g, " ");
  expect(checkpointTab).toMatch(/\b5\b/);
  expect(finalTab).toMatch(/\b8\b/);
  await expect(page.getByTestId("manager-review-question-text")).toContainText("MOCK INFERENCE");
  const markers = await page.locator('[data-testid^="portal-course-checkpoint-marker-"]').count();
  return { markers, checkpointTab, finalTab };
}

test.describe("EP-TRAIN-4Y-BE — upload once, Spectre does the rest (mock processing)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.describe.configure({ mode: "serial" });

  test("1. hands-off: upload → every stage completes → review screen appears on its own", async ({ browser }) => {
    test.setTimeout(8 * 60 * 1000);
    const creds = stagingCredsAvailable();
    test.skip(!creds.ready, creds.reason ?? "staging creds missing");
    fs.mkdirSync(OUT, { recursive: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(ctx);
    const bytes = await videoBytes(ctx, creds.baseURL);

    // 3 s per mocked model call so the stages are observable in flight.
    const up = await uploadOnce(ctx, page, creds.baseURL, bytes, { "x-spectre-training-mock-delay-ms": "3000" });
    expect(up.upload.body?.preparation?.action).toBe("GENERATION_ENQUEUED");

    // ── Hands off. No clicks, no reloads, no navigation. ──
    const timeline: string[] = [];
    const t0 = Date.now();
    let sawRunning = false;
    let preparationText = "";
    while (!/\/review/.test(page.url()) && Date.now() - t0 < 5 * 60 * 1000) {
      const s = await readStatus(ctx, creds.baseURL, up.versionId);
      const line = `${s.overall.outcome} ${s.overall.weightedPercent}% | ${s.stages.map((x) => `${x.id}=${x.status}`).join(" ")}`;
      if (timeline[timeline.length - 1]?.split(" @")[0] !== line) timeline.push(`${line} @+${Math.round((Date.now() - t0) / 1000)}s`);
      if (s.stages.some((x) => x.status === "RUNNING" || x.status === "QUEUED")) {
        if (!sawRunning) {
          sawRunning = true;
          const card = page.getByTestId("training-prep-progress");
          if (await card.isVisible().catch(() => false)) {
            preparationText = await card.innerText();
            await page.screenshot({ path: `${OUT}/1-in-flight.png`, fullPage: true });
            // Read-only screen: nothing to press, nothing about cost.
            expect(await card.locator("button").count()).toBe(0);
            expect(preparationText).not.toMatch(FORBIDDEN);
          }
        }
      }
      await page.waitForTimeout(1500);
    }
    await page.waitForURL(/\/review/, { timeout: 60_000 });
    const review = await expectReviewReady(page);
    await page.screenshot({ path: `${OUT}/1-review.png`, fullPage: true });
    expect(review.markers).toBe(5);
    const final = await readStatus(ctx, creds.baseURL, up.versionId);
    expect(final.overall.outcome).toBe("READY_FOR_REVIEW");
    fs.writeFileSync(`${OUT}/1-hands-off.json`, JSON.stringify({ ...up, upload: up.upload.body, timeline, review, sawRunning }, null, 2));
    expect(sawRunning).toBe(true);
    await ctx.close();
  });

  test("2. refresh, then leave and come back: processing is not interrupted", async ({ browser }) => {
    test.setTimeout(8 * 60 * 1000);
    const creds = stagingCredsAvailable();
    test.skip(!creds.ready, creds.reason ?? "staging creds missing");
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    let page = await loginAsFounder(ctx);
    const bytes = await videoBytes(ctx, creds.baseURL);
    const up = await uploadOnce(ctx, page, creds.baseURL, bytes, { "x-spectre-training-mock-delay-ms": "5000" });

    await expect
      .poll(async () => (await readStatus(ctx, creds.baseURL, up.versionId)).stages.find((s) => s.id === "checkpoints")!.status, { timeout: 60_000 })
      .toMatch(/RUNNING|QUEUED|COMPLETED/);
    await page.reload({ waitUntil: "domcontentloaded" });
    const afterReload = await readStatus(ctx, creds.baseURL, up.versionId);
    // Leave the screen entirely and close the tab while work is in flight.
    await page.goto(`${creds.baseURL}/app/admin/people/safety-training`, { waitUntil: "domcontentloaded" });
    await page.close();
    await expect
      .poll(async () => (await readStatus(ctx, creds.baseURL, up.versionId)).overall.outcome, { timeout: 4 * 60 * 1000, intervals: [3000] })
      .toBe("READY_FOR_REVIEW");
    // Coming back later: the course is simply ready for review.
    page = await ctx.newPage();
    await page.goto(up.uploadUrl, { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/review/, { timeout: 30_000 });
    const review = await expectReviewReady(page);
    expect(review.markers).toBe(5);
    fs.writeFileSync(`${OUT}/2-refresh-leave.json`, JSON.stringify({ versionId: up.versionId, afterReload: afterReload.overall, review }, null, 2));
    await ctx.close();
  });

  test("3. a missing question is repaired automatically", async ({ browser }) => {
    test.setTimeout(8 * 60 * 1000);
    const creds = stagingCredsAvailable();
    test.skip(!creds.ready, creds.reason ?? "staging creds missing");
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(ctx);
    const bytes = await videoBytes(ctx, creds.baseURL);
    // First pass returns nothing for the first checkpoint.
    const up = await uploadOnce(ctx, page, creds.baseURL, bytes, { "x-spectre-training-mock-fault": "drop-first-checkpoint" });
    await page.waitForURL(/\/review/, { timeout: 4 * 60 * 1000 });
    const review = await expectReviewReady(page);
    expect(review.markers).toBe(5);
    fs.writeFileSync(`${OUT}/3-repair.json`, JSON.stringify({ versionId: up.versionId, review }, null, 2));
    await ctx.close();
  });

  test("4. a course from before automatic preparation: read-only screen, then operator recovery completes it untouched", async ({ browser }) => {
    test.setTimeout(10 * 60 * 1000);
    const creds = stagingCredsAvailable();
    test.skip(!creds.ready, creds.reason ?? "staging creds missing");
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(ctx);
    const bytes = await videoBytes(ctx, creds.baseURL);
    // "hold" leaves the course exactly as a pre-automation upload would be:
    // video + transcript present, nothing authorized, nothing queued.
    const up = await uploadOnce(ctx, page, creds.baseURL, bytes, { "x-spectre-training-hold": "1" });
    expect(up.upload.body?.preparation ?? null).toBeNull();
    await page.goto(up.uploadUrl, { waitUntil: "domcontentloaded" });
    const card = page.getByTestId("training-prep-progress");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("training-prep-stage-objectives-status")).toHaveText(/blocked/i);
    expect(await card.locator("button").count()).toBe(0);
    expect(await card.innerText()).not.toMatch(FORBIDDEN);
    await page.screenshot({ path: `${OUT}/4-held-read-only.png`, fullPage: true });
    // Hand the version id to the operator step, then keep hands off.
    fs.writeFileSync(`${OUT}/4-held-version.txt`, up.versionId);
    await page.waitForURL(/\/review/, { timeout: 8 * 60 * 1000 });
    const review = await expectReviewReady(page);
    expect(review.markers).toBe(5);
    await page.screenshot({ path: `${OUT}/4-recovered-review.png`, fullPage: true });
    await ctx.close();
  });

  test("5. the real blocked course: looked at only — no controls, no cost wording", async ({ browser }) => {
    const creds = stagingCredsAvailable();
    test.skip(!creds.ready, creds.reason ?? "staging creds missing");
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(ctx);
    await page.goto(
      `${creds.baseURL}/app/admin/people/safety-training/${REAL_BLOCKED_COURSE_ID}/${REAL_BLOCKED_VERSION_ID}/upload`,
      { waitUntil: "domcontentloaded" },
    );
    const card = page.getByTestId("training-prep-progress");
    await expect(card).toBeVisible({ timeout: 20_000 });
    expect(await card.locator("button").count()).toBe(0);
    expect(await card.innerText()).not.toMatch(FORBIDDEN);
    await page.screenshot({ path: `${OUT}/5-real-course-read-only.png`, fullPage: true });
    const status = await readStatus(ctx, creds.baseURL, REAL_BLOCKED_VERSION_ID);
    fs.writeFileSync(`${OUT}/5-real-course-status.json`, JSON.stringify(status, null, 2));
    await ctx.close();
  });
});
