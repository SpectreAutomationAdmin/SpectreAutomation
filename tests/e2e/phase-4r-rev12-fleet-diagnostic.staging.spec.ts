// Phase 4R rev-12 fleet diagnostic (2026-08-16).
//
// Founder-observed critical defect: the read/unread state model
// is not functioning correctly on live staging. Four observed
// failures — see the rev-12 diagnostic checkpoint doc.
//
// This spec is READ-ONLY. It produces a comprehensive state table
// for every Outlook-backed Work Intake card on the fleet:
//
//   GRAPH LIVE isRead  ↔  DB EmailMessage.isRead
//                       ↔  loader isUnread projection
//                       ↔  client rendered data-unread
//                       ↔  rendered border-left-width
//
// It also captures full state for the specific #221007 case,
// including the OutlookMarkReadMutation history.
//
// Any card whose (graph → db → loader → rendered) chain diverges
// is a defect; the first point of divergence identifies the
// responsible subsystem.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = "test-results/phase-4r-rev12-fleet-diagnostic";
fs.mkdirSync(OUT, { recursive: true });

interface FleetRow {
  cardIndex: number;
  title: string;
  invoiceNumber: string | null;
  workIntakeItemIdTail: string;
  emailMessageIdTail: string;
  graphMessageIdTail: string;
  ui: {
    dataUnread: string | null;
    borderLeftWidth: string;
    h3FontWeight: string;
  };
  db: {
    isRead: boolean | null;
    lastSyncedAt: string | null;
    updatedAt: string | null;
  };
  graph: {
    isRead: boolean | null;
    lastModifiedDateTime: string | null;
    subject: string | null;
    error?: string;
  };
  mutation: {
    status: string | null;
    attemptCount: number | null;
    createdAt: string | null;
    completedAt: string | null;
    errorCode: string | null;
  } | null;
  divergence: {
    graphVsDb: string | null;      // "AGREE" | "GRAPH_DRIFTED" | "DB_STALE" | "..."
    dbVsRendered: string | null;   // "AGREE" | "RENDERED_DRIFTED" | "..."
    firstDivergencePoint: string;  // "NONE" | "GRAPH→DB" | "DB→RENDERED" | "GRAPH_ERROR"
  };
}

