// Phase 4R rev-13 (2026-08-16) — live acceptance for the three
// surgical fixes proven by the rev-12 critical-defect diagnostic.
//
// Stages the spec exercises directly against staging v242 + worker v117:
//
//   Stage A — Outlook UNREAD → manual Feed Refresh → Spectre UNREAD
//     Prior: FEED SYNCED flipped back without a real mailbox sync;
//     DB stayed stale-true; card stayed read (rev-12 Defect A).
//     Rev-13: refresh POSTs to /refresh-mailbox → enqueues
//     MAILBOX_DELTA_SYNC → client polls status until COMPLETED →
//     snapshot-summary GET + router.refresh → card renders unread.
//
//   Stage B — Spectre interaction → new mutation → Graph → SUCCEEDED
//     Prior: `if (mutation.status === "SUCCEEDED") return` short-
//     circuit blocked a second-generation PATCH forever
//     (rev-12 Defect B).
//     Rev-13: enqueue creates a NEW mutation row per generation
//     (unique index dropped, active-intent dedupe at enqueue site);
//     worker executes the specific row by ID. Historical SUCCEEDED
//     rows remain as audit and DO NOT block.
//
//   Stage D-proxy — Fleet post-refresh consistency
//     Rev-13 fix A means the manual refresh should bring every
//     Outlook-backed card's DB mirror in agreement with Graph.
//
//   Stages C + D for #221007 specifically require founder-side
//   Outlook action (mark #221007 unread in Outlook AFTER Stage B).
//   The spec captures the state as of the run and documents what
//   remains for the founder to trigger.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = "test-results/phase-4r-rev13-round-trip";
fs.mkdirSync(OUT, { recursive: true });

interface DebugResponse {
  email: { isRead: boolean; lastSyncedAt: string | null; updatedAt: string | null } | null;
  mutation: { id: string; status: string; attemptCount: number; createdAt: string } | null;
  mutationHistory: Array<{ id: string; status: string; createdAt: string; completedAt: string | null }>;
  graphProbe: { isRead?: boolean | null; error?: string } | null;
}

