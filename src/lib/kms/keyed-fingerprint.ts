// HR mobile-hotfix (2026-08-30) — Keyed deterministic fingerprint
// helper for duplicate detection over sensitive identifiers (SIN,
// banking).
//
// Why HMAC (and not plain SHA-256): the SIN keyspace is small
// (10⁹ possible values) and easily brute-forced from an unsalted
// SHA-256. HMAC with a per-deployment secret means a fingerprint
// leak (e.g. through a downstream index dump) cannot be reversed
// to the original SIN without also stealing the HMAC key.
//
// Why deterministic (and not per-row salt): we need equality
// lookup — two employees with the same SIN produce the same
// fingerprint so the database uniqueness constraint fires. A
// per-row salt would defeat the purpose. This is a legitimate
// trade-off the founder brief §11 explicitly directs.
//
// Key management (§27):
//   * Dedicated env var: `SPECTRE_HR_FINGERPRINT_KEY` (production).
//   * Dev fallback: derived deterministically from
//     `SPECTRE_LOCAL_KMS_KEY` so unit tests + dev environments have
//     a stable key without extra config.
//   * The key is NEVER returned to the browser / logged / exposed
//     in audits or error responses.
//
// This module has no dependency on the KMS provider abstraction —
// fingerprinting is a keyed hash, not an encryption round-trip.

import { createHash, createHmac } from "node:crypto";

/**
 * Resolve the fingerprint key. Production must set
 * `SPECTRE_HR_FINGERPRINT_KEY`; dev/test derives from the local
 * KMS key so the same fixtures work across the suite.
 *
 * Deliberately does NOT throw when the env var is unset — the
 * derived-from-local fallback exists precisely so a fresh
 * developer clone works out of the box. Production deployments
 * MUST set `SPECTRE_HR_FINGERPRINT_KEY` (Fly secrets).
 */
function resolveFingerprintKey(): Buffer {
  const dedicated = process.env.SPECTRE_HR_FINGERPRINT_KEY;
  if (dedicated && dedicated.trim().length > 0) {
    return createHash("sha256").update(dedicated).digest();
  }
  const localRaw = process.env.SPECTRE_LOCAL_KMS_KEY ??
    "spectre-local-kms-development-only-key-do-not-use-in-production";
  // Derive a distinct subkey so a leak of one doesn't compromise
  // the other. The `HR-FINGERPRINT-V1` domain-separator preserves
  // the option of rotating fingerprint-key derivations later.
  return createHash("sha256").update(`HR-FINGERPRINT-V1:${localRaw}`).digest();
}

/**
 * Deterministic HMAC-SHA256 fingerprint. Returns lowercase hex.
 * The returned string is safe to store + index, but MUST NOT be
 * returned to the browser or logged in cleartext audit fields
 * — treat it as a sensitive derived identifier.
 */
export function keyedFingerprint(normalisedInput: string): string {
  const key = resolveFingerprintKey();
  return createHmac("sha256", key).update(normalisedInput).digest("hex");
}

// ---------------------------------------------------------------------------
// SIN normalisation
// ---------------------------------------------------------------------------

/**
 * Canonical SIN normalisation. Strips spaces and hyphens, validates
 * exactly 9 digits. Throws if the input is not a valid CRA-shaped SIN.
 * Used by both the encryption path and the fingerprint path so
 * "123 456 789", "123-456-789", "123456789" all produce the same
 * fingerprint.
 */
export function normaliseSin(input: string): string {
  const stripped = input.replace(/[\s-]/g, "");
  if (!/^\d{9}$/.test(stripped)) {
    throw new Error("Invalid SIN: expected 9 digits after removing spaces + hyphens.");
  }
  return stripped;
}

export function sinFingerprint(sin: string): string {
  return keyedFingerprint(`SIN-CA-V1:${normaliseSin(sin)}`);
}

// ---------------------------------------------------------------------------
// Banking normalisation (Canadian institution/transit/account triple)
// ---------------------------------------------------------------------------

export interface BankTriple {
  institution: string;
  transit: string;
  account: string;
}

/**
 * Canonical Canadian banking triple normalisation:
 *   * institution: exactly 3 digits
 *   * transit:     exactly 5 digits
 *   * account:     7-12 digits
 * Strips spaces and hyphens before validation so "003-12345-987654321"
 * and "003 12345 987654321" and "003 / 12345 / 987654321" all
 * fingerprint identically. Throws on invalid triples.
 */
export function normaliseBankTriple(t: BankTriple): { institution: string; transit: string; account: string } {
  const strip = (v: string) => v.replace(/[\s/\-]/g, "");
  const institution = strip(t.institution);
  const transit = strip(t.transit);
  const account = strip(t.account);
  if (!/^\d{3}$/.test(institution)) throw new Error("Invalid institution number: expected 3 digits.");
  if (!/^\d{5}$/.test(transit)) throw new Error("Invalid transit number: expected 5 digits.");
  if (!/^\d{7,12}$/.test(account)) throw new Error("Invalid account number: expected 7-12 digits.");
  return { institution, transit, account };
}

export function bankFingerprint(t: BankTriple): string {
  const { institution, transit, account } = normaliseBankTriple(t);
  return keyedFingerprint(`BANK-CA-V1:${institution}:${transit}:${account}`);
}
