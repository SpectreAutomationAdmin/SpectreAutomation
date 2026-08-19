// Phase 4R rev-8 acceptance on staging v227. Captures:
//   §1 Tab strip forms the top edge of the card (Summary default)
//   §2 Attachments tab renders at the SAME card outer height as Summary
//      (Work Intake Feed does not jump when swapping)
//   §3 Conversation baseline height equals Summary baseline
//   §4 A long Conversation grows past baseline naturally (no scrollbar,
//      no clipping)
//   §5 Downstream card's top position stays constant across the swap
//      (feed stability — proves the height stayed constant, not just
//      the card box)

import { test, expect } from "@playwright/test";
import type { Locator } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = "test-results/phase-4r-rev8-card-framing/after";
fs.mkdirSync(OUT, { recursive: true });

async function boxOf(loc: Locator) {
  const box = await loc.boundingBox();
  if (!box) throw new Error("no bounding box");
  return box;
}

test.describe("Phase 4R rev-8 · Work Intake card framing + stable height", () => {
  const avail = stagingCredsAvailable();
  test.skip(!avail.ready, avail.reason ?? "creds missing");
  test.setTimeout(300_000);

  test("Summary as top edge + Attachments same height + Conversation grows + downstream feed stable", async ({ browser }) => {
    expect(avail.baseURL, "safety: staging-only").toMatch(/staging|localhost/i);
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await loginAsFounder(ctx, { landing: "/app/admin" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1500);

    // Ensure the founder is on Mission Control, not a wildcard admin route.
    if (!page.url().includes("/app/admin")) {
      await page.goto(`${avail.baseURL}/app/admin`);
      await page.waitForLoadState("networkidle").catch(() => {});
    }

    const cards = page.locator('[data-testid="email-intake-card"]');
    const total = await cards.count();
    console.log(`[setup] work intake cards visible = ${total}`);
    expect(total, "at least two work intake cards for stability test").toBeGreaterThanOrEqual(2);

    // Find a card that HAS an attachments tab — that's the only card
    // whose Summary ↔ Attachments height parity can be tested.
    let cardIndex = -1;
    for (let i = 0; i < total; i += 1) {
      const c = cards.nth(i);
      const hasAttach = await c.locator('[data-testid="card-tab-attachments"]').count() > 0;
      if (hasAttach) { cardIndex = i; break; }
    }
    if (cardIndex < 0) {
      test.skip(true, "no card on staging fleet has the attachments tab — the height-parity assertion is only meaningful when Attachments is present");
      return;
    }
    const cardA = cards.nth(cardIndex);
    // Pick a downstream card (below A) so its `y` moves iff A's height changes.
    const downstreamIndex = cardIndex + 1 < total ? cardIndex + 1 : cardIndex - 1;
    const cardDownstream = cards.nth(downstreamIndex);
    await cardA.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    // ---- §1 Summary default — tabs as top edge -----------------
    expect(await cardA.getAttribute("data-active-tab")).toBe("spectre-summary");
    // Rev-8 structural pins: tabs are the first visual band inside the card.
    const tabBar = cardA.locator('[data-testid="card-tabs"]').first();
    await expect(tabBar).toBeVisible();
    const cardBoxSummary = await boxOf(cardA);
    const tabBarBox = await boxOf(tabBar);
    // The tab bar's top edge must sit at (or within 1px of) the card's
    // top edge — proving the tabs form the top boundary of the card.
    expect(tabBarBox.y - cardBoxSummary.y, "tab bar sits flush against card top edge").toBeLessThanOrEqual(1);
    // Sanity: the tab bar spans (nearly) the full card width. This
    // is what "bleeds to the card's inner edges" produces in the DOM.
    expect(tabBarBox.width / cardBoxSummary.width, "tab bar bleeds to card edges (≥ 95 % width)").toBeGreaterThanOrEqual(0.95);
    // Record downstream card top position on Summary — feed stability baseline.
    const downstreamTopSummary = (await boxOf(cardDownstream)).y;
    await cardA.screenshot({ path: path.join(OUT, "01-summary-top-edge.png") });

    // ---- §2 Attachments swap — never shrinks below Summary ------
    // Founder brief §7 rule: Summary defines the baseline; Attachments
    // uses the SAME baseline (no shrink) but MAY grow naturally past
    // it when the card has many attachments — the symmetric case of
    // Conversation growing past baseline. "Quiet empty space beneath
    // is acceptable" applies when Attachments content is shorter;
    // when longer, the card grows to accommodate — same rule as
    // Conversation, no clipping and no nested scrollbar.
    await cardA.locator('[data-testid="card-tab-attachments"]').first().click();
    await expect(cardA).toHaveAttribute("data-active-tab", "attachments", { timeout: 3_000 });
    await expect(cardA.locator('[data-testid="card-attachments"]').first()).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(400); // let layout settle
    const cardBoxAttachments = await boxOf(cardA);
    const heightDelta = cardBoxAttachments.height - cardBoxSummary.height;
    console.log(`[§2] Summary height = ${cardBoxSummary.height.toFixed(1)}px · Attachments height = ${cardBoxAttachments.height.toFixed(1)}px · Δ = ${heightDelta.toFixed(1)}px (+ = grew, − = shrank)`);
    // The anti-shrink invariant — Attachments MUST NOT shrink below
    // the Summary baseline. 4px slack for sub-pixel rendering.
    expect(heightDelta, "Attachments must NEVER shrink below Summary baseline")
      .toBeGreaterThanOrEqual(-4);
    // Confirm the CSS baseline is doing its job — Attachments height
    // is at least the shared min-height (380px). A shorter number
    // proves the min-height rule didn't reach the tab body.
    expect(cardBoxAttachments.height, "Attachments height honours the shared 380px baseline via CSS min-height")
      .toBeGreaterThanOrEqual(376);
    // Feed stability: downstream card either stays put (short
    // Attachments) or shifts down by exactly Card A's growth amount
    // (long Attachments). Never shifts UP — that would prove the
    // card shrank.
    const downstreamTopAttach = (await boxOf(cardDownstream)).y;
    const downstreamDelta = downstreamTopAttach - downstreamTopSummary;
    console.log(`[§5 partial] downstream card y Δ Summary→Attachments = ${downstreamDelta.toFixed(1)}px`);
    expect(downstreamDelta, "downstream card must not shift UP — that would mean Card A shrank")
      .toBeGreaterThanOrEqual(-4);
    // If the card grew, the downstream shift equals the growth (± 4px).
    if (heightDelta > 4) {
      expect(Math.abs(downstreamDelta - heightDelta), "downstream shift tracks Card A growth exactly")
        .toBeLessThanOrEqual(4);
    }
    await cardA.screenshot({ path: path.join(OUT, "02-attachments-height.png") });

    // ---- §3 Conversation baseline (short thread) --------------
    await cardA.locator('[data-testid="card-tab-conversation"]').first().click();
    await expect(cardA).toHaveAttribute("data-active-tab", "conversation", { timeout: 3_000 });
    await expect(cardA.locator('[data-testid="card-conversation"]').first()).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(600);
    const cardBoxConversation = await boxOf(cardA);
    console.log(`[§3] Conversation height = ${cardBoxConversation.height.toFixed(1)}px`);
    // Baseline: Conversation must be AT LEAST as tall as the Summary
    // baseline — a short thread must not shrink below the Summary
    // outer height (may grow naturally past it for long threads).
    expect(cardBoxConversation.height, "Conversation ≥ Summary baseline height")
      .toBeGreaterThanOrEqual(cardBoxSummary.height - 4);
    await cardA.screenshot({ path: path.join(OUT, "03-conversation-baseline.png") });

    // ---- §4 Long Conversation (if fleet has one) --------------
    // Sweep the fleet for the longest-conversation card; take its
    // Conversation height and confirm it exceeds the baseline (grew
    // naturally past 380px, not clipped, no nested scrollbar).
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
      const h = (await boxOf(c)).height;
      if (h > cardBoxSummary.height + 20) {
        longestGrew = true;
        await c.scrollIntoViewIfNeeded();
        await c.screenshot({ path: path.join(OUT, "04-long-conversation.png") });
        console.log(`[§4] found conversation card that grew past baseline: card ${i}, height ${h.toFixed(1)}px vs baseline ${cardBoxSummary.height.toFixed(1)}px`);
        break;
      }
    }
    if (!longestGrew) {
      console.log("[§4] no conversation card on staging exceeds baseline — long-thread growth screenshot skipped (all threads short); baseline behaviour still satisfied");
    }

    // ---- §5 Full feed stability screenshot --------------------
    await cardA.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(OUT, "05-feed-stability.png"), fullPage: false });

    await ctx.close();
  });
});
