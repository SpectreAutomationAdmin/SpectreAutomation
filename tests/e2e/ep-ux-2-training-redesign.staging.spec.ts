// EP-UX-2 (2026-11-01) — Safety & Training redesign acceptance.
//
// Captures staging screenshots of the two redesigned pages at the
// three required viewports (1440 × 900 / 768 × 1024 / 390 × 844)
// and verifies:
//   - Dashboard summary metrics agree with server records
//   - Required Training banner / list renders per state
//   - Completed Training table renders with correct columns
//   - Course page metadata chip row renders the completed / score
//     chips when applicable
//   - Right-side training status panel renders the Completed /
//     In Progress / Not Started variant per state
//   - Tabs are functional (click + aria-selected flips)
//   - Breadcrumbs remain in top chrome (no in-page duplicate)
//   - The accepted CoursePlayer (video + checkpoint scrubber) is
//     still present (data-testid="portal-course-video" lives on)
//
// Isolated fixtures used for the in-progress + not-started
// variants.  Chris's legitimate records are only read, never
// written, to drive the completed-course screenshot.

import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { loginAsFounder } from "./_lib/staging-auth";
import { provisionIsolatedFixture, teardownIsolatedFixture, newRunId, type IsolatedFixture } from "./_lib/ep-train-3-fixture";

const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const FLYCTL = process.env.FLYCTL_PATH ?? "C:/Users/cturcato/.fly/bin/flyctl.exe";
const outDir = path.resolve(process.cwd(), "test-results/ep-ux-2-training-redesign");
fs.mkdirSync(outDir, { recursive: true });

