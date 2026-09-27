// PAY-1A (2026-09-26) — shared Payments infrastructure barrel.

export * from "./types";
export * from "./kill-switch";
export * from "./fingerprint";
export * from "./events";
export * from "./destination";
export * from "./run";
export * from "./instruction";
export type {
  PaymentProvider,
  ProviderSubmitInput,
  ProviderSubmitOutcome,
  ProviderStatusQueryOutcome,
  ProviderCancelOutcome,
} from "./provider";
export * from "./payroll-source";
export * from "./authorization";
export * from "./submission";
export type { RetrySubmitOutcome } from "./submission";
export * from "./accounting";
export { getSimulator, resetSimulator, SimulatorProvider, getSimulatorV2 } from "./provider/simulator";
export { selectProvider } from "./provider/selector";
export * from "./provider/contract";
export * from "./provider/connection";
export * from "./external-events";
