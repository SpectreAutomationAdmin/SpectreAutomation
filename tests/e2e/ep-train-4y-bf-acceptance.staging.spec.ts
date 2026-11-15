/**
 * EP-TRAIN-4Y-BF — real-browser acceptance on staging.
 *
 * Product rule under test: a manager uploads a video and does nothing
 * else. Spectre prepares the course and the review screen appears. No
 * test below clicks, confirms, resumes or refreshes to MAKE processing
 * happen.
 *
 * NO BILLABLE PROCESSING — by identity, not by marker.
 *   Every test logs in as the dedicated Safety & Training test principal
 *   (never the founder). The server lists that account's id, so whatever
 *   it uploads is simulated end to end — transcription included — no
 *   matter which headers a request carries. Test 4 proves it by sending
 *   no test header at all. Independently of that, staging runs with
 *   billable inference locked, so even a real account could not reach
 *   the provider.
 *
 *   Nothing here intercepts or rewrites a request. Optional test
 *   controls (pacing, one injected fault) are set on the browser context,
 *   so every request carries them, and they can only tune a simulation.
 *
 * These tests prove the automatic workflow and its safeguards. They do
 * NOT prove that real AI transcription or generation works; simulated
 * questions are labelled "MOCK INFERENCE".
 */
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import {
  loginAsTrainingTestPrincipal,
  trainingTestPrincipalAvailable,
} from "./_lib/staging-auth";

/** A real staging course whose stored video is used as test footage.
 *  It is only ever READ here. */
const SOURCE_COURSE_ID = "cmwgxzh6j000e54dnh62vwznu";
const SOURCE_VERSION_ID = "cmwgxzh7e000g54dn2btx5kfp";
const OUT = "test-results/4ybf";
const STAGE_IDS = ["upload", "ingest", "transcribe", "objectives", "checkpoints", "assessment", "ready"] as const;

/** Words a club manager must never see on the preparation screen. */
const FORBIDDEN =
  /\$\s?\d|\bcosts?\b|\bbudget|\bGPU\b|\bModal\b|authoriz|\binference\b|\bbillable\b|Continue preparation|Confirm and continue|\bResume\b|\bRetry\b/i;

interface StageJson { id: string; status: string; failureReason?: string | null }
interface StatusJson { overall: { outcome: string; weightedPercent: number }; stages: StageJson[] }

let cachedVideo: Buffer | null = null;

async function newTestContext(browser: Browser, controls: Record<string, string> = {}): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    // Context-level: carried by EVERY request this browser sends.
    ...(Object.keys(controls).length > 0 ? { extraHTTPHeaders: controls } : {}),
  });
  const page = await loginAsTrainingTestPrincipal(ctx);
  await assertIsolated(ctx);
  return { ctx, page };
}

/** PRE-FLIGHT, before any upload: the server itself must confirm that
 *  this session is a test principal, that simulated processing is
 *  allowed, and that billable inference is locked. A build without test
 *  isolation has no such endpoint (404), a session the server does not
 *  recognise gets 404 too, and an environment switched on for a real
 *  run answers ENABLED — in every one of those cases the test stops
 *  here and nothing is uploaded. */
