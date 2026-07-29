// Sprint 3 Checkpoint 15H-1 (2026-07-25) — Source-contract locks for
// the mailbox auto-sync scheduler + Mission Control live-refresh
// component. Verifies:
//   * scheduler is feature-gated (short-circuits when disabled)
//   * scheduler uses time-bucketed idempotency to prevent duplicate
//     Graph calls under multiple worker instances
//   * scheduler is bounded (respects local backoff + interval budget)
//   * live-refresh component preserves expanded review panes
//     (uses router.refresh + DOM check for .spectre-mc-inline-expansion)
//   * snapshot-summary endpoint is GET-only + auth-gated + tenant-scoped
//   * worker loop invokes tickAutoSync
//   * live-refresh component polls at 60s + provides Refresh Now button
//   * live-refresh component pauses on hidden tab (visibilitychange)

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCHEDULER = readFileSync(join(process.cwd(), "src/lib/mailbox/auto-sync-scheduler.ts"), "utf8");
const WORKER = readFileSync(join(process.cwd(), "bin/worker.ts"), "utf8");
const LIVE = readFileSync(join(process.cwd(), "src/components/mission-control/MissionControlLiveRefresh.tsx"), "utf8");
const SUMMARY_ROUTE = readFileSync(join(process.cwd(), "src/app/api/mission-control/snapshot-summary/route.ts"), "utf8");
const PAGE = readFileSync(join(process.cwd(), "src/app/app/admin/page.tsx"), "utf8");

describe("auto-sync scheduler — feature-gated + idempotent + bounded", () => {
  it("refuses to enqueue when MAILBOX_INTEGRATION_ENABLED is false", () => {
    expect(SCHEDULER).toMatch(/isMailboxIntegrationEnabled\(\)/);
    expect(SCHEDULER).toMatch(/reason: "feature_disabled"/);
  });
  it("uses time-bucketed idempotency keys so parallel workers dedupe", () => {
    expect(SCHEDULER).toMatch(/const bucket = Math\.floor\(now\.getTime\(\) \/ intervalMs\)/);
    expect(SCHEDULER).toMatch(/idempotencyKey:\s*`mailbox:auto-delta:\$\{mbx\.id\}:\$\{bucket\}`/);
  });
  it("respects an interval budget (default 60s) between ticks", () => {
    expect(SCHEDULER).toMatch(/lastTickAt/);
    expect(SCHEDULER).toMatch(/intervalMs.*60000/);
  });
  it("respects local backoff (default 30s) since lastAttemptedSyncAt", () => {
    expect(SCHEDULER).toMatch(/minGapMs.*30000/);
    expect(SCHEDULER).toMatch(/lastAttemptedSyncAt/);
  });
  it("only enumerates mailboxes with a deltaLink + refresh token + CONNECTED-ish status", () => {
    // Sprint 3 · Checkpoint 15R (2026-07-29) — the status filter
    // now uses the canonical MAILBOX_STATUS constants (see
    // src/lib/mailbox/status.ts). The pre-15R bare-string form
    // ("PENDING_SYNC") drifted from the actual enum and left
    // CONNECTED_PENDING_SYNC connections unscheduled.
    expect(SCHEDULER).toMatch(/deltaLink:\s*\{\s*not:\s*null\s*\}/);
    expect(SCHEDULER).toMatch(/refreshTokenSecretRef:\s*\{\s*not:\s*null\s*\}/);
    expect(SCHEDULER).toMatch(/MAILBOX_STATUS\.CONNECTED\b/);
    expect(SCHEDULER).toMatch(/MAILBOX_STATUS\.CONNECTED_PENDING_SYNC/);
    expect(SCHEDULER).toMatch(/MAILBOX_STATUS\.DELAYED/);
  });
  it("caps the scan at 200 mailboxes per tick", () => {
    expect(SCHEDULER).toMatch(/take: 200/);
  });
  it("never calls Graph directly — only enqueues", () => {
    expect(SCHEDULER).not.toMatch(/runDeltaSyncForConnection/);
    expect(SCHEDULER).not.toMatch(/getMicrosoftDelegatedProvider/);
    expect(SCHEDULER).not.toMatch(/graph\.microsoft\.com/i);
  });
});

