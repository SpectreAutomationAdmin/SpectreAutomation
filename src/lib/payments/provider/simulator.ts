// PAY-1A/4 (2026-09-26) — Deterministic Simulator Provider.
//
// A first-class Payment Provider that exercises the SAME code path as
// any future real provider — bank-independent submit + status +
// cancel — but never touches a bank. `movesRealMoney: false`, so it is
// allowed even when `PAYMENTS_REAL_MONEY_ENABLED=false`.
//
// Supported deterministic behaviours (§21):
//   1. accepted payment (default)
//   2. rejected payment (directive: REJECT)
//   3. settlement (default: auto-transitions ACCEPTED → SETTLED at check)
//   4. returned payment (directive: RETURN)
//   5. provider timeout (directive: TIMEOUT)
//   6. retry (retry works via idempotency — see submit())
//   7. duplicate submission attempt (returns same providerInstructionId)
//   8. partial batch acceptance/failure (per-instruction directives
//      let a caller set mixed outcomes across a run)
//
// The simulator maintains its own in-process state store (Map). This
// is intentional — the "provider" is external to the domain, so its
// state should not leak into our DB except via the domain's status
// updates and PaymentEvents. Tests that need cross-process persistence
// can seed the singleton via `resetSimulator`.

import { createHash } from "node:crypto";
import { assertProviderConstructionAllowed } from "../kill-switch";
import type {
  PaymentProvider,
  ProviderSubmitInput,
  ProviderSubmitOutcome,
  ProviderStatusQueryOutcome,
  ProviderCancelOutcome,
} from "./index";
import type {
  PaymentProviderV2,
  ProviderCapabilities,
  ProviderSubmissionResultV2,
  ProviderStatusResultV2,
  ProviderCancelResultV2,
  ExternalPaymentEventEnvelope,
  ExternalPaymentEventType,
  ProviderProcessingStatus,
} from "./contract";

// -----------------------------------------------------------------
// Directive shape — per-instruction control.
// -----------------------------------------------------------------
export type SimulatorDirective =
  | { kind: "ACCEPT_THEN_SETTLE" }             // default
  | { kind: "REJECT"; code?: string; description?: string }
  | { kind: "TIMEOUT" }                          // submit throws
  | { kind: "RETURN_AFTER_SETTLE"; code?: string; description?: string };

export interface SimulatorConfig {
  // Per-idempotencyKey directives. Missing keys default to ACCEPT_THEN_SETTLE.
  directives?: Map<string, SimulatorDirective>;
}

// In-memory persistence per-provider-instance.
interface SimState {
  providerInstructionId: string;
  status: "SUBMITTED" | "ACCEPTED" | "SETTLED" | "REJECTED" | "RETURNED" | "CANCELLED";
  providerReference: string;
  submitCallCount: number; // for retry-idempotency assertions
  rejectionCode?: string;
  rejectionDescription?: string;
  returnCode?: string;
  returnDescription?: string;
  settledAt?: Date;
  returnedAt?: Date;
}

// Singleton instance (per Node process). Tests reset it.
let SIM_SINGLETON: SimulatorProvider | null = null;
export function getSimulator(config?: SimulatorConfig): SimulatorProvider {
  if (!SIM_SINGLETON) SIM_SINGLETON = new SimulatorProvider(config);
  else if (config?.directives) SIM_SINGLETON.replaceDirectives(config.directives);
  return SIM_SINGLETON;
}
export function resetSimulator(): void {
  SIM_SINGLETON = null;
}

let COUNTER = 0;
function nextProviderRef(): string {
  COUNTER += 1;
  return `SIM-PAY-${String(COUNTER).padStart(6, "0")}`;
}

// PAY-1B/1 — v2 capability declaration. The simulator supports every
// axis a Canadian rail could exercise so the conformance suite can
// verify every capability path.
const SIMULATOR_CAPABILITIES: ProviderCapabilities = {
  supportsSubmission: true,
  supportsStatusLookup: true,
  supportsCancellation: true,
  supportsAsyncEvents: true,
  supportsReturns: true,
  supportsBatchSubmission: false,
  supportsPerInstructionStatus: true,
  supportsScheduledExecution: true,
  supportsRealTimePayments: false,
  supportsBatchEft: false,
};

export class SimulatorProvider implements PaymentProvider {
  public readonly providerType = "SIMULATOR";
  public readonly capabilities = SIMULATOR_CAPABILITIES;
  public readonly movesRealMoney = false;

  // Idempotency: idempotencyKey → SimState. Retries return the same row.
  private readonly byIdemKey = new Map<string, SimState>();
  // Providers surface a distinct id per instruction to callers.
  private readonly byProviderId = new Map<string, SimState>();
  private directives: Map<string, SimulatorDirective>;

  constructor(config: SimulatorConfig = {}) {
    assertProviderConstructionAllowed({
      providerType: this.providerType,
      movesRealMoney: this.movesRealMoney,
    });
    this.directives = config.directives ?? new Map();
  }

  replaceDirectives(directives: Map<string, SimulatorDirective>): void {
    this.directives = directives;
  }

