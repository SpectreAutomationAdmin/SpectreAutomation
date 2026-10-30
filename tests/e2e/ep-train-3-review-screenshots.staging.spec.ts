// EP-TRAIN-3 (2026-10-30) — Founder-review screenshot capture.
//
// Prepares desktop + mobile evidence for the hands-on founder review
// per directive §4.  No application code or data is changed.
//
// Manager screenshots (Chris's own CLUB_ADMIN account via
// .env.playwright.local SPECTRE_STAGING_EMAIL / SPECTRE_STAGING_PASSWORD):
//   - Training course catalogue
//   - New course form
//   - Version editor (video + checkpoint timeline + question editor +
//     final assessment + publish panel) on the review-fixture course
//
// Employee screenshots (disposable demo credential — password supplied
// to the founder via a secure channel, never written to a file in
// this repo):
//   - Employee portal course list
//   - Course player with cp1 overlay
//
// Capture at the directive's primary review viewports (1440×900
// desktop + 390×844 mobile).

import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const outDir = path.resolve(process.cwd(), "test-results/ep-train-3-review-screenshots");
fs.mkdirSync(outDir, { recursive: true });

// Review fixture (provisioned 2026-10-30 via
// scripts/ep-train-3-review-fixture.mjs). Updating these constants if
// the fixture is reprovisioned.
const REVIEW_COURSE_ID = "cmvvgku6p00062ml0lb9jj5nd";
const REVIEW_VERSION_ID = "cmvvgku7b00082ml0hvy6deof";
const REVIEW_EMPLOYEE_EMAIL = "ep-train-3-founder-demo@spectre.test";
const REVIEW_EMPLOYEE_PASSWORD = process.env.EP_TRAIN_3_REVIEW_PORTAL_PASSWORD ?? "";

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

async function managerLogin(page: Page): Promise<void> {
  const email = process.env.SPECTRE_STAGING_EMAIL!;
  const password = process.env.SPECTRE_STAGING_PASSWORD!;
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 }),
    page.locator('form button[type="submit"]').first().click(),
  ]);
}

async function employeeLogin(page: Page): Promise<void> {
  if (!REVIEW_EMPLOYEE_PASSWORD) {
    test.skip(true, "EP_TRAIN_3_REVIEW_PORTAL_PASSWORD env not set — review employee shots skipped");
  }
  await page.goto(`${BASE}/employee/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="email"]').fill(REVIEW_EMPLOYEE_EMAIL);
  await page.locator('input[name="password"]').fill(REVIEW_EMPLOYEE_PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/employee/login"), { timeout: 30_000 }),
    page.locator('form button[type="submit"]').first().click(),
  ]);
}

for (const vp of [{ label: "desktop-1440x900", width: 1440, height: 900 }, { label: "mobile-390x844", width: 390, height: 844 }] as const) {
  test.describe(`EP-TRAIN-3 review screenshots :: ${vp.label}`, () => {
    test(`manager safety-training course catalogue @ ${vp.label}`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await ctx.newPage();
      await managerLogin(page);
      await page.goto(`${BASE}/app/admin/people/safety-training`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => { /* ignore */ });
      await page.screenshot({ path: path.join(outDir, `${vp.label}-mgr-01-course-catalogue.png`), fullPage: true });
      await ctx.close();
    });

    test(`manager new-course form @ ${vp.label}`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await ctx.newPage();
      await managerLogin(page);
      await page.goto(`${BASE}/app/admin/people/safety-training/new`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => { /* ignore */ });
      await page.screenshot({ path: path.join(outDir, `${vp.label}-mgr-02-new-course.png`), fullPage: true });
      await ctx.close();
    });

    test(`manager version editor (video + checkpoints + questions + publish) @ ${vp.label}`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await ctx.newPage();
      await managerLogin(page);
      // NOTE: the review fixture's version is PUBLISHED, so this
      // renders the read-only view. For the editable view the founder
      // creates a new course from the catalogue (New course button).
      await page.goto(`${BASE}/app/admin/people/safety-training/${REVIEW_COURSE_ID}/${REVIEW_VERSION_ID}`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => { /* ignore */ });
      await page.screenshot({ path: path.join(outDir, `${vp.label}-mgr-03-version-editor.png`), fullPage: true });
      await ctx.close();
    });

    test(`manager safety-training course detail @ ${vp.label}`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await ctx.newPage();
      await managerLogin(page);
      await page.goto(`${BASE}/app/admin/people/safety-training/${REVIEW_COURSE_ID}`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => { /* ignore */ });
      await page.screenshot({ path: path.join(outDir, `${vp.label}-mgr-04-course-detail.png`), fullPage: true });
      await ctx.close();
    });

    test(`manager compliance view @ ${vp.label}`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await ctx.newPage();
      await managerLogin(page);
      await page.goto(`${BASE}/app/admin/people/safety-training/compliance`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => { /* ignore */ });
      await page.screenshot({ path: path.join(outDir, `${vp.label}-mgr-05-compliance.png`), fullPage: true });
      await ctx.close();
    });

    test(`employee portal course list @ ${vp.label}`, async ({ browser }) => {
      if (!REVIEW_EMPLOYEE_PASSWORD) test.skip(true, "no demo portal password in env");
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await ctx.newPage();
      await employeeLogin(page);
      await page.goto(`${BASE}/employee/safety-training`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => { /* ignore */ });
      await page.screenshot({ path: path.join(outDir, `${vp.label}-emp-01-course-list.png`), fullPage: true });
      await ctx.close();
    });

    test(`employee course player with cp1 overlay @ ${vp.label}`, async ({ browser }) => {
      if (!REVIEW_EMPLOYEE_PASSWORD) test.skip(true, "no demo portal password in env");
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await ctx.newPage();
      await employeeLogin(page);
      await page.goto(`${BASE}/employee/safety-training`, { waitUntil: "domcontentloaded" });
      const link = page.locator('[data-testid^="portal-safety-training-course-"]:visible').filter({ hasText: "Founder Demo" }).first();
      await expect(link).toBeVisible({ timeout: 15_000 });
      await Promise.all([
        page.waitForURL(/\/employee\/safety-training\/[^/]+/, { timeout: 15_000 }),
        link.click(),
      ]);
      await page.waitForLoadState("domcontentloaded");
      await page.waitForFunction(() => {
        const videos = Array.from(document.querySelectorAll('[data-testid="portal-course-video"]')) as HTMLVideoElement[];
        return videos.some((v) => v.readyState >= 2 && Number.isFinite(v.duration));
      }, undefined, { timeout: 30_000 }).catch(() => { /* ignore */ });
      await page.evaluate(async () => {
        const videos = Array.from(document.querySelectorAll('[data-testid="portal-course-video"]')) as HTMLVideoElement[];
        const v = videos.find((el) => el.offsetParent !== null);
        if (!v) return;
        v.muted = true;
        v.playbackRate = 2;
        try { await v.play(); } catch { /* ignore */ }
      });
      await expect(page.locator('[data-testid="portal-checkpoint-overlay"]:visible').first()).toBeVisible({ timeout: 30_000 });
      await page.screenshot({ path: path.join(outDir, `${vp.label}-emp-02-cp1-overlay.png`), fullPage: true });
      await ctx.close();
    });
  });
}
