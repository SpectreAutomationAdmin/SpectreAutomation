// Sprint 2 B3 (2026-07-19) — Presentation mapper unit tests.
//
// Pin the visible outcome for every backend status. Adding a new
// status without updating this test is a signal that the mapper's
// "fail closed" default is being relied on unintentionally — which
// the founder's directive explicitly requires as a fallback but not
// as a design choice.

import { describe, it, expect } from "vitest";
import {
  presentConnection,
  notConnectedPresentation,
  callbackBanner,
  CONNECTION_ACTION,
} from "@/lib/mailbox/presentation";
import { MAILBOX_STATUS } from "@/lib/mailbox/status";

describe("presentConnection — one row per backend status", () => {
  it("null → Not connected + Connect primary action", () => {
    const p = presentConnection(null);
    expect(p.badgeLabel).toBe("Not connected");
    expect(p.primaryAction?.key).toBe(CONNECTION_ACTION.CONNECT);
    expect(p.showIdentity).toBe(false);
  });

  it("CONNECTING → transient info state", () => {
    const p = presentConnection(MAILBOX_STATUS.CONNECTING);
    expect(p.badgeTone).toBe("info");
    expect(p.showIdentity).toBe(false);
  });

  it("CONNECTED_PENDING_SYNC → Connected — awaiting sync + Disconnect only", () => {
    const p = presentConnection(MAILBOX_STATUS.CONNECTED_PENDING_SYNC);
    expect(p.badgeLabel).toBe("Connected — awaiting sync");
    expect(p.primaryAction).toBeUndefined();
    expect(p.secondaryAction?.key).toBe(CONNECTION_ACTION.DISCONNECT);
    expect(p.showIdentity).toBe(true);
    expect(p.showVisibility).toBe(true);
    // No last-sync line before B4.
    expect(p.showLastSync).toBe(false);
  });

  it("CONNECTED → success badge + Sync now enabled + Disconnect", () => {
    const p = presentConnection(MAILBOX_STATUS.CONNECTED);
    expect(p.badgeTone).toBe("success");
    expect(p.primaryAction?.key).toBe(CONNECTION_ACTION.SYNC_NOW);
    // Sprint 2 B4 (2026-07-19) — Sync now is now enabled. The
    // disabled-reason string in presentation.ts is intentionally
    // kept behind a nullable const so a future outage can flip
    // Sync back to disabled without a component-level edit.
    expect(p.primaryAction?.disabledReason).toBeUndefined();
    expect(p.secondaryAction?.key).toBe(CONNECTION_ACTION.DISCONNECT);
    expect(p.showLastSync).toBe(true);
  });

  it("DELAYED → warning + retry sync enabled", () => {
    const p = presentConnection(MAILBOX_STATUS.DELAYED);
    expect(p.badgeTone).toBe("warning");
    expect(p.primaryAction?.disabledReason).toBeUndefined();
  });

  it("REAUTH_REQUIRED → warning + Reconnect primary + Disconnect secondary", () => {
    const p = presentConnection(MAILBOX_STATUS.REAUTH_REQUIRED);
    expect(p.badgeTone).toBe("warning");
    expect(p.primaryAction?.key).toBe(CONNECTION_ACTION.RECONNECT);
    expect(p.primaryAction?.disabledReason).toBeUndefined();
  });

  it("DISCONNECTED → neutral + Reconnect primary, no Disconnect", () => {
    const p = presentConnection(MAILBOX_STATUS.DISCONNECTED);
    expect(p.badgeTone).toBe("neutral");
    expect(p.primaryAction?.key).toBe(CONNECTION_ACTION.RECONNECT);
    expect(p.secondaryAction).toBeUndefined();
    expect(p.showVisibility).toBe(false);
  });

  it("ERROR → error tone + Reconnect primary + Disconnect secondary", () => {
    const p = presentConnection(MAILBOX_STATUS.ERROR);
    expect(p.badgeTone).toBe("error");
    expect(p.primaryAction?.key).toBe(CONNECTION_ACTION.RECONNECT);
    expect(p.secondaryAction?.key).toBe(CONNECTION_ACTION.DISCONNECT);
  });

  it("unknown status fails closed to ERROR presentation (no leaked string)", () => {
    const p = presentConnection("MYSTERY_STATE_FROM_THE_FUTURE" as never);
    expect(p.badgeTone).toBe("error");
    expect(p.explanation).not.toContain("MYSTERY_STATE_FROM_THE_FUTURE");
    // Reconnect is the safe universal escape hatch from an unknown state.
    expect(p.primaryAction?.key).toBe(CONNECTION_ACTION.RECONNECT);
  });
});

describe("notConnectedPresentation", () => {
  it("advertises the read-only scope in the explanation", () => {
    const p = notConnectedPresentation();
    expect(p.explanation.toLowerCase()).toContain("not send email");
    // "modify your mailbox" is the exact copy that documents the
    // read-only guarantee. Assert it verbatim so a well-meaning
    // copy edit does not silently drop the disclaimer.
    expect(p.explanation.toLowerCase()).toContain("modify your mailbox");
    expect(p.primaryAction?.key).toBe(CONNECTION_ACTION.CONNECT);
  });
});

describe("callbackBanner — one-time result messages", () => {
  it("returns null when no known query params are set", () => {
    expect(callbackBanner(new URLSearchParams())).toBeNull();
  });
  it("renders a success message on ?mailbox=connected", () => {
    const b = callbackBanner(new URLSearchParams("mailbox=connected"));
    expect(b?.tone).toBe("success");
    expect(b?.message.toLowerCase()).toContain("connected");
  });
  it("translates known error codes to plain language", () => {
    const b = callbackBanner(new URLSearchParams("mailbox=error&error=oauth_denied_by_user"));
    expect(b?.tone).toBe("error");
    expect(b?.message.toLowerCase()).toContain("declined");
  });
  it("falls through to a generic message for unknown error codes", () => {
    const b = callbackBanner(new URLSearchParams("mailbox=error&error=totally_unknown_code"));
    expect(b?.tone).toBe("error");
    expect(b?.message.toLowerCase()).toContain("try again");
  });
});
