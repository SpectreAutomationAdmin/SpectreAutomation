/**
 * EP-TRAIN-4Y-AV §5 — READ-ONLY snapshot of the manager review surface.
 * Walks CP tab + FA tab, captures DOM text of each question pane, and
 * screenshots at 1440×900. No edits, no approvals.
 */
import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";
import fs from "node:fs";

const COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";
const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";
const REVIEW_PATH = `/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/review`;

test.describe("EP-TRAIN-4Y-AV — read-only workflow snapshot", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("snapshot CP tab + FA tab with every question pane", async ({ browser }) => {
    const creds = stagingCredsAvailable();
    test.skip(!creds.ready, creds.reason ?? "staging creds missing");

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(ctx);
    await page.goto(`${creds.baseURL}${REVIEW_PATH}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(3000);

    fs.mkdirSync("test-results/4yav-screens", { recursive: true });

    // Header
    await expect(page.locator('[data-testid="manager-review-tabs"]')).toBeVisible();
    const cpTab = page.locator('[data-testid="manager-review-mode-checkpoints"]');
    const faTab = page.locator('[data-testid="manager-review-mode-final"]');
    const cpLabel = (await cpTab.innerText()).trim();
    const faLabel = (await faTab.innerText()).trim();

    const pane = page.locator('[data-testid="manager-review-question-pane"]');
    const nextBtn = page.locator('[data-testid="manager-review-next"]').first();

    async function walk(tab: typeof cpTab, prefix: string, maxN: number) {
      await tab.first().click();
      await page.waitForTimeout(800);
      const panes: Array<{ i: number; text: string }> = [];
      for (let i = 0; i < maxN; i++) {
        const t = await pane.innerText();
        panes.push({ i: i + 1, text: t });
        await page.screenshot({ path: `test-results/4yav-screens/${prefix}-q${i + 1}.png`, fullPage: false });
        const m = /question\s+(\d+)\s+of\s+(\d+)/i.exec(t);
        if (m && Number(m[1]) === Number(m[2])) break;
        if (await nextBtn.count()) {
          try { await nextBtn.click({ timeout: 2000 }); await page.waitForTimeout(500); } catch { break; }
        } else break;
      }
      return panes;
    }
    const cpPanes = await walk(cpTab, "cp", 7);
    const faPanes = await walk(faTab, "fa", 12);

    fs.writeFileSync("test-results/4yav-workflow-snapshot.json", JSON.stringify({
      cpTabLabel: cpLabel, faTabLabel: faLabel, cpPanes, faPanes,
    }, null, 2));

    await ctx.close();
  });
});
