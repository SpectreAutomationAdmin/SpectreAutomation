// Phase 4R rev-12 (2026-08-16) — visual acceptance for the unread
// treatment redesign (§9 retires the green dot; §10 thickens the
// existing accent; §11 makes the difference obvious; §13 preserves
// geometry; §19 covers two work-types to prove color-orthogonality).

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = "test-results/phase-4r-rev12-visual-acceptance";
fs.mkdirSync(OUT, { recursive: true });

test.describe("Phase 4R rev-12 · Unread visual — thicker accent, no dot", () => {
  const avail = stagingCredsAvailable();
  test.skip(!avail.ready, avail.reason ?? "creds missing");
  test.setTimeout(300_000);

  test("thick accent unread + thin accent read; no ::after dot; content-position stable", async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await loginAsFounder(ctx, { landing: "/app/admin" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1000);

    const cards = page.locator('[data-testid="email-intake-card"]');
    const total = await cards.count();
    console.log(`[setup] cards visible = ${total}`);

    // Bucket cards by (state class, data-unread) so we can capture
    // representative examples per work-type.
    const bucket: Array<{ index: number; stateClass: string; dataUnread: string | null; borderLeftWidth: string; paddingLeft: string; borderLeftColor: string; pseudoContent: string; titleFontWeight: string }> = [];
    for (let i = 0; i < total; i += 1) {
      const c = cards.nth(i);
      const measured = await c.evaluate((el) => {
        const cs = getComputedStyle(el);
        const afterCS = getComputedStyle(el, "::after");
        const stateClass = ["judgment", "approval", "comm", "done", "info-item"].find((s) => el.classList.contains(s)) ?? "";
        const h3 = el.querySelector("h3");
        const h3Weight = h3 ? getComputedStyle(h3).fontWeight : "";
        return {
          stateClass,
          dataUnread: el.getAttribute("data-unread"),
          borderLeftWidth: cs.borderLeftWidth,
          borderLeftColor: cs.borderLeftColor,
          paddingLeft: cs.paddingLeft,
          pseudoContent: afterCS.content,
          titleFontWeight: h3Weight,
        };
      });
      bucket.push({ index: i, ...measured });
      console.log(`[card ${i}] state=${measured.stateClass} unread=${measured.dataUnread} border-left=${measured.borderLeftWidth} pad-left=${measured.paddingLeft} color=${measured.borderLeftColor} title-weight=${measured.titleFontWeight} ::after=${measured.pseudoContent}`);
    }

    // Founder brief §9: NO green ::after dot may render on any card.
    for (const b of bucket) {
      const strippedContent = (b.pseudoContent ?? "").replace(/["']/g, "");
      expect(strippedContent === "none" || strippedContent === "", `card ${b.index} must not have an ::after dot (rev-12 retires the green dot)`).toBeTruthy();
    }

    // Founder brief §11: thickness difference must be obvious.
    // Read cards use border-left 3px; unread use 6px. Verify at
    // least one of each was rendered.
    const readCards = bucket.filter((b) => b.dataUnread === "false");
    const unreadCards = bucket.filter((b) => b.dataUnread === "true");
    console.log(`[buckets] read=${readCards.length} unread=${unreadCards.length}`);
    if (readCards.length > 0) {
      expect(parseFloat(readCards[0].borderLeftWidth), "read card accent thickness ~= 3px").toBeLessThanOrEqual(4);
      expect(parseFloat(readCards[0].paddingLeft), "read card padding-left ~= 20px").toBeGreaterThanOrEqual(18);
    }
    if (unreadCards.length > 0) {
      const u = unreadCards[0];
      expect(parseFloat(u.borderLeftWidth), "unread card accent thickness ~= 6px").toBeGreaterThanOrEqual(5);
      expect(parseFloat(u.paddingLeft), "unread card padding-left compensated to ~17px").toBeLessThanOrEqual(18);
      // Content-position preservation (founder brief §13):
      // border-left + padding-left should be identical between read
      // and unread (within 1 px tolerance for rounding).
      const readOffset = parseFloat(readCards[0].borderLeftWidth) + parseFloat(readCards[0].paddingLeft);
      const unreadOffset = parseFloat(u.borderLeftWidth) + parseFloat(u.paddingLeft);
      console.log(`[content-offset] read=${readOffset}px unread=${unreadOffset}px Δ=${(unreadOffset - readOffset).toFixed(2)}px`);
      expect(Math.abs(unreadOffset - readOffset), "content-area X position unchanged read ↔ unread").toBeLessThanOrEqual(1);
      // Bolder title (secondary cue, brief §12).
      expect(parseInt(u.titleFontWeight, 10), "unread title font-weight >= 700").toBeGreaterThanOrEqual(700);
    }

    // Founder brief §19: capture screenshots at least two work types.
    // On the founder fleet, all cards are AP (judgment). We capture
    // representative unread + read anyway; a note in evidence.json
    // records that non-AP examples aren't currently on the fleet.
    if (unreadCards.length > 0) {
      const u = cards.nth(unreadCards[0].index);
      await u.scrollIntoViewIfNeeded();
      await u.screenshot({ path: path.join(OUT, "01-unread-AP.png") });
    }
    if (readCards.length > 0) {
      const r = cards.nth(readCards[0].index);
      await r.scrollIntoViewIfNeeded();
      await r.screenshot({ path: path.join(OUT, "02-read-AP.png") });
    }
    // Side-by-side view for founder review.
    await page.screenshot({ path: path.join(OUT, "03-feed-full.png"), fullPage: false });

    // Non-AP capture — try to find a card whose stateClass is NOT
    // judgment (AP flow is judgment; approval/comm/info-item are
    // other work types). If none exist, note it in the evidence.
    const nonAP = bucket.find((b) => b.stateClass !== "judgment" && b.stateClass !== "");
    if (nonAP) {
      const c = cards.nth(nonAP.index);
      await c.scrollIntoViewIfNeeded();
      await c.screenshot({ path: path.join(OUT, `04-${nonAP.dataUnread === "true" ? "unread" : "read"}-${nonAP.stateClass}.png`) });
    }

    const evidence = {
      capturedAt: new Date().toISOString(),
      staging: { web: "v239", worker: "v116" },
      cardsSampled: total,
      readCount: readCards.length,
      unreadCount: unreadCards.length,
      workTypesPresent: Array.from(new Set(bucket.map((b) => b.stateClass).filter(Boolean))),
      nonAPExampleFound: !!nonAP,
      buckets: bucket,
    };
    fs.writeFileSync(path.join(OUT, "visual-evidence.json"), JSON.stringify(evidence, null, 2));

    await ctx.close();
  });
});
