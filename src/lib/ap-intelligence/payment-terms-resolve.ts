// Sprint 3 · Checkpoint 15P-2 (2026-07-27) — payment-terms
// resolution with honest provenance.
//
// The founder's Rule: never label a Spectre fallback as "extracted
// from the invoice PDF." The provenance chip below the terms field
// must tell the truth about where the number came from.
//
// Precedence — first non-null wins:
//
//   1. VENDOR_PROFILE  — an existing Vendor row with paymentTermsDays
//                        set. Trusted highest because a human already
//                        agreed to those terms.
//   2. INVOICE_PDF     — the extractor pulled a "Terms: Net N" line
//                        (or the auto-pay fallback → 0-day).
//   3. PRIOR_INVOICE   — the same vendor has posted invoices whose
//                        "terms" field converged on a consistent
//                        Net N. Only surfaces when the extractor and
//                        the vendor profile both had nothing.
//   4. CLUB_DEFAULT    — a per-club default from Settings (not
//                        implemented in this checkpoint but the
//                        resolver leaves the slot open so a future
//                        Settings UI can plug in without a rewrite).
//   5. SPECTRE_DEFAULT — Net 30. A proposed default, NOT a claim
//                        that the invoice explicitly said Net 30.
//
// The auto-pay case is handled separately: when the extractor flags
// auto-pay, the effective terms are "due immediately" (days=0).

export type PaymentTermsSource =
  | "VENDOR_PROFILE"
  | "INVOICE_PDF"
  | "PRIOR_INVOICE"
  | "CLUB_DEFAULT"
  | "SPECTRE_DEFAULT";

export interface ResolvedPaymentTerms {
  days: number;                       // resolved term length in days
  source: PaymentTermsSource;
  label: string;                      // e.g. "Net 30" or "Auto-pay"
  isAutoPay: boolean;                 // true when auto-charge is the effective model
  provenanceHuman: string;            // e.g. "Spectre default"
}

export const SPECTRE_DEFAULT_TERMS_DAYS = 30;

const HUMAN: Record<PaymentTermsSource, string> = {
  VENDOR_PROFILE:  "From vendor profile",
  INVOICE_PDF:     "From invoice PDF",
  PRIOR_INVOICE:   "From prior approved invoices",
  CLUB_DEFAULT:    "Club default",
  SPECTRE_DEFAULT: "Spectre default",
};

// 15P-4: auto-pay carries its own provenance label. Founder-observed
// defect: displaying "Net 0 · From invoice PDF" when the extractor
// actually detected AUTO_PAY misrepresents the evidence. Auto-pay is
// a payment METHOD, not a payment TERMS window — the vendor charges
// automatically, so from the AP module's perspective the due date IS
// the invoice date, but the user-facing label must read "Auto-pay"
// rather than "Net 0" so the operator understands why.
const AUTO_PAY_PROVENANCE = "Auto-pay — charged automatically";

export interface ResolvePaymentTermsInput {
  // Vendor row's own paymentTermsDays (already-agreed policy). Null
  // when the vendor doesn't exist yet OR when the vendor row leaves
  // it unset. Note: Prisma defaults `paymentTermsDays` to 30 on the
  // schema, so an "unset" existing vendor usually reads 30 here —
  // that IS the vendor profile speaking, not a Spectre fallback.
  vendorProfileTermsDays?: number | null;

  // Extractor result: either a numeric days count (parsed from
  // "Terms: Net N") OR the string "AUTO_PAY" (parsed from Microsoft
  // "You will be charged" wording). Null when the extractor found
  // nothing.
  extractedTerms?:
    | { kind: "NET_DAYS"; days: number }
    | { kind: "AUTO_PAY" }
    | null;

  // Best guess from prior posted invoices on this vendor. Only used
  // when the extractor + vendor profile both had nothing.
  priorInvoiceTermsDays?: number | null;

  // Reserved for a future Settings-driven per-club default.
  clubDefaultTermsDays?: number | null;
}