  setDirective(idempotencyKey: string, directive: SimulatorDirective): void {
    this.directives.set(idempotencyKey, directive);
  }

  async submit(input: ProviderSubmitInput): Promise<ProviderSubmitOutcome> {
    // Idempotency: same key → same result, always.
    const existing = this.byIdemKey.get(input.idempotencyKey);
    if (existing) {
      existing.submitCallCount += 1;
      return this.outcomeFor(existing);
    }
    const directive = this.directives.get(input.idempotencyKey) ?? { kind: "ACCEPT_THEN_SETTLE" as const };
    if (directive.kind === "TIMEOUT") {
      // Do NOT create state — the caller must retry.
      throw new Error("SIM: provider timeout — retry required.");
    }

    const state: SimState = {
      providerInstructionId: `SPI-${input.instructionId.slice(-8)}-${Math.random().toString(36).slice(2, 8)}`,
      status: directive.kind === "REJECT" ? "REJECTED" : "SUBMITTED",
      providerReference: nextProviderRef(),
      submitCallCount: 1,
      rejectionCode: directive.kind === "REJECT" ? directive.code : undefined,
      rejectionDescription: directive.kind === "REJECT" ? directive.description : undefined,
    };
    this.byIdemKey.set(input.idempotencyKey, state);
    this.byProviderId.set(state.providerInstructionId, state);
    return this.outcomeFor(state);
  }

  async getStatus(providerInstructionId: string): Promise<ProviderStatusQueryOutcome> {
    const state = this.byProviderId.get(providerInstructionId);
    if (!state) throw new Error(`SIM: unknown providerInstructionId ${providerInstructionId}`);
    // ACCEPT_THEN_SETTLE auto-advances to SETTLED on first status check
    // after being SUBMITTED. RETURN_AFTER_SETTLE goes SUBMITTED → SETTLED
    // → RETURNED across sequential checks.
    // Find the directive by scanning the idem map — cheap for PAY-1A.
    let dir: SimulatorDirective = { kind: "ACCEPT_THEN_SETTLE" };
    for (const [k, s] of this.byIdemKey.entries()) {
      if (s === state) {
        dir = this.directives.get(k) ?? { kind: "ACCEPT_THEN_SETTLE" };
        break;
      }
    }
    if (state.status === "SUBMITTED") {
      if (dir.kind === "ACCEPT_THEN_SETTLE" || dir.kind === "RETURN_AFTER_SETTLE") {
        state.status = "ACCEPTED";
      } else if (dir.kind === "REJECT") {
        state.status = "REJECTED";
      }
    } else if (state.status === "ACCEPTED") {
      if (dir.kind === "ACCEPT_THEN_SETTLE" || dir.kind === "RETURN_AFTER_SETTLE") {
        state.status = "SETTLED";
        state.settledAt = new Date();
      }
    } else if (state.status === "SETTLED" && dir.kind === "RETURN_AFTER_SETTLE") {
      state.status = "RETURNED";
      state.returnedAt = new Date();
      state.returnCode = dir.code ?? "R08";
      state.returnDescription = dir.description ?? "Account closed";
    }
    return {
      providerInstructionId: state.providerInstructionId,
      status: state.status,
      providerReference: state.providerReference,
      settledAt: state.settledAt,
      returnedAt: state.returnedAt,
      returnCode: state.returnCode,
      returnDescription: state.returnDescription,
    };
  }

  async cancel(providerInstructionId: string, reason?: string): Promise<ProviderCancelOutcome> {
    const state = this.byProviderId.get(providerInstructionId);
    if (!state) return { providerInstructionId, cancelled: false, reason: "unknown-id" };
    if (state.status === "SETTLED" || state.status === "RETURNED") {
      return { providerInstructionId, cancelled: false, reason: `provider-final:${state.status}` };
    }
    state.status = "CANCELLED";
    return { providerInstructionId, cancelled: true, reason };
  }

  private outcomeFor(state: SimState): ProviderSubmitOutcome {
    if (state.status === "REJECTED") {
      return {
        providerInstructionId: state.providerInstructionId,
        status: "REJECTED",
        providerReference: state.providerReference,
        rejectionCode: state.rejectionCode,
        rejectionDescription: state.rejectionDescription,
      };
    }
    return {
      providerInstructionId: state.providerInstructionId,
      status: "SUBMITTED",
      providerReference: state.providerReference,
    };
  }

  // Test helper — how many times submit() was called for an idem key.
  __submitCallCount(idempotencyKey: string): number {
    return this.byIdemKey.get(idempotencyKey)?.submitCallCount ?? 0;
  }
}

// -----------------------------------------------------------------
// PAY-1B/1 (2026-09-27) — v2 facade + verifiable event envelope.
// -----------------------------------------------------------------
//
// The v2 facade exposes the SimulatorProvider through the hardened
// PAY-1B Provider Contract v2. It reuses the same internal state
// store so idempotency and outcome directives are shared. Callers
// that want v2 semantics use `getSimulatorV2()`; the engine continues
// to use v1 through `getSimulator()`.

