// Sprint 3 · Checkpoint 15X (2026-07-30) — Textract AnalyzeExpense
// response → CanonicalDocumentExtraction normalizer.
//
// AnalyzeExpense returns ExpenseDocuments[], each with:
//   * SummaryFields[]     — invoice-level fields (VENDOR_NAME,
//                           INVOICE_RECEIPT_ID, TOTAL, etc.)
//   * LineItemGroups[]    — grouped by table region; each contains
//                           LineItems[] with LineItemExpenseFields[]
//                           (ITEM, PRICE, QUANTITY, etc.)
//   * Blocks[]            — raw layout blocks (bounding boxes)
//
// Each field carries Type.Text (canonical label like "VENDOR_NAME"),
// ValueDetection.Text (extracted value), ValueDetection.Confidence,
// LabelDetection (optional printed label), and PageNumber.

import type { AnalyzeExpenseCommandOutput, ExpenseField, ExpenseDocument } from "@aws-sdk/client-textract";
import type {
  CanonicalDocumentExtraction, CanonicalLineItem, ExtractedField,
  ExtractedAddress, DocumentExtractionWarning, BoundingRegion,
} from "./canonical-model";
import type { DocumentClass } from "../document-class";

// -----------------------------------------------------------------------------
// Public entrypoint
// -----------------------------------------------------------------------------

export function normalizeTextractExpense(
  response: AnalyzeExpenseCommandOutput,
  documentClass: DocumentClass,
): CanonicalDocumentExtraction {
  const warnings: DocumentExtractionWarning[] = [];
  const docs = response.ExpenseDocuments ?? [];
  if (docs.length === 0) {
    return {
      strategy: "AWS_TEXTRACT_EXPENSE",
      documentClass,
      pages: [],
      fields: {},
      lineItems: [],
      confidence: 0,
      warnings: [{ code: "DOCUMENT_ANALYSIS_FAILED", message: "Provider returned no ExpenseDocuments" }],
    };
  }

  // AnalyzeExpense sync = 1 page = 1 document.
  const primary = docs[0];
  const summary = primary.SummaryFields ?? [];
  const lineItemGroups = primary.LineItemGroups ?? [];

  const fields = mapSummaryFields(summary);
  const lineItems = mapLineItems(lineItemGroups);

  // Extract per-page metadata — Textract returns Blocks with
  // Page property; we just count distinct pages.
  const pageNumbers = new Set<number>();
  for (const f of summary) {
    if (f.PageNumber != null) pageNumbers.add(f.PageNumber);
  }
  for (const g of lineItemGroups) {
    for (const li of g.LineItems ?? []) {
      for (const f of li.LineItemExpenseFields ?? []) {
        if (f.PageNumber != null) pageNumbers.add(f.PageNumber);
      }
    }
  }
  const pages = [...pageNumbers].sort((a, b) => a - b).map((n) => ({ pageNumber: n }));

  // Overall confidence — average of populated field confidences.
  const populatedConfidences: number[] = [];
  for (const key of Object.keys(fields.fields) as Array<keyof typeof fields.fields>) {
    const f = fields.fields[key];
    if (!f) continue;
    if (typeof f === "object" && "providerConfidence" in f) {
      populatedConfidences.push(f.providerConfidence);
    } else if (key === "supplierAddress" && f) {
      const addr = f as ExtractedAddress;
      for (const subKey of Object.keys(addr) as Array<keyof ExtractedAddress>) {
        const sub = addr[subKey];
        if (sub) populatedConfidences.push(sub.providerConfidence);
      }
    }
  }
  const overallConfidence = populatedConfidences.length > 0
    ? Math.round(populatedConfidences.reduce((s, n) => s + n, 0) / populatedConfidences.length)
    : 0;

  // Warnings for reconciliation gaps.
  const subtotalValue = fields.fields.subtotal?.value ?? null;
  const taxValue = fields.fields.tax?.value ?? null;
  const totalValue = fields.fields.total?.value ?? null;
  if (subtotalValue != null && taxValue != null && totalValue != null) {
    const derived = subtotalValue + taxValue;
    if (Math.abs(derived - totalValue) > 0.05) {
      warnings.push({
        code: "ARITHMETIC_UNBALANCED",
        message: `subtotal + tax = ${derived.toFixed(2)} but total = ${totalValue.toFixed(2)}`,
      });
    }
  }
  if (!fields.fields.supplierName) warnings.push({ code: "MISSING_SUPPLIER", message: "Provider did not return a supplier name" });
  if (!fields.fields.payableReference) warnings.push({ code: "MISSING_PAYABLE_REFERENCE", message: "Provider did not return an invoice/statement/bill reference" });
  if (!fields.fields.total) warnings.push({ code: "MISSING_TOTAL", message: "Provider did not return an invoice total" });

  return {
    strategy: "AWS_TEXTRACT_EXPENSE",
    documentClass,
    pages,
    fields: fields.fields,
    lineItems,
    // Do not surface raw text — Textract expense does not concatenate a
    // clean flattened text and any raw text we compose here would leak
    // supplier details into diagnostic responses. Downstream token
    // matching uses the structured fields.
    rawText: undefined,
    confidence: overallConfidence,
    warnings,
  };
}

