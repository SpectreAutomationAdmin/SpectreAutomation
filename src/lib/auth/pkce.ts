// SIGNUP-1 (2026-10-19) — shared PKCE / OAuth-state helpers.
//
// Previously only used by mailbox/connect.ts; extracted here so the
// SIGNUP-1 Microsoft identity-only flow can reuse the exact same
// primitives.  See mailbox/connect.ts for the identical functions
// still in use there — they are kept locally for backwards
// compatibility and will be migrated to these shared primitives in a
// later cleanup.
//
// All random values are drawn from Node's crypto.randomBytes.
// base64url is the OAuth-safe URL-friendly encoding (RFC 7636).

import { createHash, randomBytes } from "node:crypto";

export function base64url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function generateOpaqueToken(byteLength = 32): string {
  return base64url(randomBytes(byteLength));
}

export function sha256HashHex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function pkceVerifier(): string {
  // RFC 7636 §4.1 — 43..128 chars.  32 random bytes → 43 chars base64url.
  return base64url(randomBytes(32));
}

export function pkceChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

export function oauthState(): string {
  return base64url(randomBytes(32));
}

export function oauthNonce(): string {
  return base64url(randomBytes(24));
}
