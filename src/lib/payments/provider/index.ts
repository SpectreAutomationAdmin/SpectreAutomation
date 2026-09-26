// PAY-1A (2026-09-26) — bank-independent Payment Provider interface.
//
// Two conceptual layers:
//   1. The provider INTERFACE (this file) — what any adapter must
//      implement. Bank-neutral by design; supports EFT, ACSS, RTR,
//      wires, or any future Canadian rail without leaking rail names
//      into the domain.
//   2. Provider IMPLEMENTATIONS — the simulator lives at ./simulator.
//      Any future real provider (never present in PAY-1A) must:
//        • declare `movesRealMoney: true`
//        • call `assertRealMoneyEnabled()` inside its constructor AND
//          inside every submit method (defense in depth)
//        • be unable to be imported dynamically without the env gate

import type { ProviderCapabilityDeclaration } from "../kill-switch";

export interface ProviderSubmitInput {
  clubId: string;
  runId: string;
  instructionId: string;
  amount: string;        // Decimal-safe string
  currency: string;
  requestedExecutionDate: Date;
  idempotencyKey: string; // MUST be stable across retries for the same instruction
  // Bank-neutral destination handle. The provider adapter resolves
  // this against its own store (e.g. via KMS refs on the snapshot).
  destinationRef: string; // opaque to the caller — provider decides
  // Bank-neutral funding handle.
  fundingRef: string;
}

export interface ProviderSubmitOutcome {
  providerInstructionId: string; // MUST be stable across retries for the same idempotencyKey
  status: "SUBMITTED" | "ACCEPTED" | "REJECTED"; // sync outcome
  providerReference?: string;
  rejectionCode?: string;
  rejectionDescription?: string;
}

export interface ProviderStatusQueryOutcome {
  providerInstructionId: string;
  status: "SUBMITTED" | "ACCEPTED" | "SETTLED" | "REJECTED" | "RETURNED" | "CANCELLED";
  providerReference?: string;
  settledAt?: Date;
  returnedAt?: Date;
  returnCode?: string;
  returnDescription?: string;
}

export interface ProviderCancelOutcome {
  providerInstructionId: string;
  cancelled: boolean;
  reason?: string;
}

export interface PaymentProvider extends ProviderCapabilityDeclaration {
  submit(input: ProviderSubmitInput): Promise<ProviderSubmitOutcome>;
  getStatus(providerInstructionId: string): Promise<ProviderStatusQueryOutcome>;
  cancel(providerInstructionId: string, reason?: string): Promise<ProviderCancelOutcome>;
}
