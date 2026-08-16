// Phase 4R rev-9 acceptance on staging v229. Measures the actual
// VISIBLE frame (the bordered surface, not the outer bare wrapper
// article), plus downstream Card B's Y-position which is the real
// founder-visible feed-stability signal.
//
// Rev-8's acceptance test measured the outer <article> bounding
// box, which — after rev-8 restructured the article to include
// natural Attachments content — happened to grow with the content
// and pass the anti-shrink assertion while the founder-visible
// visual boundary still shifted. Rev-9's article is a bare wrapper
// with no visible boundary of its own; the visible boundary is
// `.spectre-mc-item-frame`, so we measure THAT.
//
// The definitive stability signal (founder brief §14): Card B's
// top position must not move by more than a rounding tolerance
// when Card A is swapped Summary ↔ Attachments and back.

import { test, expect } from "@playwright/test";
import type { Locator } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = "test-results/phase-4r-rev9-card-framing/after";
fs.mkdirSync(OUT, { recursive: true });

async function boxOf(loc: Locator) {
  const box = await loc.boundingBox();
  if (!box) throw new Error("no bounding box");
  return box;
}

test.describe("Phase 4R rev-9 · Tabbed-document framing + per-card baseline", () => {
  const avail = stagingCredsAvailable();
  test.skip(!avail.ready, avail.reason ?? "creds missing");
  test.setTimeout(300_000);

  test("Tabbed geometry + Card B feed stability across Summary ↔ Attachments ↔ Summary", async ({ browser }) => {
    expect(avail.baseURL, "safety: staging-only").toMatch(/staging|localhost/i);
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await loginAsFounder(ctx, { landing: "/app/admin" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1500);

    if (!page.url().includes("/app/admin")) {
      await page.goto(`${avail.baseURL}/app/admin`);
      await page.waitForLoadState("networkidle").catch(() => {});
    }

    const cards = page.locator('[data-testid="email-intake-card"]');
    const total = await cards.count();
    console.log(`[setup] work intake cards visible = ${total}`);
    expect(total, "at least two cards for feed-stability test").toBeGreaterThanOrEqual(2);

    // Find a card that HAS an attachments tab.
    let cardIndex = -1;
    for (let i = 0; i < total; i += 1) {
      const c = cards.nth(i);
      const hasAttach = await c.locator('[data-testid="card-tab-attachments"]').count() > 0;
      if (hasAttach) { cardIndex = i; break; }
    }
    if (cardIndex < 0) {
      test.skip(true, "no card on staging fleet has the attachments tab");
      return;
    }
    const cardA = cards.nth(cardIndex);
    // Downstream card = the next visible card below A.
    const downstreamIndex = cardIndex + 1 < total ? cardIndex + 1 : cardIndex - 1;
    const cardDownstream = cards.nth(downstreamIndex);
    await cardA.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);

    // ---- §1 Summary default — tabbed-document geometry -----------
    expect(await cardA.getAttribute("data-active-tab")).toBe("spectre-summary");
    const frameSummary = cardA.locator('[data-testid="card-frame"]').first();
    const tabs = cardA.locator('[data-testid="card-tabs"]').first();
    await expect(frameSummary).toBeVisible();
    await expect(tabs).toBeVisible();

    const frameBoxSummary = await boxOf(frameSummary);
    const tabsBox = await boxOf(tabs);

    // Tabs sit ABOVE the frame's top border (the tabs protrude
    // upward and physically define the top edge). Founder brief §3.
    console.log(`[§1] tabs bottom = ${(tabsBox.y + tabsBox.height).toFixed(1)}px · frame top = ${frameBoxSummary.y.toFixed(1)}px`);
    // The active tab overlaps the frame's top border by 1 px, so
    // tabs.bottom should be ≥ frame.top − small tolerance.
    expect(tabsBox.y + tabsBox.height - frameBoxSummary.y, "active tab overlaps frame top border")
      .toBeGreaterThanOrEqual(-2);
    // Founder brief §4 — tabs are NOT stretched across the card. The
    // tab group width must be substantially less than the frame
    // width (allow up to 65 % — three labels + gaps).
    console.log(`[§1] tabs width / frame width = ${(tabsBox.width / frameBoxSummary.width).toFixed(3)}`);
    expect(tabsBox.width / frameBoxSummary.width, "tabs self-size to labels (< 0.65 of frame width)")
      .toBeLessThanOrEqual(0.65);
    // Record Card B's top for the feed-stability comparison.
    const cardBTopSummary = (await boxOf(cardDownstream)).y;
    console.log(`[§1] Card A frame height = ${frameBoxSummary.height.toFixed(1)}px · Card B top = ${cardBTopSummary.toFixed(1)}px`);
    await cardA.screenshot({ path: path.join(OUT, "01-summary-tabbed.png") });

    // ---- §2 Swap to Attachments — SAME visible frame height ------
    await cardA.locator('[data-testid="card-tab-attachments"]').first().click();
    await expect(cardA).toHaveAttribute("data-active-tab", "attachments", { timeout: 3_000 });
    await expect(cardA.locator('[data-testid="card-attachments"]').first()).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(700); // let layout + ResizeObserver settle
    const frameBoxAttach = await boxOf(cardA.locator('[data-testid="card-frame"]').first());
    const cardBTopAttach = (await boxOf(cardDownstream)).y;
    const frameHeightDelta = frameBoxAttach.height - frameBoxSummary.height;
    const cardBShift = cardBTopAttach - cardBTopSummary;
    console.log(`[§2] Attachments frame height = ${frameBoxAttach.height.toFixed(1)}px · Δ vs Summary = ${frameHeightDelta.toFixed(1)}px`);
    console.log(`[§2] Card B top shift Summary→Attachments = ${cardBShift.toFixed(1)}px`);
    // Founder brief §7: Attachments must occupy the same outer card
    // height as Spectre Summary. Enforce ≤ 4 px (both directions).
    expect(Math.abs(frameHeightDelta), "Attachments frame height matches Summary within 4 px")
      .toBeLessThanOrEqual(4);
    // Founder brief §14: Card B must NOT move measurably.
    expect(Math.abs(cardBShift), "Card B top position stable Summary → Attachments")
      .toBeLessThanOrEqual(4);
    await cardA.screenshot({ path: path.join(OUT, "02-attachments-same-height.png") });

    // ---- §3 Swap BACK to Summary — Card B returns to original ----
    await cardA.locator('[data-testid="card-tab-spectre-summary"]').first().click();
    await expect(cardA).toHaveAttribute("data-active-tab", "spectre-summary", { timeout: 3_000 });
    await expect(cardA.locator('[data-testid="card-summary"]').first()).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(400);
    const cardBTopAfterReturn = (await boxOf(cardDownstream)).y;
    const returnShift = cardBTopAfterReturn - cardBTopSummary;
    console.log(`[§3] Card B top shift after return-to-Summary = ${returnShift.toFixed(1)}px`);
    expect(Math.abs(returnShift), "Card B returns to original position")
      .toBeLessThanOrEqual(4);

    // ---- §4 Conversation — floor at baseline; may grow past ------
    await cardA.locator('[data-testid="card-tab-conversation"]').first().click();
    await expect(cardA).toHaveAttribute("data-active-tab", "conversation", { timeout: 3_000 });
    await expect(cardA.locator('[data-testid="card-conversation"]').first()).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(700);
    const frameBoxConv = await boxOf(cardA.locator('[data-testid="card-frame"]').first());
    console.log(`[§4] Conversation frame height = ${frameBoxConv.height.toFixed(1)}px (Summary baseline = ${frameBoxSummary.height.toFixed(1)}px)`);
    // Anti-shrink: Conversation must be ≥ Summary baseline.
    expect(frameBoxConv.height, "Conversation floors at Summary baseline")
      .toBeGreaterThanOrEqual(frameBoxSummary.height - 4);
    await cardA.screenshot({ path: path.join(OUT, "03-conversation-baseline.png") });

    // ---- §5 Long conversation (sweep for one) --------------------
    let longestGrew = false;
    for (let i = 0; i < total; i += 1) {
      const c = cards.nth(i);
      const convTab = c.locator('[data-testid="card-tab-conversation"]');
      if (await convTab.count() === 0) continue;
      await c.scrollIntoViewIfNeeded();
      await convTab.first().click();
      const active = await c.getAttribute("data-active-tab");
      if (active !== "conversation") continue;
      await c.locator('[data-testid="card-conversation"]').first().waitFor({ state: "visible", timeout: 6_000 }).catch(() => {});
      await page.waitForTimeout(300);
      const summaryEl = c.locator('[data-testid="card-summary"]');
      // Compare THIS card's Conversation vs its own Summary baseline.
      // We can't measure Summary while on Conversation, so switch there,
      // measure, switch back to Conversation — expensive but correct.
      await c.locator('[data-testid="card-tab-spectre-summary"]').first().click();
      await c.locator('[data-testid="card-summary"]').first().waitFor({ state: "visible", timeout: 6_000 }).catch(() => {});
      await page.waitForTimeout(300);
      const s = (await boxOf(c.locator('[data-testid="card-frame"]').first())).height;
      await c.locator('[data-testid="card-tab-conversation"]').first().click();
      await c.locator('[data-testid="card-conversation"]').first().waitFor({ state: "visible", timeout: 6_000 }).catch(() => {});
      await page.waitForTimeout(300);
      const h = (await boxOf(c.locator('[data-testid="card-frame"]').first())).height;
      if (h > s + 20) {
        longestGrew = true;
        await c.scrollIntoViewIfNeeded();
        await c.screenshot({ path: path.join(OUT, "04-long-conversation.png") });
        console.log(`[§5] card ${i} conversation grew past baseline: ${h.toFixed(1)}px vs ${s.toFixed(1)}px`);
        break;
      }
    }
    if (!longestGrew) {
      console.log("[§5] no card on staging has a long enough conversation to exceed baseline — natural-growth screenshot skipped");
    }

    // ---- §6 Feed stability full-viewport shot --------------------
    await cardA.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(OUT, "05-feed-stability.png"), fullPage: false });

    await ctx.close();
  });
});
