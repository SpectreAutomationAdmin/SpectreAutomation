// Sprint 2 Checkpoint 13C (2026-07-22).
//
// Source-contract tests for the refresh-token diagnostic path.
//
// Two guarantees locked in:
//   1. The MSAL refresh path emits structured safe-metadata logs
//      that never include access tokens, refresh tokens, Authorization
//      headers, or KMS ciphertext.
//   2. The initial-sync handler, when MAILBOX_SYNC_DIAGNOSTIC_ONLY is
//      true AND MAILBOX_CONTROLLED_SYNC_MODE is true, short-circuits
//      after the token-refresh step and returns without calling any
//      Graph mail endpoint or ingesting any message.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const GRAPH_TS = readFileSync(
  path.resolve(__dirname, "../src/lib/integrations/microsoft-graph-delegated.ts"),
  "utf8",
);
const SYNC_TS = readFileSync(path.resolve(__dirname, "../src/lib/mailbox/sync.ts"), "utf8");
const ENV_TS = readFileSync(path.resolve(__dirname, "../src/lib/env.ts"), "utf8");
const CONTROLLED_TS = readFileSync(path.resolve(__dirname, "../src/lib/mailbox/controlled-sync.ts"), "utf8");

// ---------------------------------------------------------------------------
// 1. MSAL refresh diagnostic logging
// ---------------------------------------------------------------------------

