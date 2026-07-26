// Shared AP types & enums.

export const VENDOR_STATUSES = ["DRAFT", "PENDING_APPROVAL", "ACTIVE", "INACTIVE", "BLOCKED"] as const;
export type VendorStatus = (typeof VENDOR_STATUSES)[number];

export const BANKING_STATUSES = ["DRAFT", "PENDING_APPROVAL", "VERIFIED", "REJECTED", "INACTIVE"] as const;
export type BankingStatus = (typeof BANKING_STATUSES)[number];

export const AP_INVOICE_STATUSES = [
  "DRAFT", "PENDING_APPROVAL", "APPROVED", "POSTED",
  "PARTIALLY_PAID", "PAID", "VOIDED", "DISPUTED",
] as const;
export type APInvoiceStatus = (typeof AP_INVOICE_STATUSES)[number];

export const PAYMENT_BATCH_STATUSES = [
  "DRAFT", "PENDING_APPROVAL", "APPROVED", "PROCESSING", "PROCESSED", "VOIDED",
] as const;
export type PaymentBatchStatus = (typeof PAYMENT_BATCH_STATUSES)[number];

export const VENDOR_PAYMENT_METHODS = ["EFT", "CHEQUE", "CC", "CASH", "OTHER"] as const;
export type VendorPaymentMethod = (typeof VENDOR_PAYMENT_METHODS)[number];

export const APPROVAL_ENTITY_TYPES = ["AP_INVOICE", "VENDOR", "VENDOR_BANKING", "PAYMENT_BATCH"] as const;
export type ApprovalEntityType = (typeof APPROVAL_ENTITY_TYPES)[number];

export const AP_EXCEPTION_KINDS = [
  "DUPLICATE_INVOICE_NUMBER",
  "DUPLICATE_AMOUNT_DATE",
  "NEW_VENDOR",
  "BANKING_RECENTLY_CHANGED",
  "EXCEEDS_NORMAL_SPEND",
  "UNEXPECTED_TAX",
  "MISSING_ATTACHMENT",
  "SELF_APPROVED",
  "EARLY_PAYMENT",
  "BLOCKED_VENDOR",
] as const;
export type APExceptionKind = (typeof AP_EXCEPTION_KINDS)[number];

// Default approval-policy rules used to seed clubs. Each rule says: when the
// amount is <= maxAmount (or null = catch-all), we need `requiredApprovals`
// distinct approvers, each holding one of `eligibleRoleKeys`.
export type ApprovalRule = {
  maxAmount: number | null;
  requiredApprovals: number;
  eligibleRoleKeys: string[];
};
