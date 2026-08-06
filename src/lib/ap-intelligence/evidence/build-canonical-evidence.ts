// Sprint 3 · Post-16H Phase 4 Slice 2 (2026-08-06) — canonical
// evidence orchestrator. Founder-required "cutover" surface:
//
//   document extraction strategies
//     → evidence candidates
//     → candidate validation
//     → conflict detection
//     → reconciliation
//     → selected canonical values
//     → ApAnalyseResult
//     → frozen Phase 3 workflow decision
//
// This module composes existing extractors as CANDIDATE SOURCES.
// It does NOT replace them — a Slice 3 refactor may collapse the
// legacy extractors into pure candidate providers, but for now
// legacy extractors continue to fire, and their outputs are
// promoted to canonical candidates plus the alternates that
// parseInvoiceText already surfaces.
//
// The orchestrator produces a CanonicalInvoiceEvidence that
// carries per-field candidate lists + conflicts. Callers pull the
// selected value via selectCanonicalFields(evidence) — that
// selection is the SOLE authority downstream ApAnalyseResult
// consumers see. Rejected alternates + conflict reasons remain on
// the evidence object for diagnostics + card-level provenance.

import {
  type CanonicalInvoiceEvidence,
  type EvidenceCandidate,
  type PayableReferenceCandidate,
  type PayableReferenceType,
  type EvidenceConflict,
  emptyEvidence,
  reconcileAmounts,
} from "./canonical-invoice-evidence";
import { extractLineItemsFromText, reconcileLineItems } from "./line-items";
import {
  extractStructuredTaxComponents,
  selectTaxTotal,
  type StructuredTaxComponent,
} from "./tax-components";
import {
  rankSuppliers,
  deriveSignals,
  type RankableSupplierCandidate,
  type SupplierRankResult,
} from "./supplier-ranker";

export interface BuildEvidenceInput {
  /** Flattened text of the primary document. */
  text: string;
  /** Selected values already produced by the legacy extractor —
   *  used as the seed candidate. Downstream additions come from
   *  parallel candidate sources (regex, layout, provider). */
  legacyValues: {
    supplierName: string | null;
    supplierConfidence?: number | null;
    supplierRuleKey?: string | null;
    supplierAlternates?: Array<{ value: string; confidence: number; rule?: string }>;
    payableReferenceValue: string | null;
    payableReferenceType: PayableReferenceType | null;
    payableReferenceConfidence?: number | null;
    payableReferenceRuleKey?: string | null;
    invoiceDate: string | null;
    dueDate: string | null;
    currency: string | null;
    currencyRuleKey?: string | null;
    subtotal: number | null;
    tax: number | null;
    total: number | null;
    /** Optional list of per-component tax lines observed. When >1
     *  distinct non-zero component was found, this is the summed
     *  breakdown that populated `tax`. */
    taxComponents?: Array<{ label: string; amount: number }>;
  };
  /** Optional email metadata — supplier candidates can carry the
   *  sender domain / display name as a weaker candidate source. */
  email?: {
    senderAddress?: string | null;
    subject?: string | null;
  };
  /** How many pages the source document had. */
  pageCount?: number;
}

/** Confidence dial per source strategy — used when the underlying
 *  extractor didn't emit its own confidence. */
const STRATEGY_BASE_CONFIDENCE = {
  EMBEDDED_TEXT: 75,
  POSITIONED_TEXT: 80,
  AWS_TEXTRACT_EXPENSE: 85,
  OCR_FALLBACK: 55,
  EMAIL_METADATA: 40,
  VENDOR_PROFILE: 90,
  CONFIG_DEFAULT: 30,
} as const;

/** Build the canonical evidence view of a document. Every field
 *  becomes a ranked candidate list; the winner will be selected
 *  by `selectCanonicalFields`. */
