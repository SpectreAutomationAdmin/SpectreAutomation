// Member number normalization + validation.
//
// User-facing: every staff input is a plain 4-digit string, leading
// zeros preserved (e.g. "0613", "1310"). Members are unique inside a
// club — two different clubs can both have member "1432" and the
// lookup never crosses tenants because every query is scoped by
// clubId. The DB enforces this via @@unique([clubId, memberNumber]).
//
// Legacy compat: prior builds emitted "SS-1310" style numbers. If a
// staff member pastes one, normalizeMemberNumber strips any letters+
// dash prefix and returns the 4-digit body so the lookup still works.
// New numbers issued by the app are always 4-digit only.

/**
 * Canonical shape of a member number in the database and on every
 * staff-facing input: exactly 4 digits, leading zeros preserved.
 */
export const MEMBER_NUMBER_REGEX = /^\d{4}$/;

/**
 * Legacy + canonical: optional letters+dash prefix (SS-, GLEN-, etc.)
 * followed by exactly 4 digits. Used by the normalizer to strip a
 * historical prefix and recover the canonical 4-digit body.
 */
const MEMBER_NUMBER_LEGACY_REGEX = /^([A-Za-z]+-)?(\d{4})$/;

/**
 * Normalize whatever the user typed into the canonical 4-digit form.
 *
 * Accepts:
 *   - "1310"      → "1310"
 *   - "0613"      → "0613"
 *   - " 1310 "    → "1310"  (whitespace trimmed)
 *   - "SS-1310"   → "1310"  (legacy prefix stripped)
 *   - "ss-1310"   → "1310"  (case insensitive)
 *   - "GLEN-0001" → "0001"  (any letter prefix)
 *
 * Returns the raw input unchanged if it doesn't match the pattern, so
 * downstream validators can produce a single canonical "Enter the
 * 4-digit member number." error message instead of guessing.
 */
export function normalizeMemberNumber(raw: string): string {
  const trimmed = raw.trim();
  const m = trimmed.match(MEMBER_NUMBER_LEGACY_REGEX);
  return m ? m[2] : trimmed;
}

/**
 * True iff `normalizeMemberNumber(raw)` would yield a valid 4-digit
 * canonical number.
 */
export function isValidMemberNumber(raw: string): boolean {
  return MEMBER_NUMBER_REGEX.test(normalizeMemberNumber(raw));
}

/**
 * Validate + normalize. Returns the canonical form on success or an
 * "Enter the 4-digit member number." error otherwise. The error
 * message is the canonical UI string per spec; reuse it everywhere a
 * staff input is rejected.
 */
export type MemberNumberParseResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

export function parseMemberNumberInput(raw: string): MemberNumberParseResult {
  if (!raw || !raw.trim()) {
    return { ok: false, error: "Enter the 4-digit member number." };
  }
  const value = normalizeMemberNumber(raw);
  if (!MEMBER_NUMBER_REGEX.test(value)) {
    return { ok: false, error: "Enter the 4-digit member number." };
  }
  return { ok: true, value };
}

/**
 * Strip a legacy letter-prefix for display ONLY. Use this when
 * rendering a stored memberNumber on a staff-facing surface — never
 * to derive a lookup key (use normalizeMemberNumber for that).
 */
export function displayMemberNumber(stored: string | null | undefined): string {
  if (!stored) return "";
  return normalizeMemberNumber(stored);
}
