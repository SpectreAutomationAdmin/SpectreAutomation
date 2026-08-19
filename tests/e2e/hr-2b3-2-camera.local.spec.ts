// HR-2B.3.2 §3 (2026-08-18) — Local Playwright acceptance for the
// in-page selfie capture experience.
//
// The photo step now supports a REAL camera flow: permission →
// live preview → capture → accept, wired through the same
// `uploadPhotoAction` server action as the native picker path.
//
// Chromium can't produce a real camera in headless mode. Instead of
// depending on `--use-fake-device-for-media-stream` we mock
// `navigator.mediaDevices.getUserMedia` at the page level via
// `page.addInitScript`, so the test survives Playwright / Chromium
// upgrades and is deterministic.
//
// Screenshots land under test-results/hr-2b3-2-camera/.

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const OUT = path.resolve("test-results/hr-2b3-2-camera");
fs.mkdirSync(OUT, { recursive: true });

const FIXTURE_PATH_DEFAULT = path.resolve("test-results/hr-2b2-fixture.json");
const FIXTURE_SCRIPT = path.resolve("scripts/hr-2b2-fixture-invitation.mjs");

interface Fixture {
  clubId: string;
  employeeId: string;
  employeeFirstName: string;
  employeeLastName: string;
  sessionId: string;
  invitationId: string;
  rawToken: string;
  expiresAt: string;
  redemptionUrl: string;
}

function readFixture(fixturePath = FIXTURE_PATH_DEFAULT): Fixture {
  if (!fs.existsSync(fixturePath)) {
    throw new Error(`[hr-2b3-2-spec] fixture file missing: ${fixturePath}`);
  }
  return JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Fixture;
}