describe("worker loop — invokes tickAutoSync every iteration", () => {
  it("imports and calls tickAutoSync inside the main loop", () => {
    expect(WORKER).toMatch(/import \{ tickAutoSync \} from ".*auto-sync-scheduler"/);
    expect(WORKER).toMatch(/await tickAutoSync\(\)/);
  });
  it("still processes queued jobs (does not replace processPending)", () => {
    expect(WORKER).toMatch(/processPending\(/);
  });
});

describe("snapshot-summary endpoint — GET only + auth-gated + minimal payload", () => {
  it("only exports GET", () => {
    expect(SUMMARY_ROUTE).toMatch(/export async function GET/);
    expect(SUMMARY_ROUTE).not.toMatch(/export async function POST/);
  });
  it("gates on authenticated principal + active club", () => {
    expect(SUMMARY_ROUTE).toMatch(/getCurrentPrincipal/);
    expect(SUMMARY_ROUTE).toMatch(/getActiveClubId/);
    expect(SUMMARY_ROUTE).toMatch(/status: 401/);
  });
  it("returns only the fields the client needs (workItemIds + count + syncedAt)", () => {
    expect(SUMMARY_ROUTE).toMatch(/workItemIds/);
    expect(SUMMARY_ROUTE).toMatch(/syncedAt/);
    // No full workItems payload — tiny response for cheap polling.
    expect(SUMMARY_ROUTE).not.toMatch(/workItems:\s*snapshot\.workItems/);
  });
});

describe("MissionControlLiveRefresh — preserves expanded panes + polls + refresh-now", () => {
  it("uses router.refresh() (not full page reload) — preserves client state", () => {
    expect(LIVE).toMatch(/useRouter\(\)/);
    expect(LIVE).toMatch(/router\.refresh\(\)/);
    // Should NEVER window.location.reload or window.location.href.
    expect(LIVE).not.toMatch(/window\.location\.reload/);
    expect(LIVE).not.toMatch(/window\.location\.href/);
  });
  it("does not force-refresh when a review pane is expanded", () => {
    expect(LIVE).toMatch(/spectre-mc-inline-expansion/);
    expect(LIVE).toMatch(/anyPaneExpanded/);
  });
  it("shows Refresh Now button", () => {
    expect(LIVE).toMatch(/data-testid="mc-refresh-now"/);
    expect(LIVE).toMatch(/Refresh now/);
  });
  it("shows Last refreshed X ago status", () => {
    expect(LIVE).toMatch(/data-testid="mc-live-refresh-status"/);
    expect(LIVE).toMatch(/Last refreshed \$\{ageLabel\}/);
  });
  it("shows new-items banner when work items arrive during review", () => {
    expect(LIVE).toMatch(/data-testid="mc-new-items-banner"/);
    expect(LIVE).toMatch(/new work \{newItemsAvailable === 1 \? "item" : "items"\}/);
  });
  it("polls every 60 000 ms by default", () => {
    expect(LIVE).toMatch(/DEFAULT_POLL_MS = 60_000/);
  });
  it("pauses on hidden tab + resumes on visibilitychange", () => {
    expect(LIVE).toMatch(/visibilitychange/);
    expect(LIVE).toMatch(/document\.visibilityState === "visible"/);
  });
  it("aria-live=polite on the status label so screen readers announce updates", () => {
    expect(LIVE).toMatch(/aria-live="polite"/);
  });
});

describe("MC page — mounts the live-refresh chip once, in the header", () => {
  it("imports the component + mounts it inside spectre-mc-header-meta", () => {
    expect(PAGE).toMatch(/import MissionControlLiveRefresh from/);
    expect(PAGE).toMatch(/<MissionControlLiveRefresh/);
  });
  it("passes initialWorkItemIds + initialSyncedAt as props", () => {
    expect(PAGE).toMatch(/initialWorkItemIds=\{snapshot\.workItems\.map\(\(w\) => w\.id\)\.sort\(\)\}/);
    expect(PAGE).toMatch(/initialSyncedAt=\{snapshot\.syncedAt\.toISOString\(\)\}/);
  });
});