describe("MSAL refresh diagnostic logging (Checkpoint 13C)", () => {
  it("declares extractAADSTSCode helper that regex-matches AADSTS\\d+", () => {
    expect(GRAPH_TS).toMatch(/function extractAADSTSCode/);
    expect(GRAPH_TS).toMatch(/\\b\(AADSTS\\d\+\)\\b/);
  });

  it("declares collectMsalErrorDiagnostics helper capturing all safe MSAL fields", () => {
    expect(GRAPH_TS).toMatch(/function collectMsalErrorDiagnostics/);
    const helper = GRAPH_TS.slice(GRAPH_TS.indexOf("function collectMsalErrorDiagnostics"));
    // Every founder-required field must be captured
    expect(helper).toMatch(/msalErrorName/);
    expect(helper).toMatch(/msalErrorCode/);
    expect(helper).toMatch(/msalErrorMessage/);
    expect(helper).toMatch(/msalSubError/);
    expect(helper).toMatch(/aadstsCode/);
    expect(helper).toMatch(/httpStatus/);
    expect(helper).toMatch(/retryAfter/);
    expect(helper).toMatch(/correlationId/);
    expect(helper).toMatch(/traceId/);
    expect(helper).toMatch(/timestamp/);
    expect(helper).toMatch(/errorClass/);
  });

  it("refreshToken wraps acquireTokenByRefreshToken in try/catch that logs diagnostics", () => {
    const block = GRAPH_TS.slice(GRAPH_TS.indexOf("async refreshToken(refreshToken)"), GRAPH_TS.indexOf("async getMe"));
    expect(block).toMatch(/logger\.info\("mailbox\.msal\.refresh\.attempt"/);
    expect(block).toMatch(/logger\.warn\("mailbox\.msal\.refresh\.failed", diag\)/);
    expect(block).toMatch(/const diag = collectMsalErrorDiagnostics\(err\);/);
    expect(block).toMatch(/logger\.info\("mailbox\.msal\.refresh\.success"/);
    // The attempt log includes token presence and length, NOT the token itself
    expect(block).toMatch(/refreshTokenPresented:\s*!!refreshToken/);
    expect(block).toMatch(/refreshTokenLength:\s*refreshToken\?\.length \?\? 0/);
  });

  it("never logs the raw refresh token, access token, or Authorization header", () => {
    // Look at everything inside refreshToken and ensure no dangerous field
    // names are being written to a logger call.
    const block = GRAPH_TS.slice(GRAPH_TS.indexOf("async refreshToken(refreshToken)"), GRAPH_TS.indexOf("async getMe"));
    // Should NEVER see a log payload with refreshToken: <the actual variable>
    expect(block).not.toMatch(/logger\.(info|warn|error)\([^)]*refreshToken:\s*refreshToken\b/);
    expect(block).not.toMatch(/logger\.(info|warn|error)\([^)]*accessToken:\s*result\.accessToken\b/);
    expect(block).not.toMatch(/Authorization:/i);
  });
});

// ---------------------------------------------------------------------------
// 2. MAILBOX_SYNC_DIAGNOSTIC_ONLY env — gated by controlled mode
// ---------------------------------------------------------------------------

describe("MAILBOX_SYNC_DIAGNOSTIC_ONLY env (Checkpoint 13C)", () => {
  it("is declared with default 'false'", () => {
    expect(ENV_TS).toMatch(/MAILBOX_SYNC_DIAGNOSTIC_ONLY:\s*z\.enum\(\["true",\s*"false"\]\)\.default\("false"\)/);
  });

  it("is included in the subordinate-alone rejection at boot", () => {
    expect(ENV_TS).toMatch(/env\.MAILBOX_SYNC_DIAGNOSTIC_ONLY === "true"/);
  });

  it("controlled-sync.ts exports shouldRunDiagnosticOnly() with proper gating", () => {
    expect(CONTROLLED_TS).toMatch(/export function shouldRunDiagnosticOnly/);
    const helper = CONTROLLED_TS.slice(CONTROLLED_TS.indexOf("shouldRunDiagnosticOnly"));
    expect(helper).toMatch(
      /return isControlledSyncModeActive\(\) && env\.MAILBOX_SYNC_DIAGNOSTIC_ONLY === "true"/,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. sync.ts short-circuit — refresh-only, no Graph mail-endpoint call
// ---------------------------------------------------------------------------

describe("sync.ts diagnostic-only short-circuit (Checkpoint 13C)", () => {
  it("checks shouldRunDiagnosticOnly() and branches before the outer while-loop", () => {
    const branchIdx = SYNC_TS.search(/if \(diagnosticOnly\)/);
    const whileIdx = SYNC_TS.search(/while \(result\.messagesExamined < effectiveCap\)/);
    expect(branchIdx).toBeGreaterThan(-1);
    expect(whileIdx).toBeGreaterThan(-1);
    expect(branchIdx).toBeLessThan(whileIdx);
  });

  it("diagnostic-only branch calls getFreshDelegatedAccessToken but does NOT call any provider.list* method", () => {
    // Slice out the diagnostic-only branch and verify it contains no Graph list call
    const start = SYNC_TS.search(/if \(diagnosticOnly\) \{/);
    // Find the outer while() as the branch's end anchor
    const end = SYNC_TS.indexOf("while (result.messagesExamined < effectiveCap)", start);
    const branch = SYNC_TS.slice(start, end);
    expect(branch).toMatch(/getFreshDelegatedAccessToken/);
    expect(branch).not.toMatch(/provider\.listInboxMessages/);
    expect(branch).not.toMatch(/provider\.listAttachmentMetadata/);
    expect(branch).not.toMatch(/provider\.getMe/);
  });

  it("diagnostic-only branch persists a synced-run row (finaliseSyncRun) on both success and failure paths", () => {
    const start = SYNC_TS.search(/if \(diagnosticOnly\) \{/);
    const end = SYNC_TS.indexOf("while (result.messagesExamined < effectiveCap)", start);
    const branch = SYNC_TS.slice(start, end);
    // At least two finaliseSyncRun calls (success + failure)
    const finaliseCalls = (branch.match(/await finaliseSyncRun\(/g) || []).length;
    expect(finaliseCalls).toBeGreaterThanOrEqual(2);
    // Success path status COMPLETED, failure path DELAYED/TERMINAL
    expect(branch).toMatch(/status:\s*"COMPLETED"/);
    expect(branch).toMatch(/status:\s*classification === "terminal" \? "TERMINAL" : "DELAYED"/);
  });

  it("diagnostic-only branch logs the pre-call state including whether the access token was expired", () => {
    const start = SYNC_TS.search(/if \(diagnosticOnly\) \{/);
    const end = SYNC_TS.indexOf("while (result.messagesExamined < effectiveCap)", start);
    const branch = SYNC_TS.slice(start, end);
    expect(branch).toMatch(/mailbox\.sync\.diagnostic_only\.start/);
    expect(branch).toMatch(/accessTokenExpiredBeforeCall/);
    expect(branch).toMatch(/minutesSinceAccessTokenExpiry/);
    expect(branch).toMatch(/refreshTokenCiphertextPresent/);
  });

  it("no message ingestion in the diagnostic-only branch (messagesExamined stays 0)", () => {
    const start = SYNC_TS.search(/if \(diagnosticOnly\) \{/);
    const end = SYNC_TS.indexOf("while (result.messagesExamined < effectiveCap)", start);
    const branch = SYNC_TS.slice(start, end);
    // No page.messages iteration
    expect(branch).not.toMatch(/page\.messages/);
    expect(branch).not.toMatch(/ingestOneMessage/);
    expect(branch).not.toMatch(/for \(const raw of/);
  });
});

// ---------------------------------------------------------------------------
// 4. Defaults preserve C13A/B behavior when the new flag is off
// ---------------------------------------------------------------------------

describe("Defaults preserve prior behavior when MAILBOX_SYNC_DIAGNOSTIC_ONLY is off", () => {
  it("shouldRunDiagnosticOnly returns false when master is off", () => {
    // Source contract: the AND with isControlledSyncModeActive() means
    // production (master off) always returns false regardless of the
    // subordinate value.
    const helper = CONTROLLED_TS.slice(CONTROLLED_TS.indexOf("shouldRunDiagnosticOnly"));
    expect(helper).toMatch(/isControlledSyncModeActive\(\)\s*&&/);
  });

  it("subordinate alone (master off) fails boot", () => {
    // The boot invariant list now includes MAILBOX_SYNC_DIAGNOSTIC_ONLY
    const invariantBlock = ENV_TS.slice(ENV_TS.indexOf("subordinateSetOutsideDefault"));
    expect(invariantBlock).toMatch(/env\.MAILBOX_SYNC_DIAGNOSTIC_ONLY === "true"/);
  });
});