export function buildCanonicalEvidence(input: BuildEvidenceInput): CanonicalInvoiceEvidence {
  const ev = emptyEvidence("EMBEDDED_TEXT");
  ev.pageCount = input.pageCount ?? 1;
  ev.rawText = input.text;

  const now = () => STRATEGY_BASE_CONFIDENCE.EMBEDDED_TEXT;

  // --- supplier candidates --------------------------------------------
  if (input.legacyValues.supplierName) {
    ev.fields.supplierCandidates.push({
      value: input.legacyValues.supplierName,
      confidence: input.legacyValues.supplierConfidence ?? now(),
      strategy: "EMBEDDED_TEXT",
      ruleKey: input.legacyValues.supplierRuleKey ?? "supplier.legacy",
      validationStatus: "UNVALIDATED",
    });
  }
  if (Array.isArray(input.legacyValues.supplierAlternates)) {
    for (const alt of input.legacyValues.supplierAlternates) {
      // Skip duplicates by value.
      if (ev.fields.supplierCandidates.some((c) => c.value === alt.value)) continue;
      ev.fields.supplierCandidates.push({
        value: alt.value,
        confidence: alt.confidence,
        strategy: "EMBEDDED_TEXT",
        ruleKey: alt.rule ?? "supplier.legacy_alternate",
        validationStatus: "UNVALIDATED",
      });
    }
  }
  // Email sender as a weakest fallback candidate — never wins over
  // a document-anchored supplier but preserved for provenance.
  if (input.email?.senderAddress) {
    const domain = input.email.senderAddress.split("@")[1];
    if (domain) {
      ev.fields.supplierCandidates.push({
        value: domain,
        confidence: STRATEGY_BASE_CONFIDENCE.EMAIL_METADATA,
        strategy: "EMAIL_METADATA",
        ruleKey: "supplier.email_domain",
        evidenceSnippet: input.email.senderAddress,
        validationStatus: "UNVALIDATED",
      });
    }
  }

  // --- recipient candidates (BILL TO / SOLD TO / SHIP TO) -------------
  // Retained separately so the selector can refute a supplier
  // candidate that collides with a recipient candidate.
  const RECIPIENT_LABEL = /^\s*(BILL\s*TO|SOLD\s*TO|SHIP\s*TO|CUSTOMER|Client|Account\s*Holder)[:\s]*$/i;
  const lines = input.text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!RECIPIENT_LABEL.test(lines[i])) continue;
    // Recipient is the next non-empty line (skip "Attn:" prefixes).
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const cand = lines[j].trim();
      if (!cand) continue;
      if (/^Attn/i.test(cand)) continue;
      // Reject pure address / postal lines from being recipient names.
      if (/^\d{1,5}\s/.test(cand)) break;
      ev.fields.recipientCandidates.push({
        value: cand,
        confidence: 70,
        strategy: "EMBEDDED_TEXT",
        ruleKey: "recipient.bill_to_block",
        evidenceSnippet: `${lines[i].trim()} → ${cand}`,
        validationStatus: "UNVALIDATED",
      });
      break;
    }
  }

  // --- payable references --------------------------------------------
  if (input.legacyValues.payableReferenceValue && input.legacyValues.payableReferenceType) {
    ev.fields.payableReferences.push({
      value: input.legacyValues.payableReferenceValue,
      confidence: input.legacyValues.payableReferenceConfidence ?? 80,
      strategy: "EMBEDDED_TEXT",
      ruleKey: input.legacyValues.payableReferenceRuleKey ?? "payable_ref.legacy",
      referenceType: input.legacyValues.payableReferenceType,
      validationStatus: "UNVALIDATED",
    } as PayableReferenceCandidate);
  }

  // --- dates ---------------------------------------------------------
  if (input.legacyValues.invoiceDate) {
    ev.fields.invoiceDates.push({
      value: input.legacyValues.invoiceDate,
      confidence: now(),
      strategy: "EMBEDDED_TEXT",
      ruleKey: "invoice_date.legacy",
      validationStatus: "UNVALIDATED",
    });
  }
  if (input.legacyValues.dueDate) {
    ev.fields.dueDates.push({
      value: input.legacyValues.dueDate,
      confidence: now(),
      strategy: "EMBEDDED_TEXT",
      ruleKey: "due_date.legacy",
      validationStatus: "UNVALIDATED",
    });
  }

  // --- currency ------------------------------------------------------
  if (input.legacyValues.currency) {
    ev.fields.currencyCandidates.push({
      value: input.legacyValues.currency,
      confidence: currencyConfidenceFromRuleKey(input.legacyValues.currencyRuleKey),
      strategy: "EMBEDDED_TEXT",
      ruleKey: input.legacyValues.currencyRuleKey ?? "currency.legacy",
      validationStatus: "UNVALIDATED",
    });
  }

  // --- amounts -------------------------------------------------------
  if (input.legacyValues.subtotal != null) {
    ev.fields.subtotalCandidates.push({
      value: input.legacyValues.subtotal, confidence: now(), strategy: "EMBEDDED_TEXT",
      ruleKey: "subtotal.legacy", validationStatus: "UNVALIDATED",
    });
  }
  if (input.legacyValues.tax != null) {
    ev.fields.taxCandidates.push({
      value: input.legacyValues.tax, confidence: now(), strategy: "EMBEDDED_TEXT",
      ruleKey: "tax.legacy", validationStatus: "UNVALIDATED",
    });
  }
  if (input.legacyValues.total != null) {
    ev.fields.totalCandidates.push({
      value: input.legacyValues.total, confidence: now(), strategy: "EMBEDDED_TEXT",
      ruleKey: "total.legacy", validationStatus: "UNVALIDATED",
    });
  }

  // --- line items / credits / surcharges (Slice 3 §7) ---------------
  const li = extractLineItemsFromText(input.text, input.pageCount ?? 1);
  ev.lineItems = li.lineItems;
  ev.credits = li.credits;
  ev.surcharges = li.surcharges;
  for (const c of li.conflicts) ev.evidenceConflicts.push(c);

  // --- structured tax components (Slice 3 §9) -----------------------
  const taxComponents = extractStructuredTaxComponents(input.text);
  // Attach on the evidence as an extension bag (not part of the base
  // shape) so downstream consumers can drill in without changing
  // the canonical evidence type surface used by Slice 2 tests.
  (ev as CanonicalInvoiceEvidence & { taxComponents?: StructuredTaxComponent[] }).taxComponents = taxComponents;

  // --- supplier ranker v2 (Slice 3 §3) ------------------------------
  // Scored composition over the collected supplier candidates.
  // Winners bubble UP within the same candidate list; losers keep
  // their preserved-alternate status. The ranker never removes
  // candidates — it re-orders + tags them.
  const rankable: RankableSupplierCandidate[] = ev.fields.supplierCandidates.map((c) => {
    const sig = deriveSignals(c.value, {
      text: input.text,
      senderDomain: input.email?.senderAddress?.split("@")[1]?.toLowerCase(),
    });
    // Add BILL_TO_PROXIMITY when the collision detector below fires,
    // but the collision detector runs AFTER the ranker — so we
    // pre-check recipient overlap here.
    if (ev.fields.recipientCandidates.some((r) => normalizeOrgName(r.value) === normalizeOrgName(c.value))) {
      sig.negative.push("BILL_TO_PROXIMITY");
    }
    return {
      value: c.value,
      positive: sig.positive,
      negative: sig.negative,
      prior: c.confidence,
      provenance: c.ruleKey ?? undefined,
    };
  });
  const rank: SupplierRankResult | null = rankable.length > 0 ? rankSuppliers(rankable) : null;
  if (rank && rank.winner) {
    // Re-order supplierCandidates so the ranker winner is first.
    // Preserve losers as alternates behind it.
    const winnerValue = rank.winner.value;
    const reordered = [
      ...ev.fields.supplierCandidates.filter((c) => c.value === winnerValue),
      ...ev.fields.supplierCandidates.filter((c) => c.value !== winnerValue),
    ];
    // Update winner's confidence to reflect the composed score (0..100).
    const winnerCand = reordered[0];
    if (winnerCand) {
      winnerCand.confidence = Math.max(0, Math.min(100, Math.round(rank.winner.score)));
      winnerCand.ruleKey = `${winnerCand.ruleKey ?? "supplier"}+ranker_v2`;
      if (rank.ambiguous) {
        winnerCand.validationStatus = "FAILED_PLAUSIBILITY";
      }
    }
    ev.fields.supplierCandidates = reordered;
  }
  // Attach the full ranked evidence for diagnostics.
  (ev as CanonicalInvoiceEvidence & { supplierRanking?: SupplierRankResult }).supplierRanking = rank ?? undefined;

  // --- line-item reconciliation (§8) --------------------------------
  const li2 = reconcileLineItems(
    ev.lineItems,
    ev.credits,
    ev.surcharges,
    input.legacyValues.subtotal,
  );
  if (li2?.conflict) ev.evidenceConflicts.push(li2.conflict);

  // --- amount reconciliation + existing conflict detection ---------
  const amountRec = reconcileAmounts(ev);
  for (const conflict of amountRec.conflicts) {
    ev.evidenceConflicts.push(conflict);
  }
  // Supplier vs recipient collision guard.
  for (const s of ev.fields.supplierCandidates) {
    if (ev.fields.recipientCandidates.some((r) => normalizeOrgName(r.value) === normalizeOrgName(s.value))) {
      ev.evidenceConflicts.push({
        code: "SUPPLIER_VS_BILL_TO_COLLISION",
        message: `Supplier candidate "${s.value}" also appears as a recipient — likely bill-to contamination.`,
        affectedField: "supplierCandidates",
      });
      s.validationStatus = "FAILED_PLAUSIBILITY";
      s.confidence = Math.min(s.confidence, 20);
    }
  }
  // Multiple invoice numbers signal.
  if (ev.fields.payableReferences.length > 1) {
    ev.evidenceConflicts.push({
      code: "MULTIPLE_INVOICE_NUMBERS",
      message: `${ev.fields.payableReferences.length} payable references present; primary=${ev.fields.payableReferences[0].value}.`,
      affectedField: "payableReferences",
    });
  }
  // Currency multiple-hints signal.
  const distinctCurrencyValues = Array.from(new Set(ev.fields.currencyCandidates.map((c) => c.value)));
  if (distinctCurrencyValues.length > 1) {
    ev.evidenceConflicts.push({
      code: "CURRENCY_MULTIPLE_HINTS",
      message: `Multiple currency hints (${distinctCurrencyValues.join(", ")}); using highest-confidence winner.`,
      affectedField: "currencyCandidates",
    });
  }

  return ev;
}

