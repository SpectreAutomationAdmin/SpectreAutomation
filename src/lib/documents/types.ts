// Sprint 3 Checkpoint 15D (2026-07-24) — Shared contracts for the
// immutable ingested-document layer.
//
// Everything here is a CLOSED enumeration. Do NOT widen these enums
// without an explicit checkpoint change — the source-contract test
// suite locks each set.

export const INGESTED_DOCUMENT_SOURCE_KINDS = ["EMAIL_ATTACHMENT"] as const;
export type IngestedDocumentSourceKind =
  (typeof INGESTED_DOCUMENT_SOURCE_KINDS)[number];

export const INGESTED_DOCUMENT_CLASSIFICATIONS = [
  "UNKNOWN",
  "INVOICE",
  "STATEMENT",
  "CREDIT_NOTE",
  "PURCHASE_ORDER",
  "REMITTANCE",
  "OTHER",
] as const;
export type IngestedDocumentClassification =
  (typeof INGESTED_DOCUMENT_CLASSIFICATIONS)[number];

export const INGESTED_DOCUMENT_STATUSES = [
  "STORED",
  "REFUSED_UNSAFE_TYPE",
  "REFUSED_TOO_LARGE",
  "REFUSED_CORRUPT",
  "REFUSED_DUPLICATE_SUPERSEDED",
] as const;
export type IngestedDocumentStatus = (typeof INGESTED_DOCUMENT_STATUSES)[number];

// Evidence target kinds — closed enumeration.
//   * 15D added WORK_INTAKE_ITEM.
//   * 15E added AP_INVOICE (ingested PDF as AP-invoice audit support).
//   * 15G adds VENDOR_STATEMENT_RECONCILIATION (statement PDF linked
//     to the reconciliation situation it produced).
//   Widening this list requires an explicit checkpoint change.
export const INGESTED_DOCUMENT_EVIDENCE_TARGET_KINDS = [
  "WORK_INTAKE_ITEM",
  "AP_INVOICE",
  "VENDOR_STATEMENT_RECONCILIATION",
] as const;
export type IngestedDocumentEvidenceTargetKind =
  (typeof INGESTED_DOCUMENT_EVIDENCE_TARGET_KINDS)[number];

export const INGESTED_DOCUMENT_EVIDENCE_ROLES = ["PRIMARY", "EVIDENCE"] as const;
export type IngestedDocumentEvidenceRole =
  (typeof INGESTED_DOCUMENT_EVIDENCE_ROLES)[number];

export const INGESTED_DOCUMENT_AUDIT_ACTIONS = [
  "INGESTED",
  "DUPLICATE_DETECTED",
  "RETRIEVED_METADATA",
  "RETRIEVED_PREVIEW",
  "RETRIEVED_DOWNLOAD",
  "REFUSED",
  "EVIDENCE_LINKED",
  "EVIDENCE_UNLINKED",
] as const;
export type IngestedDocumentAuditAction =
  (typeof INGESTED_DOCUMENT_AUDIT_ACTIONS)[number];

// ---------------------------------------------------------------------------
// Errors — every operational error thrown by the document layer maps to
// exactly one category so callers can distinguish user-visible from
// operational faults.
// ---------------------------------------------------------------------------
export type DocumentErrorCategory =
  | "TENANT_MISMATCH"
  | "UNSAFE_MIME"
  | "OVERSIZED"
  | "CORRUPT_DOWNLOAD"
  | "STORAGE_FAILURE"
  | "MISSING_INPUT"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "UNEXPECTED";

export class DocumentError extends Error {
  category: DocumentErrorCategory;
  constructor(category: DocumentErrorCategory, message: string) {
    super(message);
    this.name = "DocumentError";
    this.category = category;
  }
}

// ---------------------------------------------------------------------------
// Storage adapter contract — narrow, immutable put + get + delete. The
// delete path exists for GDPR / retention wipes only; ingest never deletes
// on the happy path (immutability rule).
// ---------------------------------------------------------------------------
export interface DocumentStorageAdapter {
  bucket: string;
  put(args: {
    storageKey: string;
    body: Buffer;
    mimeType: string;
  }): Promise<void>;
  get(args: { storageKey: string }): Promise<Buffer | null>;
  delete(args: { storageKey: string }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Result shape for the ingest pipeline. Small on purpose so a caller (a
// queue handler) can log the outcome and move on.
// ---------------------------------------------------------------------------
export interface IngestResult {
  outcome:
    | "STORED_NEW"
    | "STORED_DUPLICATE_LINKED"
    | "REFUSED_UNSAFE_TYPE"
    | "REFUSED_TOO_LARGE"
    | "REFUSED_CORRUPT";
  documentId?: string;
  sha256Hash?: string;
  classification?: IngestedDocumentClassification;
  storageBucket?: string;
  storageKey?: string;
  byteLength?: number;
  reason?: string;
}
