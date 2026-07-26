// Fund Applicability — first-class CoA property (founder rule
// 2026-07-02 v15.0).
//
// Every Profit & Loss account carries a Fund Applicability tag
// that names which reporting fund(s) it belongs to. This is the
// SINGLE SOURCE OF TRUTH for capital / operating classification —
// Spectre never infers fund from an account's name or number.
//
// Design goals:
//
//   • Extensible. The initial values are OPERATING + CAPITAL,
//     but the storage shape (comma-separated tokens on a single
//     TEXT field) accepts any future fund key without a schema
//     change. When the founder introduces RESTRICTED /
//     FOUNDATION / TOURNAMENT / ENDOWMENT, the reporting engine
//     picks them up automatically.
//
//   • Multi-select. An account can legitimately belong to more
//     than one fund (e.g. Interest Income contributes to both
//     the operating and capital funds). The storage carries a
//     SET; helpers below normalise + deduplicate + sort so the
//     serialised string is deterministic.
//
//   • FS Group is the derivation source. The founder's principle
//     is that the Financial Statement Group's canonical intent
//     determines a new account's default fund. This module owns
//     the FS Group → default Fund mapping so importers, the
//     migration backfill, and future UI defaults all agree.
//
// Nothing in this file references account names or account
// numbers. That's intentional — it keeps the "no inference"
// design principle enforced at the type level.

import type { AccountType } from "./types";

// ---------------------------------------------------------------------------
// Fund key vocabulary
// ---------------------------------------------------------------------------

/**
 * The set of fund keys Spectre understands today. Extending this
 * union (add `"RESTRICTED"`, `"FOUNDATION"`, etc) is the ONLY
 * change future fund additions require in this module — the
 * reporting engine iterates `KNOWN_FUND_KEYS` so new tokens flow
 * through automatically.
 */
export type FundKey = "OPERATING" | "CAPITAL";

/**
 * The canonical, ordered list of fund keys. Order is used to
 * normalise the serialised CSV so `"CAPITAL,OPERATING"` and
 * `"OPERATING,CAPITAL"` deserialise to the same set and
 * re-serialise to the same string ("OPERATING,CAPITAL").
 */
export const KNOWN_FUND_KEYS: ReadonlyArray<FundKey> = ["OPERATING", "CAPITAL"];

const KNOWN_FUND_KEY_SET: ReadonlySet<string> = new Set(KNOWN_FUND_KEYS);

/**
 * Type guard for the FundKey union.
 */
export function isFundKey(value: string): value is FundKey {
  return KNOWN_FUND_KEY_SET.has(value);
}

// ---------------------------------------------------------------------------
// Parse / serialise / query helpers
// ---------------------------------------------------------------------------

/**
 * Parse the stored CSV string into a deduplicated, canonically-
 * ordered array of FundKeys. Unknown tokens are DROPPED (not
 * thrown) so a future rollback or partial deploy can't crash the
 * reporting engine — callers that need strict validation should
 * use `assertFundApplicability` below.
 *
 * `null` / empty string / whitespace-only → `[]`.
 */
export function parseFundApplicability(raw: string | null | undefined): FundKey[] {
  if (raw == null) return [];
  const tokens = String(raw)
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter((t) => t.length > 0);
  const seen = new Set<FundKey>();
  for (const t of tokens) {
    if (isFundKey(t)) seen.add(t);
  }
  // Return in KNOWN_FUND_KEYS order so serialisation is deterministic.
  return KNOWN_FUND_KEYS.filter((k) => seen.has(k));
}

/**
 * Canonical serialisation of a fund-applicability set. Empty
 * arrays serialise to `null` so a "no funds" row reads
 * identically to a legacy row that hasn't been backfilled yet
 * (both trigger the reporting-engine's diagnostic path).
 */
export function serializeFundApplicability(funds: ReadonlyArray<FundKey>): string | null {
  const set = new Set<FundKey>();
  for (const f of funds) {
    if (isFundKey(f)) set.add(f);
  }
  if (set.size === 0) return null;
  return KNOWN_FUND_KEYS.filter((k) => set.has(k)).join(",");
}