// -----------------------------------------------------------------------------
// Summary field mapping
// -----------------------------------------------------------------------------

interface SummaryFieldMap {
  fields: CanonicalDocumentExtraction["fields"];
}

function mapSummaryFields(summary: ExpenseField[]): SummaryFieldMap {
  const out: SummaryFieldMap = { fields: {} };

  // Address components accumulate across multiple provider labels.
  const addressComponents: {
    line1?: ExtractedField<string>;
    line2?: ExtractedField<string>;
    city?: ExtractedField<string>;
    provinceState?: ExtractedField<string>;
    postalCode?: ExtractedField<string>;
    country?: ExtractedField<string>;
    combined?: ExtractedField<string>;   // fallback: unparsed VENDOR_ADDRESS
  } = {};

  for (const f of summary) {
    const type = f.Type?.Text?.toUpperCase() ?? "";
    const valueText = f.ValueDetection?.Text?.trim();
    const confidence = f.ValueDetection?.Confidence ?? 0;
    if (!valueText) continue;
    const region = geometryToRegion(f.PageNumber ?? 1, f.ValueDetection?.Geometry);

    const strField = (): ExtractedField<string> => ({
      value: valueText,
      providerConfidence: Math.round(confidence),
      validationConfidence: Math.round(confidence),
      sourceStrategy: "AWS_TEXTRACT_EXPENSE",
      region,
      evidenceSnippet: `${type} → ${valueText.slice(0, 60)}`,
    });
    const numField = (): ExtractedField<number> | null => {
      const n = parseMoney(valueText);
      if (n == null) return null;
      return {
        value: n,
        providerConfidence: Math.round(confidence),
        validationConfidence: Math.round(confidence),
        sourceStrategy: "AWS_TEXTRACT_EXPENSE",
        region,
        evidenceSnippet: `${type} → ${valueText.slice(0, 60)}`,
      };
    };

    switch (type) {
      case "VENDOR_NAME":
        if (!out.fields.supplierName) out.fields.supplierName = strField();
        break;
      case "RECEIVER_NAME":
      case "CUSTOMER_NUMBER":
      case "BILL_TO":
      case "RECEIVER_ADDRESS":
        // Ignore — these are RECIPIENT-side, not supplier.
        break;
      case "VENDOR_ADDRESS":
      case "ADDRESS":
        addressComponents.combined = strField();
        break;
      case "STREET":
      case "VENDOR_STREET":
        addressComponents.line1 = strField();
        break;
      case "CITY":
      case "VENDOR_CITY":
        addressComponents.city = strField();
        break;
      case "STATE":
      case "VENDOR_STATE":
        addressComponents.provinceState = strField();
        break;
      case "ZIP_CODE":
      case "VENDOR_ZIP":
      case "POSTAL_CODE":
        addressComponents.postalCode = strField();
        break;
      case "COUNTRY":
      case "VENDOR_COUNTRY":
        addressComponents.country = strField();
        break;
      case "VENDOR_PHONE":
      case "PHONE":
        if (!out.fields.supplierPhone) out.fields.supplierPhone = strField();
        break;
      case "VENDOR_URL":
      case "WEBSITE":
        if (!out.fields.supplierWebsite) out.fields.supplierWebsite = strField();
        break;
      case "VENDOR_EMAIL":
      case "EMAIL":
        if (!out.fields.supplierEmail) out.fields.supplierEmail = strField();
        break;
      case "TAX_PAYER_ID":
      case "GST_NUMBER":
      case "HST_NUMBER":
      case "VAT_NUMBER":
      case "TAX_ID":
        if (!out.fields.taxRegistrationNumber) out.fields.taxRegistrationNumber = strField();
        break;
      case "INVOICE_RECEIPT_ID":
      case "INVOICE_NUMBER":
        if (!out.fields.payableReference) {
          out.fields.payableReference = strField();
          out.fields.payableReferenceType = "INVOICE_NUMBER";
        }
        break;
      case "STATEMENT_NUMBER":
        if (!out.fields.payableReference) {
          out.fields.payableReference = strField();
          out.fields.payableReferenceType = "STATEMENT_NUMBER";
        }
        break;
      case "PO_NUMBER":
      case "PURCHASE_ORDER":
        if (!out.fields.purchaseOrderNumber) out.fields.purchaseOrderNumber = strField();
        break;
      case "INVOICE_RECEIPT_DATE":
      case "INVOICE_DATE":
        if (!out.fields.invoiceDate) out.fields.invoiceDate = strField();
        break;
      case "DUE_DATE":
      case "PAYMENT_DUE_DATE":
        if (!out.fields.dueDate) out.fields.dueDate = strField();
        break;
      case "SUBTOTAL":
        if (!out.fields.subtotal) {
          const n = numField();
          if (n) out.fields.subtotal = n;
        }
        break;
      case "TAX":
      case "TOTAL_TAX":
      case "TAX_AMOUNT":
        if (!out.fields.tax) {
          const n = numField();
          if (n) out.fields.tax = n;
        }
        break;
      case "TOTAL":
      case "AMOUNT_DUE":
      case "GRAND_TOTAL":
      case "AMOUNT":
        if (!out.fields.total) {
          const n = numField();
          if (n) out.fields.total = n;
        }
        break;
    }
  }

  // Assemble supplierAddress from components. If any component is
  // populated, emit the address object; otherwise leave undefined.
  const anyComponent = addressComponents.line1 || addressComponents.line2
    || addressComponents.city || addressComponents.provinceState
    || addressComponents.postalCode || addressComponents.country
    || addressComponents.combined;
  if (anyComponent) {
    const addr: ExtractedAddress = {};
    if (addressComponents.line1) addr.addressLine1 = addressComponents.line1;
    else if (addressComponents.combined && !addressComponents.city) {
      // Fallback — dump the combined provider value into line1.
      addr.addressLine1 = addressComponents.combined;
    }
    if (addressComponents.line2) addr.addressLine2 = addressComponents.line2;
    if (addressComponents.city) addr.city = addressComponents.city;
    if (addressComponents.provinceState) addr.provinceState = addressComponents.provinceState;
    if (addressComponents.postalCode) addr.postalCode = addressComponents.postalCode;
    if (addressComponents.country) addr.country = addressComponents.country;
    out.fields.supplierAddress = addr;
  }

  return out;
}

