// Sprint 2 B2 (2026-07-19) — Pure unit tests for the mailbox module.
// No Prisma, no MSAL. Everything below is a direct assertion on the
// contract of status.ts / errors.ts / audit.ts.

import { describe, it, expect } from "vitest";
import {
  MAILBOX_STATUS,
  MAILBOX_STATUS_TRANSITIONS,
  assertMailboxStatusTransition,
  InvalidMailboxStatusTransition,
  isTerminalStatus,
} from "@/lib/mailbox/status";
import { classifyMsalError, MAILBOX_ERROR_CODE, MailboxFlowError } from "@/lib/mailbox/errors";
import { sanitiseAuditMeta } from "@/lib/mailbox/audit";

describe("mailbox status transitions", () => {
  it("every source status is present in the transition map", () => {
    for (const s of Object.values(MAILBOX_STATUS)) {
      expect(MAILBOX_STATUS_TRANSITIONS[s]).toBeDefined();
    }
  });

  it("REAUTH_REQUIRED can only lead to CONNECTED_PENDING_SYNC or DISCONNECTED", () => {
    expect([...MAILBOX_STATUS_TRANSITIONS.REAUTH_REQUIRED]).toEqual([
      "CONNECTED_PENDING_SYNC",
      "DISCONNECTED",
    ]);
  });

  it("DISCONNECTED can only lead back through CONNECTED_PENDING_SYNC (reconnect)", () => {
    expect([...MAILBOX_STATUS_TRANSITIONS.DISCONNECTED]).toEqual(["CONNECTED_PENDING_SYNC"]);
  });

  it("assertMailboxStatusTransition throws on illegal transitions", () => {
    expect(() => assertMailboxStatusTransition("DISCONNECTED", "CONNECTED")).toThrow(
      InvalidMailboxStatusTransition,
    );
    expect(() => assertMailboxStatusTransition("REAUTH_REQUIRED", "DELAYED")).toThrow();
    expect(() => assertMailboxStatusTransition("CONNECTED", "CONNECTED")).not.toThrow();
  });

  it("isTerminalStatus flags only REAUTH_REQUIRED and DISCONNECTED", () => {
    expect(isTerminalStatus("REAUTH_REQUIRED")).toBe(true);
    expect(isTerminalStatus("DISCONNECTED")).toBe(true);
    expect(isTerminalStatus("CONNECTED")).toBe(false);
    expect(isTerminalStatus("CONNECTED_PENDING_SYNC")).toBe(false);
    expect(isTerminalStatus("DELAYED")).toBe(false);
    expect(isTerminalStatus("ERROR")).toBe(false);
  });
});

describe("classifyMsalError", () => {
  it("classifies invalid_grant as terminal", () => {
    expect(classifyMsalError({ errorCode: "invalid_grant" })).toBe("terminal");
  });
  it("classifies consent_required as terminal", () => {
    expect(classifyMsalError({ errorCode: "consent_required" })).toBe("terminal");
  });
  it("classifies interaction_required as terminal", () => {
    expect(classifyMsalError({ errorCode: "interaction_required" })).toBe("terminal");
  });
  it("classifies 429 as retryable", () => {
    expect(classifyMsalError({ response: { status: 429 } })).toBe("retryable");
  });
  it("classifies 503 as retryable", () => {
    expect(classifyMsalError({ response: { status: 503 } })).toBe("retryable");
  });
  it("classifies 400 with unknown code as terminal (defensive)", () => {
    expect(classifyMsalError({ response: { status: 400 } })).toBe("terminal");
  });
  it("classifies unknown errors as retryable (default)", () => {
    expect(classifyMsalError({})).toBe("retryable");
    expect(classifyMsalError(new Error("network hiccup"))).toBe("retryable");
  });
  it("classifies token-expired sub-error as terminal", () => {
    expect(classifyMsalError({ subError: "token_expired" })).toBe("terminal");
  });
});

describe("MailboxFlowError", () => {
  it("carries a machine-readable code and safe context", () => {
    const err = new MailboxFlowError(MAILBOX_ERROR_CODE.OAUTH_STATE_REPLAY, { transactionId: "t_1" });
    expect(err.code).toBe("oauth_state_replay");
    expect(err.context.transactionId).toBe("t_1");
    expect(err.message).toContain("oauth_state_replay");
  });
});

describe("sanitiseAuditMeta — token material stripped, safe metadata kept", () => {
  it("removes tokens by field name", () => {
    const meta = {
      accessToken: "at_secret",
      access_token: "at_secret",
      refreshToken: "rt_secret",
      refresh_token: "rt_secret",
      idToken: "id_secret",
      authorizationCode: "auth_secret",
      code: "auth_secret",
      pkceVerifier: "verifier_secret",
      code_verifier: "verifier_secret",
      nonce: "nonce_secret",
      state: "state_secret",
      clientState: "clientstate_secret",
      client_secret: "cs_secret",
      microsoftTenantId: "tenant_abc",
      connectedEmail: "user@corp.com",
      errorCode: "oauth_denied_by_user",
    };
    const out = sanitiseAuditMeta(meta);
    // Every forbidden key gone
    for (const k of [
      "accessToken",
      "access_token",
      "refreshToken",
      "refresh_token",
      "idToken",
      "authorizationCode",
      "code",
      "pkceVerifier",
      "code_verifier",
      "nonce",
      "state",
      "clientState",
      "client_secret",
    ]) {
      expect(out[k]).toBeUndefined();
    }
    // Safe fields kept
    expect(out.microsoftTenantId).toBe("tenant_abc");
    expect(out.connectedEmail).toBe("user@corp.com");
    expect(out.errorCode).toBe("oauth_denied_by_user");
  });

  it("removes secret-shaped values by heuristic even when the field name is innocent", () => {
    const meta = {
      notes: "This is a regular sentence with spaces",
      // GUIDs / dashed IDs are ALLOWED — real tenant + user ids need
      // to survive sanitisation for the audit to be useful.
      microsoftTenantId: "00000000-0000-0000-0000-tenant00abc0",
      // Long compact base64url — matches the heuristic and gets dropped.
      customField: "ABCdef0123456789_.~=+/abcdefghijklmnopqrstuvwxyzWXYZ0123",
    };
    const out = sanitiseAuditMeta(meta);
    expect(out.notes).toBe("This is a regular sentence with spaces");
    expect(out.microsoftTenantId).toBe("00000000-0000-0000-0000-tenant00abc0");
    expect(out.customField).toBeUndefined();
  });

  it("recurses into nested objects", () => {
    const meta = {
      microsoftTenantId: "tenant_ok",
      raw: { accessToken: "leaked", nested: { refresh_token: "leaked" } },
    };
    const out = sanitiseAuditMeta(meta);
    const rawOut = out.raw as Record<string, unknown>;
    expect(rawOut.accessToken).toBeUndefined();
    const nested = rawOut.nested as Record<string, unknown>;
    expect(nested.refresh_token).toBeUndefined();
  });
});