test.describe("Phase 4R rev-13 · live round-trip acceptance", () => {
  const avail = stagingCredsAvailable();
  test.skip(!avail.ready, avail.reason ?? "creds missing");
  test.setTimeout(600_000);

  test("Stage A + B + fleet consistency + generation ledger", async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await loginAsFounder(ctx, { landing: "/app/admin" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1500);

    const evidence: Record<string, unknown> = {
      capturedAt: new Date().toISOString(),
      staging: { web: "v242", worker: "v117" },
    };

    // ---------- Locate #221007 ----------
    const cards = page.locator('[data-testid="email-intake-card"]');
    const total = await cards.count();
    let targetIndex = -1;
    for (let i = 0; i < total; i += 1) {
      const title = ((await cards.nth(i).locator("h3").first().textContent().catch(() => "")) ?? "").trim();
      if (title.includes("#221007")) { targetIndex = i; break; }
    }
    expect(targetIndex, "#221007 card must be on founder fleet").toBeGreaterThanOrEqual(0);
    const targetCard = cards.nth(targetIndex);
    await targetCard.scrollIntoViewIfNeeded();
    const emailId = await targetCard.getAttribute("data-email-id");
    const wiId = await targetCard.getAttribute("data-work-intake-item-id");
    expect(emailId).toBeTruthy();
    console.log(`[locate] #221007 → card ${targetIndex}, intake=${(wiId ?? "").slice(-8)}, email=${(emailId ?? "").slice(-8)}`);

    async function debugQuery(withGraph: boolean = false): Promise<DebugResponse> {
      const url =
        `${avail.baseURL}/api/staging/outlook-mark-read-status?emailMessageId=${encodeURIComponent(emailId!)}` +
        (withGraph ? "&probeGraph=1" : "");
      const res = await page.request.get(url);
      return (await res.json()) as DebugResponse;
    }
    async function cardUi() {
      return targetCard.evaluate((el) => {
        const cs = getComputedStyle(el);
        const h3 = el.querySelector("h3");
        return {
          dataUnread: el.getAttribute("data-unread"),
          borderLeftWidth: cs.borderLeftWidth,
          h3FontWeight: h3 ? getComputedStyle(h3).fontWeight : "",
        };
      });
    }

    // ---------- Snapshot INITIAL state ----------
    const initial = await debugQuery(true);
    const initialUi = await cardUi();
    console.log(`[initial] graph.isRead=${initial.graphProbe?.isRead} db.isRead=${initial.email?.isRead} rendered.unread=${initialUi.dataUnread} border=${initialUi.borderLeftWidth} mutations=${initial.mutationHistory.length}`);
    (evidence as { initial?: unknown }).initial = {
      graphIsRead: initial.graphProbe?.isRead ?? null,
      dbIsRead: initial.email?.isRead ?? null,
      ui: initialUi,
      mutationHistoryLength: initial.mutationHistory.length,
      lastSyncedAt: initial.email?.lastSyncedAt ?? null,
    };

    // ---------- Stage A: manual Feed Sync barrier ----------
    // If Graph says unread but DB says read, this refresh MUST bring
    // them in agreement (rev-12 Defect A fix).
    console.log(`[Stage A] triggering manual refresh via /refresh-mailbox …`);
    const refreshRes = await page.request.post(`${avail.baseURL}/api/mission-control/refresh-mailbox`);
    expect(refreshRes.status(), "POST /refresh-mailbox returns 202").toBe(202);
    const refreshBody = (await refreshRes.json()) as { jobIds: string[]; mailboxConnectionIds: string[] };
    console.log(`[Stage A] enqueued jobIds=${refreshBody.jobIds.length} for ${refreshBody.mailboxConnectionIds.length} mailboxes`);
    expect(refreshBody.jobIds.length, "at least one delta-sync job enqueued").toBeGreaterThan(0);

    // Poll job status until terminal (or timeout).
    const jobIdsCsv = refreshBody.jobIds.join(",");
    let terminal = false;
    let failed = false;
    const stageAStart = Date.now();
    while (Date.now() - stageAStart < 45_000) {
      await page.waitForTimeout(1_500);
      const s = await page.request.get(
        `${avail.baseURL}/api/mission-control/refresh-mailbox/status?jobIds=${encodeURIComponent(jobIdsCsv)}`,
      );
      const b = (await s.json()) as { allTerminal: boolean; anyFailed: boolean };
      if (b.allTerminal) { terminal = true; failed = b.anyFailed; break; }
    }
    console.log(`[Stage A] terminal=${terminal} anyFailed=${failed} elapsed=${Date.now() - stageAStart}ms`);
    expect(terminal, "manual sync completes within 45s").toBe(true);
    expect(failed, "manual sync succeeds").toBe(false);

    // Reload the page so the loader re-projects with fresh DB values.
    await page.reload();
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1_000);

    // Re-locate #221007 (indices may have shifted if unread items reordered).
    let targetIndex2 = -1;
    const cards2 = page.locator('[data-testid="email-intake-card"]');
    const total2 = await cards2.count();
    for (let i = 0; i < total2; i += 1) {
      const title = ((await cards2.nth(i).locator("h3").first().textContent().catch(() => "")) ?? "").trim();
      if (title.includes("#221007")) { targetIndex2 = i; break; }
    }
    expect(targetIndex2).toBeGreaterThanOrEqual(0);
    const targetCard2 = cards2.nth(targetIndex2);
    await targetCard2.scrollIntoViewIfNeeded();

    const afterRefresh = await debugQuery(true);
    const afterRefreshUi = await targetCard2.evaluate((el) => {
      const cs = getComputedStyle(el);
      const h3 = el.querySelector("h3");
      return {
        dataUnread: el.getAttribute("data-unread"),
        borderLeftWidth: cs.borderLeftWidth,
        h3FontWeight: h3 ? getComputedStyle(h3).fontWeight : "",
      };
    });
    console.log(`[Stage A post-sync] graph.isRead=${afterRefresh.graphProbe?.isRead} db.isRead=${afterRefresh.email?.isRead} rendered.unread=${afterRefreshUi.dataUnread} border=${afterRefreshUi.borderLeftWidth}`);
    (evidence as { stageA_postRefresh?: unknown }).stageA_postRefresh = {
      graphIsRead: afterRefresh.graphProbe?.isRead ?? null,
      dbIsRead: afterRefresh.email?.isRead ?? null,
      ui: afterRefreshUi,
    };
    // After the manual sync, Graph and DB MUST agree.
    expect(afterRefresh.email?.isRead, "DB mirror agrees with Graph after manual sync").toBe(afterRefresh.graphProbe?.isRead);
    if (afterRefresh.email?.isRead === false) {
      await targetCard2.screenshot({ path: path.join(OUT, "01-stage-A-unread-after-manual-refresh.png") });
    } else {
      await targetCard2.screenshot({ path: path.join(OUT, "01-stage-A-still-read.png") });
      console.log(`[Stage A note] Outlook currently reports #221007 as READ. Stage B (click to mark read) is a no-op. Founder must mark #221007 UNREAD in Outlook to observe Stage B end-to-end for THIS invoice.`);
    }

    // ---------- Stage B: interaction → generation ledger ----------
    // Only exercisable if DB currently reports unread.
    if (afterRefresh.email?.isRead === false) {
      console.log(`[Stage B] card is unread; clicking Conversation tab to trigger mark-read`);
      const historyBefore = afterRefresh.mutationHistory.length;
      await targetCard2.locator('[data-testid="card-tab-conversation"]').first().click();
      await page.waitForTimeout(500);
      await targetCard2.locator('[data-testid="card-tab-spectre-summary"]').first().click();
      // Poll for a NEW mutation row to appear (rev-13 generation).
      let afterClick: DebugResponse | null = null;
      const stageBStart = Date.now();
      while (Date.now() - stageBStart < 60_000) {
        await page.waitForTimeout(2_000);
        const s = await debugQuery(true);
        if (
          s.mutationHistory.length > historyBefore &&
          s.mutation?.status === "SUCCEEDED" &&
          s.email?.isRead === true &&
          s.graphProbe?.isRead === true
        ) {
          afterClick = s;
          break;
        }
      }
      expect(afterClick, "new SUCCEEDED mutation lands within 60s").not.toBeNull();
      if (afterClick) {
        console.log(`[Stage B success] new mutation=${afterClick.mutation?.id?.slice(-8)} status=${afterClick.mutation?.status} history=${afterClick.mutationHistory.length} graph.isRead=${afterClick.graphProbe?.isRead}`);
        (evidence as { stageB?: unknown }).stageB = {
          newestMutation: afterClick.mutation,
          historyLengthBefore: historyBefore,
          historyLengthAfter: afterClick.mutationHistory.length,
          allMutations: afterClick.mutationHistory,
          graphIsRead: afterClick.graphProbe?.isRead,
          dbIsRead: afterClick.email?.isRead,
        };
        await page.reload();
        await page.waitForTimeout(1_000);
        const cards3 = page.locator('[data-testid="email-intake-card"]');
        for (let i = 0; i < await cards3.count(); i += 1) {
          const title = ((await cards3.nth(i).locator("h3").first().textContent().catch(() => "")) ?? "").trim();
          if (title.includes("#221007")) {
            await cards3.nth(i).scrollIntoViewIfNeeded();
            await cards3.nth(i).screenshot({ path: path.join(OUT, "02-stage-B-read-after-click.png") });
            break;
          }
        }
      }
    } else {
      (evidence as { stageB?: unknown }).stageB = {
        note: "Skipped — #221007 was READ at Stage A start. Founder must mark unread in Outlook first.",
      };
    }

    // ---------- Fleet consistency ----------
    console.log(`[fleet] rerunning full fleet Graph-vs-DB comparison…`);
    const cardsFinal = page.locator('[data-testid="email-intake-card"]');
    const totalFinal = await cardsFinal.count();
    const fleetRows: Array<{ i: number; invoice: string | null; graph: boolean | null; db: boolean | null; rendered: boolean; agree: boolean }> = [];
    for (let i = 0; i < totalFinal; i += 1) {
      const c = cardsFinal.nth(i);
      const title = ((await c.locator("h3").first().textContent().catch(() => "")) ?? "").trim();
      const invoiceMatch = title.match(/#(\S+)/);
      const eId = await c.getAttribute("data-email-id");
      const rendered = (await c.getAttribute("data-unread")) === "true";
      if (!eId) continue;
      const res = await page.request.get(
        `${avail.baseURL}/api/staging/outlook-mark-read-status?emailMessageId=${encodeURIComponent(eId)}&probeGraph=1`,
      );
      const body = (await res.json()) as DebugResponse;
      const g = typeof body.graphProbe?.isRead === "boolean" ? body.graphProbe.isRead : null;
      const d = typeof body.email?.isRead === "boolean" ? body.email.isRead : null;
      const agree = g !== null && d !== null && g === d && (d === false) === rendered;
      fleetRows.push({ i, invoice: invoiceMatch?.[1] ?? null, graph: g, db: d, rendered, agree });
    }
    (evidence as { fleetConsistency?: unknown }).fleetConsistency = {
      total: fleetRows.length,
      agreeCount: fleetRows.filter((r) => r.agree).length,
      disagreeCount: fleetRows.filter((r) => !r.agree).length,
      rows: fleetRows,
    };
    console.log(`[fleet] ${fleetRows.filter((r) => r.agree).length}/${fleetRows.length} cards agree (Graph = DB = rendered)`);

    await page.screenshot({ path: path.join(OUT, "03-mission-control-full-fleet.png"), fullPage: false });

    // ---------- Save evidence ----------
    fs.writeFileSync(path.join(OUT, "round-trip-evidence.json"), JSON.stringify(evidence, null, 2));

    await ctx.close();
  });
});
