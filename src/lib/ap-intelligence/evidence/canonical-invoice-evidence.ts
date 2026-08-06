// Sprint 3 · Post-16H Phase 4 Slice 1 (2026-08-05) — canonical
// invoice evidence model. Founder-mandated scaffold for the
// evidence-first extraction reset.
//
// Central premise: extraction produces CANDIDATES, not answers.
// Every field is a *list* of ranked hypotheses; the reconciler
// picks a winner but never discards losers before validation +
// downstream cross-checks (subtotal + tax must equal total,
// supplier vs. bill-to disambiguation, etc.).
//
// This module is ADDITIVE. It sits alongside — and eventually
// composes — the existing single-value canonical-model
// (document-extractors/canonical-model.ts) used by the Textract
// path. Slice 1 populates supplierCandidates + payableReferences
// + taxCandidates from parseInvoiceText output; later slices
// populate line-items, addresses, tax-registrations, and
// multi-page geometry from the strategy router.
//
// This module is TEST + DIAGNOSTIC only in Slice 1 — it does not
// yet drive `ApAnalyseResult`. Wiring happens in later slices
// once the reconciler is battle-tested. The scoreboard target is:
// prove the model can express every failure class observed in
// the frozen-baseline scorecard.

export type EvidenceStrategy =
  | "EMBEDDED_TEXT"
  | "POSITIONED_TEXT"
  | "AWS_TEXTRACT_EXPENSE"
  | "OCR_FALLBACK"
  | "EMAIL_METADATA"
  | "VENDOR_PROFILE"
  | "CONFIG_DEFAULT";

export type ValidationStatus =
  | "UNVALIDATED"
  | "PASSED"
  | "FAILED_RECONCILIATION"
  | "FAILED_PLAUSIBILITY"
  | "SUPPRESSED_BY_ROLE"
  | "SHADOWED";

export interface BoundingRegion {
  page: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  lineIndex?: number;
}

/** A single hypothesis for a field's value. Confidence + strategy
 *  are always populated; region + snippet are best-effort. */
export interface EvidenceCandidate<T> {
  value: T;
  /** 0..100. Combines provider-reported confidence + Spectre's
   *  own reweighting once cross-strategy signals land. */
  confidence: number;
  strategy: EvidenceStrategy;
  region?: BoundingRegion;
  /** Short textual hint for diagnostics — MUST be safe to log. */
  evidenceSnippet?: string;
  /** Set by the reconciler AFTER cross-field validation. Before
   *  reconciliation this is UNVALIDATED. */
  validationStatus?: ValidationStatus;
  /** Optional string tag naming the rule / model / regex that
   *  produced this candidate. Same shape as `ParseHint.ruleKey` on
   *  the legacy extractors so diagnostics can pivot on it. */
  ruleKey?: string;
}

export type PayableReferenceType =
  | "INVOICE_NUMBER"
  | "STATEMENT_NUMBER"
  | "BILL_NUMBER"
  | "REFERENCE_NUMBER"
  | "OTHER";

export interface PayableReferenceCandidate extends EvidenceCandidate<string> {
  referenceType: PayableReferenceType;
}

export interface ExtractedAddressCandidate extends EvidenceCandidate<string> {
  /** Semantic role of the address in the document. */
  role: "REMIT_TO" | "BILL_TO" | "SHIP_TO" | "LETTERHEAD" | "UNKNOWN";
}

export interface ExtractedLineItem {
  description: EvidenceCandidate<string>;
  quantity?: EvidenceCandidate<number>;
  unitPrice?: EvidenceCandidate<number>;
  amount: EvidenceCandidate<number>;
  productCode?: EvidenceCandidate<string>;
  taxAmount?: EvidenceCandidate<number>;
  isCredit?: boolean;
  isSurcharge?: boolean;
}

export interface EvidenceConflict {
  code:
    | "AMOUNT_MISMATCH_SUBTOTAL_PLUS_TAX_VS_TOTAL"
    | "SUPPLIER_VS_BILL_TO_COLLISION"
    | "MULTIPLE_INVOICE_NUMBERS"
    | "MULTIPLE_TAX_RATES"
    | "CURRENCY_MULTIPLE_HINTS"
    | "DATE_INVOICE_AFTER_DUE"
    | "LINE_ITEMS_DO_NOT_SUM_TO_SUBTOTAL";
  message: string;
  affectedField: keyof CanonicalInvoiceEvidence["fields"] | "lineItems";
}

export interface CanonicalInvoiceEvidence {
  /** Which strategy actually produced most of the evidence.
   *  When multiple strategies contributed, this names the primary
   *  and the details live under `strategiesUsed`. */
  extractionStrategy: EvidenceStrategy;
  strategiesUsed: EvidenceStrategy[];

  /** Total pages known from the source document. */
  pageCount: number;