function makeSimulatorV2(underlying: SimulatorProvider): PaymentProviderV2 {
  const provider: PaymentProviderV2 = {
    providerType: underlying.providerType,
    movesRealMoney: underlying.movesRealMoney,
    capabilities: underlying.capabilities,

    async submit(input) {
      try {
        const out = await underlying.submit({
          clubId: input.clubId,
          runId: input.runId,
          instructionId: input.instructionId,
          amount: input.amount,
          currency: input.currency,
          requestedExecutionDate: input.requestedExecutionDate,
          idempotencyKey: input.idempotencyKey,
          destinationRef: input.destinationRef,
          fundingRef: input.fundingRef,
        });
        const result: ProviderSubmissionResultV2 =
          out.status === "REJECTED"
            ? {
                outcome: "REJECTED",
                providerInstructionId: out.providerInstructionId,
                providerReference: out.providerReference,
                processingStatus: "REJECTED",
                error: {
                  category: "INVALID_DESTINATION",
                  retryable: false,
                  message: out.rejectionDescription ?? "provider rejected",
                  providerCode: out.rejectionCode,
                  providerMessage: out.rejectionDescription,
                },
                providerEvidenceRef: undefined,
              }
            : {
                outcome: "ACKNOWLEDGED",
                providerInstructionId: out.providerInstructionId,
                providerReference: out.providerReference,
                processingStatus: "ACCEPTED",
              };
        return result;
      } catch (err) {
        // v1 threw on TIMEOUT — normalise to UNKNOWN with retryable=true.
        const message = err instanceof Error ? err.message : String(err);
        return {
          outcome: "UNKNOWN",
          error: {
            category: "TIMEOUT",
            retryable: true,
            message,
          },
        };
      }
    },

    async getStatus(providerInstructionId) {
      try {
        const s = await underlying.getStatus(providerInstructionId);
        const status: ProviderProcessingStatus =
          s.status === "SUBMITTED" ? "RECEIVED"
          : s.status === "ACCEPTED" ? "ACCEPTED"
          : s.status === "SETTLED" ? "SETTLED"
          : s.status === "RETURNED" ? "RETURNED"
          : s.status === "REJECTED" ? "REJECTED"
          : s.status === "CANCELLED" ? "CANCELLED"
          : "UNKNOWN";
        return {
          providerInstructionId: s.providerInstructionId,
          status,
          providerReference: s.providerReference,
          settledAt: s.settledAt,
          returnedAt: s.returnedAt,
          returnCode: s.returnCode,
          returnDescription: s.returnDescription,
        };
      } catch (err) {
        // Adapter must fail safely — never synthesise SETTLED.
        return {
          providerInstructionId,
          status: "UNKNOWN",
          error: {
            category: "UNKNOWN",
            retryable: false,
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    },

    async cancel(providerInstructionId, reason) {
      const v1 = await underlying.cancel(providerInstructionId, reason);
      const outcome: ProviderCancelResultV2["outcome"] =
        v1.cancelled ? "ACCEPTED"
        : v1.reason?.startsWith("provider-final:") ? "TOO_LATE"
        : v1.reason === "unknown-id" ? "UNKNOWN"
        : "REJECTED";
      return {
        providerInstructionId: v1.providerInstructionId,
        outcome,
        providerReference: v1.reason,
      };
    },

    async verifyExternalEvent(payload, headers) {
      // Simulator's synthetic signing scheme:
      //   header "x-sim-signature" = sha256("SIM-SECRET|" + JSON.stringify(payload))
      // Real adapters implement their provider's actual scheme; this
      // is deliberately synthetic and test-only.
      const raw = JSON.stringify(payload ?? {});
      const payloadHash = createHash("sha256").update(raw).digest("hex");
      const expected = createHash("sha256").update("SIM-SECRET|" + raw).digest("hex");
      const supplied = headers["x-sim-signature"] ?? headers["X-Sim-Signature"] ?? "";
      const verificationStatus: ExternalPaymentEventEnvelope["verificationStatus"] =
        supplied === "" ? "UNVERIFIED"
        : supplied === expected ? "VERIFIED"
        : "FAILED";
      const p = (payload ?? {}) as Record<string, unknown>;
      const eventType: ExternalPaymentEventType =
        (p.eventType as ExternalPaymentEventType) ?? "UNKNOWN";
      return {
        provider: underlying.providerType,
        providerEventId: (p.providerEventId as string) ?? payloadHash,
        providerInstructionId: p.providerInstructionId as string | undefined,
        providerReference: p.providerReference as string | undefined,
        eventType,
        providerTimestamp: p.providerTimestamp ? new Date(p.providerTimestamp as string) : undefined,
        status: p.status as ProviderProcessingStatus | undefined,
        amount: p.amount as string | undefined,
        currency: p.currency as string | undefined,
        returnCode: p.returnCode as string | undefined,
        returnDescription: p.returnDescription as string | undefined,
        payloadHash,
        verificationStatus,
      };
    },
  };
  return provider;
}

// Public helpers.
export function getSimulatorV2(config?: SimulatorConfig): PaymentProviderV2 {
  return makeSimulatorV2(getSimulator(config));
}
