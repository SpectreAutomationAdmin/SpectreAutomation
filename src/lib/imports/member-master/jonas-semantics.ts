// MEM-HIST-2 §6 / §15 (2026-10-03) — Jonas source-semantics mapping.
//
// The real Jonas export carries source-specific status codes that do
// NOT map cleanly to an ACTIVE/RESIGNED/TERMINATED enum. Per
// directive §6, we PRESERVE raw source codes on the
// MembershipHistoryEntry row and additionally derive a conservative
// `interpretedStatus` where the mapping is DETERMINISTIC.
//
// Deterministic rules established from the 2026-10-03 workbook audit
// (21 distinct Status values; see MEM-HIST-2 §B of the acceptance
// report):
//
//   RESIGNED               → RESIGNED
//   S/HOLDER               → ACTIVE  (+ isShareholder = true)
//   SPOUSE                 → ACTIVE
//   JUNIOR / SPONSOR JR    → ACTIVE
//   SOCIAL                 → ACTIVE
//   IN-HOUSE               → ACTIVE
//   INTER. / SPON INTER    → ACTIVE
//   CLUB                   → ACTIVE
//   STAFF                  → ACTIVE
//   LEGACY / LEGCY SPOS    → ACTIVE
//   SHUTTLE                → ACTIVE
//   DESIGNATE              → ACTIVE
//   PROMO                  → ACTIVE
//   TRIAL                  → ACTIVE
//   BANQUET                → ACTIVE
//   OUT/BANQ               → RESIGNED (status includes "OUT")
//   WAIT LIST              → APPLICANT
//   MISC A/R               → UNKNOWN  (AR-only ambiguous — see §22)
//
// MISC A/R intentionally stays UNKNOWN because the directive §22
// warns against calling AR-only rows "memberships" without founder
// policy. These rows ARE Members (we still create the Spectre
// identity so AR aging can resolve) but their membership
// classification is deferred to founder review.

export type InterpretedMembershipStatus =
  | "ACTIVE"
  | "RESIGNED"
  | "INACTIVE"
  | "APPLICANT"
  | "UNKNOWN";

/** Shareholder-conferring source status codes. Deterministic per §15. */
export const SHAREHOLDER_SOURCE_STATUSES = new Set<string>([
  "S/HOLDER",
]);

/** Deterministic source status → interpreted status map. Any unseen
 *  value falls through to "UNKNOWN" (never guessed). */
const STATUS_MAP: Record<string, InterpretedMembershipStatus> = {
  "RESIGNED": "RESIGNED",
  "OUT/BANQ": "RESIGNED",
  "S/HOLDER": "ACTIVE",
  "SPOUSE": "ACTIVE",
  "JUNIOR": "ACTIVE",
  "SPONSOR JR": "ACTIVE",
  "SOCIAL": "ACTIVE",
  "IN-HOUSE": "ACTIVE",
  "INTER.": "ACTIVE",
  "SPON INTER": "ACTIVE",
  "CLUB": "ACTIVE",
  "STAFF": "ACTIVE",
  "LEGACY": "ACTIVE",
  "LEGCY SPOS": "ACTIVE",
  "SHUTTLE": "ACTIVE",
  "DESIGNATE": "ACTIVE",
  "PROMO": "ACTIVE",
  "TRIAL": "ACTIVE",
  "BANQUET": "ACTIVE",
  "WAIT LIST": "APPLICANT",
  "MISC A/R": "UNKNOWN",
};

export function interpretSourceStatus(raw: string): InterpretedMembershipStatus {
  const key = raw.trim().toUpperCase();
  return STATUS_MAP[key] ?? "UNKNOWN";
}

export function isShareholderFromSourceStatus(raw: string): boolean {
  return SHAREHOLDER_SOURCE_STATUSES.has(raw.trim().toUpperCase());
}
