// EP-TRAIN-4Y-B-IMPL (2026-11-07) — deterministic JSON canonicaliser.
//
// Produces byte-identical output for logically equivalent JSON values
// regardless of key order. Lifted from the EP-TRAIN-6C-11 operator
// runner (`scratchpad/ep-train-6b/gen/generate-lite-run.mjs:33-38`)
// with ASCII-only enforcement on auth-envelope scope / operation /
// requestId strings. The em-dash incident in 6C-11 §4.2 — an em-dash
// in `pilotAuthorization.scope` broke canonicalisation across the
// Node/Python boundary — motivates the strict ASCII guard.
//
// Byte-identical to 6C-11 fixtures is a hard requirement: the
// response-HMAC key is shared with the Modal workspace secret
// `spectre-training-runtime-hmac` and signatures are computed on
// both sides. Any divergence from 6C-11's output is a protocol
// break.

/**
 * Canonical JSON serialisation.
 *
 * - Object keys sorted lexicographically (ascending).
 * - No whitespace around separators.
 * - Arrays preserve element order.
 * - Primitives via `JSON.stringify` (handles string escaping,
 *   Infinity / NaN via throw — see note below).
 *
 * Throws:
 *   - `TypeError` if a numeric field is `NaN` or `±Infinity`.
 *   - `TypeError` on a BigInt or Symbol (not representable in JSON).
 *
 * Identical byte-level output to the 6C-11 runner. Verified by the
 * shared fixture test in `tests/ep-train-4yb-impl-canonicalise.test.ts`.
 */
export function canonicalise(value: unknown): string {
  if (typeof value === "bigint") {
    throw new TypeError("canonicalise: BigInt is not JSON-serialisable.");
  }
  if (typeof value === "symbol") {
    throw new TypeError("canonicalise: Symbol is not JSON-serialisable.");
  }
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError(`canonicalise: non-finite number ${value}.`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalise(item)).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map((k) => {
    const v = (value as Record<string, unknown>)[k];
    return JSON.stringify(k) + ":" + canonicalise(v);
  });
  return "{" + parts.join(",") + "}";
}

/**
 * The 6C-11 em-dash lesson: certain string fields in the auth
 * envelope cross the Node → Modal Python boundary and are compared
 * byte-for-byte on both sides. A character outside the printable
 * ASCII range (0x20-0x7E) can serialise differently across
 * implementations (UTF-8 vs UTF-16 escape forms). ASCII-only
 * enforcement prevents that class of bug entirely.
 *
 * Applies to:
 *   - `operation` (both envelope + request-signing)
 *   - `requestId` (opaque nonce; ASCII hex / base32 recommended)
 *   - `PilotAuthorizationV1.scope`
 *   - `PilotAuthorizationV1.issuedBy`
 *   - `PilotAuthorizationV1.authorizationId`
 *
 * Does NOT apply to user content like `questionText`, `transcript`,
 * `explanation` — those legitimately carry Unicode.
 */
export function assertPrintableAscii(
  field: string,
  value: string,
): void {
  if (typeof value !== "string") {
    throw new TypeError(`assertPrintableAscii: ${field} is not a string.`);
  }
  // Allow printable ASCII only. Reject control characters, DEL,
  // and anything outside 0x20-0x7E.
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      throw new TypeError(
        `assertPrintableAscii: ${field} contains non-ASCII character at index ${i} (code ${code}).`,
      );
    }
  }
}

/**
 * SHA-256 of canonicalised JSON, lower-case hex. Exported for both
 * client-side body-digest computation and server-side verification.
 */
export async function sha256HexOfCanonical(value: unknown): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(canonicalise(value), "utf-8").digest("hex");
}

/**
 * Synchronous variant for environments where `createHash` import
 * is top-level (Node.js). Same output as `sha256HexOfCanonical`.
 */
export function sha256HexOfCanonicalSync(value: unknown): string {
  // Lazy require to keep this module ESM-friendly.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(canonicalise(value), "utf-8").digest("hex");
}
