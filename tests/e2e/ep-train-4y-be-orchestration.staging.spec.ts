/**
 * EP-TRAIN-4Y-BE — real-browser acceptance on staging.
 *
 * Test 1 (no GPU): the affected course's Continue preparation button
 *   produces a visible response. The course was uploaded before
 *   automatic preparation was authorized, so the expected response is
 *   the cost-confirmation panel. The test CANCELS — it never confirms,
 *   so no billable inference is started.
 *
 * Test 2 (mock inference): a brand-new course is created through the
 *   real upload UI. The upload request carries the staging-only
 *   `x-spectre-training-inference: mock` header, so the worker writes
 *   labelled mock questions instead of calling Modal. Proves the
 *   pipeline advances with no clicks, survives a refresh and a
 *   closed/re-opened page, and lands in manager review. It does NOT
 *   prove that real AI generation works.
 */
import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";
import fs from "node:fs";

const AFFECTED_COURSE_ID = "cmwgxzh6j000e54dnh62vwznu";
const AFFECTED_VERSION_ID = "cmwgxzh7e000g54dn2btx5kfp";
const OUT = "test-results/4ybe";

interface StageJson { id: string; status: string; blockedReason: string | null; failureReason: string | null }
interface StatusJson { overall: { outcome: string; weightedPercent: number }; stages: StageJson[] }

async function readStatus(page: Page, base: string, versionId: string): Promise<StatusJson> {
  const r = await page.request.get(`${base}/api/admin/training/versions/${versionId}/preparation-status`);
  expect(r.status()).toBe(200);
  return (await r.json()) as StatusJson;
}