/** Result of picking canonical values from an evidence object.
 *  Every field carries provenance so downstream consumers + the
 *  Work Intake card can render per-field source strategy + rule
 *  key + confidence + rejected alternates. */
export interface CanonicalSelection<T> {
  value: T | null;
  strategy: EvidenceCandidate<T>["strategy"] | null;
  confidence: number | null;
  ruleKey: string | null;
  evidenceSnippet: string | null;
  rejectedAlternates: Array<{ value: T; reason: "LOWER_CONFIDENCE" | "VALIDATION_FAILED" | "SUPPRESSED_BY_ROLE" }>;
  conflicts: EvidenceConflict[];
}

export interface CanonicalFieldSelection {
  supplier: CanonicalSelection<string>;
  payableReference: CanonicalSelection<string> & { type: PayableReferenceType | null };
  invoiceDate: CanonicalSelection<string>;
  dueDate: CanonicalSelection<string>;
  currency: CanonicalSelection<string>;
  subtotal: CanonicalSelection<number>;
  tax: CanonicalSelection<number>;
  total: CanonicalSelection<number>;
  amountReconciliation: ReturnType<typeof reconcileAmounts>;
}

/** Highest-confidence winner per field, with the rest kept as
 *  rejected alternates. Never mutates the input evidence. */