test.describe("Rev-12 fleet diagnostic", () => {
  const avail = stagingCredsAvailable();
  test.skip(!avail.ready, avail.reason ?? "creds missing");
  test.setTimeout(300_000);

  test("compare live Graph vs DB vs rendered for every card on the fleet", async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await loginAsFounder(ctx, { landing: "/app/admin" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1000);

    const cards = page.locator('[data-testid="email-intake-card"]');
    const total = await cards.count();
    console.log(`[fleet] cards visible = ${total}`);

    const rows: FleetRow[] = [];
    for (let i = 0; i < total; i += 1) {
      const c = cards.nth(i);
      const title = ((await c.locator("h3").first().textContent().catch(() => "")) ?? "").trim();
      const invoiceMatch = title.match(/#(\S+)/);
      const wiId = await c.getAttribute("data-work-intake-item-id");
      const emailId = await c.getAttribute("data-email-id");
      const ui = await c.evaluate((el) => {
        const cs = getComputedStyle(el);
        const h3 = el.querySelector("h3");
        return {
          dataUnread: el.getAttribute("data-unread"),
          borderLeftWidth: cs.borderLeftWidth,
          h3FontWeight: h3 ? getComputedStyle(h3).fontWeight : "",
        };
      });
      // Query debug endpoint WITH live-Graph probe.
      const res = emailId
        ? await page.request.get(
            `${avail.baseURL}/api/staging/outlook-mark-read-status?emailMessageId=${encodeURIComponent(emailId)}&probeGraph=1`,
          )
        : null;
      const body = res && res.ok() ? await res.json() : null;
      const graphErr = (body?.graphProbe?.error as string | undefined) ?? undefined;
      const graphIsRead = typeof body?.graphProbe?.isRead === "boolean" ? body.graphProbe.isRead : null;
      const dbIsRead = typeof body?.email?.isRead === "boolean" ? body.email.isRead : null;
      const renderedUnread = ui.dataUnread === "true";
      const dbSaysUnread = dbIsRead === false;
      const graphSaysUnread = graphIsRead === false;

      // Divergence analysis
      let graphVsDb: string | null = null;
      if (graphIsRead === null) graphVsDb = "GRAPH_ERROR";
      else if (dbIsRead === null) graphVsDb = "DB_MISSING";
      else if (graphIsRead === dbIsRead) graphVsDb = "AGREE";
      else graphVsDb = graphIsRead ? "DB_STALE_says_unread_but_graph_says_read" : "DB_STALE_says_read_but_graph_says_unread";

      const dbVsRendered = dbIsRead === null
        ? "DB_MISSING"
        : dbSaysUnread === renderedUnread ? "AGREE" : "RENDERED_DRIFTED";

      const firstDivergence = graphVsDb === "GRAPH_ERROR"
        ? "GRAPH_ERROR"
        : graphVsDb !== "AGREE" ? "GRAPH→DB"
        : dbVsRendered !== "AGREE" ? "DB→RENDERED" : "NONE";

      const row: FleetRow = {
        cardIndex: i,
        title,
        invoiceNumber: invoiceMatch ? invoiceMatch[1] : null,
        workIntakeItemIdTail: (wiId ?? "").slice(-8),
        emailMessageIdTail: (emailId ?? "").slice(-8),
        graphMessageIdTail: (body?.email?.graphMessageId ?? "").slice(-12),
        ui,
        db: {
          isRead: dbIsRead,
          lastSyncedAt: body?.email?.lastSyncedAt ?? null,
          updatedAt: body?.email?.updatedAt ?? null,
        },
        graph: {
          isRead: graphIsRead,
          lastModifiedDateTime: body?.graphProbe?.lastModifiedDateTime ?? null,
          subject: body?.graphProbe?.subject ?? null,
          ...(graphErr ? { error: graphErr } : {}),
        },
        mutation: body?.mutation
          ? {
              status: body.mutation.status,
              attemptCount: body.mutation.attemptCount,
              createdAt: body.mutation.createdAt,
              completedAt: body.mutation.completedAt,
              errorCode: body.mutation.errorCode,
            }
          : null,
        divergence: {
          graphVsDb,
          dbVsRendered,
          firstDivergencePoint: firstDivergence,
        },
      };
      rows.push(row);

      console.log(
        `[card ${i}] #${row.invoiceNumber ?? "?"} ` +
          `graph=${graphIsRead === null ? "?" : graphIsRead ? "T" : "F"} ` +
          `db=${dbIsRead === null ? "?" : dbIsRead ? "T" : "F"} ` +
          `rendered=${renderedUnread ? "unread" : "read"} ` +
          `border=${ui.borderLeftWidth} ` +
          `divergence=${row.divergence.firstDivergencePoint} ` +
          `mut=${body?.mutation?.status ?? "none"}`,
      );
    }

    // Summary buckets
    const summary = {
      total: rows.length,
      firstDivergencePoints: {
        NONE: rows.filter((r) => r.divergence.firstDivergencePoint === "NONE").length,
        GRAPH_TO_DB: rows.filter((r) => r.divergence.firstDivergencePoint === "GRAPH→DB").length,
        DB_TO_RENDERED: rows.filter((r) => r.divergence.firstDivergencePoint === "DB→RENDERED").length,
        GRAPH_ERROR: rows.filter((r) => r.divergence.firstDivergencePoint === "GRAPH_ERROR").length,
      },
      graphVsDb: {
        AGREE: rows.filter((r) => r.divergence.graphVsDb === "AGREE").length,
        DB_STALE_says_unread_but_graph_says_read: rows.filter((r) => r.divergence.graphVsDb === "DB_STALE_says_unread_but_graph_says_read").length,
        DB_STALE_says_read_but_graph_says_unread: rows.filter((r) => r.divergence.graphVsDb === "DB_STALE_says_read_but_graph_says_unread").length,
      },
    };
    console.log(`[summary]`, JSON.stringify(summary, null, 2));

    // Save full evidence
    fs.writeFileSync(path.join(OUT, "fleet-state-table.json"), JSON.stringify({
      capturedAt: new Date().toISOString(),
      staging: { web: "v241+ (diagnostic-only probe)", worker: "v116" },
      summary,
      rows,
    }, null, 2));
    console.log(`[complete] fleet state written to ${OUT}/fleet-state-table.json`);

    await ctx.close();
  });
});