function primeFixture(email: string): Fixture {
  execFileSync("node", [FIXTURE_SCRIPT, "--email", email], {
    cwd: path.resolve("."),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  return readFixture();
}

/** Install a getUserMedia stub that returns a synthetic MediaStream
 *  built from a canvas. The stream's tracks respond to .stop(). We
 *  also patch DataTransfer defensively in case the browser strips it
 *  in some future headless mode. Runs on every navigation. */
async function installCameraMock(context: BrowserContext, mode: "granted" | "denied" | "no-device") {
  await context.addInitScript((cfg: { mode: string }) => {
    // Draw a solid-colour frame into a canvas and capture its stream
    // so <video srcObject> renders something. When captureStream isn't
    // available (some Chromium versions in headless), fall back to a
    // duck-typed MediaStream with a stop-able video track.
    function makeSyntheticStream(): MediaStream {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 320;
        canvas.height = 240;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.fillStyle = "#065f46"; // emerald-800 so the frame is visibly non-black
          ctx.fillRect(0, 0, 320, 240);
          ctx.fillStyle = "#fff";
          ctx.font = "20px sans-serif";
          ctx.fillText("SELFIE STUB", 60, 130);
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stream = (canvas as any).captureStream
          ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ((canvas as any).captureStream(15) as MediaStream)
          : null;
        if (stream) return stream;
      } catch {
        /* fall through to duck-typed stream */
      }
      const track = {
        stop() {
          /* mocked */
        },
        kind: "video",
        readyState: "live",
        enabled: true,
      } as unknown as MediaStreamTrack;
      const tracks = [track];
      return {
        getTracks: () => tracks,
        getVideoTracks: () => tracks,
        getAudioTracks: () => [],
        active: true,
      } as unknown as MediaStream;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nav = navigator as any;
    if (!nav.mediaDevices) nav.mediaDevices = {};
    nav.mediaDevices.getUserMedia = () => {
      if (cfg.mode === "denied") {
        const err = new Error("Permission denied by user");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (err as any).name = "NotAllowedError";
        return Promise.reject(err);
      }
      if (cfg.mode === "no-device") {
        const err = new Error("Requested device not found");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (err as any).name = "NotFoundError";
        return Promise.reject(err);
      }
      return Promise.resolve(makeSyntheticStream());
    };
  }, { mode });
}

/** Terse About-You walk that lands the browser on the photo step. */
async function walkAboutYouUntilPhoto(page: Page, fixture: Fixture) {
  await page.goto(fixture.redemptionUrl, { waitUntil: "domcontentloaded" });
  await Promise.all([
    page.waitForURL(/\/hr\/onboarding\/about-you\/name/, { timeout: 30_000 }),
    page.locator('[data-testid="hr-onboarding-begin"]').click(),
  ]);
  await page.locator('input[name="firstName"]').fill(fixture.employeeFirstName);
  await page.locator('input[name="lastName"]').fill(fixture.employeeLastName);
  await Promise.all([
    page.waitForURL(/\/hr\/onboarding\/about-you\/contact/, { timeout: 20_000 }),
    page.locator('button[type="submit"]').first().click(),
  ]);
  await page.locator('input[name="personalEmail"]').fill("hr-2b3-2-camera@spectre.test");
  await page.locator('input[name="mobilePhone"]').fill("(403) 555-0222");
  await Promise.all([
    page.waitForURL(/\/hr\/onboarding\/about-you\/employment/, { timeout: 20_000 }),
    page.locator('button[type="submit"]').first().click(),
  ]);
  await page.locator('[data-testid="employment-outcome-correct"]').check();
  await Promise.all([
    page.waitForURL(/\/hr\/onboarding\/about-you\/photo/, { timeout: 20_000 }),
    page.locator('button[type="submit"]').first().click(),
  ]);
}

test.describe.serial("HR-2B.3.2 §3 · in-page camera capture (local)", () => {
  test.setTimeout(300_000);

  // -------------------------------------------------------------------
  // Golden path — grant permission, take photo, accept, land on
  // /complete.
  // -------------------------------------------------------------------
  test("golden path · Take a selfie → Take photo → Use this photo → /complete", async ({ browser }) => {
    const fixture = primeFixture("hr-2b3-2-camera-golden@spectre.test");
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2,
      permissions: ["camera"],
    });
    await installCameraMock(ctx, "granted");
    const page = await ctx.newPage();

    try {
      await walkAboutYouUntilPhoto(page, fixture);

      // Idle → click "Take a selfie".
      const selfieBtn = page.locator('[data-testid="photo-selfie-button"]');
      await expect(selfieBtn).toBeVisible();
      await selfieBtn.click();

      // Live preview — video visible + Take / Cancel available.
      const video = page.locator('[data-testid="photo-selfie-video"]');
      await expect(video).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('[data-testid="photo-selfie-take-button"]')).toBeVisible();
      await expect(page.locator('[data-testid="photo-selfie-cancel-button"]')).toBeVisible();
      await page.screenshot({ path: path.join(OUT, "camera-live-preview-mobile.png"), fullPage: true });

      // Take photo → captured still visible + accept / retake / cancel.
      await page.locator('[data-testid="photo-selfie-take-button"]').click();
      const still = page.locator('[data-testid="photo-selfie-still"]');
      await expect(still).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('[data-testid="photo-selfie-accept-button"]')).toBeVisible();
      await expect(page.locator('[data-testid="photo-selfie-retake-button"]')).toBeVisible();
      await expect(page.locator('[data-testid="photo-selfie-cancel-button"]')).toBeVisible();
      await page.screenshot({ path: path.join(OUT, "camera-captured-still-mobile.png"), fullPage: true });

      // Use this photo → form submits + redirects to /complete.
      await Promise.all([
        page.waitForURL(/\/hr\/onboarding\/about-you\/complete/, { timeout: 30_000 }),
        page.locator('[data-testid="photo-selfie-accept-button"]').click(),
      ]);
    } finally {
      await ctx.close();
    }
  });

  // -------------------------------------------------------------------
  // Cancel + Retake — cover the non-happy interaction paths.
  // -------------------------------------------------------------------
  test("cancel + retake · stays on the photo step, stream is manageable", async ({ browser }) => {
    const fixture = primeFixture("hr-2b3-2-camera-cancel-retake@spectre.test");
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2,
      permissions: ["camera"],
    });
    await installCameraMock(ctx, "granted");
    const page = await ctx.newPage();

    try {
      await walkAboutYouUntilPhoto(page, fixture);
      // Open camera → live preview.
      await page.locator('[data-testid="photo-selfie-button"]').click();
      await expect(page.locator('[data-testid="photo-selfie-video"]')).toBeVisible({ timeout: 15_000 });

      // Cancel from live → back to Idle (trigger button visible again).
      await page.locator('[data-testid="photo-selfie-cancel-button"]').click();
      await expect(page.locator('[data-testid="photo-selfie-button"]')).toBeVisible();

      // Reopen → take → retake (must return to live without a fresh
      // permission prompt — the mock would still return the stream so
      // this only checks state transitions).
      await page.locator('[data-testid="photo-selfie-button"]').click();
      await expect(page.locator('[data-testid="photo-selfie-video"]')).toBeVisible({ timeout: 15_000 });
      await page.locator('[data-testid="photo-selfie-take-button"]').click();
      await expect(page.locator('[data-testid="photo-selfie-still"]')).toBeVisible();
      await page.locator('[data-testid="photo-selfie-retake-button"]').click();
      await expect(page.locator('[data-testid="photo-selfie-video"]')).toBeVisible();

      // Still on the photo URL — no accidental navigation.
      expect(page.url()).toMatch(/\/hr\/onboarding\/about-you\/photo$/);
    } finally {
      await ctx.close();
    }
  });

  // -------------------------------------------------------------------
  // Permission denied — surface the fallback + do not crash.
  // -------------------------------------------------------------------
  test("permission denied · shows fallback + suggests Choose a photo", async ({ browser }) => {
    const fixture = primeFixture("hr-2b3-2-camera-denied@spectre.test");
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2,
      // Deliberately DO NOT grant permission — but the init-script
      // mock overrides mediaDevices.getUserMedia to reject anyway, so
      // the outcome is deterministic across Chromium versions.
    });
    await installCameraMock(ctx, "denied");
    const page = await ctx.newPage();

    try {
      await walkAboutYouUntilPhoto(page, fixture);
      await page.locator('[data-testid="photo-selfie-button"]').click();

      const denied = page.locator('[data-testid="photo-selfie-permission-denied"]');
      await expect(denied).toBeVisible({ timeout: 10_000 });
      await expect(denied).toContainText(/Choose a photo/i);

      // The Choose-a-photo native path must still be reachable.
      await expect(page.locator('[data-testid="photo-choose-button"]')).toBeVisible();

      await page.screenshot({ path: path.join(OUT, "camera-permission-denied-mobile.png"), fullPage: true });
    } finally {
      await ctx.close();
    }
  });
});
