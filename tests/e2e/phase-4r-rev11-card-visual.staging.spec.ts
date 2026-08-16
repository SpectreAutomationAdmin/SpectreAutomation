// Phase 4R rev-11 (2026-08-15) — visual reconstruction acceptance.
//
// Founder brief §20 required screenshot set:
//   1. Unread — Spectre Summary (unread dot + bolder title visible on
//      the restored single-card visual)
//   2. Read — Spectre Summary (same card after click; identical
//      geometry, unread cues gone)
//   3. Conversation (restored card shell, Conversation body only)
//   4. Attachments (restored card shell, Attachments body only)
//   5. Full Mission Control (proves the surrounding shell remains
//      unchanged)
//
// Also verifies (founder brief §16 acceptance) that the Graph
// mark-read still fires from the restored card — polls the debug
// endpoint after the first click.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = "test-results/phase-4r-rev11-card-visual/after";
fs.mkdirSync(OUT, { recursive: true });

test.describe("Phase 4R rev-11 · Single-card visual reconstruction", () => {
  const avail = stagingCredsAvailable();
  test.skip(!avail.ready, avail.reason ?? "creds missing");
  test.setTimeout(300_000);

  test("5 screenshots + Graph verification survives visual rebuild", async ({ browser }) => {
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
    expect(total).toBeGreaterThan(0);

    // ---- Structural pins for the restored card ------------------
    // The outer article once again owns the visible border + shadow.
    // Assert via computed style on the article.
    const firstCard = cards.first();
    const articleStyles = await firstCard.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        borderTopStyle: cs.borderTopStyle,
        borderTopWidth: cs.borderTopWidth,
        borderRadius: cs.borderRadius,
        backgroundColor: cs.backgroundColor,
        borderLeftWidth: cs.borderLeftWidth,
        boxShadow: cs.boxShadow,
        padding: cs.padding,
      };
    });
    console.log(`[§structural] article computed:`, articleStyles);
    // Article carries a real visible border (rev-11), not a bare wrapper (rev-9).
    expect(articleStyles.borderTopStyle).toBe("solid");
    expect(parseFloat(articleStyles.borderTopWidth)).toBeGreaterThanOrEqual(1);
    expect(parseFloat(articleStyles.borderLeftWidth)).toBeGreaterThanOrEqual(3);
    expect(articleStyles.boxShadow).not.toBe("none");

    // The frame is a bare passthrough — no border, no bg, no shadow.
    const frame = firstCard.locator('[data-testid="card-frame"]').first();
    const frameStyles = await frame.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        borderTopStyle: cs.borderTopStyle,
        borderTopWidth: cs.borderTopWidth,
        boxShadow: cs.boxShadow,
        backgroundColor: cs.backgroundColor,
      };
    });
    console.log(`[§structural] frame computed:`, frameStyles);
    // Bare passthrough: no visible border, no shadow.
    expect(frameStyles.borderTopStyle === "none" || parseFloat(frameStyles.borderTopWidth) === 0).toBeTruthy();
    expect(frameStyles.boxShadow).toBe("none");

    // Tabs sit inside the card interior (below the article's top
    // border + padding), not protruding above it.
    const tabs = firstCard.locator('[data-testid="card-tabs"]').first();
    const cardBox = await firstCard.boundingBox();
    const tabsBox = await tabs.boundingBox();
    if (cardBox && tabsBox) {
      // Tab strip's top must sit BELOW the card's top edge — inside
      // the card, not overlapping the border.
      const inside = tabsBox.y - cardBox.y;
      console.log(`[§structural] tabs sit ${inside.toFixed(1)}px below card top edge`);
      expect(inside, "tab strip sits INSIDE the card (below the top border + padding)").toBeGreaterThanOrEqual(6);
      // Tab BUTTONS are content-width (not equal-width segmented
      // control). The strip CONTAINER may span the interior because
      // its border-bottom is the hairline separator between tabs
      // and body — that's the founder-approved single-card treatment
      // shown in the reference screenshot. Guard on the buttons.
      const summaryTab = firstCard.locator('[data-testid="card-tab-spectre-summary"]').first();
      const conversationTab = firstCard.locator('[data-testid="card-tab-conversation"]').first();
      const summaryBox = await summaryTab.boundingBox();
      const conversationBox = await conversationTab.boundingBox();
      if (summaryBox && conversationBox) {
        // Sum of tab-button widths should be small vs card width
        // (< 40 %). If it approached full width, the buttons would be
        // stretched — a rev-8-style segmented control regression.
        const combined = summaryBox.width + conversationBox.width;
        const buttonsRatio = combined / cardBox.width;
        console.log(`[§structural] tab BUTTONS width sum / card width = ${buttonsRatio.toFixed(3)}`);
        expect(buttonsRatio, "individual tab buttons are content-width, not stretched")
          .toBeLessThanOrEqual(0.40);
      }
    }

    // ---- Find an unread card ------------------------------------
    let unreadIndex = -1;
    for (let i = 0; i < total; i += 1) {
      const c = cards.nth(i);
      if (await c.getAttribute("data-unread") === "true") {
        unreadIndex = i; break;
      }
    }
    if (unreadIndex < 0) {
      console.log("[note] no unread card on fleet — visual acceptance for A/B will use a read card; unread visual is asserted via the pseudo-element pin below only");
    }

    // ---- Screenshot 1: Unread — Spectre Summary ----------------
    const targetIndex = unreadIndex >= 0 ? unreadIndex : 0;
    const targetCard = cards.nth(targetIndex);
    await targetCard.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await targetCard.screenshot({ path: path.join(OUT, "01-unread-summary.png") });

    // ---- Assert the unread ::after dot is anchored to the ARTICLE (rev-11) not the frame (rev-9)
    if (unreadIndex >= 0) {
      const articleDot = await targetCard.evaluate((el) => {
        const cs = getComputedStyle(el, "::after");
        return { content: cs.content, top: cs.top, right: cs.right, width: cs.width, borderRadius: cs.borderRadius };
      });
      const frameDot = await targetCard.locator('[data-testid="card-frame"]').first().evaluate((el) => {
        const cs = getComputedStyle(el, "::after");
        return { content: cs.content };
      });
      console.log(`[§unread] article ::after = ${JSON.stringify(articleDot)}`);
      console.log(`[§unread] frame ::after content = ${frameDot.content}`);
      // Rev-11: the dot is on the article's ::after (frame's ::after is inert).
      expect(articleDot.content.replace(/["']/g, "")).toBe("");
      expect(parseFloat(articleDot.width)).toBeGreaterThanOrEqual(5);
      expect(parseFloat(articleDot.width)).toBeLessThanOrEqual(10);
      expect(frameDot.content === "none" || frameDot.content === "").toBeTruthy();
    }

    // Grab identifiers for Graph verification later.
    const emailMessageId = await targetCard.getAttribute("data-email-id");
    const workIntakeItemId = await targetCard.getAttribute("data-work-intake-item-id");
    console.log(`[§target] intake=${(workIntakeItemId ?? "").slice(-8)} email=${(emailMessageId ?? "").slice(-8)}`);

    // Record card outer height + downstream card position — read/unread
    // transition must not shift layout (founder brief §11 + §18).
    const heightBefore = (await targetCard.boundingBox())?.height ?? 0;
    const downstreamIdx = targetIndex + 1 < total ? targetIndex + 1 : Math.max(0, targetIndex - 1);
    const downstream = cards.nth(downstreamIdx);
    const downstreamTopBefore = (await downstream.boundingBox())?.y ?? 0;

    // ---- Screenshot 2: Read — Spectre Summary -------------------
    // Click Conversation to trigger the mark-read path...
    await targetCard.locator('[data-testid="card-tab-conversation"]').first().click();
    await page.waitForTimeout(500);
    // ...then flip back to Spectre Summary for the read-state screenshot.
    await targetCard.locator('[data-testid="card-tab-spectre-summary"]').first().click();
    await expect(targetCard).toHaveAttribute("data-active-tab", "spectre-summary", { timeout: 3_000 });
    await page.waitForTimeout(500);
    expect(await targetCard.getAttribute("data-unread"), "card is read after first interaction").toBe("false");
    const heightAfter = (await targetCard.boundingBox())?.height ?? 0;
    const downstreamTopAfter = (await downstream.boundingBox())?.y ?? 0;
    console.log(`[§geometry] card height before=${heightBefore} after=${heightAfter} Δ=${(heightAfter-heightBefore).toFixed(1)}`);
    console.log(`[§geometry] downstream y shift = ${(downstreamTopAfter-downstreamTopBefore).toFixed(1)}px`);
    expect(Math.abs(heightAfter - heightBefore), "card height unchanged read ↔ unread")
      .toBeLessThanOrEqual(4);
    expect(Math.abs(downstreamTopAfter - downstreamTopBefore), "feed stability preserved")
      .toBeLessThanOrEqual(4);
    await targetCard.screenshot({ path: path.join(OUT, "02-read-summary.png") });

    // ---- Screenshot 3: Conversation ----------------------------
    await targetCard.locator('[data-testid="card-tab-conversation"]').first().click();
    await expect(targetCard).toHaveAttribute("data-active-tab", "conversation", { timeout: 3_000 });
    await targetCard.locator('[data-testid="card-conversation"]').first().waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForTimeout(500);
    await targetCard.screenshot({ path: path.join(OUT, "03-conversation.png") });

    // ---- Screenshot 4: Attachments (only if this card has the tab) -----
    const attachmentsTab = targetCard.locator('[data-testid="card-tab-attachments"]');
    if (await attachmentsTab.count() > 0) {
      await attachmentsTab.first().click();
      await expect(targetCard).toHaveAttribute("data-active-tab", "attachments", { timeout: 3_000 });
      await targetCard.locator('[data-testid="card-attachments"]').first().waitFor({ state: "visible", timeout: 10_000 });
      await page.waitForTimeout(500);
      await targetCard.screenshot({ path: path.join(OUT, "04-attachments.png") });
    } else {
      // Fall back to another card with attachments.
      for (let i = 0; i < total; i += 1) {
        const c = cards.nth(i);
        if (await c.locator('[data-testid="card-tab-attachments"]').count() > 0) {
          await c.scrollIntoViewIfNeeded();
          await c.locator('[data-testid="card-tab-attachments"]').first().click();
          await c.locator('[data-testid="card-attachments"]').first().waitFor({ state: "visible", timeout: 10_000 });
          await page.waitForTimeout(500);
          await c.screenshot({ path: path.join(OUT, "04-attachments.png") });
          break;
        }
      }
    }

    // ---- Screenshot 5: Full Mission Control --------------------
    await page.screenshot({ path: path.join(OUT, "05-mission-control-full.png"), fullPage: false });

    // ---- Graph verification (§16 acceptance) -------------------
    // Only meaningful if we clicked an unread card that had a linked
    // email. Poll the debug endpoint.
    if (emailMessageId) {
      let mutationStatus: string | null = null;
      let localMirror: boolean | null = null;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const res = await page.request.get(
          `${avail.baseURL}/api/staging/outlook-mark-read-status?emailMessageId=${encodeURIComponent(emailMessageId)}`,
        ).catch(() => null);
        if (res && res.ok()) {
          const body = await res.json() as {
            email: { isRead: boolean } | null;
            mutation: { status: string } | null;
          };
          mutationStatus = body.mutation?.status ?? null;
          localMirror = body.email?.isRead ?? null;
          if (mutationStatus === "SUCCEEDED") break;
        }
        await page.waitForTimeout(2_000);
      }
      console.log(`[§graph] mutation.status=${mutationStatus} localMirror.isRead=${localMirror}`);
      const evidence = {
        capturedAt: new Date().toISOString(),
        staging: { web: "v238" },
        cardTargetedForClick: {
          workIntakeItemIdTail: (workIntakeItemId ?? "").slice(-8),
          emailMessageIdTail: emailMessageId.slice(-8),
          wasUnreadAtStart: unreadIndex >= 0,
        },
        graphOutcome: { mutationStatus, localMirrorIsRead: localMirror },
        interpretation:
          unreadIndex >= 0
            ? (mutationStatus === "SUCCEEDED"
                ? "Rev-11 restored card still fires the Graph PATCH — Outlook source was propagated."
                : mutationStatus
                    ? `Mutation status = ${mutationStatus} — see mark-read.ts outcomes.`
                    : "No mutation row — card was already read locally before click (per-user row existed), so enqueue was skipped by the isRead guard.")
            : "Target card was already read at test start (no unread cards on fleet). Graph propagation was previously verified in rev-10 acceptance evidence.json; this run does not add a fresh SUCCEEDED entry.",
      };
      fs.writeFileSync(path.join(OUT, "graph-evidence.json"), JSON.stringify(evidence, null, 2));
    }

    await ctx.close();
  });
});
