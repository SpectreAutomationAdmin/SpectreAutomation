// HR-2B.3 tail (2026-08-20) — invitation delivery classification.
//
// Pure-function tests for `classifyDeliveryResult`. These pin the
// exact rule set the invitation route depends on:
//
//   dev/console adapter mode           → DEV_LOGGED
//   any provider + messageId "dev-*"   → DEV_LOGGED (defence-in-depth)
//   real provider + status "SENT"      → DELIVERED
//   real provider + non-SENT / error   → FAILED
//
// The founder invariant these enforce: the invitation route never
// treats a console-only send as if it were external delivery.

import { describe, it, expect } from "vitest";
import { classifyDeliveryResult } from "@/lib/hr/invitation-email";

describe("HR invitation delivery classification", () => {
  it("console mode always classifies as DEV_LOGGED regardless of returned status", async () => {
    const r = classifyDeliveryResult("console", { status: "SENT", providerMessageId: "dev-12345" });
    expect(r.status).toBe("DEV_LOGGED");
    expect(r.provider).toBe("console");
    expect(r.externalSendConfirmed).toBe(false);
    expect(r.failureReason).toBeNull();
  });

  it("dev-* messageId prefix classifies as DEV_LOGGED even if the adapter mode says smtp — defence-in-depth", async () => {
    // A misconfigured smtp adapter that inadvertently used the dev
    // adapter under the hood must still be classified as DEV_LOGGED.
    const r = classifyDeliveryResult("smtp", { status: "SENT", providerMessageId: "dev-999" });
    expect(r.status).toBe("DEV_LOGGED");
    expect(r.externalSendConfirmed).toBe(false);
  });

  it("real provider + SENT + non-dev messageId classifies as DELIVERED", async () => {
    const r = classifyDeliveryResult("ses", {
      status: "SENT",
      providerMessageId: "0100018e0f8a4b7c-abcdef-000000",
    });
    expect(r.status).toBe("DELIVERED");
    expect(r.provider).toBe("ses");
    expect(r.externalSendConfirmed).toBe(true);
    expect(r.failureReason).toBeNull();
  });

  it("real provider + FAILED classifies as FAILED with the reason preserved", async () => {
    const r = classifyDeliveryResult("smtp", {
      status: "FAILED",
      failureReason: "554 5.7.1 relay access denied",
    });
    expect(r.status).toBe("FAILED");
    expect(r.provider).toBe("smtp");
    expect(r.externalSendConfirmed).toBe(false);
    expect(r.failureReason).toBe("554 5.7.1 relay access denied");
  });

  it("real provider returning unknown status (not SENT) classifies as FAILED", async () => {
    const r = classifyDeliveryResult("microsoft365", { status: "REJECTED" });
    expect(r.status).toBe("FAILED");
    expect(r.provider).toBe("microsoft365");
    expect(r.failureReason).toBe("REJECTED");
  });

  it("no messageId + SENT + real provider still classifies as DELIVERED (some providers don't return a messageId)", async () => {
    const r = classifyDeliveryResult("smtp", { status: "SENT" });
    expect(r.status).toBe("DELIVERED");
    expect(r.externalSendConfirmed).toBe(true);
    expect(r.providerMessageId).toBeNull();
  });
});
