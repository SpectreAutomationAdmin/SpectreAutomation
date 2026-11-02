// EP-TRAIN-5C-3A (2026-11-02) — Authenticated employee-portal
// acceptance for the obligation-aware UI shipped by EP-TRAIN-5C-3.
//
// Resolves the employee-auth gap by reusing the existing EP-TRAIN-3
// Slice 3 isolated-fixture harness (tests/e2e/_lib/ep-train-3-fixture.ts),
// which provisions a disposable employee WITH an EmployeePortalCredential
// row + random password + a published course.  No new auth system is
// introduced; no production impersonation path is created; no founder
// identity is used to simulate an employee.
//
// Per directive §1 requirements:
//   * Each test provisions its own disposable fixture (new runId).
//   * The fixture employee is logged in via the real /employee/login
//     flow with the harness-generated password.
//   * Teardown cleans up the fixture (employee + credential + course
//     + attempts + progress + completions + obligations + audit).
//   * Legitimate employees + credentials are never touched.
//   * Fixture credentials never persist to source — they live only
//     in the test's local variable + the staging DB row that
//     teardown deletes.
//
// Scenarios (directive §2 - §6):
//   A — Baseline dashboard (no obligation): preserved EP-UX-2D.
//   B — Replay compatibility (historical completion, no obligation):
//       course page = Training Complete, player replay-only.
//   C — Retake Required (MANUAL_REINSTATE on prior completion):
//       dashboard chip + course page amber banner + reason note.
//   D — Multiple Outstanding (2x MANUAL_REINSTATE Keep Both):
//       single card + "Multiple completions required" chip.
//   E — Historical vs current gating (directive §6): historical
//       completion is NOT presented as current compliance; prior
//       passing score cannot unlock the new assessment.
//
// Each scenario captures screenshots at the three required viewports
// (1440×900, 768×1024, 390×844) per directive §7.

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import {
  provisionIsolatedFixture,
  teardownIsolatedFixture,
  newRunId,
  type IsolatedFixture,
} from "./_lib/ep-train-3-fixture";
import {
  seedHistoricalCompletion,
  seedObligation,
  snapshotFixtureCounts,
  snapshotFounderCounts,
  cleanupFixtureObligations,
} from "./_lib/ep-train-5c3a-seed";

const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const outDir = path.resolve(process.cwd(), "test-results/ep-train-5c3a-authenticated-employee");
fs.mkdirSync(outDir, { recursive: true });

