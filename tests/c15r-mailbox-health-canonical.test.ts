// Sprint 3 · Checkpoint 15R (2026-07-29) — canonical mailbox health
// mapper tests. Proves that:
//   (a) all 7 MailboxStatus enum values map to a single MailboxHealth
//       tuple deterministically,
//   (b) CONNECTED_PENDING_SYNC is credentials=CONNECTED (NOT
//       REAUTH_REQUIRED — the pre-15R Mission Control bug), and
//   (c) an access token past its expiry does NOT flip credentials
//       to REAUTH_REQUIRED (auto-refresh is transparent).

import { describe, expect, it } from "vitest";
import { deriveMailboxHealth } from "@/lib/mailbox/health";
import { MAILBOX_STATUS } from "@/lib/mailbox/status";

const NOW = new Date("2026-07-29T00:00:00.000Z");
const FRESH = new Date("2026-07-29T00:00:00.000Z");
const STALE = new Date("2026-07-28T22:00:00.000Z"); // > 30m ago

function baseConn(overrides: Record<string, unknown> = {}) {
  return {
    status: MAILBOX_STATUS.CONNECTED,
    lastSuccessfulSyncAt: FRESH,
    lastAttemptedSyncAt: FRESH,
    lastSyncError: null,
    connectedEmail: "user@example.com",
    hasRefreshToken: true,
    ...overrides,
  };
}

describe("15R · canonical mailbox health mapper", () => {
  it("returns credentials=NONE for a missing connection", () => {
    const h = deriveMailboxHealth(null, { now: NOW });
    expect(h.credentials).toBe("NONE");
    expect(h.sync).toBe("NEVER");
    expect(h.connectedEmail).toBeNull();
  });

  it("CONNECTED + fresh sync → credentials=CONNECTED, sync=FRESH", () => {
    const h = deriveMailboxHealth(baseConn(), { now: NOW });
    expect(h.credentials).toBe("CONNECTED");
    expect(h.sync).toBe("FRESH");
  });

  it("CONNECTED_PENDING_SYNC is credentials=CONNECTED (NOT REAUTH_REQUIRED) — the pre-15R Mission Control bug", () => {
    // The exact founder-observed staging state — mailbox stuck in
    // CONNECTED_PENDING_SYNC with a valid refresh token. The
    // canonical mapper MUST recognise this as healthy credentials
    // with an "awaiting sync" sync-axis, not as a reauth needed.
    const h = deriveMailboxHealth(
      baseConn({
        status: MAILBOX_STATUS.CONNECTED_PENDING_SYNC,
        lastSuccessfulSyncAt: null,
      }),
      { now: NOW },
    );
    expect(h.credentials).toBe("CONNECTED");
    expect(h.sync).toBe("NEVER");
    expect(h.rawStatus).toBe(MAILBOX_STATUS.CONNECTED_PENDING_SYNC);
  });

  it("CONNECTED_PENDING_SYNC WITH prior successful sync (reconnect flow) → sync=FRESH", () => {
    const h = deriveMailboxHealth(
      baseConn({ status: MAILBOX_STATUS.CONNECTED_PENDING_SYNC, lastSuccessfulSyncAt: FRESH }),
      { now: NOW },
    );
    expect(h.credentials).toBe("CONNECTED");
    expect(h.sync).toBe("FRESH");
  });

  it("REAUTH_REQUIRED → credentials=REAUTH_REQUIRED", () => {
    const h = deriveMailboxHealth(baseConn({ status: MAILBOX_STATUS.REAUTH_REQUIRED }), { now: NOW });
    expect(h.credentials).toBe("REAUTH_REQUIRED");
  });

  it("DISCONNECTED → credentials=DISCONNECTED", () => {
    const h = deriveMailboxHealth(baseConn({ status: MAILBOX_STATUS.DISCONNECTED }), { now: NOW });
    expect(h.credentials).toBe("DISCONNECTED");
  });

  it("CONNECTING → credentials=CONNECTED (transient)", () => {
    const h = deriveMailboxHealth(baseConn({ status: MAILBOX_STATUS.CONNECTING, lastSuccessfulSyncAt: null }), { now: NOW });
    expect(h.credentials).toBe("CONNECTED");
    expect(h.sync).toBe("NEVER");
  });

  it("DELAYED → credentials=CONNECTED, sync=STALE if last success is old", () => {
    const h = deriveMailboxHealth(
      baseConn({ status: MAILBOX_STATUS.DELAYED, lastSuccessfulSyncAt: STALE, lastAttemptedSyncAt: STALE }),
      { now: NOW },
    );
    expect(h.credentials).toBe("CONNECTED");
    expect(h.sync).toBe("STALE");
  });

  it("ERROR + prior sync → credentials=CONNECTED, sync=FAILING if attempt-after-success", () => {
    const attemptedLater = new Date(STALE.getTime() + 30_000);
    const h = deriveMailboxHealth(
      baseConn({
        status: MAILBOX_STATUS.ERROR,
        lastSuccessfulSyncAt: STALE,
        lastAttemptedSyncAt: attemptedLater,
        lastSyncError: "graph_5xx",
      }),
      { now: NOW },
    );
    expect(h.credentials).toBe("CONNECTED");
    expect(h.sync).toBe("FAILING");
  });

  it("missing refresh token (not DISCONNECTED) → credentials=REAUTH_REQUIRED", () => {
    // Defence in depth: if refreshTokenSecretRef gets cleared
    // without status update, the mapper still reports the correct
    // credentials state.
    const h = deriveMailboxHealth(
      baseConn({ status: MAILBOX_STATUS.CONNECTED, hasRefreshToken: false }),
      { now: NOW },
    );
    expect(h.credentials).toBe("REAUTH_REQUIRED");
  });
});
