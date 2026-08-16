// Phase 4R rev-10 (2026-08-15) — Outlook ↔ Spectre read/unread
// staging acceptance.
//
// Runs against staging web v233 + worker v115 on the real founder
// account against real Outlook data. Captures the four artefacts
// founder brief §21 asks for:
//
//   A. Unread — Work Intake card tied to an unread Outlook email,
//      visible unread treatment (dot in top-right corner of frame,
//      bolder title, slightly stronger surface).
//   B. After — same card immediately after first tab click; read
//      treatment (no dot, normal weight).
//   C. Graph verification — the OutlookMarkReadMutation row for
//      this (mailboxConnectionId, emailMessageId) landed as
//      status=SUCCEEDED with a completedAt timestamp, AND the
//      local EmailMessage.isRead mirror flipped to true.
//   D. Outlook → Spectre — is exercised structurally by the
//      loader OR-semantics guard in the source-contract suite
//      + observed on-fleet in production sync ticks. Reproducing
//      it deterministically in a Playwright spec requires
//      Graph-side write access which staging does not currently
//      have.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = "test-results/phase-4r-rev10-outlook-mark-read/after";
fs.mkdirSync(OUT, { recursive: true });

test.describe("Phase 4R rev-10 · Outlook ↔ Spectre read/unread sync", () => {
  const avail = stagingCredsAvailable();
  test.skip(!avail.ready, avail.reason ?? "creds missing");
  test.setTimeout(300_000);

  test("A/B/C — unread card → first-interaction propagates → Graph mutation lands", async ({ browser }) => {
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
    expect(total, "at least one work intake card on the founder fleet").toBeGreaterThan(0);

    // Find an UNREAD card. `data-unread="true"` is emitted by the
    // article per rev-7. If none are unread on the fleet at test
    // time, skip cleanly — the test cannot fabricate one.
    let unreadIndex = -1;
    for (let i = 0; i < total; i += 1) {
      const c = cards.nth(i);
      const attr = await c.getAttribute("data-unread");
      if (attr === "true") { unreadIndex = i; break; }
    }
    if (unreadIndex < 0) {
      test.skip(true, "no unread work-intake cards on the founder fleet — the acceptance case requires at least one; try again after unread mail arrives");
      return;
    }
    const cardUnread = cards.nth(unreadIndex);
    await cardUnread.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    // Capture the workIntakeItemId + emailMessageId so we can verify
    // the mutation row after the click. `data-work-intake-item-id`
    // and `data-email-id` are both on the article per rev-7.
    const workIntakeItemId = await cardUnread.getAttribute("data-work-intake-item-id");
    const emailMessageId = await cardUnread.getAttribute("data-email-id");
    console.log(`[setup] target card intake=${(workIntakeItemId ?? "").slice(-6)} email=${(emailMessageId ?? "").slice(-6)}`);
    expect(workIntakeItemId).toBeTruthy();
    expect(emailMessageId).toBeTruthy();

    // ---- A. UNREAD screenshot -----------------------------------
    // Confirm the rev-10 unread dot is rendered (the frame's ::after
    // pseudo-element carries the small green dot; we assert via the
    // computed style since the ::after itself has no DOM node).
    const frame = cardUnread.locator('[data-testid="card-frame"]').first();
    await expect(frame).toBeVisible();
    const dotPseudo = await frame.evaluate((el) => {
      const cs = getComputedStyle(el, "::after");
      return {
        content: cs.content,
        top: cs.top,
        right: cs.right,
        width: cs.width,
        height: cs.height,
        borderRadius: cs.borderRadius,
      };
    });
    console.log(`[A] unread dot pseudo:`, dotPseudo);
    // A rendered ::after with content: "" (or "'"'") means the pseudo is active.
    expect(dotPseudo.content.replace(/["']/g, "")).toBe("");
    // Dot should be small (≤ 10 px) and positioned top-right.
    expect(parseFloat(dotPseudo.width)).toBeGreaterThanOrEqual(5);
    expect(parseFloat(dotPseudo.width)).toBeLessThanOrEqual(10);
    await cardUnread.screenshot({ path: path.join(OUT, "A-unread-card.png") });

    // ---- B. First interaction (tab click) marks read locally + enqueues Graph -----
    // The tabs strip is above the frame; click Conversation (a real
    // founder tab, not a synthetic Summary re-click).
    await cardUnread.locator('[data-testid="card-tab-conversation"]').first().click();
    await expect(cardUnread).toHaveAttribute("data-active-tab", "conversation", { timeout: 3_000 });
    // Wait for the mark-read POST + local state flip.
    await page.waitForTimeout(1_500);
    // After the click, the article's data-unread flips to false
    // because the local optimistic markReadOnce path sets readLocal.
    const afterAttr = await cardUnread.getAttribute("data-unread");
    console.log(`[B] card data-unread after click = ${afterAttr}`);
    expect(afterAttr, "card visually reads as READ immediately after interaction").toBe("false");
    // The ::after dot is gated by .spectre-mc-item--unread — should be gone.
    const dotAfter = await frame.evaluate((el) => {
      const cs = getComputedStyle(el, "::after");
      return cs.content;
    });
    console.log(`[B] frame ::after content post-click = ${dotAfter}`);
    // With .spectre-mc-item--unread removed, the ::after rule doesn't
    // apply — computed content is "none" or empty.
    expect(dotAfter === "none" || dotAfter === "").toBeTruthy();
    await cardUnread.screenshot({ path: path.join(OUT, "B-read-card.png") });

    // ---- C. Graph verification via debug endpoint ---------------
    // Poll the mutation-status endpoint we ship for staging inspection.
    // Give the worker up to 60s to consume the job + hit Graph.
    let mutationStatus: string | null = null;
    let localMirror: boolean | null = null;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const res = await page.request.get(
        `${avail.baseURL}/api/staging/outlook-mark-read-status?emailMessageId=${encodeURIComponent(emailMessageId!)}`,
      ).catch(() => null);
      if (res && res.ok()) {
        const body = await res.json() as { mutation?: { status?: string }; email?: { isRead?: boolean } };
        mutationStatus = body.mutation?.status ?? null;
        localMirror = body.email?.isRead ?? null;
        if (mutationStatus === "SUCCEEDED") break;
      }
      await page.waitForTimeout(2_000);
    }
    console.log(`[C] mutation.status = ${mutationStatus} · localMirror.isRead = ${localMirror}`);
    // Both signals must be true for a genuine Graph propagation to
    // have occurred: the worker recorded SUCCEEDED and updated the
    // local mirror in the same transaction.
    expect(mutationStatus, "mutation row landed as SUCCEEDED — Graph accepted PATCH").toBe("SUCCEEDED");
    expect(localMirror, "local EmailMessage.isRead mirror flipped to true").toBe(true);

    // ---- Compose an evidence file ------------------------------
    const evidence = {
      capturedAt: new Date().toISOString(),
      staging: {
        webVersion: "v233",
        workerVersion: "v115",
      },
      card: {
        workIntakeItemIdTail: (workIntakeItemId ?? "").slice(-6),
        emailMessageIdTail: (emailMessageId ?? "").slice(-6),
      },
      unreadBefore: {
        dotWidth: dotPseudo.width,
        dotBorderRadius: dotPseudo.borderRadius,
        dotPosition: { top: dotPseudo.top, right: dotPseudo.right },
      },
      readAfter: {
        cardDataUnread: afterAttr,
        pseudoContentPostRead: dotAfter,
      },
      graph: {
        mutationStatus,
        localMirrorIsRead: localMirror,
      },
    };
    fs.writeFileSync(
      path.join(OUT, "evidence.json"),
      JSON.stringify(evidence, null, 2),
    );

    await ctx.close();
  });
});