export function resolvePaymentTerms(
  input: ResolvePaymentTermsInput,
): ResolvedPaymentTerms {
  // 1. Vendor profile wins whenever the vendor already exists. We
  //    only skip this branch when the caller passed null / undefined
  //    (i.e. the vendor row doesn't exist yet).
  if (input.vendorProfileTermsDays != null && Number.isFinite(input.vendorProfileTermsDays)) {
    const d = clampDays(input.vendorProfileTermsDays);
    return {
      days: d,
      source: "VENDOR_PROFILE",
      label: labelFor(d, false),
      isAutoPay: false,
      provenanceHuman: HUMAN.VENDOR_PROFILE,
    };
  }

  // 2. Extractor.
  if (input.extractedTerms) {
    if (input.extractedTerms.kind === "AUTO_PAY") {
      return {
        days: 0,
        source: "INVOICE_PDF",
        label: "Auto-pay",
        isAutoPay: true,
        // 15P-4: honest provenance — the extractor found auto-pay
        // wording, not literally Net 0 terms.
        provenanceHuman: AUTO_PAY_PROVENANCE,
      };
    }
    if (input.extractedTerms.kind === "NET_DAYS" && Number.isFinite(input.extractedTerms.days)) {
      const d = clampDays(input.extractedTerms.days);
      return {
        days: d,
        source: "INVOICE_PDF",
        label: labelFor(d, false),
        isAutoPay: false,
        provenanceHuman: HUMAN.INVOICE_PDF,
      };
    }
  }

  // 3. Prior invoices on this vendor.
  if (input.priorInvoiceTermsDays != null && Number.isFinite(input.priorInvoiceTermsDays)) {
    const d = clampDays(input.priorInvoiceTermsDays);
    return {
      days: d,
      source: "PRIOR_INVOICE",
      label: labelFor(d, false),
      isAutoPay: false,
      provenanceHuman: HUMAN.PRIOR_INVOICE,
    };
  }

  // 4. Club default.
  if (input.clubDefaultTermsDays != null && Number.isFinite(input.clubDefaultTermsDays)) {
    const d = clampDays(input.clubDefaultTermsDays);
    return {
      days: d,
      source: "CLUB_DEFAULT",
      label: labelFor(d, false),
      isAutoPay: false,
      provenanceHuman: HUMAN.CLUB_DEFAULT,
    };
  }

  // 5. Spectre default — Net 30.
  return {
    days: SPECTRE_DEFAULT_TERMS_DAYS,
    source: "SPECTRE_DEFAULT",
    label: labelFor(SPECTRE_DEFAULT_TERMS_DAYS, false),
    isAutoPay: false,
    provenanceHuman: HUMAN.SPECTRE_DEFAULT,
  };
}

function clampDays(raw: number): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 0) return SPECTRE_DEFAULT_TERMS_DAYS;
  if (n > 365) return 365;
  return n;
}

function labelFor(days: number, autoPay: boolean): string {
  if (autoPay) return "Auto-pay";
  if (days === 0) return "Due on receipt";
  return `Net ${days}`;
}

/**
 * Parse the extractor's paymentTerms.value string into the discriminated
 * shape the resolver consumes. The extractor emits "Net 30" or
 * "Auto-pay (charged automatically)" or "Due on receipt".
 */
export function parseExtractedTermsValue(
  raw: string | null | undefined,
): ResolvePaymentTermsInput["extractedTerms"] {
  if (!raw) return null;
  const s = raw.trim();
  if (/^auto[-\s]?pay/i.test(s)) return { kind: "AUTO_PAY" };
  const m = s.match(/^Net\s*(\d{1,3})/i);
  if (m) return { kind: "NET_DAYS", days: parseInt(m[1], 10) };
  if (/due\s*(?:on|upon)\s*receipt/i.test(s)) return { kind: "NET_DAYS", days: 0 };
  return null;
}
