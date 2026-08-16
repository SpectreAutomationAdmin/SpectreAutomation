// Phase 4R rev-12 (2026-08-16) — LIVE round-trip verification of
// the founder's specific case: invoice #221007. No code changes,
// only observation + interaction.
//
// The spec:
//   1. Locates the #221007 card on the founder's Mission Control.
//   2. Snapshots initial state (UI + local mirror + mutation
//      history + mailbox sync timestamps).
//   3. Captures a screenshot of the card in its current state.
//   4. If the mirror currently reports isRead=false → performs
//      Stage A observation (Spectre correctly renders unread),
//      then Stage B (click → optimistic read → Graph PATCH →
//      mirror flips to true).
//   5. If the mirror currently reports isRead=true → clicks the
//      card to exercise Stage B (either idempotent no-op or a
//      fresh mark-read), then instructs the founder to complete
//      Stages C + D manually and rerun.
//   6. Records everything to `round-trip-evidence.json` for the
//      founder-facing closeout.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = "test-results/phase-4r-rev12-221007-round-trip";
fs.mkdirSync(OUT, { recursive: true });

interface DebugEndpointResponse {
  callerClubId: string;
  serverTimestamp: string;
  email: {
    id: string;
    clubId: string;
    isRead: boolean;
    updatedAt: string;
    lastSyncedAt: string;
    receivedAt: string;
    graphMessageId: string;
    mailboxConnectionId: string;
  } | null;
  origins: Array<{ id: string; workIntakeItemId: string; emailMessageId: string; role: string }>;
  mutation: {
    id: string; status: string; attemptCount: number;
    createdAt: string; updatedAt: string;
    lastAttemptAt: string | null; completedAt: string | null;
    errorCode: string | null; workIntakeItemId: string;
    triggeredByUserId: string | null;
  } | null;
  mutationHistory: Array<{
    id: string; status: string; attemptCount: number;
    createdAt: string; updatedAt: string;
    lastAttemptAt: string | null; completedAt: string | null;
    errorCode: string | null;
  }>;
  mailboxSync: {
    id: string; status: string;
    lastSuccessfulSyncAt: string | null;
    lastAttemptedSyncAt: string | null;
    hasDeltaLink: boolean;
  } | null;
  recentJobs: Array<{
    id: string; status: string; attempts: number;
    createdAt: string; scheduledFor: string;
    payloadJson: string; idempotencyKey: string;
  }>;
  featureFlags: { isEmailMarkReadOnInteractionEnabled: boolean };
}

