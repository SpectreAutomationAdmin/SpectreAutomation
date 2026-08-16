// HR-1 (2026-08-16) — Masked read helpers for sensitive numbers.
//
// Every HR read path that surfaces the "last N digits" of a sensitive
// value (SIN, bank account) routes through these helpers so the mask
// shape is consistent across the product. The plaintext is never
// touched here — callers pass in the ALREADY-EXTRACTED last-N digits
// that were persisted alongside the encrypted blob at write time.
//
// A masked read is always safe to log. A masked read is what the
// audit trail carries in `before` / `after` for reveal actions.

/**
 * SIN mask: `XXX XXX 123`. Canadian SIN is nine digits.
 * The caller supplies the three-digit suffix that was persisted at
 * write time as `EmployeeSensitiveIdentity.sinLastThree`.
 *
 * Throws on empty input or non-digit characters — callers must
 * validate + strip the plaintext BEFORE storing / masking.
 */
export function maskSin(sinLastThree: string): string {
  if (!sinLastThree || sinLastThree.length !== 3) {
    throw new Error("maskSin: expected exactly 3 digits");
  }
  if (!/^\d{3}$/.test(sinLastThree)) {
    throw new Error("maskSin: expected digits only");
  }
  return `XXX XXX ${sinLastThree}`;
}

/**
 * Bank account mask: `•••• 4567`. Callers supply the four-digit
 * suffix persisted as `EmployeeBankAccount.accountLastFour`.
 *
 * Throws on empty input or non-digit characters.
 */
export function maskBankAccount(lastFour: string): string {
  if (!lastFour || lastFour.length !== 4) {
    throw new Error("maskBankAccount: expected exactly 4 digits");
  }
  if (!/^\d{4}$/.test(lastFour)) {
    throw new Error("maskBankAccount: expected digits only");
  }
  return `•••• ${lastFour}`;
}

/**
 * Generic mask: `<prefixChar × groupSize> <lastN>`. Used by the
 * two named helpers above and by any future HR reveal path that
 * needs a consistent shape.
 *
 * Throws on empty input or non-digit last-N characters.
 */
export function maskGeneric(
  lastN: string,
  prefixChar = "•",
  groupSize = 4,
): string {
  if (!lastN || lastN.length === 0) {
    throw new Error("maskGeneric: expected non-empty lastN");
  }
  if (!/^\d+$/.test(lastN)) {
    throw new Error("maskGeneric: expected digits only");
  }
  if (groupSize <= 0) {
    throw new Error("maskGeneric: groupSize must be positive");
  }
  if (!prefixChar || prefixChar.length === 0) {
    throw new Error("maskGeneric: prefixChar must be non-empty");
  }
  return `${prefixChar.repeat(groupSize)} ${lastN}`;
}
