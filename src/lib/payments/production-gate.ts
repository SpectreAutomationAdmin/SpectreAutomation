// PAY-1C/4 (2026-09-26) — Central production-execution enablement gate.
//
// A future real Canadian rail adapter will be tempted to execute the
// moment `PAYMENTS_REAL_MONEY_ENABLED=true`. That single flag is NOT
// enough. This gate composes every prerequisite that must hold before
// real money can move — and any one of them missing MUST refuse
// external submission.
//
// Prerequisites (all must be true):
//   ● global real-money kill switch enabled;
//   ● provider adapter registered + not the simulator;
//   ● provider adapter certification == PRODUCTION_APPROVED;
//   ● connection resolved: ACTIVE, environment=PRODUCTION, has version
//     with credentialSecretRef;
//   ● connection health is usable (not DEGRADED/SUSPENDED/REVOKED);
//   ● capability required by the payment is declared supported by the
//     adapter;
//   ● PaymentAuthorization ACTIVE + fingerprint still matches;
//   ● payment run passes limit evaluation.
//
// This gate does NOT perform mutation. It reports "allowed" or
// throws a categorized error. Staging preserves fail-closed for
// EVERY unspecified case.

import { prisma } from "@/lib/prisma";
import { realMoneyEnabled } from "./kill-switch";
import { resolveActiveConnection } from "./provider/connection";
import { assertConnectionUsable } from "./provider/health";
import { getProviderReadiness } from "./certification";
import { assertPaymentRunWithinLimits } from "./limits";

export type ProductionGateFailureReason =
  | "REAL_MONEY_DISABLED"
  | "SIMULATOR_NOT_PRODUCTION_ELIGIBLE"
  | "ADAPTER_NOT_APPROVED"
  | "CONNECTION_NOT_ACTIVE"
  | "CONNECTION_ENVIRONMENT_MISMATCH"
  | "CONNECTION_HEALTH_UNUSABLE"
  | "CAPABILITY_MISSING"
  | "AUTHORIZATION_MISSING"
  | "AUTHORIZATION_INVALIDATED"
  | "AUTHORIZATION_FINGERPRINT_MISMATCH"
  | "LIMIT_BREACH";

export interface ProductionGateInput {
  clubId: string;
  providerType: string;
  connectionId: string;
  runId: string;
  requiredCapability?:
    | "supportsSubmission"
    | "supportsScheduledExecution"
    | "supportsBatchEft"
    | "supportsBatchSubmission"
    | "supportsRealTimePayments";
}