export function selectCanonicalFields(ev: CanonicalInvoiceEvidence): CanonicalFieldSelection {
  const amountReconciliation = reconcileAmounts(ev);
  return {
    supplier: pickSingle(ev.fields.supplierCandidates, ev.evidenceConflicts, "supplierCandidates"),
    payableReference: {
      ...pickSingle(ev.fields.payableReferences, ev.evidenceConflicts, "payableReferences"),
      type: ev.fields.payableReferences[0]?.referenceType ?? null,
    },
    invoiceDate: pickSingle(ev.fields.invoiceDates, ev.evidenceConflicts, "invoiceDates"),
    dueDate: pickSingle(ev.fields.dueDates, ev.evidenceConflicts, "dueDates"),
    currency: pickSingle(ev.fields.currencyCandidates, ev.evidenceConflicts, "currencyCandidates"),
    subtotal: pickSingle(ev.fields.subtotalCandidates, ev.evidenceConflicts, "subtotalCandidates"),
    tax: pickSingle(ev.fields.taxCandidates, ev.evidenceConflicts, "taxCandidates"),
    total: {
      ...pickSingle(ev.fields.totalCandidates, ev.evidenceConflicts, "totalCandidates"),
      // Reconciler may prefer a reconciled total when printed total
      // is missing — surface the reconciler's chosen source so the
      // card can display "computed" vs "printed".
      value: amountReconciliation.chosenTotal ?? ev.fields.totalCandidates[0]?.value ?? null,
    },
    amountReconciliation,
  };
}