  fields: {
    /** All plausible supplier candidates, ranked. Winner: first. */
    supplierCandidates: EvidenceCandidate<string>[];
    /** Explicit recipient / bill-to / sold-to lines — used to
     *  refute supplier candidates that share text with the recipient. */
    recipientCandidates: EvidenceCandidate<string>[];

    payableReferences: PayableReferenceCandidate[];

    invoiceDates: EvidenceCandidate<string>[];   // ISO strings
    dueDates: EvidenceCandidate<string>[];       // ISO strings

    currencyCandidates: EvidenceCandidate<string>[];

    subtotalCandidates: EvidenceCandidate<number>[];
    taxCandidates: EvidenceCandidate<number>[];
    totalCandidates: EvidenceCandidate<number>[];

    addresses: ExtractedAddressCandidate[];
    taxRegistrations: EvidenceCandidate<string>[];
  };

  lineItems: ExtractedLineItem[];
  credits: ExtractedLineItem[];
  surcharges: ExtractedLineItem[];

  evidenceConflicts: EvidenceConflict[];

  /** Optional flattened text — kept for downstream token matchers
   *  that don't yet consume the structured evidence. */
  rawText?: string;
}

/** Empty-shape factory used by builders and tests. Never returns
 *  a partial — every list is initialised so callers can push
 *  candidates without null-checking. */
export function emptyEvidence(strategy: EvidenceStrategy): CanonicalInvoiceEvidence {
  return {
    extractionStrategy: strategy,
    strategiesUsed: [strategy],
    pageCount: 0,
    fields: {
      supplierCandidates: [],
      recipientCandidates: [],
      payableReferences: [],
      invoiceDates: [],
      dueDates: [],
      currencyCandidates: [],
      subtotalCandidates: [],
      taxCandidates: [],
      totalCandidates: [],
      addresses: [],
      taxRegistrations: [],
    },
    lineItems: [],
    credits: [],
    surcharges: [],
    evidenceConflicts: [],
  };
}

/**
 * Slice 1 reconciler — the amount hierarchy enforcement.
 *
 *   printed invoice total
 *     > reconciled (subtotal + tax − credits)
 *     > other supported total
 *     > subtotal only
 *
 * Rounds to 2 decimals. Returns the winner + which rung of the
 * ladder it came from + the conflict (if any) between the printed
 * total and the reconciled total.
 */
export interface AmountReconciliationResult {
  chosenTotal: number | null;
  chosenSource: "PRINTED_TOTAL" | "RECONCILED" | "OTHER_SUPPORTED" | "SUBTOTAL_ONLY" | "NONE";
  reconciliationDelta: number | null;   // printed − reconciled (null when either is missing)
  conflicts: EvidenceConflict[];
}

export function reconcileAmounts(
  evidence: CanonicalInvoiceEvidence,
  opts: { toleranceCents?: number } = {},
): AmountReconciliationResult {
  const tolerance = opts.toleranceCents ?? 2;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const printedTotal = evidence.fields.totalCandidates[0]?.value ?? null;
  const subtotal = evidence.fields.subtotalCandidates[0]?.value ?? null;
  const tax = evidence.fields.taxCandidates[0]?.value ?? 0;
  const credits = evidence.credits.reduce((a, c) => a + (c.amount.value ?? 0), 0);

  const reconciled = subtotal != null ? round2(subtotal + tax - credits) : null;

  const conflicts: EvidenceConflict[] = [];
  if (printedTotal != null && reconciled != null) {
    const delta = Math.abs(printedTotal - reconciled);
    if (delta > tolerance / 100) {
      conflicts.push({
        code: "AMOUNT_MISMATCH_SUBTOTAL_PLUS_TAX_VS_TOTAL",
        message: `Printed total ${printedTotal.toFixed(2)} differs from subtotal+tax-credits ${reconciled.toFixed(2)} by ${delta.toFixed(2)}.`,
        affectedField: "totalCandidates",
      });
    }
  }

  let chosenTotal: number | null;
  let chosenSource: AmountReconciliationResult["chosenSource"];
  if (printedTotal != null) {
    chosenTotal = printedTotal;
    chosenSource = "PRINTED_TOTAL";
  } else if (reconciled != null) {
    chosenTotal = reconciled;
    chosenSource = "RECONCILED";
  } else if (evidence.fields.totalCandidates.length > 1) {
    chosenTotal = evidence.fields.totalCandidates[1].value;
    chosenSource = "OTHER_SUPPORTED";
  } else if (subtotal != null) {
    chosenTotal = subtotal;
    chosenSource = "SUBTOTAL_ONLY";
  } else {
    chosenTotal = null;
    chosenSource = "NONE";
  }

  return {
    chosenTotal,
    chosenSource,
    reconciliationDelta:
      printedTotal != null && reconciled != null ? round2(printedTotal - reconciled) : null,
    conflicts,
  };
}
