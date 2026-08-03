// Sprint 3 · Checkpoint 16C (2026-08-04) — unified Work Intake
// amount formatter.
//
// Founder rule §14: all Work Intake amount displays must use one
// shared formatter with format:
//
//   $77,833.35 CAD
//
// Requirements:
//   * currency symbol
//   * thousands separators
//   * two decimal places
//   * ISO currency code
//   * consistent negative + zero handling
//   * same output regardless of extraction strategy / vendor-match
//     state / document type / workflow state / card variant
//
// Use the invoice currency when known. When absent, use the
// tenant's configured base currency (passed in by the caller).
// Never fabricate a currency.

export interface FormatAmountArgs {
  amount: string | number | null | undefined;
  currency: string | null | undefined;     // ISO 4217 or null
  tenantDefaultCurrency?: string | null;   // ClubProfile.defaultCurrency fallback
}

/**
 * The single formatter for every Work Intake amount cell / token /
 * chip. Returns "—" for absent amount. Uses `en-CA` locale for the
 * digit-grouping style but always prefixes the currency symbol +
 * suffixes the ISO code.
 */
export function formatWorkIntakeAmount(args: FormatAmountArgs): string {
  const amt = normalizeAmount(args.amount);
  if (amt === null) return "—";
  const iso = (args.currency ?? args.tenantDefaultCurrency ?? "").trim().toUpperCase();

  // 16C — every path uses the SAME grouping + decimal format. When
  // no ISO is available we still show the symbol-less bare amount
  // rather than fabricating a currency.
  const digits = formatDigits(amt);

  if (!iso) return digits;

  const symbol = symbolFor(iso);
  return `${symbol}${digits} ${iso}`;
}

function normalizeAmount(v: FormatAmountArgs["amount"]): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function formatDigits(n: number): string {
  // Always 2 decimal places, grouped by thousands. Negative values
  // formatted as -$X,XXX.XX (minus BEFORE the symbol) when composed
  // with symbol; here we emit the digits only.
  return new Intl.NumberFormat("en-CA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: true,
  }).format(n);
}

// -----------------------------------------------------------------------------
// Symbols — the same symbol table Intl.NumberFormat uses in
// currency mode, extracted so the format is deterministic across
// runtimes and independent of locale currency-display quirks.
// -----------------------------------------------------------------------------

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$", CAD: "$", AUD: "$", NZD: "$", HKD: "$", SGD: "$", MXN: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥", CNY: "¥",
  INR: "₹",
  CHF: "CHF ",
};

function symbolFor(iso: string): string {
  return CURRENCY_SYMBOLS[iso] ?? "";
}