function pickSingle<T>(
  cands: EvidenceCandidate<T>[],
  conflicts: EvidenceConflict[],
  fieldKey: string,
): CanonicalSelection<T> {
  if (cands.length === 0) {
    return {
      value: null, strategy: null, confidence: null, ruleKey: null,
      evidenceSnippet: null, rejectedAlternates: [], conflicts: [],
    };
  }
  // Winner: highest confidence with validationStatus != FAILED_*.
  const usable = cands.filter((c) =>
    !c.validationStatus || (c.validationStatus !== "FAILED_PLAUSIBILITY" && c.validationStatus !== "FAILED_RECONCILIATION"),
  );
  const source = (usable.length > 0 ? usable : cands).slice().sort((a, b) => b.confidence - a.confidence);
  const winner = source[0];
  const rejected = source.slice(1).map((c) => ({
    value: c.value,
    reason:
      c.validationStatus === "FAILED_PLAUSIBILITY" || c.validationStatus === "FAILED_RECONCILIATION"
        ? ("VALIDATION_FAILED" as const)
        : ("LOWER_CONFIDENCE" as const),
  }));
  return {
    value: winner.value,
    strategy: winner.strategy,
    confidence: winner.confidence,
    ruleKey: winner.ruleKey ?? null,
    evidenceSnippet: winner.evidenceSnippet ?? null,
    rejectedAlternates: rejected,
    conflicts: conflicts.filter((c) => c.affectedField === fieldKey),
  };
}

function normalizeOrgName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\bltd\.?|\binc\.?|\bcorp\.?|\bllc\.?|\bllp\.?|\bcompany\.?|\bco\.?/gi, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function currencyConfidenceFromRuleKey(ruleKey: string | null | undefined): number {
  if (!ruleKey) return 60;
  if (ruleKey === "currency.explicit") return 95;
  if (ruleKey.startsWith("currency.symbolic")) return 85;
  if (ruleKey === "currency.dollar_default_cad") return 55;
  if (ruleKey === "currency.canadian_tax_inference") return 65;
  if (ruleKey === "currency.us_tax_inference") return 55;
  return 60;
}