/**
 * True when the stored value carries the given fund key. Handles
 * null / unknown tokens defensively — never throws.
 */
export function hasFund(raw: string | null | undefined, key: FundKey): boolean {
  return parseFundApplicability(raw).includes(key);
}

/**
 * Validate a caller-provided value. Throws a stable error message
 * (used by Zod refinement) when any token is not a known FundKey.
 * Empty string and null are accepted (they represent "not set").
 */
export function assertFundApplicability(raw: string | null | undefined): void {
  if (raw == null) return;
  const tokens = String(raw)
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter((t) => t.length > 0);
  const bad = tokens.filter((t) => !isFundKey(t));
  if (bad.length > 0) {
    throw new Error(
      `Unknown fund key(s): ${bad.join(", ")}. Known keys: ${KNOWN_FUND_KEYS.join(", ")}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// FS Group → default Fund Applicability
// ---------------------------------------------------------------------------

/**
 * Financial Statement Group keys whose canonical intent maps to
 * a fund other than OPERATING. Any P&L FS Group NOT listed here
 * defaults to OPERATING.
 *
 * Founder principle (2026-07-02): FS Group is the derivation
 * source, NOT account name or number. This table is the ONLY
 * place that translation lives. When a new capital FS Group is
 * introduced (e.g. `IS_CAPITAL_INVESTMENT_INCOME`), adding it
 * here backfills the migration + the import defaults in one edit.
 */
export const FS_GROUP_DEFAULT_FUND: Readonly<Record<string, ReadonlyArray<FundKey>>> = {
  // Capital revenue — special / annual assessments the club levies
  // for capital reserve funding are booked directly to the capital
  // fund; nothing else in the standard revenue taxonomy is
  // exclusively capital.
  IS_CAPITAL_ASSESSMENTS: ["CAPITAL"],
};

/**
 * Compute the default Fund Applicability for a P&L account with a
 * given (type, fsGroupKey) pair. Non-P&L account types return an
 * empty array — Fund Applicability is a P&L concept only.
 *
 * Rules:
 *   • ASSET / LIABILITY / EQUITY → []   (fund applicability n/a)
 *   • REVENUE / EXPENSE:
 *     • FS group listed in `FS_GROUP_DEFAULT_FUND` → that mapping
 *     • Otherwise                                  → ["OPERATING"]
 *
 * Callers that already carry a caller-provided value should skip
 * this function and use the caller's value verbatim (this default
 * is only a fallback when the caller has no preference).
 */
export function defaultFundApplicabilityForAccount(
  type: AccountType,
  fsGroupKey: string | null | undefined,
): FundKey[] {
  if (type !== "REVENUE" && type !== "EXPENSE") return [];
  if (fsGroupKey && FS_GROUP_DEFAULT_FUND[fsGroupKey]) {
    return [...FS_GROUP_DEFAULT_FUND[fsGroupKey]];
  }
  return ["OPERATING"];
}

/**
 * Convenience: derive AND serialise in one call — matches the
 * shape most callers (importers, migration, service defaults)
 * want to write straight into `Account.fundApplicability`.
 */
export function defaultFundApplicabilityStringForAccount(
  type: AccountType,
  fsGroupKey: string | null | undefined,
): string | null {
  return serializeFundApplicability(defaultFundApplicabilityForAccount(type, fsGroupKey));
}

// ---------------------------------------------------------------------------
// Reporting helpers
// ---------------------------------------------------------------------------

/**
 * True when a P&L account is applicable to the capital fund. The
 * canonical way for reporting code to ask "is this a capital
 * account?" — replaces every prior use of account-number ranges
 * or FS-group name matching.
 */
export function isCapitalAccount(raw: string | null | undefined): boolean {
  return hasFund(raw, "CAPITAL");
}

/**
 * True when a P&L account is applicable to the operating fund.
 */
export function isOperatingAccount(raw: string | null | undefined): boolean {
  return hasFund(raw, "OPERATING");
}
