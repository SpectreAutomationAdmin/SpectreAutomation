// Sprint 3 · Checkpoint 15R (2026-07-29) — the Mission Control
// "Feed synced" pill and the Connected Accounts page MUST derive
// their health from the same canonical source. Real founder-observed
// staging state: Mission Control said "RECONNECT REQUIRED" while
// Connected Accounts said "Connected — awaiting sync" for the same
// MailboxConnection row (`CONNECTED_PENDING_SYNC`, valid refresh
// token, deltaLink populated).
//
// This test source-contracts feed-synced-status.ts to prove the
// canonical mapper is the sole source of truth downstream.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveMailboxHealth } from "@/lib/mailbox/health";
import { MAILBOX_STATUS } from "@/lib/mailbox/status";

const FEED_SRC_RAW = readFileSync(
  join(process.cwd(), "src/lib/mission-control/feed-synced-status.ts"),
  "utf8",
);
// Strip line comments + block comments so historical notes that
// name the pre-15R defect patterns verbatim do not trip the regex.
const FEED_SRC = FEED_SRC_RAW
  .replace(/\/\/[^\n]*/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "");

describe("15R · feed-synced-status derives from canonical health mapper", () => {
  it("imports deriveMailboxHealth from @/lib/mailbox/health", () => {
    expect(FEED_SRC).toMatch(/from ["']@\/lib\/mailbox\/health["']/);
    expect(FEED_SRC).toMatch(/deriveMailboxHealth/);
  });

  it("no longer contains the pre-15R defect patterns (status !== \"CONNECTED\" or accessTokenExpiresAt < now)", () => {
    // These two comparisons are the exact pre-15R bugs. Neither
    // may reappear in this file.
    expect(FEED_SRC).not.toMatch(/status\s*!==\s*"CONNECTED"/);
    expect(FEED_SRC).not.toMatch(/accessTokenExpiresAt\.getTime\(\)\s*<\s*now/);
  });
});

describe("15R · Mission Control does NOT show RECONNECT for CONNECTED_PENDING_SYNC (behavioural)", () => {
  // Behavioural test — the founder-observed staging state produces
  // credentials=CONNECTED via the canonical mapper. Since Mission
  // Control now derives from that mapper, it can't render
  // RECONNECT_REQUIRED unless the mapper says so.
  it("healthy CONNECTED_PENDING_SYNC yields credentials=CONNECTED", () => {
    const h = deriveMailboxHealth({
      status: MAILBOX_STATUS.CONNECTED_PENDING_SYNC,
      lastSuccessfulSyncAt: null,
      lastAttemptedSyncAt: null,
      lastSyncError: null,
      connectedEmail: "founder@example.com",
      hasRefreshToken: true,
    });
    expect(h.credentials).toBe("CONNECTED");
    // The founder-observed pre-15R Mission Control label was
    // "Reconnect required" — the mapper's credentials axis MUST
    // NOT be REAUTH_REQUIRED here.
    expect(h.credentials).not.toBe("REAUTH_REQUIRED");
  });

  it("CONNECTED_PENDING_SYNC AFTER a successful initial sync (reconnect flow) is credentials=CONNECTED + sync=FRESH", () => {
    const h = deriveMailboxHealth({
      status: MAILBOX_STATUS.CONNECTED_PENDING_SYNC,
      lastSuccessfulSyncAt: new Date(),
      lastAttemptedSyncAt: new Date(),
      lastSyncError: null,
      connectedEmail: "founder@example.com",
      hasRefreshToken: true,
    });
    expect(h.credentials).toBe("CONNECTED");
    expect(h.sync).toBe("FRESH");
  });
});