async function assertIsolated(ctx: BrowserContext): Promise<void> {
  const base = trainingTestPrincipalAvailable().baseURL;
  const r = await ctx.request.get(`${base}/api/admin/training/test-isolation`);
  if (r.status() !== 200) {
    throw new Error(
      `STOP — the server did not confirm test isolation (HTTP ${r.status()}). Nothing was uploaded. ` +
        "Either this build predates test isolation or this account is not recognised as a test principal.",
    );
  }
  const status = (await r.json()) as { testPrincipal?: boolean; simulationAllowed?: boolean; billableInference?: string };
  if (status.testPrincipal !== true || status.simulationAllowed !== true || status.billableInference !== "LOCKED") {
    throw new Error(`STOP — isolation not confirmed: ${JSON.stringify(status)}. Nothing was uploaded.`);
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(`${OUT}/0-isolation-preflight.json`, JSON.stringify({ at: new Date().toISOString(), ...status }, null, 2));
}

async function readStatus(ctx: BrowserContext, base: string, versionId: string): Promise<StatusJson> {
  const r = await ctx.request.get(`${base}/api/admin/training/versions/${versionId}/preparation-status`);
  expect(r.status()).toBe(200);
  return (await r.json()) as StatusJson;
}

/** Unique footage per test: the stored video plus one MP4 `free` box of
 *  random bytes. Still a valid MP4 of the same length, but with its own
 *  checksum — so nothing is reused and every stage has to run. */
async function uniqueVideo(ctx: BrowserContext, base: string): Promise<Buffer> {
  if (!cachedVideo) {
    const video = await ctx.request.get(`${base}/api/hr/training/versions/${SOURCE_VERSION_ID}/video`, { timeout: 180_000 });
    expect(video.ok()).toBe(true);
    cachedVideo = await video.body();
    expect(cachedVideo.length).toBeGreaterThan(1_000_000);
  }
  const box = Buffer.alloc(24);
  box.writeUInt32BE(24, 0);
  box.write("free", 4, "ascii");
  randomBytes(16).copy(box, 8);
  return Buffer.concat([cachedVideo, box]);
}

/** Create a With-Video course through the real UI. */
async function createCourse(page: Page, base: string): Promise<{ courseId: string; versionId: string; uploadUrl: string }> {
  await page.goto(`${base}/app/admin/people/safety-training/new/with-video`, { waitUntil: "domcontentloaded" });
  await page.waitForURL(/\/safety-training\/[^/]+\/[^/]+\/upload$/, { timeout: 30_000 });
  const m = page.url().match(/safety-training\/([^/]+)\/([^/]+)\/upload$/)!;
  return { courseId: m[1], versionId: m[2], uploadUrl: page.url() };
}

/** Upload once through the real uploader. The response is only OBSERVED. */
async function uploadThroughUi(page: Page, versionId: string, bytes: Buffer): Promise<number> {
  const responded = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith(`/api/hr/training/versions/${versionId}/video`),
    { timeout: 300_000 },
  );
  await page
    .locator('[data-testid="training-video-uploader"] input[type="file"]')
    .setInputFiles({ name: "bf-acceptance-simulated.mp4", mimeType: "video/mp4", buffer: bytes }, { timeout: 240_000 });
  return (await responded).status();
}

function remember(name: string, value: Record<string, unknown>): void {
  fs.mkdirSync(OUT, { recursive: true });
  const file = `${OUT}/versions.json`;
  const all = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>) : {};
  all[name] = value;
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
}

async function expectReviewReady(page: Page): Promise<{ markerIds: string[]; checkpointTab: string; finalTab: string }> {
  await expect(page.getByTestId("manager-review-mode-checkpoints")).toBeVisible({ timeout: 30_000 });
  const checkpointTab = (await page.getByTestId("manager-review-mode-checkpoints").innerText()).replace(/\s+/g, " ");
  const finalTab = (await page.getByTestId("manager-review-mode-final").innerText()).replace(/\s+/g, " ");
  expect(checkpointTab).toMatch(/\b5\b/);
  expect(finalTab).toMatch(/\b8\b/);
  // Simulated content is visibly labelled as such.
  await expect(page.getByTestId("manager-review-question-text").first()).toContainText("MOCK INFERENCE");
  const markers = page.locator('[data-testid^="portal-course-checkpoint-marker-"]');
  const ids = await markers.evaluateAll((els) =>
    els.map((el) => (el.getAttribute("data-testid") ?? "").replace("portal-course-checkpoint-marker-", "")),
  );
  return { markerIds: [...new Set(ids)], checkpointTab, finalTab };
}

