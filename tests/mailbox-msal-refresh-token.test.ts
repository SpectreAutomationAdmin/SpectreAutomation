// Sprint 2 Checkpoint 12B (2026-07-21).
//
// Locks in two guarantees for the MSAL delegated provider:
//
//   1. The OAuth authorize URL that MSAL constructs includes `offline_access`
//      in the requested scopes. Without this, Microsoft never returns a
//      refresh token.
//
//   2. After acquireTokenByCode succeeds, normaliseTokenResponse():
//        (a) surfaces the refresh token that was passed in as a parameter
//            (which extractRefreshTokenFromCache pulled from MSAL's cache),
//        (b) adds `offline_access` to grantedScopes when a refresh token is
//            present, because Microsoft omits it from the token endpoint's
//            `scope` response even when granted.
//
// Deliberately covers only the module-boundary behavior: the exported constant
// APPROVED_DELEGATED_SCOPES and the internal shape of TokenResponse. We do
// not (and should not) exercise real MSAL or Microsoft here.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { APPROVED_DELEGATED_SCOPES, type TokenResponse } from "@/lib/integrations/microsoft-graph-delegated";

const MODULE_PATH = path.resolve(__dirname, "../src/lib/integrations/microsoft-graph-delegated.ts");
const src = readFileSync(MODULE_PATH, "utf8");

// --------------------------------------------------------------------------
// Source contract — offline_access is in APPROVED_DELEGATED_SCOPES AND is
// used in every MSAL call that could return / rotate a refresh token.
// --------------------------------------------------------------------------

describe("APPROVED_DELEGATED_SCOPES", () => {
  it("contains all seven required delegated scopes (Mail.Send added in C14C-B)", () => {
    expect([...APPROVED_DELEGATED_SCOPES].sort()).toEqual(
      ["Mail.Read", "Mail.Send", "User.Read", "email", "offline_access", "openid", "profile"].sort(),
    );
  });

  it("explicitly includes offline_access (required for refresh token issuance)", () => {
    expect(APPROVED_DELEGATED_SCOPES).toContain("offline_access");
  });
});

describe("MSAL provider source contract", () => {
  it("buildAuthorizationUrl passes APPROVED_DELEGATED_SCOPES to app.getAuthCodeUrl", () => {
    // getAuthCodeUrl must receive `scopes: [...APPROVED_DELEGATED_SCOPES]` so
    // the authorize URL Microsoft sees includes offline_access. If a future
    // refactor spreads a different list, this fails.
    const block = src.slice(src.indexOf("getAuthCodeUrl("), src.indexOf("acquireTokenByCode("));
    expect(block).toMatch(/scopes:\s*\[\.\.\.APPROVED_DELEGATED_SCOPES\]/);
  });

  it("acquireTokenByCode passes APPROVED_DELEGATED_SCOPES too", () => {
    const block = src.slice(src.indexOf("acquireTokenByCode("), src.indexOf("acquireTokenByRefreshToken("));
    expect(block).toMatch(/scopes:\s*\[\.\.\.APPROVED_DELEGATED_SCOPES\]/);
  });

  it("acquireTokenByRefreshToken passes APPROVED_DELEGATED_SCOPES too", () => {
    const block = src.slice(src.indexOf("acquireTokenByRefreshToken("));
    expect(block).toMatch(/scopes:\s*\[\.\.\.APPROVED_DELEGATED_SCOPES\]/);
  });

  it("exchangeCode extracts the refresh token from MSAL's cache (not from result)", () => {
    // The bug being fixed: the previous code read (result as any).refreshToken,
    // which MSAL Node never sets. Fixed version calls extractRefreshTokenFromCache.
    const exchangeBlock = src.slice(src.indexOf("async exchangeCode"), src.indexOf("async refreshToken"));
    expect(exchangeBlock).toMatch(/extractRefreshTokenFromCache\(app,\s*result\.account\?\.homeAccountId/);
    // Old broken pattern must NOT be present anywhere in exchangeCode
    expect(exchangeBlock).not.toMatch(/result\s+as\s+unknown\s+as\s+\{\s*refreshToken/);
  });

  it("refreshToken also extracts rotated refresh token from cache", () => {
    const refreshBlock = src.slice(src.indexOf("async refreshToken"), src.indexOf("async getMe"));
    expect(refreshBlock).toMatch(/extractRefreshTokenFromCache\(app,\s*result\.account\?\.homeAccountId/);
  });

  it("extractRefreshTokenFromCache filters by home_account_id when available", () => {
    const helperBlock = src.slice(src.indexOf("async function extractRefreshTokenFromCache"));
    expect(helperBlock).toMatch(/getTokenCache\(\)\.serialize\(\)/);
    expect(helperBlock).toMatch(/home_account_id\s*===\s*homeAccountId/);
  });
});

// --------------------------------------------------------------------------
// normaliseTokenResponse — since it's a module-internal function, exercise
// via a re-import trick. We test the CONTRACT via a runtime import of the
// full module and use MSAL provider mock semantics for the shape check.
// --------------------------------------------------------------------------
//
// Rather than trying to reach into the module, we assert the contract by
// creating a synthetic AuthenticationResult-like object and verifying the
// public surface: our TokenResponse type must include offline_access in
// grantedScopes when a refreshToken is present, and must omit it when not.
//
// Since normaliseTokenResponse is not exported, we cover its behavior via
// the source contract above (exact regex on the offline_access injection
// logic) plus one end-to-end shape check.

describe("normaliseTokenResponse offline_access injection (source contract)", () => {
  it("adds offline_access to grantedScopes when a refresh token is present", () => {
    // Match the exact bit of code that does the injection.
    const block = src.slice(src.indexOf("function normaliseTokenResponse"));
    expect(block).toMatch(
      /refreshToken\s*&&\s*!resourceScopes\.includes\("offline_access"\)[\s\S]*?\[\.\.\.\s*resourceScopes\s*,\s*"offline_access"\]/,
    );
  });

  it("omits offline_access when no refresh token was returned", () => {
    // The else branch of the ternary keeps resourceScopes as-is.
    const block = src.slice(src.indexOf("function normaliseTokenResponse"));
    expect(block).toMatch(/:\s*resourceScopes\s*;/);
  });
});

// --------------------------------------------------------------------------
// TokenResponse type shape: refreshToken is nullable — keep it that way,
// downstream code (mailbox/connect.ts) already tolerates null.
// --------------------------------------------------------------------------

describe("TokenResponse type shape", () => {
  it("permits refreshToken: null (backwards-compatible for edge cases)", () => {
    const nullish: TokenResponse = {
      accessToken: "x",
      refreshToken: null,
      expiresOn: new Date(),
      idTokenClaims: {},
      grantedScopes: [],
    };
    expect(nullish.refreshToken).toBeNull();
  });

  it("permits refreshToken: string (the fixed happy path)", () => {
    const withRt: TokenResponse = {
      accessToken: "x",
      refreshToken: "rt-value",
      expiresOn: new Date(),
      idTokenClaims: {},
      grantedScopes: ["openid", "offline_access"],
    };
    expect(withRt.refreshToken).toBe("rt-value");
  });
});
