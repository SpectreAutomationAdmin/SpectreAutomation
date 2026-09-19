// Slice E (2026-09-19) — canonical pay-date-adjustment policy.
//
// Applies a founder-configured weekend shift to a raw scheduled pay
// date. Values (matching `PayrollPayGroup.payDateAdjustment`):
//
//   NONE                  — issue on the raw calendar date, even if Sat/Sun
//   PREVIOUS_BUSINESS_DAY — move Sat → Fri, Sun → Fri (earlier)
//   NEXT_BUSINESS_DAY     — move Sat → Mon, Sun → Mon (later)
//
// WEEKDAY-ONLY today. Statutory-holiday awareness is NOT automated —
// callers must label the setting honestly. Repo has no canonical
// Canadian/Alberta holiday calendar (audited Slice E §21); shipping
// holiday-aware behaviour requires that architecture first.

const DAY_MS = 86_400_000;

export type PayDateAdjustment =
  | "NONE"
  | "PREVIOUS_BUSINESS_DAY"
  | "NEXT_BUSINESS_DAY";

export const PAY_DATE_ADJUSTMENTS: readonly PayDateAdjustment[] = [
  "NONE",
  "PREVIOUS_BUSINESS_DAY",
  "NEXT_BUSINESS_DAY",
];

export const PAY_DATE_ADJUSTMENT_LABEL: Record<PayDateAdjustment, string> = {
  NONE: "Keep the scheduled date (may fall on a weekend)",
  PREVIOUS_BUSINESS_DAY: "Pay on the previous weekday",
  NEXT_BUSINESS_DAY: "Pay on the next weekday",
};

export function applyPayDateAdjustment(raw: Date, policy: PayDateAdjustment): Date {
  const dow = raw.getUTCDay(); // 0=Sun, 6=Sat
  if (policy === "NONE") return raw;
  if (policy === "PREVIOUS_BUSINESS_DAY") {
    if (dow === 6) return new Date(raw.getTime() - 1 * DAY_MS); // Sat → Fri
    if (dow === 0) return new Date(raw.getTime() - 2 * DAY_MS); // Sun → Fri
    return raw;
  }
  // NEXT_BUSINESS_DAY
  if (dow === 6) return new Date(raw.getTime() + 2 * DAY_MS); // Sat → Mon
  if (dow === 0) return new Date(raw.getTime() + 1 * DAY_MS); // Sun → Mon
  return raw;
}

/** Guardrail: fail closed on an unrecognised policy. */
export function assertKnownPolicy(value: string): PayDateAdjustment {
  if (!(PAY_DATE_ADJUSTMENTS as readonly string[]).includes(value)) {
    throw new Error(`Unknown pay-date-adjustment policy: ${value}`);
  }
  return value as PayDateAdjustment;
}
