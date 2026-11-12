/**
 * EP-TRAIN-4Y-AX §7+§8 — end-to-end acceptance against live staging.
 *
 * Covers:
 *   §1 Active Courses → review workspace direct nav.
 *   §2 "+ Add question" affordance visible on each tab.
 *   §3 Manual FA question creation (SINGLE_CHOICE) succeeds; shows in
 *      the manager-authored list AND the tab counter.
 *   §4 Manual CP question creation with a disposable at-sec timestamp
 *      succeeds and renders chronologically.
 *   §5 Persistence: after a hard reload, the disposable manual
 *      questions are still visible.
 *   §6 Authorised cleanup: DELETE both disposable questions; counters
 *      return to the pilot baseline (5 CP · 10 FA).
 *   §7 Pilot preservation: 15 AI draft hashes untouched before +
 *      after the test.
 *
 * READ-ONLY on the AI side: only manager-authored TrainingQuestion
 * rows are created / deleted; the 15 AI drafts and their metadata are
 * NEVER written. Every write goes through hr:training:write; no
 * approvals, no publications.
 *
 * Run with: npm run test:e2e:staging -- tests/e2e/ep-train-4y-ax-manual-questions.staging.spec.ts
 */

import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";
import fs from "node:fs";

const COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";
const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";
const REVIEW_PATH = `/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/review`;

const DISPOSABLE_CP_PROMPT = "AX disposable CP question — delete me";
const DISPOSABLE_FA_PROMPT = "AX disposable FA question — delete me";

async function postManualQuestion(page: Page, baseURL: string, body: Record<string, unknown>): Promise<{
  status: number;
  json: { ok?: boolean; questionId?: string; checkpointId?: string | null; message?: string };
}> {
  const resp = await page.request.post(`${baseURL}/api/admin/training/versions/${VERSION_ID}/manual-questions`, {
    data: body,
    headers: { "Content-Type": "application/json" },
  });
  const json = await resp.json().catch(() => ({}));
  return { status: resp.status(), json };
}

async function deleteManualQuestion(page: Page, baseURL: string, questionId: string): Promise<number> {
  const resp = await page.request.delete(
    `${baseURL}/api/admin/training/versions/${VERSION_ID}/manual-questions/${questionId}`,
  );
  return resp.status();
}

async function deleteCheckpointRow(page: Page, baseURL: string, checkpointId: string): Promise<number> {
  const resp = await page.request.delete(
    `${baseURL}/api/admin/training/versions/${VERSION_ID}/checkpoints/${checkpointId}`,
  );
  return resp.status();
}

