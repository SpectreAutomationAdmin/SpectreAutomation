// PAY-1B/4 (2026-09-27) — Provider health / circuit breaker.
//
// Tracks per-connection consecutive failure counters and flips the
// connection status to DEGRADED when the threshold is crossed. A
// DEGRADED connection is refused by the selector for NEW submissions,
// but historical PaymentInstructions and authorized runs are
// preserved. Human authorization or auto-recovery flips back to
// ACTIVE.

import { prisma } from "@/lib/prisma";

const DEFAULT_FAILURE_THRESHOLD = 5;

export interface RecordHealthSampleInput {
  connectionId: string;
  outcome: "OK" | "FAILURE";
  reason?: string;
}

// The connection carries `capabilities` as a JSON blob; we reuse a
// small subset of it to store health counters (no schema change
// required in PAY-1B/4). Read/write pattern is idempotent.
interface ConnectionHealthState {
  consecutiveFailures: number;
  lastFailureAt?: string;
  lastOkAt?: string;
}

function readHealth(capabilitiesJson: string | null): ConnectionHealthState {
  if (!capabilitiesJson) return { consecutiveFailures: 0 };
  try {
    const j = JSON.parse(capabilitiesJson) as { __health?: ConnectionHealthState };
    return j.__health ?? { consecutiveFailures: 0 };
  } catch {
    return { consecutiveFailures: 0 };
  }
}

function writeHealth(capabilitiesJson: string | null, health: ConnectionHealthState): string {
  const base: Record<string, unknown> = capabilitiesJson ? JSON.parse(capabilitiesJson) : {};
  base.__health = health;
  return JSON.stringify(base);
}

export async function recordHealthSample(
  input: RecordHealthSampleInput,
  threshold: number = DEFAULT_FAILURE_THRESHOLD,
): Promise<{ status: string; consecutiveFailures: number; flipped: boolean }> {
  const conn = await prisma.paymentProviderConnection.findUnique({
    where: { id: input.connectionId },
    select: { id: true, status: true, capabilities: true },
  });
  if (!conn) throw new Error("PAY-1B: connection not found");
  if (conn.status === "REVOKED") {
    // Terminal — don't touch health on revoked connections.
    return { status: "REVOKED", consecutiveFailures: 0, flipped: false };
  }

  const h = readHealth(conn.capabilities);
  let flipped = false;
  let nextStatus = conn.status;
  if (input.outcome === "FAILURE") {
    h.consecutiveFailures += 1;
    h.lastFailureAt = new Date().toISOString();
    if (h.consecutiveFailures >= threshold && conn.status === "ACTIVE") {
      nextStatus = "DEGRADED";
      flipped = true;
    }
  } else {
    h.consecutiveFailures = 0;
    h.lastOkAt = new Date().toISOString();
    if (conn.status === "DEGRADED") {
      nextStatus = "ACTIVE";
      flipped = true;
    }
  }
  await prisma.paymentProviderConnection.update({
    where: { id: conn.id },
    data: { status: nextStatus, capabilities: writeHealth(conn.capabilities, h) },
  });
  return { status: nextStatus, consecutiveFailures: h.consecutiveFailures, flipped };
}

/** Selector helper — refuses to hand out a provider whose connection
 *  is in DEGRADED, SUSPENDED, or REVOKED state. */
export async function assertConnectionUsable(connectionId: string): Promise<void> {
  const c = await prisma.paymentProviderConnection.findUnique({
    where: { id: connectionId },
    select: { status: true },
  });
  if (!c) throw new Error("PAY-1B: connection not found");
  if (c.status !== "ACTIVE") {
    throw new Error(`PAY-1B: connection is not ACTIVE (status=${c.status}) — new submissions refused. Existing runs are preserved.`);
  }
}
