// Phase 4R rev-7 acceptance on staging v226. Captures:
//   §1 Spectre Summary tab (default) — actions + intelligence
//   §2 Conversation tab — no summary above it
//   §3 Attachments tab — no summary above it
//   §4 Independent tab state across cards

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = "test-results/phase-4r-rev7-card-tabs/after";
fs.mkdirSync(OUT, { recursive: true });

test.describe("Phase 4R rev-7 · Work Intake card tab model", () => {
  const avail = stagingCredsAvailable();
  test.skip(!avail.ready, avail.reason ?? "creds missing");
  test.setTimeout(300_000);

  test("Spectre Summary default + Conversation swap + Attachments swap + independent per-card state", async ({ browser }) => {
    expect(avail.baseURL, "safety: staging-only").toMatch(/staging|localhost/i);
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await loginAsFounder(ctx, { landing: "/app/admin" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1500);

    const cards = page.locator('[data-testid="email-intake-card"]');
    const total = await cards.count();
    console.log(`[setup] work intake cards visible = ${total}`);
    expect(total, "at least one work intake card").toBeGreaterThan(0);

    const first = cards.first();
    await first.scrollIntoViewIfNeeded();

    // ---- §1 Spectre Summary default ---------------------------
    expect(await first.getAttribute("data-active-tab")).toBe("spectre-summary");
    await expect(first.locator('[data-testid="card-summary"]').first()).toBeVisible();
    // Attachments + Conversation panels are NOT rendered while
    // Spectre Summary is active.
    expect(await first.locator('[data-testid="card-conversation"]').count()).toBe(0);
    expect(await first.locator('[data-testid="card-attachments"]').count()).toBe(0);
    // Retired affordances gone.
    expect(await first.locator('[data-testid="card-toggle"]').count()).toBe(0);
    expect(await first.locator('[data-testid="unified-tab-invoice"]').count()).toBe(0);
    expect(await first.locator('[data-testid="unified-tab-activity"]').count()).toBe(0);
    // Retired tab-bar testid gone; card-tabs takes over.
    expect(await first.locator('[data-testid="unified-tabs"]').count()).toBe(0);
    await expect(first.locator('[data-testid="card-tabs"]').first()).toBeVisible();
    await first.screenshot({ path: path.join(OUT, "01-spectre-summary.png") });

    // ---- §2 Conversation tab swap ------------------------------
    await first.locator('[data-testid="card-tab-conversation"]').first().click();
    await expect(first).toHaveAttribute("data-active-tab", "conversation", { timeout: 3_000 });
    await expect(first.locator('[data-testid="card-conversation"]').first()).toBeVisible({ timeout: 10_000 });
    // Spectre Summary body is NOT rendered above the conversation.
    expect(await first.locator('[data-testid="card-summary"]').count()).toBe(0);
    expect(await first.locator('[data-testid="card-attachments"]').count()).toBe(0);
    await first.screenshot({ path: path.join(OUT, "02-conversation.png") });

    // ---- §3 Attachments tab swap -------------------------------
    const attachmentsTab = first.locator('[data-testid="card-tab-attachments"]');
    if (await attachmentsTab.count() > 0) {
      await attachmentsTab.first().click();
      await expect(first).toHaveAttribute("data-active-tab", "attachments", { timeout: 3_000 });
      await expect(first.locator('[data-testid="card-attachments"]').first()).toBeVisible({ timeout: 10_000 });
      // Spectre Summary + Conversation NOT rendered above the attachments list.
      expect(await first.locator('[data-testid="card-summary"]').count()).toBe(0);
      expect(await first.locator('[data-testid="card-conversation"]').count()).toBe(0);
      await first.screenshot({ path: path.join(OUT, "03-attachments.png") });
    } else {
      console.log("[§3] first card has no attachments — tab correctly hidden; screenshot skipped");
    }

    // ---- §4 Independent per-card state -------------------------
    if (total >= 2) {
      const second = cards.nth(1);
      await second.scrollIntoViewIfNeeded();
      // Second card should still be on its default tab even after
      // we changed the first card's tab.
      expect(await second.getAttribute("data-active-tab")).toBe("spectre-summary");
      // Change second card's tab.
      await second.locator('[data-testid="card-tab-conversation"]').first().click();
      await expect(second).toHaveAttribute("data-active-tab", "conversation", { timeout: 3_000 });
      // First card's tab is UNCHANGED by second card's click.
      const firstStillActive = await first.getAttribute("data-active-tab");
      console.log(`[§4] card A tab = "${firstStillActive}" · card B tab = "conversation"`);
      expect(firstStillActive, "card A tab independent of card B click")
        .not.toBe("spectre-summary");
      await page.screenshot({ path: path.join(OUT, "04-independent-tabs.png"), fullPage: true });
    } else {
      console.log("[§4] only one card visible — independent-state assertion skipped");
    }

    await ctx.close();
  });
});