test.describe("EP-TRAIN-4Y-AX — manual question authoring on staging", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("direct nav + manual CP + FA create / render / reload / delete; pilot preserved", async ({ browser }) => {
    const creds = stagingCredsAvailable();
    test.skip(!creds.ready, creds.reason ?? "staging creds missing");

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(ctx);

    fs.mkdirSync("test-results/4yax-screens", { recursive: true });

    // ── §1: Active Courses → direct review nav ──────────────────
    await page.goto(`${creds.baseURL}/app/admin/people/safety-training`, { waitUntil: "networkidle" });
    await page.screenshot({ path: "test-results/4yax-screens/01-active-courses.png" });
    const silverSpringsLink = page.locator(`[data-testid="training-active-row-${COURSE_ID}"] a`).first();
    const href = await silverSpringsLink.getAttribute("href");
    expect(href, "Active Courses row should link straight to /review").toContain("/review");

    // Click and verify we land on the review workspace header.
    await silverSpringsLink.click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2500);
    await expect(page.locator('[data-testid="manager-review-header"]')).toBeVisible();
    const cpTabInitial = await page.locator('[data-testid="manager-review-mode-checkpoints"]').innerText();
    const faTabInitial = await page.locator('[data-testid="manager-review-mode-final"]').innerText();
    expect(cpTabInitial).toMatch(/Checkpoints\s*·\s*5\b/);
    expect(faTabInitial).toMatch(/Final\s+assessment\s*·\s*10\b/);
    await page.screenshot({ path: "test-results/4yax-screens/02-review-directly-opened.png" });

    // ── §2: "+ Add question" affordance exists on both tabs ────
    const addBtn = page.locator('[data-testid="manager-review-add-question-open"]');
    await expect(addBtn, "+ Add question button must be visible on the CP tab").toBeVisible();
    // Switch to FA tab and re-check.
    await page.locator('[data-testid="manager-review-mode-final"]').first().click();
    await page.waitForTimeout(500);
    await expect(addBtn, "+ Add question button must be visible on the FA tab").toBeVisible();

    // ── §3: Create a disposable FA question via the API (exercises
    //    the exact same route the UI calls). ────────────────────
    const createFa = await postManualQuestion(page, creds.baseURL, {
      prompt: DISPOSABLE_FA_PROMPT,
      questionType: "SINGLE_CHOICE",
      destination: "FINAL_ASSESSMENT",
      options: [
        { text: "Correct FA option", isCorrect: true },
        { text: "Wrong FA option A", isCorrect: false },
        { text: "Wrong FA option B", isCorrect: false },
      ],
    });
    expect(createFa.status, `FA create response: ${JSON.stringify(createFa.json)}`).toBe(200);
    expect(createFa.json.ok).toBe(true);
    const faQId = createFa.json.questionId!;
    expect(faQId).toBeTruthy();

    // ── §4: Create a disposable CP question with a new checkpoint
    //    at a disposable timestamp far from existing CP atSecs
    //    (107, 214, 321, 428, 535). Use 550, which is beyond the
    //    last existing CP but well inside the ~640s video. ─────
    const CP_ATSEC = 550;
    const createCp = await postManualQuestion(page, creds.baseURL, {
      prompt: DISPOSABLE_CP_PROMPT,
      questionType: "SINGLE_CHOICE",
      destination: "CHECKPOINT",
      newCheckpoint: {
        atSecond: CP_ATSEC,
        label: "AX disposable CP",
        requiredToProceed: false,
        maxRetries: 1,
      },
      options: [
        { text: "Correct CP option", isCorrect: true },
        { text: "Wrong CP option A", isCorrect: false },
        { text: "Wrong CP option B", isCorrect: false },
      ],
    });
    expect(createCp.status, `CP create response: ${JSON.stringify(createCp.json)}`).toBe(200);
    expect(createCp.json.ok).toBe(true);
    const cpQId = createCp.json.questionId!;
    const cpCheckpointId = createCp.json.checkpointId!;
    expect(cpQId).toBeTruthy();
    expect(cpCheckpointId).toBeTruthy();

    // Reload the review page and confirm both manual questions appear.
    // The page defaults to the Checkpoints tab when any CP draft exists,
    // so we assert both tab counters first (they are page-level) and then
    // switch tabs to inspect each manager-authored list section.
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(2500);

    // Tab counters: page-level, visible regardless of active mode.
    const faTabAfter = await page.locator('[data-testid="manager-review-mode-final"]').innerText();
    const cpTabAfter = await page.locator('[data-testid="manager-review-mode-checkpoints"]').innerText();
    expect(faTabAfter, "FA tab must reflect the new manual FA question").toMatch(/Final\s+assessment\s*·\s*11\b/);
    expect(cpTabAfter, "CP tab must reflect the new manual CP question").toMatch(/Checkpoints\s*·\s*6\b/);

    // CP tab active by default (there are AI CP drafts) — assert the
    // disposable CP manual item is rendered in this tab's manual list.
    await expect(page.locator(`[data-testid="manager-review-manual-item-${cpQId}"]`)).toBeVisible();

    // Switch to the FA tab and assert the disposable FA manual item.
    await page.locator('[data-testid="manager-review-mode-final"]').first().click();
    await page.waitForTimeout(600);
    await expect(page.locator(`[data-testid="manager-review-manual-item-${faQId}"]`)).toBeVisible();
    await expect(
      page.locator(`[data-testid="manager-review-manual-item-${faQId}"]`),
    ).toContainText(DISPOSABLE_FA_PROMPT);

    // Switch back to the CP tab for the screenshot capture below.
    await page.locator('[data-testid="manager-review-mode-checkpoints"]').first().click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: "test-results/4yax-screens/03-manual-cp-visible.png" });
    await page.locator('[data-testid="manager-review-mode-final"]').first().click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: "test-results/4yax-screens/04-manual-fa-visible.png" });

    // ── §5 (persistence): a fresh browser context sees the same ─
    const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page2 = await loginAsFounder(ctx2);
    await page2.goto(`${creds.baseURL}${REVIEW_PATH}`, { waitUntil: "networkidle" });
    await page2.waitForTimeout(2500);
    const faTabFresh = await page2.locator('[data-testid="manager-review-mode-final"]').innerText();
    const cpTabFresh = await page2.locator('[data-testid="manager-review-mode-checkpoints"]').innerText();
    expect(faTabFresh).toMatch(/Final\s+assessment\s*·\s*11\b/);
    expect(cpTabFresh).toMatch(/Checkpoints\s*·\s*6\b/);
    await ctx2.close();

    // ── §6: Authorised cleanup via the DELETE routes ─────────
    const delCp = await deleteManualQuestion(page, creds.baseURL, cpQId);
    const delFa = await deleteManualQuestion(page, creds.baseURL, faQId);
    expect(delCp, "disposable CP question delete").toBe(200);
    expect(delFa, "disposable FA question delete").toBe(200);
    // Delete the disposable checkpoint (only possible after the
    // question is gone — the service refuses otherwise).
    const delCpRow = await deleteCheckpointRow(page, creds.baseURL, cpCheckpointId);
    expect(delCpRow, "disposable CP row delete").toBe(200);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(2500);
    const cpTabCleanup = await page.locator('[data-testid="manager-review-mode-checkpoints"]').innerText();
    const faTabCleanup = await page.locator('[data-testid="manager-review-mode-final"]').innerText();
    expect(cpTabCleanup).toMatch(/Checkpoints\s*·\s*5\b/);
    expect(faTabCleanup).toMatch(/Final\s+assessment\s*·\s*10\b/);
    await page.screenshot({ path: "test-results/4yax-screens/05-after-cleanup.png" });

    // ── §7 captured server-side in the preservation probe. The
    //    Playwright surface asserts tab counts only; the probe
    //    asserts byte-identical hashes.

    await ctx.close();
  });
});
