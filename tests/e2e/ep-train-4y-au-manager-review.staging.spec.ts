/**
 * EP-TRAIN-4Y-AU §6 — browser-level regression for the manager
 * review page's destination rendering + tab-count integrity.
 *
 * Prevents the AT false-positive where a regex over the initial
 * render passed while the rendered Q7 header still read
 * "destination unknown" after navigation.
 *
 * Run with:
 *   npm run test:e2e:staging -- tests/e2e/ep-train-4y-au-manager-review.staging.spec.ts
 */

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";
const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";
const REVIEW_PATH = `/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/review`;

test.describe("EP-TRAIN-4Y-AU — manager review DOM parity", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Q7 (recovered) renders with no 'destination unknown' header; tab counts match canonical", async ({
    browser,
  }) => {
    const creds = stagingCredsAvailable();
    test.skip(!creds.ready, creds.reason ?? "staging creds missing");

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(ctx);
    await page.goto(`${creds.baseURL}${REVIEW_PATH}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(3500);

    // ── Tab counts (page-level) ──────────────────────────────
    const cpTab = page.locator('[data-testid="manager-review-mode-checkpoints"]');
    const faTab = page.locator('[data-testid="manager-review-mode-final"]');
    await expect(cpTab).toHaveText(/Checkpoints\s*·\s*5\b/);
    await expect(faTab).toHaveText(/Final\s+assessment\s*·\s*10\b/);

    // ── Final Assessment → navigate to Q7 ────────────────────
    await faTab.first().click();
    await page.waitForTimeout(1200);
    const pane = page.locator('[data-testid="manager-review-question-pane"]');
    const nextBtn = page.locator('button:has-text("Next")').first();
    let foundQ7 = false;
    for (let i = 0; i < 20; i++) {
      const txt = await pane.innerText();
      const m = /question\s+(\d+)\s+of\s+(\d+)/i.exec(txt);
      if (m && Number(m[1]) === 7 && Number(m[2]) === 10) { foundQ7 = true; break; }
      if (await nextBtn.count()) {
        try { await nextBtn.click({ timeout: 2000 }); await page.waitForTimeout(400); continue; } catch {}
      }
      break;
    }
    expect(foundQ7, "could not advance to Q7 of 10 on the Final Assessment tab").toBe(true);

    // ── Pane assertions on Q7 ────────────────────────────────
    const q7Text = await pane.innerText();
    expect(q7Text).not.toMatch(/destination\s+unknown/i);
    expect(q7Text).not.toMatch(/·\s*unknown\b/i);
    expect(q7Text).not.toMatch(/·\s*checkpoint\b/i);
    expect(q7Text).toMatch(/pay\s*stubs?/i);

    // ── Reload + repeat ──────────────────────────────────────
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(2500);
    await expect(cpTab).toHaveText(/Checkpoints\s*·\s*5\b/);
    await expect(faTab).toHaveText(/Final\s+assessment\s*·\s*10\b/);

    await faTab.first().click();
    await page.waitForTimeout(1200);
    let foundQ7AfterReload = false;
    for (let i = 0; i < 20; i++) {
      const txt = await pane.innerText();
      const m = /question\s+(\d+)\s+of\s+(\d+)/i.exec(txt);
      if (m && Number(m[1]) === 7) { foundQ7AfterReload = true; break; }
      if (await nextBtn.count()) {
        try { await nextBtn.click({ timeout: 2000 }); await page.waitForTimeout(400); continue; } catch {}
      }
      break;
    }
    expect(foundQ7AfterReload).toBe(true);
    const q7TextReload = await pane.innerText();
    expect(q7TextReload).not.toMatch(/destination\s+unknown/i);
    expect(q7TextReload).not.toMatch(/·\s*unknown\b/i);
    expect(q7TextReload).not.toMatch(/·\s*checkpoint\b/i);
    expect(q7TextReload).toMatch(/pay\s*stubs?/i);

    await ctx.close();
  });

  test("Checkpoints tab does NOT contain the recovered pay-stub question", async ({ browser }) => {
    const creds = stagingCredsAvailable();
    test.skip(!creds.ready, creds.reason ?? "staging creds missing");

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(ctx);
    await page.goto(`${creds.baseURL}${REVIEW_PATH}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(3500);

    const cpTab = page.locator('[data-testid="manager-review-mode-checkpoints"]');
    await cpTab.first().click();
    await page.waitForTimeout(1000);

    const pane = page.locator('[data-testid="manager-review-question-pane"]');
    const nextBtn = page.locator('button:has-text("Next")').first();
    for (let i = 0; i < 10; i++) {
      const txt = await pane.innerText();
      expect(txt, `Q${i + 1} on Checkpoints tab contained "pay stubs" (recovered FA draft leak)`)
        .not.toMatch(/pay\s*stubs?/i);
      const m = /question\s+(\d+)\s+of\s+(\d+)/i.exec(txt);
      if (m && Number(m[1]) === Number(m[2])) break;
      if (await nextBtn.count()) {
        try { await nextBtn.click({ timeout: 2000 }); await page.waitForTimeout(400); } catch { break; }
      } else break;
    }

    await ctx.close();
  });
});