test.describe("EP-TRAIN-4Y-BE — automatic preparation on staging", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("affected course: Continue preparation gives a visible, cancellable cost confirmation", async ({ browser }) => {
    const creds = stagingCredsAvailable();
    test.skip(!creds.ready, creds.reason ?? "staging creds missing");
    fs.mkdirSync(OUT, { recursive: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(ctx);
    const trace: Array<Record<string, unknown>> = [];
    page.on("response", async (resp) => {
      const url = resp.url();
      if (!/continue-preparation|recover-shortfall|auto-prepare|authorize-recovery/.test(url)) return;
      let body: unknown = null;
      try { body = await resp.json(); } catch { /* non-JSON */ }
      trace.push({ url: url.replace(creds.baseURL, ""), method: resp.request().method(), status: resp.status(), body });
    });

    const before = await readStatus(page, creds.baseURL, AFFECTED_VERSION_ID);
    await page.goto(
      `${creds.baseURL}/app/admin/people/safety-training/${AFFECTED_COURSE_ID}/${AFFECTED_VERSION_ID}/upload`,
      { waitUntil: "domcontentloaded" },
    );
    const button = page.getByTestId("training-prep-start-button");
    await expect(button).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: `${OUT}/affected-1-before-click.png`, fullPage: true });

    await button.click();
    const confirm = page.getByTestId("training-prep-confirm");
    await expect(confirm).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("training-prep-confirm-estimate")).toContainText("$");
    await page.screenshot({ path: `${OUT}/affected-2-confirmation.png`, fullPage: true });
    const confirmText = await confirm.innerText();

    // Cancel — never confirm. No billable inference from this test.
    await page.getByTestId("training-prep-confirm-cancel").click();
    await expect(confirm).toBeHidden();
    await expect(button).toBeEnabled();

    const after = await readStatus(page, creds.baseURL, AFFECTED_VERSION_ID);
    fs.writeFileSync(
      `${OUT}/affected-trace.json`,
      JSON.stringify({ before, trace, confirmText, after }, null, 2),
    );
    expect(trace.some((t) => String(t.url).includes("continue-preparation") && t.status === 200)).toBe(true);
    expect(trace.some((t) => String(t.url).includes("auto-prepare"))).toBe(false);
    const stage = (s: StatusJson, id: string) => s.stages.find((x) => x.id === id)!;
    // Nothing was enqueued: the objectives stage is exactly as it was.
    expect(stage(after, "objectives").status).toBe(stage(before, "objectives").status);
    await ctx.close();
  });

  test("new course: upload → automatic preparation → manager review (mock inference)", async ({ browser }) => {
    test.setTimeout(8 * 60 * 1000);
    const creds = stagingCredsAvailable();
    test.skip(!creds.ready, creds.reason ?? "staging creds missing");
    fs.mkdirSync(OUT, { recursive: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    let page = await loginAsFounder(ctx);

    // Same video bytes as the affected course → its transcript is reused,
    // so no transcription GPU call is needed either.
    const video = await page.request.get(
      `${creds.baseURL}/api/hr/training/versions/${AFFECTED_VERSION_ID}/video`,
      { timeout: 120_000 },
    );
    expect(video.ok()).toBe(true);
    const bytes = await video.body();
    expect(bytes.length).toBeGreaterThan(1_000_000);

    // Every upload from this context asks for mock inference. The server
    // refuses the upload (409) if mock inference is not enabled, so this
    // test can never fall through to billable inference.
    let uploadResult: { status: number; body: { preparation?: { action: string; message: string } | null } | null } | null = null;
    await ctx.route("**/api/hr/training/versions/*/video", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const resp = await route.fetch({
        headers: { ...route.request().headers(), "x-spectre-training-inference": "mock" },
        timeout: 180_000,
      });
      let body = null;
      try { body = await resp.json(); } catch { /* non-JSON */ }
      uploadResult = { status: resp.status(), body };
      await route.fulfill({ response: resp });
    });

    await page.goto(`${creds.baseURL}/app/admin/people/safety-training/new/with-video`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForURL(/\/safety-training\/[^/]+\/[^/]+\/upload$/, { timeout: 30_000 });
    const m = page.url().match(/safety-training\/([^/]+)\/([^/]+)\/upload$/)!;
    const courseId = m[1];
    const versionId = m[2];
    const uploadUrl = page.url();

    await page.locator('[data-testid="training-video-uploader"] input[type="file"]').setInputFiles({
      name: "be-acceptance-mock.mp4",
      mimeType: "video/mp4",
      buffer: bytes,
    });
    await expect.poll(() => uploadResult, { timeout: 180_000, intervals: [1000] }).not.toBeNull();
    const up = uploadResult!;
    const upBody = up.body;
    expect(up.status).toBe(201);
    expect(upBody?.preparation?.action).toMatch(/GENERATION_ENQUEUED|GENERATION_IN_PROGRESS/);

    // No clicks from here on. Observe, refresh, close + reopen.
    const timeline: Array<{ t: number; outcome: string; stages: string }> = [];
    const snap = async () => {
      const s = await readStatus(page, creds.baseURL, versionId);
      timeline.push({
        t: Date.now(),
        outcome: s.overall.outcome,
        stages: s.stages.map((x) => `${x.id}=${x.status}`).join(" "),
      });
      return s;
    };
    await snap();
    await page.screenshot({ path: `${OUT}/new-1-after-upload.png`, fullPage: true });
    await page.reload({ waitUntil: "domcontentloaded" });
    await snap();
    await page.close();
    page = await ctx.newPage();
    await snap();

    let final = await snap();
    const deadline = Date.now() + 6 * 60 * 1000;
    while (!["READY_FOR_REVIEW", "FAILED", "PARTIALLY_GENERATED"].includes(final.overall.outcome) && Date.now() < deadline) {
      await page.waitForTimeout(5000);
      final = await snap();
    }
    fs.writeFileSync(
      `${OUT}/new-course-timeline.json`,
      JSON.stringify({ courseId, versionId, upload: upBody, timeline, final }, null, 2),
    );
    expect(final.overall.outcome).toBe("READY_FOR_REVIEW");

    // Opening the preparation page now lands the manager in review.
    await page.goto(uploadUrl, { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/review/, { timeout: 30_000 });
    await expect(page.getByText("MOCK INFERENCE").first()).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: `${OUT}/new-2-review.png`, fullPage: true });
    await ctx.close();
  });
});
