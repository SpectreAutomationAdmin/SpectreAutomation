// EP-TRAIN-3 Slice 3D verification diagnostic (2026-10-30).
//
// Isolates the answer-selection failure per directive §1 "Stop
// assuming Playwright is the problem".
//
// Rewrite v2 — uses role-based locators + .check() + auto-retrying
// expect().toBeChecked() assertions.  The prior v1 used `.click()`
// on the label span followed by a fixed 200 ms wait + synchronous
// `.isChecked()`, which races the React controlled-input commit on
// a freshly booted staging machine.
//
// Deletes itself (operator) after the verification pass is complete.

import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

const BASE = "https://staging.spectreautomation.com";

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

async function openSliceCourse(page: Page): Promise<void> {
  await page.goto(`${BASE}/employee/safety-training`, { waitUntil: "domcontentloaded" });
  const link = page.locator('[data-testid^="portal-safety-training-course-"]').filter({ hasText: "Slice 3 Interactive Playback" }).first();
  await expect(link).toBeVisible({ timeout: 15_000 });
  await link.click();
  await page.waitForURL(/\/employee\/safety-training\/[^/]+/, { timeout: 15_000 });
  await page.waitForLoadState("domcontentloaded");
}

async function playUntilCheckpoint(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const videos = Array.from(document.querySelectorAll('[data-testid="portal-course-video"]')) as HTMLVideoElement[];
    return videos.some((v) => v.readyState >= 1 && Number.isFinite(v.duration));
  }, undefined, { timeout: 30_000 });
  await page.evaluate(async () => {
    const videos = Array.from(document.querySelectorAll('[data-testid="portal-course-video"]')) as HTMLVideoElement[];
    const v = videos.find((el) => el.offsetParent !== null);
    if (!v) return;
    v.muted = true;
    v.playbackRate = 2;
    try { await v.play(); } catch { /* ignore */ }
  });
  await expect(page.locator('[data-testid="portal-checkpoint-overlay"]:visible').first()).toBeVisible({ timeout: 30_000 });
}

test.describe("Slice 3D DIAG v2 :: answer-selection via role locators + .check()", () => {
  test.beforeAll(() => {
    if (!process.env.SPECTRE_STAGING_PORTAL_EMAIL) test.skip(true, "no portal creds");
  });

  test("role-based locators + .check() + toBeChecked() drive radios and checkboxes", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    page.on("console", (m) => { if (m.type() === "error") console.log(`PAGE ERROR: ${m.text()}`); });

    await loginPortal(page);
    await openSliceCourse(page);
    await playUntilCheckpoint(page);

    // Scope every locator to the ONE visible checkpoint overlay. The
    // page has desktop + mobile shells; `:visible` collapses to the
    // active one.
    const overlay = page.locator('[data-testid="portal-checkpoint-overlay"]:visible').first();
    await expect(overlay).toBeVisible();

    // Count exposed roles. Q1 radios (3) + Q2 checkboxes (3) + Q3
    // radios (2) = 5 radios + 3 checkboxes. Prove the DOM is sane.
    const radios = overlay.getByRole("radio");
    const checkboxes = overlay.getByRole("checkbox");
    await expect(radios).toHaveCount(5);
    await expect(checkboxes).toHaveCount(3);

    // Q1 SINGLE_CHOICE :: role=radio name=Orange. Use .check() which
    // performs an actionability-aware input toggle + waits for the
    // checked state to settle. Then auto-retrying toBeChecked() proves
    // the controlled React commit landed.
    const orangeRadio = overlay.getByRole("radio", { name: "Orange", exact: true });
    await expect(orangeRadio).toHaveCount(1);
    await expect(orangeRadio).not.toBeChecked();
    await orangeRadio.check();
    await expect(orangeRadio).toBeChecked();

    // Q2 MULTI_ANSWER :: role=checkbox name="Hard hat". This is the
    // specific control my 2a279d9 fix targets (explicit onClick on
    // label + htmlFor + id). Prove it toggles via .check() AND via a
    // plain label click (what a real user does).
    const hardHatCheckbox = overlay.getByRole("checkbox", { name: "Hard hat", exact: true });
    await expect(hardHatCheckbox).toHaveCount(1);
    await expect(hardHatCheckbox).not.toBeChecked();
    await hardHatCheckbox.check();
    await expect(hardHatCheckbox).toBeChecked();

    // Second MULTI_ANSWER option. User-style label click (click the
    // label testid, not the input). Prove the Slice 3D onClick fix
    // routes through to the React setMultiAnswers path.
    const sgLabel = overlay.locator('label[data-testid^="portal-checkpoint-option-"]').filter({ hasText: "Safety goggles" }).first();
    const sgCheckbox = overlay.getByRole("checkbox", { name: "Safety goggles", exact: true });
    await expect(sgCheckbox).not.toBeChecked();
    await sgLabel.click();
    await expect(sgCheckbox).toBeChecked();

    // Q3 TRUE_FALSE :: role=radio name=True.
    const trueRadio = overlay.getByRole("radio", { name: "True", exact: true });
    await expect(trueRadio).toHaveCount(1);
    await trueRadio.check();
    await expect(trueRadio).toBeChecked();

    // ===== DIAGNOSTIC SCOPE =====
    // The purpose of this diag is to prove that:
    //   (1) radios flip on .check()
    //   (2) checkboxes flip on .check()
    //   (3) checkbox LABEL CLICK propagates to React state (the
    //       Slice 3D-verify 2a279d9 fix for MULTI_ANSWER)
    // All three are proven above. The post-submit flow is covered by
    // the full walkthrough spec, not here.
    console.log("PASS: all four controls (Orange, Hard hat, Safety goggles via label-click, True) toggled correctly");
  });
});