/** Poll until ready for review, recording every status each stage shows. */
async function watchUntilReady(
  ctx: BrowserContext,
  base: string,
  versionId: string,
  timeoutMs: number,
  onTick?: (status: StatusJson) => Promise<void>,
): Promise<{ seen: Record<string, string[]>; timeline: string[]; final: StatusJson }> {
  const seen: Record<string, string[]> = {};
  const timeline: string[] = [];
  const t0 = Date.now();
  let last: StatusJson | null = null;
  while (Date.now() - t0 < timeoutMs) {
    const s = await readStatus(ctx, base, versionId);
    last = s;
    for (const stage of s.stages) {
      const list = (seen[stage.id] ??= []);
      if (list[list.length - 1] !== stage.status) list.push(stage.status);
    }
    const line = `${s.overall.outcome} ${s.overall.weightedPercent}% | ${s.stages.map((x) => `${x.id}=${x.status}`).join(" ")}`;
    if (timeline[timeline.length - 1]?.split(" @")[0] !== line) timeline.push(`${line} @+${Math.round((Date.now() - t0) / 1000)}s`);
    if (onTick) await onTick(s);
    if (s.overall.outcome === "READY_FOR_REVIEW") return { seen, timeline, final: s };
    // A stage may show a failed attempt while Spectre retries on its own;
    // only a HALT (the "our team has been notified" message) is final.
    const halted = s.stages.find((x) => /our team has been notified/i.test(x.failureReason ?? ""));
    expect(halted, `preparation halted: ${line}`).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`not ready after ${Math.round(timeoutMs / 1000)}s: ${JSON.stringify(last?.stages)}`);
}

