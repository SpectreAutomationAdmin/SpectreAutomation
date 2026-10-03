// MEM-HIST-1 §G / §10 (2026-10-03) — deterministic sanitization helper.
//
// PRIVACY CONTRACT (hard)
//   The real Jonas Member Master MUST NEVER be read by Spectre
//   staging. The founder keeps the real workbook on their own
//   machine. This helper exists for the founder (or their local
//   script) to run OUTSIDE the Spectre repo — it produces
//   deterministic synthetic identifiers from a real Jonas member
//   number + a founder-controlled salt that lives OUTSIDE the repo.
//
//   The salt is NEVER stored in:
//     - the Spectre application database
//     - the Spectre git repository
//     - staging logs / screenshots / Prisma dumps
//
//   If the salt is lost, synthetic IDs change — this is INTENDED.
//   The property "no reversible real↔synthetic crosswalk in Spectre"
//   is preserved.
//
// USAGE
//   1. Founder keeps `SPECTRE_SANITIZE_SALT` in a .env.local on
//      their workstation (never committed; .gitignore already blocks).
//   2. Founder runs a local script that:
//        - reads the real Jonas workbook,
//        - calls makeSyntheticIdentifier(realId, salt),
//        - writes a sanitized workbook with synthetic ids + synthetic
//          "Member NNNN" display names,
//        - does NOT emit email / phone / address / DOB columns.
//   3. Only the sanitized workbook is uploaded to Spectre.

import { createHash } from "node:crypto";

/** Make a deterministic synthetic external identifier from a real
 *  source identifier + a founder-held salt.
 *
 *  Output format: `CR-<12-hex-chars>` — short enough to display,
 *  wide enough (48 bits) to avoid collisions across tens of
 *  thousands of members, and clearly non-numeric so staging viewers
 *  can tell it is synthetic. */
export function makeSyntheticIdentifier(realIdentifier: string, salt: string): string {
  if (!salt || salt.length < 16) {
    throw new Error(
      "makeSyntheticIdentifier: salt must be at least 16 characters (keep secret, do NOT commit)",
    );
  }
  const h = createHash("sha256").update(salt).update("::").update(realIdentifier).digest("hex");
  return `CR-${h.slice(0, 12)}`;
}

/** Deterministic synthetic display name derived from a real
 *  identifier. The output is intentionally generic — never attempts
 *  to preserve the real name's shape. */
export function makeSyntheticDisplayName(realIdentifier: string, salt: string): string {
  if (!salt || salt.length < 16) {
    throw new Error(
      "makeSyntheticDisplayName: salt must be at least 16 characters (keep secret, do NOT commit)",
    );
  }
  const h = createHash("sha256").update(salt).update("::").update(realIdentifier).digest("hex");
  return `Member ${h.slice(0, 4)}`;
}

/** Audit guard — surface any attempt to call these helpers with a
 *  salt that looks like a real identifier (e.g. the founder
 *  accidentally passed a member number instead of a salt). Does
 *  NOT guarantee salt entropy — the length check already does — but
 *  catches the common mis-call. */
export function assertSaltLooksSecret(salt: string): void {
  if (/^\d+$/.test(salt)) {
    throw new Error("assertSaltLooksSecret: salt is pure digits — looks like a member number, not a salt");
  }
  if (salt.length < 16) {
    throw new Error(`assertSaltLooksSecret: salt is ${salt.length} chars — must be ≥ 16`);
  }
}
