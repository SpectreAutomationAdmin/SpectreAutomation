#!/usr/bin/env node
// EP-TRAIN-4Y-AC §8 acceptance — delete both 4YAC fixtures through
// the real Admin UI and verify behaviour end-to-end.
//
// Preconditions: fixture ids were produced by
// `scripts/4yac-fly-seed-fixture.mjs` into
// test-results/4yac-fixture-ids.json. BOTH fixtures are tagged
// with the "4YAC-ACCEPT-*" course code so a safety guard refuses
// to run against any id whose code doesn't start with the tag.
//
// Pilot-course safety: refuses to click Delete on either of the two
// Silver Springs pilot course ids (hard-coded protect list).

import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = "https://staging.spectreautomation.com";
const PROTECTED_COURSE_IDS = new Set([
  "cmw8n6z8f0008z4nxck6uvms9", // 4Y-Z Silver Springs pilot
  "cmvzs3vz9000256qcu7lfysoz", // older Silver Springs pilot (historical AI evidence)
]);
const TAG_PREFIX = "4YAC-ACCEPT-";

function env(k) {
  if (process.env[k]) return process.env[k];
  for (const f of [".env.playwright.local", ".env.local"]) {
    const p = path.join(process.cwd(), f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)\s*$/);
      if (m && m[1] === k) return m[2].replace(/^["']|["']$/g, "");
    }
  }
  return null;
}

const fixturesPath = "test-results/4yac-fixture-ids.json";
if (!fs.existsSync(fixturesPath)) {
  console.error("Missing", fixturesPath, "— run scripts/4yac-fly-seed-fixture.mjs first.");
  process.exit(2);
}
const fixtures = JSON.parse(fs.readFileSync(fixturesPath, "utf8"));
for (const f of [fixtures.fixtureA, fixtures.fixtureB]) {
  if (PROTECTED_COURSE_IDS.has(f.courseId)) {
    console.error("REFUSING — fixture id collides with a protected pilot:", f.courseId);
    process.exit(2);
  }
  if (!f.courseCode?.startsWith(TAG_PREFIX)) {
    console.error("REFUSING — fixture code does not carry the", TAG_PREFIX, "tag:", f.courseCode);
    process.exit(2);
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  // Auto-accept window.confirm dialogs.
  page.on("dialog", async (d) => {
    console.log(`  confirm (accept): ${d.message().slice(0, 80)}`);
    await d.accept();
  });

  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[name="email"]', env("SPECTRE_STAGING_EMAIL"));
  await page.fill('input[name="password"]', env("SPECTRE_STAGING_PASSWORD"));
  await Promise.all([page.waitForURL(/\/app\//), page.click('button[type="submit"]')]);

  const listUrl = `${BASE}/app/admin/people/safety-training`;
  await page.goto(listUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  fs.mkdirSync("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/4yac-before.png", fullPage: true });

  const bodyBefore = await page.locator('body').innerText();
  const pilotPresentBefore =
    bodyBefore.includes("Employee Onboarding and Policies") ||
    [...PROTECTED_COURSE_IDS].some((id) => bodyBefore.includes(id));
  console.log(`\n  pilot-course sentinel visible before delete: ${pilotPresentBefore}`);

  const report = { capturedAt: new Date().toISOString(), scenarios: [] };

  async function runDelete(label, courseId, courseCode) {
    console.log(`\n--- ${label} ---`);
    console.log(`  courseId: ${courseId}`);
    const rowBefore = page.locator(`[data-testid="training-active-row-${courseId}"]`);
    const rowExistsBefore = (await rowBefore.count()) > 0;
    console.log(`  row visible before click: ${rowExistsBefore}`);
    const deleteBtn = page.locator(`[data-testid="training-course-delete-draft-${courseId}"]`);
    const btnPresent = (await deleteBtn.count()) > 0;
    console.log(`  delete button visible:    ${btnPresent}`);

    if (!btnPresent) {
      report.scenarios.push({
        label, courseId, courseCode,
        skipped: "delete button not visible — course may already be gone",
      });
      return;
    }

    await deleteBtn.click();
    await page.waitForTimeout(6000);

    const bodyAfter = await page.locator('body').innerText();
    const crashed = bodyAfter.includes("Application error");
    const boundary = (await page.locator('[data-testid="training-dashboard-error"]').count()) > 0;
    const rowGone = (await page.locator(`[data-testid="training-active-row-${courseId}"]`).count()) === 0;
    const inlineErr = await page
      .locator(`[data-testid="training-course-row-error-${courseId}"]`)
      .textContent()
      .catch(() => null);

    console.log(`  crashed:         ${crashed}`);
    console.log(`  error boundary:  ${boundary}`);
    console.log(`  row gone:        ${rowGone}`);
    if (inlineErr) console.log(`  inline error:    ${inlineErr.slice(0, 160)}`);

    report.scenarios.push({
      label,
      courseId,
      courseCode,
      crashed,
      errorBoundaryShown: boundary,
      rowGoneAfterDelete: rowGone,
      inlineError: inlineErr,
    });
  }

  // Fixture A — happy-path delete (no AI data).
  await runDelete("Scenario A (happy path, no AI)", fixtures.fixtureA.courseId, fixtures.fixtureA.courseCode);
  // Reload to pull fresh state.
  await page.goto(listUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  // Fixture B — AI-child cleanup path.
  await runDelete("Scenario B (AI-child path)", fixtures.fixtureB.courseId, fixtures.fixtureB.courseCode);
  await page.goto(listUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: "test-results/4yac-after.png", fullPage: true });

  const bodyFinal = await page.locator('body').innerText();
  const pilotPresentAfter = bodyFinal.includes("Employee Onboarding and Policies");
  const dashboardReloadCrashed = bodyFinal.includes("Application error");

  report.pilotPresentBefore = pilotPresentBefore;
  report.pilotPresentAfter = pilotPresentAfter;
  report.dashboardReloadCrashed = dashboardReloadCrashed;

  console.log(`\n--- post-delete dashboard reload ---`);
  console.log(`  pilot still present:        ${pilotPresentAfter}`);
  console.log(`  reload crashed:             ${dashboardReloadCrashed}`);

  fs.writeFileSync("test-results/4yac-acceptance.json", JSON.stringify(report, null, 2));
  console.log("\n→ wrote test-results/4yac-acceptance.json");

  await browser.close();
  // Exit non-zero if any scenario crashed or any row did not disappear.
  const failed = report.scenarios.some((s) => s.crashed || s.errorBoundaryShown || (s.skipped === undefined && !s.rowGoneAfterDelete));
  if (failed) process.exit(1);
  if (!report.pilotPresentAfter) {
    console.error("PILOT NOT VISIBLE AFTER DELETE — pilot may have been unexpectedly affected!");
    process.exit(2);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