test.describe("EP-TRAIN-4Y-BF — upload once, Spectre does the rest (simulated processing)", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(() => {
    const creds = trainingTestPrincipalAvailable();
    test.skip(!creds.ready, creds.reason ?? "test-principal credentials missing");
  });

  test("1. hands-off: one upload → all seven stages run → review screen appears on its own", async ({ browser }) => {
    test.setTimeout(12 * 60 * 1000);
    const base = trainingTestPrincipalAvailable().baseURL;
    fs.mkdirSync(OUT, { recursive: true });
    // 3 s per simulated call so each stage can be seen in flight.
    const { ctx, page } = await newTestContext(browser, { "x-spectre-training-mock-delay-ms": "3000" });
    const bytes = await uniqueVideo(ctx, base);
    const course = await createCourse(page, base);
    expect(await uploadThroughUi(page, course.versionId, bytes)).toBe(201);
    remember("1-hands-off", course);

    // ── Hands off from here: no clicks, no reloads, no navigation. ──
    let cardChecked = false;
    const watched = await watchUntilReady(ctx, base, course.versionId, 8 * 60 * 1000, async (s) => {
      if (cardChecked || !s.stages.some((x) => x.status === "RUNNING" || x.status === "QUEUED")) return;
      const card = page.getByTestId("training-prep-progress");
      if (!(await card.isVisible().catch(() => false))) return;
      cardChecked = true;
      // The preparation screen is read-only and says nothing internal.
      expect(await card.locator("button, a[role='button'], input, select").count()).toBe(0);
      expect(await card.innerText()).not.toMatch(FORBIDDEN);
      for (const id of STAGE_IDS) await expect(page.getByTestId(`training-prep-stage-${id}`)).toBeVisible();
      await page.screenshot({ path: `${OUT}/1-in-flight.png`, fullPage: true });
    });
    expect(cardChecked).toBe(true);

    // All seven stages exist and every one finished.
    expect(watched.final.stages.map((s) => s.id)).toEqual([...STAGE_IDS]);
    for (const id of STAGE_IDS) expect(watched.seen[id][watched.seen[id].length - 1], `stage ${id}`).toBe("COMPLETED");
    // The stages that do work were seen working before they finished —
    // including transcription, which had nothing to reuse.
    for (const id of ["transcribe", "checkpoints", "assessment"] as const) {
      expect(watched.seen[id].some((s) => s !== "COMPLETED"), `stage ${id} was observed in progress: ${watched.seen[id]}`).toBe(true);
    }
    // A stage never goes backwards from COMPLETED.
    for (const id of STAGE_IDS) expect(watched.seen[id].indexOf("COMPLETED")).toBe(watched.seen[id].length - 1);

    // The browser moves to the review screen by itself.
    await page.waitForURL(/\/review/, { timeout: 60_000 });
    const review = await expectReviewReady(page);
    expect(review.markerIds.length).toBe(5);
    await page.screenshot({ path: `${OUT}/1-review.png`, fullPage: true });
    fs.writeFileSync(`${OUT}/1-hands-off.json`, JSON.stringify({ ...course, seen: watched.seen, timeline: watched.timeline, review }, null, 2));
    await ctx.close();
  });

  test("2. refresh during generation, then leave and come back: progress is preserved", async ({ browser }) => {
    test.setTimeout(12 * 60 * 1000);
    const base = trainingTestPrincipalAvailable().baseURL;
    const { ctx, page: first } = await newTestContext(browser, { "x-spectre-training-mock-delay-ms": "5000" });
    let page = first;
    const bytes = await uniqueVideo(ctx, base);
    const course = await createCourse(page, base);
    expect(await uploadThroughUi(page, course.versionId, bytes)).toBe(201);
    remember("2-refresh-leave", course);

    // Wait until question generation is actually running.
    await expect
      .poll(async () => (await readStatus(ctx, base, course.versionId)).stages.find((s) => s.id === "checkpoints")!.status, { timeout: 4 * 60 * 1000, intervals: [1000] })
      .toMatch(/RUNNING|COMPLETED/);
    const before = await readStatus(ctx, base, course.versionId);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("training-prep-progress")).toBeVisible({ timeout: 20_000 });
    const afterReload = await readStatus(ctx, base, course.versionId);
    // Nothing was reset by the refresh.
    expect(afterReload.overall.weightedPercent).toBeGreaterThanOrEqual(before.overall.weightedPercent);
    for (const stage of before.stages) {
      if (stage.status === "COMPLETED") expect(afterReload.stages.find((s) => s.id === stage.id)!.status).toBe("COMPLETED");
    }
    await page.screenshot({ path: `${OUT}/2-after-refresh.png`, fullPage: true });

    // Leave the screen and close the tab while work is in flight.
    await page.goto(`${base}/app/admin/people/safety-training`, { waitUntil: "domcontentloaded" });
    await page.close();
    await expect
      .poll(async () => (await readStatus(ctx, base, course.versionId)).overall.outcome, { timeout: 6 * 60 * 1000, intervals: [3000] })
      .toBe("READY_FOR_REVIEW");

    // Coming back later: the course is simply ready for review.
    page = await ctx.newPage();
    await page.goto(course.uploadUrl, { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/review/, { timeout: 30_000 });
    const review = await expectReviewReady(page);
    expect(review.markerIds.length).toBe(5);
    await page.screenshot({ path: `${OUT}/2-returned-review.png`, fullPage: true });
    fs.writeFileSync(`${OUT}/2-refresh-leave.json`, JSON.stringify({ ...course, before: before.overall, afterReload: afterReload.overall, review }, null, 2));
    await ctx.close();
  });

  test("3. a missing question is repaired automatically", async ({ browser }) => {
    test.setTimeout(12 * 60 * 1000);
    const base = trainingTestPrincipalAvailable().baseURL;
    // The first pass returns nothing for the first checkpoint.
    const { ctx, page } = await newTestContext(browser, { "x-spectre-training-mock-fault": "drop-first-checkpoint" });
    const bytes = await uniqueVideo(ctx, base);
    const course = await createCourse(page, base);
    expect(await uploadThroughUi(page, course.versionId, bytes)).toBe(201);
    remember("3-auto-repair", course);
    await page.waitForURL(/\/review/, { timeout: 8 * 60 * 1000 });
    const review = await expectReviewReady(page);
    expect(review.markerIds.length).toBe(5);
    await page.screenshot({ path: `${OUT}/3-repaired-review.png`, fullPage: true });
    await ctx.close();
  });

  test("4. NEGATIVE: no test marker of any kind is sent — processing is still simulated", async ({ browser }) => {
    test.setTimeout(12 * 60 * 1000);
    const base = trainingTestPrincipalAvailable().baseURL;
    // A plain browser context: no extra headers, nothing intercepted.
    const { ctx, page } = await newTestContext(browser);
    const sent: Array<Record<string, string>> = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && /\/api\/hr\/training\/versions\/[^/]+\/video$/.test(r.url())) sent.push(r.headers());
    });
    const bytes = await uniqueVideo(ctx, base);
    const course = await createCourse(page, base);
    expect(await uploadThroughUi(page, course.versionId, bytes)).toBe(201);
    remember("4-no-marker", course);
    // The upload request really carried no test control.
    expect(sent.length).toBe(1);
    expect(Object.keys(sent[0]).filter((h) => h.startsWith("x-spectre-training"))).toEqual([]);

    await page.waitForURL(/\/review/, { timeout: 8 * 60 * 1000 });
    // Simulated questions, built from the simulated transcript.
    const review = await expectReviewReady(page);
    expect(review.markerIds.length).toBe(5);
    await page.screenshot({ path: `${OUT}/4-no-marker-review.png`, fullPage: true });
    await ctx.close();
  });

  test("5. badly formatted AI output is repaired, not thrown away", async ({ browser }) => {
    test.setTimeout(12 * 60 * 1000);
    const base = trainingTestPrincipalAvailable().baseURL;
    // Every simulated question arrives with the three formatting defects
    // real model output showed. Unrepaired, all 13 would be rejected.
    const { ctx, page } = await newTestContext(browser, { "x-spectre-training-mock-fault": "formatting-defects" });
    const bytes = await uniqueVideo(ctx, base);
    const course = await createCourse(page, base);
    expect(await uploadThroughUi(page, course.versionId, bytes)).toBe(201);
    remember("5-formatting-repair", course);
    await page.waitForURL(/\/review/, { timeout: 8 * 60 * 1000 });
    const review = await expectReviewReady(page);
    expect(review.markerIds.length).toBe(5);
    // What the manager reads is clean.
    const text = await page.locator("main").innerText();
    expect(text).not.toMatch(/according to the training material/i);
    expect(text).not.toMatch(/Correct Answer:/i);
    expect(text).not.toMatch(/aligns with segment/i);
    await page.screenshot({ path: `${OUT}/5-formatting-repaired-review.png`, fullPage: true });
    await ctx.close();
  });

  test("6. two uploads finishing at the same moment, then a third mid-flight: still one workflow", async ({ browser }) => {
    test.setTimeout(12 * 60 * 1000);
    const base = trainingTestPrincipalAvailable().baseURL;
    const { ctx, page } = await newTestContext(browser, { "x-spectre-training-mock-delay-ms": "2000" });
    const bytes = await uniqueVideo(ctx, base);
    const course = await createCourse(page, base);
    remember("6-concurrent", course);
    const post = () =>
      ctx.request.post(`${base}/api/hr/training/versions/${course.versionId}/video`, {
        multipart: { video: { name: "bf-concurrent.mp4", mimeType: "video/mp4", buffer: bytes } },
        timeout: 300_000,
      });
    // Two upload completions race each other.
    const [a, b] = await Promise.all([post(), post()]);
    expect(a.status()).toBe(201);
    expect(b.status()).toBe(201);
    // A third arrives while preparation is already running.
    await expect
      .poll(async () => (await readStatus(ctx, base, course.versionId)).stages.find((s) => s.id === "transcribe")!.status, { timeout: 2 * 60 * 1000, intervals: [1000] })
      .toMatch(/RUNNING|COMPLETED/);
    expect((await post()).status()).toBe(201);

    await watchUntilReady(ctx, base, course.versionId, 8 * 60 * 1000);
    await page.goto(course.uploadUrl, { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/review/, { timeout: 30_000 });
    // Exactly the planned questions — not doubled.
    const review = await expectReviewReady(page);
    expect(review.markerIds.length).toBe(5);
    await page.screenshot({ path: `${OUT}/6-concurrent-review.png`, fullPage: true });
    await ctx.close();
  });

  test("7. the previously blocked real course: looked at only — read-only, nothing internal shown", async ({ browser }) => {
    const base = trainingTestPrincipalAvailable().baseURL;
    const { ctx, page } = await newTestContext(browser);
    await page.goto(`${base}/app/admin/people/safety-training/${SOURCE_COURSE_ID}/${SOURCE_VERSION_ID}/upload`, { waitUntil: "domcontentloaded" });
    const card = page.getByTestId("training-prep-progress");
    await expect(card).toBeVisible({ timeout: 20_000 });
    expect(await card.locator("button, a[role='button'], input, select").count()).toBe(0);
    expect(await card.innerText()).not.toMatch(FORBIDDEN);
    await page.screenshot({ path: `${OUT}/7-real-course-read-only.png`, fullPage: true });
    fs.writeFileSync(`${OUT}/7-real-course-status.json`, JSON.stringify(await readStatus(ctx, base, SOURCE_VERSION_ID), null, 2));
    await ctx.close();
  });
});