test.describe("Phase 4R rev-12 · #221007 round-trip live verification", () => {
  const avail = stagingCredsAvailable();
  test.skip(!avail.ready, avail.reason ?? "creds missing");
  test.setTimeout(300_000);

  test("locate #221007, snapshot state, exercise available stages, capture evidence", async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await loginAsFounder(ctx, { landing: "/app/admin" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1000);

    // -------- Locate the #221007 card ------------------------------
    const cards = page.locator('[data-testid="email-intake-card"]');
    const total = await cards.count();
    console.log(`[locate] cards visible on Mission Control = ${total}`);

    let targetIndex = -1;
    let cardTitle = "";
    for (let i = 0; i < total; i += 1) {
      const c = cards.nth(i);
      const title = ((await c.locator("h3").first().textContent().catch(() => "")) ?? "").trim();
      if (title.includes("#221007") || title.includes("221007")) {
        targetIndex = i;
        cardTitle = title;
        break;
      }
    }
    expect(targetIndex, "invoice #221007 card must be on the founder's Mission Control fleet").toBeGreaterThanOrEqual(0);
    const targetCard = cards.nth(targetIndex);
    await targetCard.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);

    const emailId = await targetCard.getAttribute("data-email-id");
    const wiId = await targetCard.getAttribute("data-work-intake-item-id");
    console.log(`[locate] #221007 → card index ${targetIndex}, title="${cardTitle}", intake=${(wiId ?? "").slice(-8)}, email=${(emailId ?? "").slice(-8)}`);
    expect(emailId).toBeTruthy();

    // -------- Snapshot initial state --------------------------------
    async function snapshot(label: string): Promise<{ ui: unknown; server: DebugEndpointResponse; capturedAt: string }> {
      const ui = await targetCard.evaluate((el) => {
        const cs = getComputedStyle(el);
        const h3 = el.querySelector("h3");
        return {
          dataUnread: el.getAttribute("data-unread"),
          dataActiveTab: el.getAttribute("data-active-tab"),
          borderLeftWidth: cs.borderLeftWidth,
          borderLeftColor: cs.borderLeftColor,
          paddingLeft: cs.paddingLeft,
          h3FontWeight: h3 ? getComputedStyle(h3).fontWeight : "",
          pseudoAfterContent: getComputedStyle(el, "::after").content,
        };
      });
      const res = await page.request.get(
        `${avail.baseURL}/api/staging/outlook-mark-read-status?emailMessageId=${encodeURIComponent(emailId!)}`,
      );
      const server = (await res.json()) as DebugEndpointResponse;
      const capturedAt = new Date().toISOString();
      console.log(`[snapshot:${label}] ui=${JSON.stringify(ui)}`);
      console.log(`[snapshot:${label}] server.email.isRead=${server.email?.isRead} lastSyncedAt=${server.email?.lastSyncedAt} mutation.status=${server.mutation?.status ?? "none"}`);
      return { ui, server, capturedAt };
    }

    const initial = await snapshot("initial");

    // Screenshot the current state — labelled by the mirror's isRead
    // value so the founder can see which stage this run captured.
    const initialLabel = initial.server.email?.isRead === false ? "unread" : initial.server.email?.isRead === true ? "read" : "unknown";
    await targetCard.screenshot({ path: path.join(OUT, `01-initial-${initialLabel}.png`) });

    // -------- Interpret + branch ------------------------------------
    const evidence: Record<string, unknown> = {
      capturedAt: new Date().toISOString(),
      staging: { web: "v239+", worker: "v116" },
      target: {
        cardTitle,
        workIntakeItemIdTail: (wiId ?? "").slice(-8),
        emailMessageIdTail: (emailId ?? "").slice(-8),
      },
      initial,
    };

    const outlookIsReadNow = initial.server.email?.isRead;
    const mutations = initial.server.mutationHistory ?? [];

    if (outlookIsReadNow === false) {
      // ---- Stage A verification: Outlook unread → Spectre unread --
      console.log(`[stage-A] mirror reports isRead=false → Spectre should render unread`);
      expect(initial.ui, "UI must render unread when mirror reports isRead=false").toMatchObject({
        dataUnread: "true",
      });
      // Rev-12 unread visual: 6px accent + bold title, no ::after.
      const parsedWidth = parseFloat((initial.ui as { borderLeftWidth: string }).borderLeftWidth);
      const parsedWeight = parseInt((initial.ui as { h3FontWeight: string }).h3FontWeight, 10);
      expect(parsedWidth, "unread border-left-width must be ~6px").toBeGreaterThanOrEqual(5);
      expect(parsedWeight, "unread h3 font-weight must be >= 700").toBeGreaterThanOrEqual(700);
      const psContent = ((initial.ui as { pseudoAfterContent: string }).pseudoAfterContent ?? "").replace(/["']/g, "");
      expect(psContent === "none" || psContent === "", "no green ::after dot").toBeTruthy();
      evidence.stageA = {
        passed: true,
        observation: "Spectre correctly renders unread when Outlook mirror is isRead=false. Thick 6px semantic rail + bold title, no green dot.",
      };
      await targetCard.screenshot({ path: path.join(OUT, "02-stage-A-unread.png") });

      // ---- Stage B: click card → Spectre read + Graph PATCH -------
      console.log(`[stage-B] clicking card → optimistic read + Graph PATCH`);
      await targetCard.locator('[data-testid="card-tab-conversation"]').first().click();
      await page.waitForTimeout(500);
      await targetCard.locator('[data-testid="card-tab-spectre-summary"]').first().click();
      await page.waitForTimeout(500);
      const afterClick = await snapshot("after-click");
      // Optimistic UI: card should render read locally.
      expect(afterClick.ui, "card visually reads as read after click").toMatchObject({
        dataUnread: "false",
      });
      await targetCard.screenshot({ path: path.join(OUT, "03-stage-B-immediate-read.png") });
      // Poll for Graph PATCH → mirror flips to true.
      let stageBFinal: { server: DebugEndpointResponse } | null = null;
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const s = await snapshot("stage-B-poll");
        if (s.server.email?.isRead === true) {
          stageBFinal = s;
          break;
        }
        await page.waitForTimeout(3_000);
      }
      if (stageBFinal) {
        evidence.stageB = {
          passed: true,
          observation: "Spectre click enqueued MAILBOX_MARK_READ, worker PATCHed Graph, local mirror flipped to isRead=true.",
          latestMutation: stageBFinal.server.mutation,
          finalMirrorIsRead: stageBFinal.server.email?.isRead,
        };
      } else {
        evidence.stageB = {
          passed: false,
          observation: "Graph PATCH did not confirm within 90s. Local optimistic UI works but mirror not updated. Check worker + Graph availability.",
        };
      }

      evidence.stagesCandD = {
        passed: null,
        observation:
          "Stages C (founder manually marks unread in Outlook) and D " +
          "(next delta sync flips mirror → Spectre re-renders unread) " +
          "require founder-driven Outlook action. Rerun this spec after " +
          "marking #221007 unread in Outlook to observe Stage D.",
      };
    } else if (outlookIsReadNow === true) {
      // Mirror reports true. Report finding per founder brief §4.
      console.log(`[branch] mirror reports isRead=true — founder's prior unread action either not persisted, superseded, or already synced back to read`);
      evidence.currentMirrorState = {
        outlookIsRead: true,
        interpretation:
          "The local mirror currently reports #221007 as READ (isRead=true). " +
          "Per founder brief §4 this can mean: (a) the founder's prior manual Outlook unread action did not persist, " +
          "(b) it was superseded by a subsequent Outlook-side read action, " +
          "(c) it has not yet reached Graph, or " +
          "(d) it has been changed back to read since then. " +
          "Rev-12 architecture is not exercised for Outlook→Spectre unread propagation in this state — " +
          "the loader would only need to demonstrate the transition if the mirror is isRead=false.",
        recommendedNextAction:
          "Founder: manually mark #221007 unread in Outlook (phone, Outlook Web, or desktop client), " +
          "wait ~60s for the delta sync cycle to run, and either refresh Mission Control or rerun this spec. " +
          "The rev-12 loader (v239) will render the card as unread the moment the local mirror flips.",
      };
      // Even in this state we can capture Stage B to prove the outbound path still works.
      console.log(`[stage-B-alt] click the currently-read card → any tab click still fires but may short-circuit`);
      await targetCard.locator('[data-testid="card-tab-conversation"]').first().click();
      await page.waitForTimeout(500);
      await targetCard.locator('[data-testid="card-tab-spectre-summary"]').first().click();
      await page.waitForTimeout(3_000);
      const afterAltClick = await snapshot("stage-B-alt-post-click");
      evidence.stageBAlt = {
        observation:
          "Card was already read (mirror true); clicking Conversation tab and back exercised the tab-change path. " +
          "No mark-read job was expected to fire (email.isRead was already true; the enqueue helper short-circuits).",
        afterClick: afterAltClick,
      };
      await targetCard.screenshot({ path: path.join(OUT, "02-current-state-read.png") });
    } else {
      throw new Error(`Unexpected mirror state — email.isRead resolved to ${outlookIsReadNow}. Debug endpoint may be returning null email.`);
    }

    // -------- Stale-mutation guard evidence -------------------------
    const anySuperseded = mutations.filter((m) => m.status === "SUPERSEDED");
    const anyRetryable = mutations.filter((m) => m.status === "RETRYABLE" && m.attemptCount >= 1);
    evidence.staleMutationGuard = {
      superSededCount: anySuperseded.length,
      retryablePendingCount: anyRetryable.length,
      observation:
        anySuperseded.length > 0
          ? `Worker v116 SUPERSEDED guard has fired ${anySuperseded.length} time(s) — a founder Outlook-side unmark contradicted a pending mark-read.`
          : "No SUPERSEDED status observed on any #221007 mutation. Guard is present in worker v116 (src/lib/mailbox/mark-read.ts) but has not been exercised for this specific email.",
      allHistory: mutations.map((m) => ({
        status: m.status,
        attemptCount: m.attemptCount,
        createdAt: m.createdAt,
        completedAt: m.completedAt,
        errorCode: m.errorCode,
      })),
    };

    // -------- Save evidence file ----------------------------------
    fs.writeFileSync(path.join(OUT, "round-trip-evidence.json"), JSON.stringify(evidence, null, 2));
    console.log(`[complete] evidence written to ${OUT}/round-trip-evidence.json`);

    await ctx.close();
  });
});
