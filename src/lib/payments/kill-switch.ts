// PAY-1A (2026-09-26) — dual-capability kill switch.
//
// The founder's brief §4 and §50-§53 require that PAY-1A make it
// structurally impossible for staging to transmit real money, while
// still exercising the complete simulated lifecycle.
//
// Two distinct capabilities (never merged):
//
//   PAYMENTS_ENABLED             — is the Payments module active at
//                                  all? Default true. If false, no
//                                  payment run may be prepared,
//                                  authorized, or submitted.
//   PAYMENTS_REAL_MONEY_ENABLED  — may a provider that CAN move real
//                                  money be constructed or invoked?
//                                  Default false. Staging MUST have
//                                  this false permanently.
//
// The simulator is a first-class provider that does NOT move real
// money; it can operate whenever PAYMENTS_ENABLED is true regardless
// of PAYMENTS_REAL_MONEY_ENABLED.
//
// This module is imported by EVERY payment-submission code path
// (web, workers, queues, scheduled jobs). A future real provider
// must call `assertRealMoneyEnabled()` inside its constructor and
// its submit method — impossible to skip.

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export function paymentsEnabled(): boolean {
  const raw = process.env.PAYMENTS_ENABLED?.toLowerCase();
  // Default true — the module is normally on.
  return raw === undefined || TRUTHY.has(raw);
}

export function realMoneyEnabled(): boolean {
  const raw = process.env.PAYMENTS_REAL_MONEY_ENABLED?.toLowerCase();
  // Default FALSE — real money is off unless a caller-defined
  // environment explicitly opts in. Staging leaves this unset.
  return raw !== undefined && TRUTHY.has(raw);
}

export class PaymentsDisabledError extends Error {
  constructor() {
    super("PAY-1A: Payments module is disabled (PAYMENTS_ENABLED=false).");
    this.name = "PaymentsDisabledError";
  }
}

export class RealMoneyDisabledError extends Error {
  constructor() {
    super(
      "PAY-1A: Real-money payment capability is structurally disabled (PAYMENTS_REAL_MONEY_ENABLED is not true). " +
        "Only the simulator provider may be constructed or invoked.",
    );
    this.name = "RealMoneyDisabledError";
  }
}

export function assertPaymentsEnabled(): void {
  if (!paymentsEnabled()) throw new PaymentsDisabledError();
}

export function assertRealMoneyEnabled(): void {
  if (!realMoneyEnabled()) throw new RealMoneyDisabledError();
}

// Providers advertise whether they can move real money. Any provider
// with `movesRealMoney: true` MUST be gated by `assertRealMoneyEnabled`
// at construction time. The simulator sets `movesRealMoney: false`.
export interface ProviderCapabilityDeclaration {
  providerType: string;
  movesRealMoney: boolean;
}

export function assertProviderConstructionAllowed(
  cap: ProviderCapabilityDeclaration,
): void {
  assertPaymentsEnabled();
  if (cap.movesRealMoney) assertRealMoneyEnabled();
}
