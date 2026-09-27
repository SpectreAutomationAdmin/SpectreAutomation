// PAY-1B/2 (2026-09-27) — PaymentProviderConnection service.
//
// A PaymentProviderConnection is the ONLY place per-tenant provider
// credentials live in the domain. All secret material sits in KMS
// under `credentialSecretRef` on a versioned row; rotating credentials
// creates a new PaymentProviderConnectionVersion, activates it, and
// deactivates the prior version — historical PaymentInstructions
// remain attributable to the version they used at the time.
//
// Environment boundary:
//   • SIMULATOR   — always safe.
//   • SANDBOX     — synthetic non-production; safe on staging.
//   • PRODUCTION  — real-money-capable; staging structurally refuses
//                   to construct a provider from a PRODUCTION row.
//
// Status:
//   NOT_CONFIGURED → CONFIGURING → ACTIVE
//   ACTIVE ↔ DEGRADED
//   ACTIVE → SUSPENDED → ACTIVE
//   ACTIVE → REVOKED  (terminal)

import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { requirePermission } from "@/lib/rbac";
import { assertTenantOwned } from "@/lib/services/tenant";
import type { Principal } from "@/lib/rbac";
import { realMoneyEnabled } from "../kill-switch";

export type ConnectionEnvironment = "SIMULATOR" | "SANDBOX" | "PRODUCTION";
export type ConnectionStatus =
  | "NOT_CONFIGURED"
  | "CONFIGURING"
  | "ACTIVE"
  | "DEGRADED"
  | "SUSPENDED"
  | "REVOKED";

export interface CreateConnectionInput {
  clubId: string;
  providerType: string;
  connectionReference: string;
  environment: ConnectionEnvironment;
  credentialSecretRef: string;    // KMS ref only — never plaintext
  capabilities?: Record<string, boolean>;
}

export async function createConnection(
  principal: Principal,
  input: CreateConnectionInput,
): Promise<{ id: string; versionId: string }> {
  requirePermission(principal, input.clubId, "payment:bank_account:manage");
  assertEnvironmentAllowed(input.environment);

  return prisma.$transaction(async (tx) => {
    const conn = await tx.paymentProviderConnection.create({
      data: {
        clubId: input.clubId,
        providerType: input.providerType,
        connectionReference: input.connectionReference,
        environment: input.environment,
        status: "CONFIGURING",
        capabilities: input.capabilities ? JSON.stringify(input.capabilities) : null,
      },
      select: { id: true },
    });
    const version = await tx.paymentProviderConnectionVersion.create({
      data: {
        connectionId: conn.id,
        version: 1,
        credentialSecretRef: input.credentialSecretRef,
        capabilities: input.capabilities ? JSON.stringify(input.capabilities) : null,
        activatedAt: new Date(),
      },
      select: { id: true },
    });
    return { id: conn.id, versionId: version.id };
  });
}

/** Refuses any construction that would place a PRODUCTION connection
 *  on staging. Called from every service that resolves a connection
 *  and from the selector layer as defense-in-depth. */
export function assertEnvironmentAllowed(environment: ConnectionEnvironment): void {
  if (environment === "PRODUCTION" && !realMoneyEnabled()) {
    throw new Error(
      "PAY-1B: refusing to construct/activate a PRODUCTION provider connection while " +
      "PAYMENTS_REAL_MONEY_ENABLED is not true. Staging is structurally incapable of " +
      "reaching production financial infrastructure.",
    );
  }
}

export async function activateConnection(
  principal: Principal,
  connectionId: string,
): Promise<void> {
  const c = await prisma.paymentProviderConnection.findUnique({
    where: { id: connectionId },
    select: { id: true, clubId: true, environment: true, status: true },
  });
  if (!c) throw new Error("PAY-1B: connection not found");
  assertTenantOwned({ clubId: c.clubId }, principal);
  requirePermission(principal, c.clubId, "payment:bank_account:manage");
  assertEnvironmentAllowed(c.environment as ConnectionEnvironment);
  if (c.status === "REVOKED") throw new Error("PAY-1B: cannot activate a REVOKED connection");
  await prisma.paymentProviderConnection.update({
    where: { id: connectionId },
    data: { status: "ACTIVE" },
  });
}