// -----------------------------------------------------------------------------
// Line items
// -----------------------------------------------------------------------------

function mapLineItems(groups: Array<{ LineItems?: Array<{ LineItemExpenseFields?: ExpenseField[] }> }>): CanonicalLineItem[] {
  const out: CanonicalLineItem[] = [];
  for (const group of groups) {
    for (const li of group.LineItems ?? []) {
      let description: ExtractedField<string> | undefined;
      let quantity: ExtractedField<number> | undefined;
      let unitPrice: ExtractedField<number> | undefined;
      let amount: ExtractedField<number> | undefined;
      let taxAmount: ExtractedField<number> | undefined;
      let productCode: ExtractedField<string> | undefined;
      for (const f of li.LineItemExpenseFields ?? []) {
        const type = f.Type?.Text?.toUpperCase() ?? "";
        const valueText = f.ValueDetection?.Text?.trim();
        const confidence = f.ValueDetection?.Confidence ?? 0;
        if (!valueText) continue;
        const region = geometryToRegion(f.PageNumber ?? 1, f.ValueDetection?.Geometry);
        const str = (): ExtractedField<string> => ({
          value: valueText,
          providerConfidence: Math.round(confidence),
          validationConfidence: Math.round(confidence),
          sourceStrategy: "AWS_TEXTRACT_EXPENSE",
          region,
        });
        const num = (): ExtractedField<number> | null => {
          const n = parseMoney(valueText);
          if (n == null) return null;
          return {
            value: n,
            providerConfidence: Math.round(confidence),
            validationConfidence: Math.round(confidence),
            sourceStrategy: "AWS_TEXTRACT_EXPENSE",
            region,
          };
        };
        switch (type) {
          case "ITEM":
          case "PRODUCT":
          case "DESCRIPTION":
            if (!description) description = str();
            break;
          case "QUANTITY":
            if (!quantity) { const n = num(); if (n) quantity = n; }
            break;
          case "UNIT_PRICE":
          case "PRICE":
            if (!unitPrice) { const n = num(); if (n) unitPrice = n; }
            break;
          case "SUBTOTAL":
          case "TOTAL":
          case "AMOUNT":
          case "EXPENSE_ROW":
            if (!amount) { const n = num(); if (n) amount = n; }
            break;
          case "TAX":
            if (!taxAmount) { const n = num(); if (n) taxAmount = n; }
            break;
          case "PRODUCT_CODE":
          case "SKU":
            if (!productCode) productCode = str();
            break;
        }
      }
      // Skip empty rows.
      if (!description && !amount) continue;
      out.push({
        description: description ?? {
          value: "(unspecified line)",
          providerConfidence: 0,
          validationConfidence: 0,
          sourceStrategy: "AWS_TEXTRACT_EXPENSE",
        },
        quantity, unitPrice,
        amount: amount ?? {
          value: 0,
          providerConfidence: 0,
          validationConfidence: 0,
          sourceStrategy: "AWS_TEXTRACT_EXPENSE",
        },
        taxAmount, productCode,
      });
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function parseMoney(raw: string): number | null {
  const cleaned = raw.replace(/[^0-9.\-]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function geometryToRegion(page: number, geometry?: { BoundingBox?: { Left?: number; Top?: number; Width?: number; Height?: number } }): BoundingRegion | undefined {
  const bb = geometry?.BoundingBox;
  if (!bb) return undefined;
  return {
    page,
    x: Math.round((bb.Left ?? 0) * 1000) / 1000,
    y: Math.round((bb.Top ?? 0) * 1000) / 1000,
    width: Math.round((bb.Width ?? 0) * 1000) / 1000,
    height: Math.round((bb.Height ?? 0) * 1000) / 1000,
  };
}