async function portalLogin(page: Page, fixture: IsolatedFixture): Promise<void> {
  await page.goto(`${BASE}/employee/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="email"]').fill(fixture.email);
  await page.locator('input[name="password"]').fill(fixture.password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/employee/login"), { timeout: 30_000 }),
    page.locator('form button[type="submit"]').first().click(),
  ]);
}

async function captureAtViewports(
  browser: BrowserContext["browser"],
  fixture: IsolatedFixture,
  url: string,
  prefix: string,
): Promise<void> {
  const viewports = [
    { label: "1440x900", w: 1440, h: 900 },
    { label: "768x1024", w: 768, h: 1024 },
    { label: "390x844", w: 390, h: 844 },
  ];
  for (const vp of viewports) {
    const ctx = await browser!.newContext({ viewport: { width: vp.w, height: vp.h } });
    const page = await ctx.newPage();
    try {
      await portalLogin(page, fixture);
      await page.goto(`${BASE}${url}`, { waitUntil: "networkidle" });
      await page.screenshot({ path: path.join(outDir, `${prefix}-${vp.label}.png`), fullPage: true });
    } finally {
      await ctx.close();
    }
  }
}

test.describe.configure({ mode: "serial" });

test.describe("EP-TRAIN-5C-3A :: authenticated employee UX acceptance", () => {
  test.setTimeout(900_000);

  let founderBefore: { completions: number; attempts: number; progress: number };

  test.beforeAll(async () => {
    founderBefore = snapshotFounderCounts();
    console.log(`[5C-3A] Founder baseline: ${JSON.stringify(founderBefore)}`);
  });

  test.afterAll(async () => {
    const founderAfter = snapshotFounderCounts();
    console.log(`[5C-3A] Founder after: ${JSON.stringify(founderAfter)}`);
    expect(founderAfter.completions).toBe(founderBefore.completions);
    expect(founderAfter.attempts).toBe(founderBefore.attempts);
    expect(founderAfter.progress).toBe(founderBefore.progress);
  });

  // -------------------------------------------------------------------------
  // Scenario A — Baseline dashboard (no obligation).  Verifies EP-UX-2D
  // is preserved for employees without the new obligation state.
  // -------------------------------------------------------------------------
  test("A — baseline: no obligation, no completion → EP-UX-2D unchanged", async ({ browser }) => {
    const runId = newRunId("5c3a");
    const fixture = provisionIsolatedFixture(runId);
    try {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      await portalLogin(page, fixture);
      await page.goto(`${BASE}/employee/safety-training`, { waitUntil: "networkidle" });
      const shell = page.locator('[data-testid="portal-desktop-shell"]');
      await expect(shell.locator('[data-testid="portal-safety-training-hero"]')).toBeVisible();
      // The fixture course appears as Required (not completed, no obligation).
      await expect(shell.locator(`[data-testid="portal-safety-training-course-${fixture.courseId}"]`)).toBeVisible();
      // Pre-5C-3 "Required" label — no obligation chip.
      await expect(shell.locator(`[data-testid="portal-safety-training-course-${fixture.courseId}"]`)).toHaveAttribute("data-obligation-label", "Required");
      await expect(shell.locator(`[data-testid="portal-safety-training-course-${fixture.courseId}-obligation-chip"]`)).toHaveCount(0);
      await page.screenshot({ path: path.join(outDir, "A-baseline-dashboard-1440x900.png"), fullPage: true });
      await ctx.close();
    } finally {
      cleanupFixtureObligations(fixture);
      teardownIsolatedFixture(runId);
    }
  });

  // -------------------------------------------------------------------------
  // Scenario B — Replay compatibility (directive §10).  Historical
  // completion + NO obligation → EP-TRAIN-4E completed-replay preserved.
  // -------------------------------------------------------------------------
  test("B — historical completion, no obligation → Completed + replay preserved", async ({ browser }) => {
    const runId = newRunId("5c3a");
    const fixture = provisionIsolatedFixture(runId);
    try {
      seedHistoricalCompletion(fixture, { score: 95, daysAgo: 30 });
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      await portalLogin(page, fixture);
      await page.goto(`${BASE}/employee/safety-training/${encodeURIComponent(fixture.courseVersionId)}`, { waitUntil: "networkidle" });
      // Scope to the desktop shell — the portal renders mobile shell too.
      const shell = page.locator('[data-testid="portal-desktop-shell"]');
      await expect(shell.locator('[data-testid="portal-course-state-pill"]').first()).toContainText("Completed");
      await expect(shell.locator('[data-testid="portal-course-replay"]').first()).toBeVisible();
      await page.screenshot({ path: path.join(outDir, "B-completed-replay-course-1440x900.png"), fullPage: true });
      await ctx.close();
    } finally {
      cleanupFixtureObligations(fixture);
      teardownIsolatedFixture(runId);
    }
  });

  // -------------------------------------------------------------------------
  // Scenario C — Retake Required.  Historical completion + a
  // MANUAL_REINSTATE obligation → amber "Retake Required" surfaces on
  // both the dashboard card AND the course page's TrainingStatusPanel.
  // Historical completion remains visible.
  // -------------------------------------------------------------------------
  test("C — Retake Required: dashboard chip + course banner + reason note", async ({ browser }) => {
    const runId = newRunId("5c3a");
    const fixture = provisionIsolatedFixture(runId);
    try {
      const seededCompletion = seedHistoricalCompletion(fixture, { score: 92, daysAgo: 45 });
      seedObligation(fixture, {
        reason: "MANUAL_REINSTATE",
        reasonNote: "5C-3A acceptance: refresher after safety incident on 2026-10-28.",
      });

      // Dashboard check at 1440x900.
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      await portalLogin(page, fixture);
      await page.goto(`${BASE}/employee/safety-training`, { waitUntil: "networkidle" });
      const shell = page.locator('[data-testid="portal-desktop-shell"]');
      await expect(shell.locator(`[data-testid="portal-safety-training-course-${fixture.courseId}"]`)).toBeVisible();
      await expect(shell.locator(`[data-testid="portal-safety-training-course-${fixture.courseId}"]`)).toHaveAttribute("data-obligation-label", "Retake Required");
      await expect(shell.locator(`[data-testid="portal-safety-training-course-${fixture.courseId}-obligation-chip"]`)).toContainText("Retake Required");
      await page.screenshot({ path: path.join(outDir, "C-retake-required-dashboard-1440x900.png"), fullPage: true });

      // Course page check at 1440, scoped to the desktop shell.
      await page.goto(`${BASE}/employee/safety-training/${encodeURIComponent(fixture.courseVersionId)}`, { waitUntil: "networkidle" });
      const cShell = page.locator('[data-testid="portal-desktop-shell"]');
      await expect(cShell.locator('[data-testid="portal-course-state-pill"]').first()).toContainText("Retake Required");
      const statusPanel = cShell.locator('[data-testid="portal-course-status-panel"]').first();
      await expect(statusPanel).toHaveAttribute("data-variant", "retake-required");
      await expect(statusPanel).toContainText("Retake Required");
      await expect(statusPanel).toContainText("Your club has requested that you repeat this training. Your previous completion remains in your training history.");
      await expect(statusPanel.locator('[data-testid="portal-course-status-reason"]')).toContainText("refresher after safety incident");
      // Start Training button (not Replay) — the player will enter new-attempt mode.
      await expect(cShell.locator('[data-testid="portal-course-start"]').first()).toBeVisible();
      await expect(cShell.locator('[data-testid="portal-course-replay"]')).toHaveCount(0);
      await expect(statusPanel).toContainText("92%");
      await page.screenshot({ path: path.join(outDir, "C-retake-required-course-1440x900.png"), fullPage: true });
      await ctx.close();

      // Mobile + tablet captures.
      await captureAtViewports(browser, fixture, "/employee/safety-training", "C-retake-required-dashboard");
      await captureAtViewports(browser, fixture, `/employee/safety-training/${encodeURIComponent(fixture.courseVersionId)}`, "C-retake-required-course");

      // Snapshot DB state: 1 completion + 0 satisfied + 1 outstanding (as seeded).
      const snapshot = snapshotFixtureCounts(fixture);
      expect(snapshot.completions).toBe(1);
      expect(snapshot.outstandingObligations).toBe(1);
      expect(snapshot.satisfiedObligations).toBe(0);
      console.log(`[5C-3A] C snapshot after login: ${JSON.stringify(snapshot)} seededCompletion=${seededCompletion.completionId}`);
    } finally {
      cleanupFixtureObligations(fixture);
      teardownIsolatedFixture(runId);
    }
  });

  // -------------------------------------------------------------------------
  // Scenario D — Multiple Outstanding (Keep Both).  Two MANUAL_REINSTATE
  // obligations coexist → the dashboard shows ONE card with a
  // "Multiple completions required" chip (directive §3).
  // -------------------------------------------------------------------------
  test("D — Multiple Outstanding: one card + Multiple-completions-required chip", async ({ browser }) => {
    const runId = newRunId("5c3a");
    const fixture = provisionIsolatedFixture(runId);
    try {
      seedHistoricalCompletion(fixture, { score: 100, daysAgo: 60 });
      seedObligation(fixture, { reason: "MANUAL_REINSTATE", reasonNote: "First retake request", issuanceKeySuffix: "first" });
      seedObligation(fixture, { reason: "MANUAL_REINSTATE", reasonNote: "Second retake request", issuanceKeySuffix: "second" });

      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      await portalLogin(page, fixture);
      await page.goto(`${BASE}/employee/safety-training`, { waitUntil: "networkidle" });
      const shell = page.locator('[data-testid="portal-desktop-shell"]');
      // Exactly one dashboard card for this course (no duplicates even with 2 obligations).
      await expect(shell.locator(`[data-testid="portal-safety-training-course-${fixture.courseId}"]`)).toHaveCount(1);
      // Multiple-completions chip present.
      await expect(shell.locator(`[data-testid="portal-safety-training-course-${fixture.courseId}-multiple-chip"]`)).toContainText("Multiple completions required");
      // data-obligation-multiple = "true"
      await expect(shell.locator(`[data-testid="portal-safety-training-course-${fixture.courseId}"]`)).toHaveAttribute("data-obligation-multiple", "true");
      await page.screenshot({ path: path.join(outDir, "D-multiple-outstanding-dashboard-1440x900.png"), fullPage: true });
      await ctx.close();

      const snapshot = snapshotFixtureCounts(fixture);
      expect(snapshot.outstandingObligations).toBe(2);
      expect(snapshot.completions).toBe(1);
    } finally {
      cleanupFixtureObligations(fixture);
      teardownIsolatedFixture(runId);
    }
  });

  // -------------------------------------------------------------------------
  // Scenario E — Historical vs current gating (directive §6).
  // Verifies the UI does NOT present the historical result as the
  // current compliance when a retake is outstanding.
  // -------------------------------------------------------------------------
  test("E — historical completion visible AND flagged as previous; current retake remains actionable", async ({ browser }) => {
    const runId = newRunId("5c3a");
    const fixture = provisionIsolatedFixture(runId);
    try {
      seedHistoricalCompletion(fixture, { score: 88, daysAgo: 90 });
      seedObligation(fixture, {
        reason: "MANUAL_REINSTATE",
        reasonNote: "Historical-vs-current gating test",
      });

      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      await portalLogin(page, fixture);
      await page.goto(`${BASE}/employee/safety-training/${encodeURIComponent(fixture.courseVersionId)}`, { waitUntil: "networkidle" });
      const eShell = page.locator('[data-testid="portal-desktop-shell"]');
      await expect(eShell.locator('[data-testid="portal-course-state-pill"]').first()).not.toContainText("Completed");
      await expect(eShell.locator('[data-testid="portal-course-replay"]')).toHaveCount(0);
      await expect(eShell.locator('[data-testid="portal-course-start"]').first()).toBeVisible();
      await eShell.locator("button", { hasText: "Your Result" }).first().click();
      const withOutstanding = eShell.locator('[data-testid="portal-course-your-result-with-outstanding"]').first();
      await expect(withOutstanding).toBeVisible();
      await expect(withOutstanding).toContainText("Your previous completion from");
      await expect(withOutstanding).toContainText("88%");
      await expect(withOutstanding).toContainText("A new completion is required to satisfy the current requirement.");
      await page.screenshot({ path: path.join(outDir, "E-historical-vs-current-your-result-1440x900.png"), fullPage: true });
      await ctx.close();
    } finally {
      cleanupFixtureObligations(fixture);
      teardownIsolatedFixture(runId);
    }
  });
});