test.describe("EP-TRAIN-4Y-BF — worker interruption (restarts the staging worker)", () => {
  test("8. the worker is restarted mid-generation; preparation recovers on its own", async ({ browser }) => {
    test.skip(
      process.env.SPECTRE_E2E_ALLOW_WORKER_RESTART !== "1",
      "Set SPECTRE_E2E_ALLOW_WORKER_RESTART=1 to let this test restart the staging worker.",
    );
    const creds = trainingTestPrincipalAvailable();
    test.skip(!creds.ready, creds.reason ?? "test-principal credentials missing");
    // Recovery waits out the dead worker's lease (15 min) plus grace.
    test.setTimeout(40 * 60 * 1000);
    const base = creds.baseURL;
    const { ctx, page } = await newTestContext(browser, { "x-spectre-training-mock-delay-ms": "10000" });
    const bytes = await uniqueVideo(ctx, base);
    const course = await createCourse(page, base);
    expect(await uploadThroughUi(page, course.versionId, bytes)).toBe(201);
    remember("8-worker-interruption", course);

    await expect
      .poll(async () => (await readStatus(ctx, base, course.versionId)).stages.find((s) => s.id === "checkpoints")!.status, { timeout: 5 * 60 * 1000, intervals: [1000] })
      .toBe("RUNNING");
    // Kill the worker while the run is in flight.
    const flyctl = process.env.FLYCTL_PATH ?? "flyctl";
    const restartedAt = new Date().toISOString();
    // Restart the one running worker machine when its id is given;
    // otherwise every machine of the staging worker app.
    const machineId = process.env.SPECTRE_E2E_WORKER_MACHINE_ID;
    execFileSync(
      flyctl,
      machineId ? ["machine", "restart", machineId, "-a", "spectre-staging-worker"] : ["apps", "restart", "spectre-staging-worker"],
      { stdio: "pipe", timeout: 180_000 },
    );
    fs.writeFileSync(`${OUT}/8-worker-restarted-at.txt`, restartedAt);

    // Hands off. The manager sees "taking longer than usual", never an
    // instruction; the dead run's lease expires, it is superseded, and a
    // fresh run completes the course.
    const watched = await watchUntilReady(ctx, base, course.versionId, 32 * 60 * 1000);
    await page.goto(course.uploadUrl, { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/review/, { timeout: 30_000 });
    const review = await expectReviewReady(page);
    expect(review.markerIds.length).toBe(5);
    await page.screenshot({ path: `${OUT}/8-recovered-review.png`, fullPage: true });
    fs.writeFileSync(`${OUT}/8-worker-interruption.json`, JSON.stringify({ ...course, restartedAt, timeline: watched.timeline, review }, null, 2));
    await ctx.close();
  });
});