export async function setConnectionStatus(
  principal: Principal,
  connectionId: string,
  next: Exclude<ConnectionStatus, "NOT_CONFIGURED" | "CONFIGURING">,
): Promise<void> {
  const c = await prisma.paymentProviderConnection.findUnique({
    where: { id: connectionId },
    select: { clubId: true, status: true, environment: true },
  });
  if (!c) throw new Error("PAY-1B: connection not found");
  assertTenantOwned({ clubId: c.clubId }, principal);
  requirePermission(principal, c.clubId, "payment:bank_account:manage");
  if (c.status === "REVOKED") throw new Error("PAY-1B: cannot transition a REVOKED connection");
  if (next === "ACTIVE") assertEnvironmentAllowed(c.environment as ConnectionEnvironment);
  await prisma.paymentProviderConnection.update({
    where: { id: connectionId },
    data: { status: next },
  });
}

/** Rotate a connection's credential — create a new version, activate
 *  it, and deactivate the current one. Historical instructions retain
 *  their attribution to the version they used at the time via the
 *  PaymentEvent stream. */
export async function rotateConnectionCredential(
  principal: Principal,
  connectionId: string,
  nextCredentialSecretRef: string,
): Promise<{ activatedVersion: number }> {
  const c = await prisma.paymentProviderConnection.findUnique({
    where: { id: connectionId },
    select: { clubId: true, environment: true, status: true },
  });
  if (!c) throw new Error("PAY-1B: connection not found");
  assertTenantOwned({ clubId: c.clubId }, principal);
  requirePermission(principal, c.clubId, "payment:bank_account:manage");
  if (c.status === "REVOKED") throw new Error("PAY-1B: cannot rotate a REVOKED connection");

  return prisma.$transaction(async (tx) => {
    const latest = await tx.paymentProviderConnectionVersion.findFirst({
      where: { connectionId },
      orderBy: { version: "desc" },
      select: { id: true, version: true, activatedAt: true, deactivatedAt: true },
    });
    const nextVersion = (latest?.version ?? 0) + 1;
    if (latest?.activatedAt && !latest.deactivatedAt) {
      await tx.paymentProviderConnectionVersion.update({
        where: { id: latest.id },
        data: { deactivatedAt: new Date() },
      });
    }
    await tx.paymentProviderConnectionVersion.create({
      data: {
        connectionId, version: nextVersion,
        credentialSecretRef: nextCredentialSecretRef,
        activatedAt: new Date(),
      },
    });
    return { activatedVersion: nextVersion };
  });
}

/** Look up the ACTIVE version for a given (clubId, providerType).
 *  Throws if no ACTIVE connection exists. */
export async function resolveActiveConnection(
  clubId: string,
  providerType: string,
): Promise<{
  connectionId: string;
  environment: ConnectionEnvironment;
  currentVersionId: string;
  credentialSecretRef: string;
  capabilities: Record<string, boolean> | null;
}> {
  const c = await prisma.paymentProviderConnection.findFirst({
    where: { clubId, providerType, status: "ACTIVE" },
    select: {
      id: true, environment: true, capabilities: true,
      versions: {
        where: { deactivatedAt: null },
        orderBy: { version: "desc" },
        take: 1,
        select: { id: true, credentialSecretRef: true, capabilities: true },
      },
    },
  });
  if (!c) throw new Error(`PAY-1B: no ACTIVE ${providerType} connection for club ${clubId}`);
  const v = c.versions[0];
  if (!v) throw new Error(`PAY-1B: ACTIVE connection has no active version — misconfigured`);
  const env = c.environment as ConnectionEnvironment;
  assertEnvironmentAllowed(env);
  return {
    connectionId: c.id,
    environment: env,
    currentVersionId: v.id,
    credentialSecretRef: v.credentialSecretRef,
    capabilities: v.capabilities ? JSON.parse(v.capabilities) : (c.capabilities ? JSON.parse(c.capabilities) : null),
  };
}
