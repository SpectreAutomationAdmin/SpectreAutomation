// Sprint 3 · Checkpoint 15X Activation (2026-08-03) — canonical
// projection merge.
//
// When AWS Textract produces a CanonicalDocumentExtraction, the
// analyser's downstream text-parsing extractors get a SYNTHESIZED
// flat-text view (see synthesizePdfTextFromCanonical in analyse.ts).
// That works for simple fields (supplier name, invoice number,
// totals) but loses the STRUCTURED data (per-line-item amounts,
// address components with province + postal + country separated).
//
// This module bridges the gap: it accepts the analyser's derived
// outputs plus the canonical extraction, and produces enriched
// outputs where canonical values take precedence when present.
//
// Rules:
//   1. Canonical wins for STRUCTURED fields (address components,
//      line items) — extractors can never recover the structure
//      from a flat-text synthesis reliably.
//   2. Text-parsed values win as a fallback when canonical omits a
//      field — text parse may find fields Textract didn't classify.
//   3. Never invent — a field null in both sources stays null.
//   4. NOT invoice-specific — general logic that applies to any
//      canonical extraction from any provider.

import type { CanonicalDocumentExtraction, ExtractedField } from "../document-extractors/canonical-model";
import type { ExtractedInvoice } from "../types";
import type { ExtractedVendorProfile } from "../vendor-profile-extract";
import type { LineItem } from "../line-items-extract";
import type { PdfExtractionAssessment } from "../document-class";

// -----------------------------------------------------------------------------
// Utility — coerce ExtractedField<T>.value → string / number / null
// -----------------------------------------------------------------------------

function s(f: ExtractedField<string> | undefined): string | null {
  return f?.value ?? null;
}
function n(f: ExtractedField<number> | undefined): number | null {
  return f?.value ?? null;
}
function decString(f: ExtractedField<number> | undefined): string | null {
  const v = n(f);
  return v == null ? null : v.toFixed(2);
}

// -----------------------------------------------------------------------------
// ExtractedInvoice merge — canonical overrides text-parsed values
// -----------------------------------------------------------------------------

export function mergeCanonicalIntoExtraction(
  base: ExtractedInvoice,
  canonical: CanonicalDocumentExtraction,
): ExtractedInvoice {
  const f = canonical.fields;
  return {
    ...base,
    state: "STRUCTURED",
    vendor: {
      ...base.vendor,
      guessedName: s(f.supplierName) ?? base.vendor.guessedName,
      guessedEmail: s(f.supplierEmail) ?? base.vendor.guessedEmail,
      guessedTaxNumber: s(f.taxRegistrationNumber) ?? base.vendor.guessedTaxNumber,
    },
    invoiceNumber: s(f.payableReference) ?? base.invoiceNumber,
    payableReferenceType: f.payableReferenceType ?? base.payableReferenceType ?? null,
    invoiceDate: s(f.invoiceDate) ?? base.invoiceDate,
    dueDate: s(f.dueDate) ?? base.dueDate,
    purchaseOrder: s(f.purchaseOrderNumber) ?? base.purchaseOrder,
    currency: s(f.currency) ?? base.currency,
    subtotal: decString(f.subtotal) ?? base.subtotal,
    taxTotal: decString(f.tax) ?? base.taxTotal,
    total: decString(f.total) ?? base.total,
    lineItems:
      canonical.lineItems.length > 0
        ? canonical.lineItems.map((li) => ({
            description: li.description.value,
            quantity: li.quantity != null ? String(li.quantity.value) : null,
            unitCost: li.unitPrice != null ? li.unitPrice.value.toFixed(2) : null,
            amount: li.amount.value.toFixed(2),
          }))
        : base.lineItems,
  };
}

// -----------------------------------------------------------------------------
// LineItem[] merge — for the structured lineItemsExtracted output
// -----------------------------------------------------------------------------

export function mergeCanonicalIntoLineItems(
  base: LineItem[],
  canonical: CanonicalDocumentExtraction,
): LineItem[] {
  if (canonical.lineItems.length === 0) return base;
  return canonical.lineItems.map<LineItem>((li, i) => ({
    description: li.description.value,
    quantity: li.quantity != null ? li.quantity.value : null,
    unitPrice: li.unitPrice != null ? li.unitPrice.value : null,
    amount: li.amount.value,
    taxRate: null,
    taxAmount: li.taxAmount != null ? li.taxAmount.value : null,
    taxTreatment: "unknown",
    evidence: [],
    confidence: Math.round(
      (li.description.validationConfidence + li.amount.validationConfidence) / 2,
    ),
    lineNo: i + 1,
  }));
}

// -----------------------------------------------------------------------------
// ExtractedVendorProfile merge — canonical structured address wins
// -----------------------------------------------------------------------------

function makeField(value: string | null, confidence: number): {
  value: string | null;
  confidence: number;
  source: "ocr" | null;
} {
  return {
    value,
    confidence: value ? confidence : 0,
    source: value ? "ocr" : null,
  };
}

export function mergeCanonicalIntoVendorProfile(
  base: ExtractedVendorProfile,
  canonical: CanonicalDocumentExtraction,
): ExtractedVendorProfile {
  const f = canonical.fields;
  const addr = f.supplierAddress;

  return {
    ...base,
    address: {
      line1: addr?.addressLine1
        ? makeField(addr.addressLine1.value, addr.addressLine1.validationConfidence)
        : base.address.line1,
      line2: addr?.addressLine2
        ? makeField(addr.addressLine2.value, addr.addressLine2.validationConfidence)
        : base.address.line2,
      city: addr?.city
        ? makeField(addr.city.value, addr.city.validationConfidence)
        : base.address.city,
      provinceState: addr?.provinceState
        ? makeField(addr.provinceState.value, addr.provinceState.validationConfidence)
        : base.address.provinceState,
      postalCode: addr?.postalCode
        ? makeField(addr.postalCode.value, addr.postalCode.validationConfidence)
        : base.address.postalCode,
      country: addr?.country
        ? makeField(addr.country.value, addr.country.validationConfidence)
        : base.address.country,
      blockConfidence: addr
        ? Math.max(base.address.blockConfidence, 75)
        : base.address.blockConfidence,
    },
    phone: f.supplierPhone
      ? makeField(f.supplierPhone.value, f.supplierPhone.validationConfidence)
      : base.phone,
    website: f.supplierWebsite
      ? makeField(f.supplierWebsite.value, f.supplierWebsite.validationConfidence)
      : base.website,
    customerSupportEmail: f.supplierEmail
      ? makeField(f.supplierEmail.value, f.supplierEmail.validationConfidence)
      : base.customerSupportEmail,
    taxRegistrationNumber: f.taxRegistrationNumber
      ? makeField(f.taxRegistrationNumber.value, f.taxRegistrationNumber.validationConfidence)
      : base.taxRegistrationNumber,
  };
}

// -----------------------------------------------------------------------------
// documentAssessment override — trust the router's assessment when
// canonical extraction exists (the analyser's re-assessment on the
// synthesized flat text can misclassify as UNSUPPORTED).
// -----------------------------------------------------------------------------

export function overrideAssessmentFromCanonical(
  base: PdfExtractionAssessment | null,
  canonical: CanonicalDocumentExtraction,
): PdfExtractionAssessment | null {
  if (!base) return base;
  return {
    ...base,
    documentClass: canonical.documentClass,
    // Layout / text coverage numbers are meaningless when the source
    // was OCR — leave them but expose the truth via documentClass.
    fallbackRequired: false,
    exceptions: base.exceptions.filter((e) => e !== "DOCUMENT_ANALYSIS_FAILED"),
  };
}
