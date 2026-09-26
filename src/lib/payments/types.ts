// PAY-1A (2026-09-26) — shared Payments type surface.
//
// Payment lifecycle states and permitted transitions are defined
// here so both the service layer and the provider adapter share a
// single source of truth.

export const PAYMENT_SOURCE_TYPES = [
  "PAYROLL",
  "ACCOUNTS_PAYABLE",
  "REFUND",
  "OTHER_APPROVED_DISBURSEMENT",
] as const;
export type PaymentSourceType = (typeof PAYMENT_SOURCE_TYPES)[number];

export const RECIPIENT_TYPES = ["EMPLOYEE", "VENDOR", "MEMBER", "OTHER"] as const;
export type RecipientType = (typeof RECIPIENT_TYPES)[number];

export const PAYMENT_RUN_STATES = [
  "PREPARED",
  "PENDING_AUTHORIZATION",
  "AUTHORIZED",
  "SCHEDULED",
  "SUBMITTING",
  "SUBMITTED",
  "ACCEPTED",
  "SETTLED",
  "REJECTED",
  "RETURNED",
  "CANCELLED",
] as const;
export type PaymentRunState = (typeof PAYMENT_RUN_STATES)[number];

export const PAYMENT_INSTRUCTION_STATES = [
  "PREPARED",
  "AUTHORIZED",
  "SCHEDULED",
  "SUBMITTING",
  "SUBMITTED",
  "ACCEPTED",
  "SETTLED",
  "REJECTED",
  "RETURNED",
  "CANCELLED",
] as const;
export type PaymentInstructionState = (typeof PAYMENT_INSTRUCTION_STATES)[number];

// Terminal states — no further transitions permitted.
export const TERMINAL_RUN_STATES: readonly PaymentRunState[] = [
  "SETTLED",
  "REJECTED",
  "RETURNED",
  "CANCELLED",
] as const;

// State machine — permitted `from → to` transitions for the Run.
// Instruction transitions mirror the Run except for the intermediate
// PENDING_AUTHORIZATION which lives at the Run level.
const RUN_TRANSITIONS: Record<PaymentRunState, readonly PaymentRunState[]> = {
  PREPARED:              ["PENDING_AUTHORIZATION", "CANCELLED"],
  PENDING_AUTHORIZATION: ["AUTHORIZED", "PREPARED", "CANCELLED"],
  AUTHORIZED:            ["SCHEDULED", "CANCELLED"],
  SCHEDULED:             ["SUBMITTING", "CANCELLED"],
  SUBMITTING:            ["SUBMITTED", "REJECTED"],
  SUBMITTED:             ["ACCEPTED", "REJECTED"],
  ACCEPTED:              ["SETTLED", "RETURNED"],
  SETTLED:               ["RETURNED"],
  REJECTED:              [],
  RETURNED:              [],
  CANCELLED:             [],
};

export function canTransitionRunState(
  from: PaymentRunState,
  to: PaymentRunState,
): boolean {
  return RUN_TRANSITIONS[from]?.includes(to) ?? false;
}

// Domain events — 1:1 with the founder's §38 list.
export const PAYMENT_EVENT_TYPES = [
  "PAYMENT_CREATED",
  "PAYMENT_PREPARED",
  "PAYMENT_SUBMITTED_FOR_AUTHORIZATION",
  "PAYMENT_RETURNED_FOR_CHANGES",
  "PAYMENT_AUTHORIZED",
  "PAYMENT_SCHEDULED",
  "PAYMENT_SUBMISSION_STARTED",
  "PAYMENT_SUBMITTED",
  "PAYMENT_ACCEPTED",
  "PAYMENT_REJECTED",
  "PAYMENT_SETTLED",
  "PAYMENT_RETURNED",
  "PAYMENT_CANCELLED",
  "AUTHORIZATION_INVALIDATED",
] as const;
export type PaymentEventType = (typeof PAYMENT_EVENT_TYPES)[number];

export type PaymentProviderType = "SIMULATOR"; // PAY-1A intentionally exposes only the simulator.

// Material fields covered by the payment fingerprint. Any mutation
// of any of these invalidates an existing authorization.
export interface PaymentInstructionMaterialFields {
  clubId: string;
  runId: string;
  sourceType: PaymentSourceType;
  sourceId: string | null;
  recipientType: RecipientType;
  recipientId: string;
  amount: string;              // Decimal serialized as string for stability
  currency: string;
  destinationSnapshotId: string;
  requestedExecutionDate: string; // ISO date
  fundingBankAccountId: string;
}

export interface PaymentRunMaterialFields {
  clubId: string;
  runNumber: string;
  sourceType: PaymentSourceType;
  sourceId: string | null;
  fundingBankAccountId: string;
  currency: string;
  requestedExecutionDate: string;
  totalAmount: string;
  instructionFingerprints: string[]; // ordered by (recipientType, recipientId)
}
