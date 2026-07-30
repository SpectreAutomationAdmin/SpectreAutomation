// Sprint 3 · Checkpoint 15X (2026-07-30) — provider-neutral document
// extraction model.
//
// The rest of Spectre must not depend on Textract (or any future
// provider's) response types. Every extraction strategy — embedded
// text, positioned text, AWS Textract AnalyzeExpense, future OCR
// providers — normalizes into this shape. Callers see the same
// contract regardless of how the document was read.

import type { DocumentClass, DocumentException } from "../document-class";

export type DocumentExtractionStrategy =
  | "EMBEDDED_TEXT"
  | "POSITIONED_TEXT"
  | "AWS_TEXTRACT_EXPENSE"
  | "UNREADABLE";

export type PayableReferenceType =
  | "INVOICE_NUMBER"
  | "STATEMENT_NUMBER"
  | "BILL_NUMBER"
  | "REFERENCE_NUMBER"
  | "OTHER";

export interface BoundingRegion {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ExtractedField<T> {
  value: T;
  // Provider-reported confidence (0..100) OR our own heuristic score.
  providerConfidence: number;
  // Spectre validation confidence — reduced when arithmetic /
  // taxonomy checks disagreed with the provider.
  validationConfidence: number;
  // Which strategy produced this field.
  sourceStrategy: DocumentExtractionStrategy;
  // Optional bounding region when the strategy tracks geometry.
  region?: BoundingRegion;
  // Short human-readable evidence snippet for diagnostics.
  evidenceSnippet?: string;
}

export interface ExtractedAddress {
  addressLine1?: ExtractedField<string>;
  addressLine2?: ExtractedField<string>;
  city?: ExtractedField<string>;
  provinceState?: ExtractedField<string>;
  postalCode?: ExtractedField<string>;
  country?: ExtractedField<string>;
}

export interface CanonicalLineItem {
  description: ExtractedField<string>;
  quantity?: ExtractedField<number>;
  unitPrice?: ExtractedField<number>;
  amount: ExtractedField<number>;
  taxAmount?: ExtractedField<number>;
  // Optional additional metadata from providers that return column
  // hints — kept generic so consumers don't depend on Textract types.
  productCode?: ExtractedField<string>;
  category?: ExtractedField<string>;
}

export interface CanonicalPage {
  pageNumber: number;
  width?: number;
  height?: number;
  // Optional raw text of the page after the strategy's normalization.
  rawText?: string;
}

export interface DocumentExtractionWarning {
  code: DocumentException | "PROVIDER_LOW_CONFIDENCE" | "ARITHMETIC_UNBALANCED" | "MISSING_SUPPLIER" | "MISSING_PAYABLE_REFERENCE" | "MISSING_TOTAL";
  message: string;
  region?: BoundingRegion;
}

export interface CanonicalDocumentExtraction {
  strategy: DocumentExtractionStrategy;
  documentClass: DocumentClass;

  pages: CanonicalPage[];

  fields: {
    supplierName?: ExtractedField<string>;
    supplierAddress?: ExtractedAddress;
    supplierPhone?: ExtractedField<string>;
    supplierWebsite?: ExtractedField<string>;
    supplierEmail?: ExtractedField<string>;
    taxRegistrationNumber?: ExtractedField<string>;

    payableReference?: ExtractedField<string>;
    payableReferenceType?: PayableReferenceType;

    invoiceDate?: ExtractedField<string>;
    dueDate?: ExtractedField<string>;
    purchaseOrderNumber?: ExtractedField<string>;

    subtotal?: ExtractedField<number>;
    tax?: ExtractedField<number>;
    total?: ExtractedField<number>;
    currency?: ExtractedField<string>;
  };

  lineItems: CanonicalLineItem[];

  // Optional raw text (flattened) — retained for downstream token
  // matching (economic-purpose classification etc.). Strategies that
  // don't have a flattened text form leave this null.
  rawText?: string;

  // Overall document extraction confidence (0..100). NOT to be used
  // as an accounting confidence — downstream validation applies
  // reconciliation checks before GL / vendor decisions.
  confidence: number;

  warnings: DocumentExtractionWarning[];
}
