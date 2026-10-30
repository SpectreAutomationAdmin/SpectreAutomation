// EP-TRAIN-3 Slice 3A (2026-10-30) -- video startup latency measurement.
//
// Per founder directive §1 + §4: measure time-to-playable + time-to-
// first-frame for the training video on staging, split cold vs warm,
// across multiple runs, and report sample sizes.
//
// Methodology:
//   - Fresh browser context per cold run (empty cache)
//   - Reuse browser context per warm run (cache primed)
//   - For each run, time the delta from navigation to video.readyState=4
//     ("HAVE_ENOUGH_DATA" -- i.e. playable)
//   - Also capture the /api/hr/training/versions/[id]/video response
//     timing via page.on("response")
//
// Writes a measurement table to stdout at the end for the acceptance
// report.

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = "https://staging.spectreautomation.com";
const COLD_RUNS = 5;
const WARM_RUNS = 5;
const VIDEO_TIMEOUT_MS = 60_000;

function loadEnv() {
  const envPath = path.resolve(process.cwd(), ".env.playwright.local");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("="); if (eq <= 0) continue;
      const k = t.slice(0, eq); const v = t.slice(eq + 1);
      if (!(k in process.env)) process.env[k] = v;
    }
  }
}
loadEnv();

async function loginPortal(page: Page): Promise<void> {
  const email = process.env.SPECTRE_STAGING_PORTAL_EMAIL!;
  const password = process.env.SPECTRE_STAGING_PORTAL_PASSWORD!;
  await page.goto(`${BASE}/employee/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/employee/login"), { timeout: 30_000 }),
    page.locator('form button[type="submit"]').first().click(),
  ]);
}

async function openCourseAndMeasure(context: BrowserContext, label: string): Promise<{
  label: string;
  navMs: number;
  videoResponseMs: number | null;
  videoBytes: number | null;
  readyState1Ms: number | null;
  readyState4Ms: number | null;
  firstFrameMs: number | null;
}> {
  const page = await context.newPage();
  let videoRespStart: number | null = null;
  let videoRespEnd: number | null = null;
  let videoBytes: number | null = null;
  page.on("response", async (resp) => {
    const url = resp.url();
    if (url.includes("/api/hr/training/versions/") && url.endsWith("/video")) {
      if (videoRespStart === null) {
        videoRespStart = Date.now();
        try {
          const body = await resp.body().catch(() => null);
          if (body) videoBytes = body.length;
          videoRespEnd = Date.now();
        } catch { /* ignore */ }
      }
    }
  });
  const t0 = Date.now();
  await page.goto(`${BASE}/employee/safety-training`, { waitUntil: "domcontentloaded" });
  const navEnd = Date.now();
  // Click into the SLICE3_TEST course
  const link = page.locator('a:has-text("Slice 3 Interactive Playback")').first();
  await link.click();
  await page.waitForLoadState("domcontentloaded");

  const videoNavStart = Date.now();
  const result = await page.evaluate(async (timeout) => {
    const start = performance.now();
    let r1Ms: number | null = null;
    let r4Ms: number | null = null;
    let firstFrameMs: number | null = null;
    const videos = Array.from(document.querySelectorAll('[data-testid="portal-course-video"]')) as HTMLVideoElement[];
    const v = videos.find((el) => el.offsetParent !== null) ?? videos[0];
    if (!v) return { r1Ms: null, r4Ms: null, firstFrameMs: null };
    v.muted = true;
    const onLoadedMetadata = () => { r1Ms = performance.now() - start; };
    const onCanPlayThrough = () => { r4Ms = performance.now() - start; };
    v.addEventListener("loadedmetadata", onLoadedMetadata, { once: true });
    v.addEventListener("canplaythrough", onCanPlayThrough, { once: true });
    try {
      await v.play();
      // Use requestVideoFrameCallback if available for first-frame timing.
      const rvfc = (v as unknown as { requestVideoFrameCallback?: (cb: () => void) => number }).requestVideoFrameCallback;
      if (typeof rvfc === "function") {
        await new Promise<void>((resolve) => {
          rvfc.call(v, () => { firstFrameMs = performance.now() - start; resolve(); });
          setTimeout(resolve, timeout);
        });
      }
    } catch { /* autoplay refused */ }
    // Wait up to timeout for readyState=4
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline && v.readyState < 4) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (r1Ms === null && v.readyState >= 1) r1Ms = performance.now() - start;
    if (r4Ms === null && v.readyState >= 4) r4Ms = performance.now() - start;
    return { r1Ms, r4Ms, firstFrameMs };
  }, VIDEO_TIMEOUT_MS);

  const measurement = {
    label,
    navMs: navEnd - t0,
    videoResponseMs: videoRespStart !== null && videoRespEnd !== null ? videoRespEnd - videoRespStart : null,
    videoBytes,
    readyState1Ms: result.r1Ms,
    readyState4Ms: result.r4Ms,
    firstFrameMs: result.firstFrameMs,
  };
  await page.close();
  return measurement;
}

test.describe("EP-TRAIN-3 Slice 3A :: video startup latency", () => {
  test.beforeAll(() => {
    if (!process.env.SPECTRE_STAGING_PORTAL_EMAIL) test.skip(true, "no portal creds");
  });

  test("cold-cache startup (fresh context per run)", async ({ browser }) => {
    const results: Array<Awaited<ReturnType<typeof openCourseAndMeasure>>> = [];
    for (let i = 0; i < COLD_RUNS; i++) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await loginPortal(page);
      await page.close();
      const m = await openCourseAndMeasure(context, `cold-${i + 1}`);
      results.push(m);
      await context.close();
    }
    // eslint-disable-next-line no-console
    console.log("COLD RESULTS:", JSON.stringify(results, null, 2));
    expect(results.length).toBe(COLD_RUNS);
  });

  test("warm-cache startup (same context, repeat navigation)", async ({ browser }) => {
    const results: Array<Awaited<ReturnType<typeof openCourseAndMeasure>>> = [];
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginPortal(page);
    await page.close();
    for (let i = 0; i < WARM_RUNS; i++) {
      const m = await openCourseAndMeasure(context, `warm-${i + 1}`);
      results.push(m);
    }
    await context.close();
    // eslint-disable-next-line no-console
    console.log("WARM RESULTS:", JSON.stringify(results, null, 2));
    expect(results.length).toBe(WARM_RUNS);
  });
});