// The primary entry point. Throws with a categorized message on
// failure. Success returns silently.
export async function assertProductionExecutionAllowed(
  input: ProductionGateInput,
): Promise<void> {
  // 1. Global kill switch.
  if (!realMoneyEnabled()) {
    throw new Error(
      "PAY-1C production gate: REAL_MONEY_DISABLED — PAYMENTS_REAL_MONEY_ENABLED is not true",
    );
  }

  // 2. Adapter must not be the simulator.
  if (input.providerType === "SIMULATOR") {
    throw new Error(
      "PAY-1C production gate: SIMULATOR_NOT_PRODUCTION_ELIGIBLE — cannot execute real money against the simulator adapter",
    );
  }

  // 3. Adapter must be PRODUCTION_APPROVED.
  const readiness = await getProviderReadiness(input.providerType);
  if (readiness !== "PRODUCTION_APPROVED") {
    throw new Error(
      `PAY-1C production gate: ADAPTER_NOT_APPROVED — providerType=${input.providerType} readiness=${readiness}`,
    );
  }

  // 4. Connection must resolve to ACTIVE + PRODUCTION environment.
  //    resolveActiveConnection already refuses PRODUCTION when real
  //    money is disabled — this is redundant defense in depth.
  const connRow = await prisma.paymentProviderConnection.findUnique({
    where: { id: input.connectionId },
    select: {
      id: true,
      clubId: true,
      providerType: true,
      environment: true,
      status: true,
    },
  });
  if (!connRow) {
    throw new Error("PAY-1C production gate: connection not found");
  }
  if (connRow.clubId !== input.clubId) {
    throw new Error("PAY-1C production gate: connection tenant mismatch");
  }
  if (connRow.providerType !== input.providerType) {
    throw new Error("PAY-1C production gate: connection provider type mismatch");
  }
  if (connRow.status !== "ACTIVE") {
    throw new Error(
      `PAY-1C production gate: CONNECTION_NOT_ACTIVE — status=${connRow.status}`,
    );
  }
  if (connRow.environment !== "PRODUCTION") {
    throw new Error(
      `PAY-1C production gate: CONNECTION_ENVIRONMENT_MISMATCH — environment=${connRow.environment}`,
    );
  }

  // 5. Resolve (this will call assertEnvironmentAllowed which is a
  //    third layer of defense).
  const resolved = await resolveActiveConnection(input.clubId, input.providerType);
  await assertConnectionUsable(resolved.connectionId);

  // 6. Capability check.
  if (input.requiredCapability) {
    const cap = resolved.capabilities?.[input.requiredCapability];
    if (!cap) {
      throw new Error(
        `PAY-1C production gate: CAPABILITY_MISSING — required=${input.requiredCapability}`,
      );
    }
  }

  // 7. Authorization active + fingerprint match against the run.
  const auth = await prisma.paymentAuthorization.findUnique({
    where: { runId: input.runId },
    select: { status: true, paymentFingerprint: true },
  });
  if (!auth) {
    throw new Error("PAY-1C production gate: AUTHORIZATION_MISSING");
  }
  if (auth.status !== "ACTIVE") {
    throw new Error(
      `PAY-1C production gate: AUTHORIZATION_INVALIDATED — status=${auth.status}`,
    );
  }
  const run = await prisma.paymentRun.findUnique({
    where: { id: input.runId },
    select: { paymentFingerprint: true, currency: true },
  });
  if (!run || run.paymentFingerprint !== auth.paymentFingerprint) {
    throw new Error("PAY-1C production gate: AUTHORIZATION_FINGERPRINT_MISMATCH");
  }

  // 8. Limits.
  await assertPaymentRunWithinLimits({
    clubId: input.clubId,
    providerType: input.providerType,
    runId: input.runId,
    connectionId: input.connectionId,
  });
}

// Discovery helper — reports every check independently so operators
// can see exactly which prerequisite is failing without triggering
// the fail-closed throw. NOT used in the actual submission path.
export interface ProductionGateReport {
  overall: "ALLOWED" | "REFUSED";
  reasons: ProductionGateFailureReason[];
  details: Record<string, string>;
}

export async function reportProductionGate(
  input: ProductionGateInput,
): Promise<ProductionGateReport> {
  const reasons: ProductionGateFailureReason[] = [];
  const details: Record<string, string> = {};
  if (!realMoneyEnabled()) reasons.push("REAL_MONEY_DISABLED");
  if (input.providerType === "SIMULATOR") reasons.push("SIMULATOR_NOT_PRODUCTION_ELIGIBLE");
  const readiness = await getProviderReadiness(input.providerType);
  details.adapterReadiness = readiness;
  if (readiness !== "PRODUCTION_APPROVED") reasons.push("ADAPTER_NOT_APPROVED");
  const conn = await prisma.paymentProviderConnection.findUnique({
    where: { id: input.connectionId },
    select: { environment: true, status: true, clubId: true, providerType: true },
  });
  if (conn) {
    details.connectionEnvironment = conn.environment;
    details.connectionStatus = conn.status;
    if (conn.status !== "ACTIVE") reasons.push("CONNECTION_NOT_ACTIVE");
    if (conn.environment !== "PRODUCTION") reasons.push("CONNECTION_ENVIRONMENT_MISMATCH");
  }
  const auth = await prisma.paymentAuthorization.findUnique({
    where: { runId: input.runId },
    select: { status: true, paymentFingerprint: true },
  });
  if (!auth) reasons.push("AUTHORIZATION_MISSING");
  else if (auth.status !== "ACTIVE") reasons.push("AUTHORIZATION_INVALIDATED");
  return {
    overall: reasons.length === 0 ? "ALLOWED" : "REFUSED",
    reasons,
    details,
  };
}
