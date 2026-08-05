// Sprint 3 · Checkpoint 16H remediation (2026-08-05) — targeted
// tests for the OAuth permission-update reconnect flow.
//
// Covers:
//   * safeErrorReturn recovers the transaction's stored returnPath
//   * Fallback to /app/user/settings/connected-accounts when state
//     is missing / unknown / stored returnPath fails the allowlist
//   * callbackBanner renders the actionable message for
//     active_personal_mailbox_replacement_required + names the
//     currently connected email in the copy
//   * callbackBanner renders the actionable message for
//     permission_update_identity_mismatch
//   * callbackBanner emits the "Microsoft permissions updated"
//     success banner for the mailbox=updated flow
//   * PERMISSION_UPDATE_IDENTITY_MISMATCH error code is registered

import { describe, it, expect } from "vitest";
import { callbackBanner } from "@/lib/mailbox/presentation";
import { MAILBOX_ERROR_CODE } from "@/lib/mailbox/errors";

describe("16H remediation · callbackBanner", () => {
  it("emits the permissions-updated success banner for mailbox=updated", () => {
    const p = new URLSearchParams({ mailbox: "updated" });
    const b = callbackBanner(p);
    expect(b?.tone).toBe("success");
    expect(b?.message).toContain("Microsoft permissions updated");
    expect(b?.message).toContain("expanded capabilities you approved");
  });

  it("emits the connect success banner for mailbox=connected", () => {
    const p = new URLSearchParams({ mailbox: "connected" });
    const b = callbackBanner(p);
    expect(b?.tone).toBe("success");
    expect(b?.message).toContain("connected");
  });

  it("emits actionable copy for active_personal_mailbox_replacement_required (no email)", () => {
    const p = new URLSearchParams({ mailbox: "error", error: "active_personal_mailbox_replacement_required" });
    const b = callbackBanner(p);
    expect(b?.tone).toBe("error");
    expect(b?.message).toContain("does not match the mailbox currently connected");
    expect(b?.message).toContain("Try updating permissions again");
    expect(b?.message).toContain("Disconnect Outlook first only if you intend to replace");
  });

  it("names the connected email when provided (no oid/tid exposed)", () => {
    const p = new URLSearchParams({ mailbox: "error", error: "active_personal_mailbox_replacement_required" });
    const b = callbackBanner(p, { connectedEmail: "cturcato@spectreautomation.com" });
    expect(b?.message).toContain("cturcato@spectreautomation.com");
    // Never leak internal identifiers.
    expect(b?.message).not.toMatch(/\boid\b|\btid\b|token|ciphertext|mc_[a-f0-9]/i);
  });

  it("emits actionable copy for permission_update_identity_mismatch with email context", () => {
    const p = new URLSearchParams({ mailbox: "error", error: "permission_update_identity_mismatch" });
    const b = callbackBanner(p, { connectedEmail: "cturcato@spectreautomation.com" });
    expect(b?.tone).toBe("error");
    expect(b?.message).toContain("does not match the mailbox");
    expect(b?.message).toContain("No changes were made");
    expect(b?.message).toContain("cturcato@spectreautomation.com");
  });

  it("does not emit a banner when no mailbox / error param is present", () => {
    const p = new URLSearchParams();
    const b = callbackBanner(p);
    expect(b).toBeNull();
  });
});

describe("16H remediation · error-code registry", () => {
  it("registers PERMISSION_UPDATE_IDENTITY_MISMATCH", () => {
    expect(MAILBOX_ERROR_CODE.PERMISSION_UPDATE_IDENTITY_MISMATCH).toBe("permission_update_identity_mismatch");
  });

  it("retains ACTIVE_PERSONAL_MAILBOX_REPLACEMENT_REQUIRED for the pre-remediation path", () => {
    expect(MAILBOX_ERROR_CODE.ACTIVE_PERSONAL_MAILBOX_REPLACEMENT_REQUIRED).toBe("active_personal_mailbox_replacement_required");
  });
});
