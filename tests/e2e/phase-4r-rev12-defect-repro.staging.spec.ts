// Phase 4R rev-12 (2026-08-16) — reproduce the read → unread
// state-model defect that founder review flagged on invoice #221007.
//
// The rev-10 loader formula was:
//   isUnread = !viewerHasRead && !outlookAlreadyRead
// which is equivalent to:
//   isRead = viewerHasRead || outlookAlreadyRead
// A one-way latch: once viewerHasRead is true (from a prior click),
// the card stays read forever even if Outlook later flips isRead
// back to false.
//
// This spec dumps the fleet, identifies invoice #221007's card
// (or any card that exhibits the "Outlook says unread, Spectre
// says read" bug), and captures the smoking-gun state.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = "test-results/phase-4r-rev12-defect-repro";
fs.mkdirSync(OUT, { recursive: true });

test.describe("Rev-12 defect reproduction", () => {
  const avail = stagingCredsAvailable();
  test.skip(!avail.ready, avail.reason ?? "creds missing");

  test("dump every card's (rendered isUnread) vs (Outlook isRead) to expose the OR-latch", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(ctx, { landing: "/app/admin" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1000);

    const cards = page.locator('[data-testid="email-intake-card"]');
    const total = await cards.count();
    console.log(`[repro] cards visible = ${total}`);

    const rows: Array<{
      cardIndex: number;
      workIntakeItemIdTail: string;
      emailMessageIdTail: string;
      titleSample: string;
      renderedDataUnread: string | null;
      outlookIsRead: boolean | null;
      mutationStatus: string | null;
      defectMatches221007OrEquivalent: boolean;
    }> = [];

    for (let i = 0; i < total; i += 1) {
      const c = cards.nth(i);
      const wiId = await c.getAttribute("data-work-intake-item-id");
      const emailId = await c.getAttribute("data-email-id");
      const dataUnread = await c.getAttribute("data-unread");
      const titleEl = c.locator('h3').first();
      const title = (await titleEl.textContent().catch(() => "")) ?? "";
      if (!emailId) continue;
      const res = await page.request.get(
        `${avail.baseURL}/api/staging/outlook-mark-read-status?emailMessageId=${encodeURIComponent(emailId)}`,
      );
      let outlookIsRead: boolean | null = null;
      let mutationStatus: string | null = null;
      if (res.ok()) {
        const body = await res.json() as {
          email: { isRead: boolean } | null;
          mutation: { status: string } | null;
        };
        outlookIsRead = body.email?.isRead ?? null;
        mutationStatus = body.mutation?.status ?? null;
      }
      // Defect condition — Spectre renders READ (data-unread="false")
      // but Outlook mirror says UNREAD (isRead=false). This is the
      // rev-10 OR-latch bug.
      const defect = dataUnread === "false" && outlookIsRead === false;
      rows.push({
        cardIndex: i,
        workIntakeItemIdTail: (wiId ?? "").slice(-8),
        emailMessageIdTail: emailId.slice(-8),
        titleSample: title.slice(0, 60).trim(),
        renderedDataUnread: dataUnread,
        outlookIsRead,
        mutationStatus,
        defectMatches221007OrEquivalent: defect,
      });
      console.log(`[repro] card ${i} title="${title.slice(0,40).trim()}..." data-unread=${dataUnread} outlookIsRead=${outlookIsRead} mutation=${mutationStatus} DEFECT=${defect}`);
    }
    fs.writeFileSync(path.join(OUT, "defect-inventory.json"), JSON.stringify({
      capturedAt: new Date().toISOString(),
      totalCards: total,
      defectCount: rows.filter(r => r.defectMatches221007OrEquivalent).length,
      rows,
    }, null, 2));

    // Rev-12 acceptance: the fix REMOVES the OR-latch. This
    // assertion now enforces the corrected behaviour — no card
    // should show "Outlook says unread but Spectre says read".
    // Pre-fix on staging v238 this ran with defect count = 7/9;
    // post-fix on staging v239+ it must be 0.
    const defectCount = rows.filter(r => r.defectMatches221007OrEquivalent).length;
    console.log(`[repro] defect count = ${defectCount} / ${total} (rev-12 target = 0)`);
    expect(defectCount, "rev-12 loader source-split: no card may show Outlook-unread but Spectre-read (retires the rev-10 OR-latch)").toBe(0);

    await ctx.close();
  });
});