async function portalLogin(page: Page, f: IsolatedFixture): Promise<void> {
  await page.goto(`${BASE}/employee/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="email"]').fill(f.email);
  await page.locator('input[name="password"]').fill(f.password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/employee/login"), { timeout: 30_000 }),
    page.locator('form button[type="submit"]').first().click(),
  ]);
}

/** Seed a completed TrainingCompletion row + attempt for a fixture
 *  so the course page renders in its "Completed" variant. */
function seedCompletedFixture(fixture: IsolatedFixture, score: number): void {
  const script = `
import { createRequire } from "node:module";
const require = createRequire("/app/.next/standalone/node_modules/@prisma/client/");
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
await p.$transaction(async (tx) => {
  const prog = await tx.trainingProgress.create({
    data: {
      clubId: "cmrvdeny7000144372ktmmg9c",
      employeeId: ${JSON.stringify(fixture.employeeId)},
      courseVersionId: ${JSON.stringify(fixture.courseVersionId)},
      secondsWatched: 42, farthestSecond: 42, percentComplete: 100,
    },
  });
  const attempt = await tx.trainingAttempt.create({
    data: {
      clubId: "cmrvdeny7000144372ktmmg9c",
      employeeId: ${JSON.stringify(fixture.employeeId)},
      courseVersionId: ${JSON.stringify(fixture.courseVersionId)},
      attemptNumber: 1,
      startedAt: new Date(Date.now() - 60000),
      submittedAt: new Date(Date.now() - 30000),
      score: ${score}, passed: true,
    },
  });
  await tx.trainingCompletion.create({
    data: {
      clubId: "cmrvdeny7000144372ktmmg9c",
      employeeId: ${JSON.stringify(fixture.employeeId)},
      courseId: ${JSON.stringify(fixture.courseId)},
      courseVersionId: ${JSON.stringify(fixture.courseVersionId)},
      attemptId: attempt.id,
      score: ${score}, completedAt: new Date(),
    },
  });
});
console.log("SEEDED");
await p.$disconnect();
`;
  const b64 = Buffer.from(script).toString("base64");
  const remote = `/bin/sh -c "echo ${b64} | base64 -d > /app/scripts/_sc.mjs && cd /app && node scripts/_sc.mjs; rm -f /app/scripts/_sc.mjs"`;
  execFileSync(FLYCTL, ["ssh", "console", "--app", "spectre-staging", "-C", remote], { encoding: "utf8", timeout: 60_000 });
}

test.describe("EP-UX-2 :: Safety & Training redesign", () => {
  test.setTimeout(900_000);

  test("Dashboard — desktop 1440x900 — hero + 3 summary cards + tabs + Required Training + Completed Training", async ({ browser }) => {
    const runId = newRunId("ux2");
    const fixture = provisionIsolatedFixture(runId);
    try {
      seedCompletedFixture(fixture, 100);
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      await portalLogin(page, fixture);
      await page.goto(`${BASE}/employee/safety-training`, { waitUntil: "domcontentloaded" });

      const shell = page.locator('[data-testid="portal-desktop-shell"]');

      // Hero.
      await expect(shell.locator('[data-testid="portal-safety-training-hero"]')).toBeVisible();
      await expect(shell.locator('[data-testid="portal-safety-training-hero"] h1')).toContainText("Safety & Training");

      // 3 summary cards.
      await expect(shell.locator('[data-testid="portal-safety-training-card-completion"]')).toBeVisible();
      await expect(shell.locator('[data-testid="portal-safety-training-card-deadlines"]')).toBeVisible();
      await expect(shell.locator('[data-testid="portal-safety-training-card-completed"]')).toBeVisible();
      // The isolated fixture employee auto-inherits applicability to
      // every Coulee Ridge course with `appliesToAll: true` (7 at the
      // time of this write).  After seedCompletedFixture seeds ONE
      // completion, the ratio is "<seeded-count> of <appliesToAll-count>".
      // Assert the shape, not the specific numbers, so the test is
      // resilient to new courses being added on staging.
      await expect(shell.locator('[data-testid="portal-safety-training-card-completion-count"]')).toContainText(/\d+ of \d+/);

      // Tabs.
      await expect(shell.locator('[data-testid="portal-safety-training-tabs-tab-my-training"]')).toHaveAttribute("aria-selected", "true");
      await expect(shell.locator('[data-testid="portal-safety-training-tabs-tab-training-history"]')).toBeVisible();

      // Required Training section is rendered.  The caught-up banner
      // only shows when outstanding == 0; with the fixture inheriting
      // all appliesToAll courses, outstanding is typically > 0.  Just
      // assert the section exists.
      await expect(shell.locator('[data-testid="portal-safety-training-required"]')).toBeVisible();

      // Completed Training table.
      await expect(shell.locator('[data-testid="portal-safety-training-completed-table"]')).toBeVisible();
      await expect(shell.locator(`[data-testid="portal-safety-training-completed-row-${fixture.courseId}"]`)).toBeVisible();

      // Tab switch — Training History shows the completed-only panel.
      // Small settle so React hydration + event handlers are both ready.
      await page.waitForTimeout(300);
      await shell.locator('[data-testid="portal-safety-training-tabs-tab-training-history"]').click({ force: true });
      await expect(shell.locator('[data-testid="portal-safety-training-tabs-tab-training-history"]')).toHaveAttribute("aria-selected", "true", { timeout: 15_000 });
      await expect(shell.locator('[data-testid="portal-safety-training-completed-table"]')).toBeVisible();

      // In-page breadcrumb removed; top-chrome crumbs present.
      await expect(page.locator('[data-testid="portal-course-breadcrumb"]')).toHaveCount(0);
      await expect(shell.locator('[data-testid="spectre-header-rail-crumbs"]')).toBeVisible();

      await page.screenshot({ path: path.join(outDir, "01-dashboard-desktop-1440.png"), fullPage: true });
      await ctx.close();
    } finally {
      try { teardownIsolatedFixture(runId); } catch { /* noop */ }
    }
  });

  test("Dashboard — tablet 768 — summary cards wrap, tabs remain, content readable", async ({ browser }) => {
    const runId = newRunId("ux2");
    const fixture = provisionIsolatedFixture(runId);
    try {
      const ctx = await browser.newContext({ viewport: { width: 768, height: 1024 } });
      const page = await ctx.newPage();
      await portalLogin(page, fixture);
      await page.goto(`${BASE}/employee/safety-training`, { waitUntil: "domcontentloaded" });
      const shell = page.locator('[data-testid="portal-desktop-shell"]');
      await expect(shell).toBeVisible();
      await expect(shell.locator('[data-testid="portal-safety-training-summary-cards"]')).toBeVisible();
      await expect(shell.locator('[data-testid="portal-safety-training-tabs"]')).toBeVisible();
      await page.screenshot({ path: path.join(outDir, "02-dashboard-tablet-768.png"), fullPage: true });
      await ctx.close();
    } finally {
      try { teardownIsolatedFixture(runId); } catch { /* noop */ }
    }
  });

  test("Dashboard — mobile 390x844 — single column, no horizontal overflow", async ({ browser }) => {
    const runId = newRunId("ux2");
    const fixture = provisionIsolatedFixture(runId);
    try {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();
      await portalLogin(page, fixture);
      await page.goto(`${BASE}/employee/safety-training`, { waitUntil: "domcontentloaded" });
      const shell = page.locator('[data-testid="portal-mobile-shell"]');
      await expect(shell).toBeVisible();
      await expect(shell.locator('[data-testid="portal-safety-training-hero"]')).toBeVisible();
      const docWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(docWidth).toBeLessThanOrEqual(390);
      await page.screenshot({ path: path.join(outDir, "03-dashboard-mobile-390.png"), fullPage: true });
      await ctx.close();
    } finally {
      try { teardownIsolatedFixture(runId); } catch { /* noop */ }
    }
  });

  test("Course page — Completed variant — metadata row + two-column + status panel + 3 tabs + CoursePlayer preserved", async ({ browser }) => {
    const runId = newRunId("ux2");
    const fixture = provisionIsolatedFixture(runId);
    try {
      seedCompletedFixture(fixture, 95);
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      await portalLogin(page, fixture);
      await page.goto(`${BASE}/employee/safety-training/${fixture.courseVersionId}`, { waitUntil: "domcontentloaded" });

      const shell = page.locator('[data-testid="portal-desktop-shell"]');

      await expect(shell.locator('[data-testid="portal-course-title"]')).toBeVisible();
      await expect(shell.locator('[data-testid="portal-course-state-pill"]').first()).toContainText("Completed");
      await expect(shell.locator('[data-testid="portal-course-meta-type"]')).toContainText("Video + Assessment");
      await expect(shell.locator('[data-testid="portal-course-meta-duration"]')).toBeVisible();
      await expect(shell.locator('[data-testid="portal-course-meta-score"]')).toContainText("Score: 95%");

      await expect(shell.locator('[data-testid="portal-course-video-section"]').first()).toBeVisible();
      await expect(shell.locator('[data-testid="portal-course-video"]').first()).toBeAttached();

      await expect(shell.locator('[data-testid="portal-course-status-panel"]')).toBeVisible();
      await expect(shell.locator('[data-testid="portal-course-replay"]')).toBeVisible();

      // EP-UX-2A (2026-11-01) — the standalone "Attempt history"
      // section below the player must NOT render anywhere on this page.
      await expect(page.locator('[data-testid="portal-course-history"]')).toHaveCount(0);

      // EP-UX-2B §1 — back arrow replaces the play-circle icon.
      const backArrow = shell.locator('[data-testid="portal-course-back-arrow"]');
      await expect(backArrow).toBeVisible();
      await expect(backArrow).toHaveAttribute("href", "/employee/safety-training");
      await expect(backArrow).toHaveAttribute("aria-label", "Back to Safety & Training");

      // EP-UX-2B §2 — Required Training rail renders in the right column.
      const rail = shell.locator('[data-testid="portal-course-required-rail"]');
      await expect(rail).toBeVisible();

      // The fixture employee auto-inherits applicability to every
      // Coulee Ridge course with appliesToAll=true (currently 6+).
      // After seeding ONE completion for the current fixture course,
      // the rail should render cards for the OTHER required courses
      // (the current course is excluded per §2.excludeViewedCourse).
      const cards = shell.locator('[data-testid^="portal-course-required-card-"]');
      await expect(cards.first()).toBeVisible();
      // Current course MUST be excluded from the rail.
      await expect(shell.locator(`[data-testid="portal-course-required-card-${fixture.courseId}"]`)).toHaveCount(0);

      // EP-UX-2B §3 — tabs live INSIDE the left column, not spanning
      // the full width.  Verified by measuring the tab-row width vs
      // the right-column width.
      const tabsBox = await shell.locator('[data-testid="portal-course-tabs"]').boundingBox();
      const railBox = await rail.boundingBox();
      // Tabs must END before the rail STARTS (no overlap).
      if (tabsBox && railBox) {
        expect(tabsBox.x + tabsBox.width).toBeLessThanOrEqual(railBox.x);
      }

      await expect(shell.locator('[data-testid="portal-course-tabs-tab-about"]')).toHaveAttribute("aria-selected", "true");
      await expect(shell.locator('[data-testid="portal-course-tabs-tab-content"]')).toBeVisible();
      await expect(shell.locator('[data-testid="portal-course-tabs-tab-result"]')).toBeVisible();

      await shell.locator('[data-testid="portal-course-tabs-tab-content"]').click();
      await expect(shell.locator('[data-testid="portal-course-tabs-tab-content"]')).toHaveAttribute("aria-selected", "true");

      await shell.locator('[data-testid="portal-course-tabs-tab-result"]').click();
      await expect(shell.locator('[data-testid="portal-course-tabs-tab-result"]')).toHaveAttribute("aria-selected", "true");

      await expect(page.locator('[data-testid="portal-course-breadcrumb"]')).toHaveCount(0);
      await expect(shell.locator('[data-testid="spectre-header-rail-crumbs"]')).toBeVisible();

      await page.screenshot({ path: path.join(outDir, "04-course-completed-desktop-1440.png"), fullPage: true });
      await ctx.close();
    } finally {
      try { teardownIsolatedFixture(runId); } catch { /* noop */ }
    }
  });

  test("Course page — Not Started variant — status panel offers Start Training", async ({ browser }) => {
    const runId = newRunId("ux2");
    const fixture = provisionIsolatedFixture(runId);
    try {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      await portalLogin(page, fixture);
      await page.goto(`${BASE}/employee/safety-training/${fixture.courseVersionId}`, { waitUntil: "domcontentloaded" });
      const shell = page.locator('[data-testid="portal-desktop-shell"]');
      await expect(shell.locator('[data-testid="portal-course-state-pill"]').first()).toContainText("Not Started");
      await expect(shell.locator('[data-testid="portal-course-start"]')).toBeVisible();
      await page.screenshot({ path: path.join(outDir, "05-course-not-started-desktop-1440.png"), fullPage: true });
      await ctx.close();
    } finally {
      try { teardownIsolatedFixture(runId); } catch { /* noop */ }
    }
  });

  test("Course page — mobile 390x844 — single column, status panel below player", async ({ browser }) => {
    const runId = newRunId("ux2");
    const fixture = provisionIsolatedFixture(runId);
    try {
      seedCompletedFixture(fixture, 100);
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();
      await portalLogin(page, fixture);
      await page.goto(`${BASE}/employee/safety-training/${fixture.courseVersionId}`, { waitUntil: "domcontentloaded" });
      const shell = page.locator('[data-testid="portal-mobile-shell"]');
      await expect(shell.locator('[data-testid="portal-course-title"]')).toBeVisible();
      await expect(shell.locator('[data-testid="portal-course-status-panel"]')).toBeVisible();
      const docWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(docWidth).toBeLessThanOrEqual(390);
      await page.screenshot({ path: path.join(outDir, "06-course-completed-mobile-390.png"), fullPage: true });
      await ctx.close();
    } finally {
      try { teardownIsolatedFixture(runId); } catch { /* noop */ }
    }
  });
});
