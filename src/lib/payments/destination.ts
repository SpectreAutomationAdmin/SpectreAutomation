// PAY-1A (2026-09-26) — PaymentDestinationSnapshot service.
//
// A snapshot is an IMMUTABLE copy of a recipient's payment destination
// as it existed at the moment a PaymentInstruction was authorized.
// Employee bank-account changes after authorization MUST NOT redirect
// the scheduled payment. Enforced by:
//   1. Snapshot captures the sourceId + sourceVersion + the KMS secret
//      refs at capture time.
//   2. PaymentInstruction.destinationSnapshotId references a specific
//      snapshot; there is no fallback path to re-resolve the current
//      employee bank record at execution time.
//   3. The service layer never mutates an existing snapshot — new
//      destinations require a new snapshot row and (post-authorization)
//      a new instruction with fresh authorization.

import { prisma } from "@/lib/prisma";
import { assertTenantOwned } from "@/lib/services/tenant";
import type { Principal } from "@/lib/rbac";
import type { Prisma } from "@prisma/client";
import type { RecipientType } from "./types";

export interface CaptureEmployeeDestinationInput {
  clubId: string;
  employeeId: string;
  // The specific EmployeeBankAccount row to snapshot. Callers MUST
  // resolve the currently-active row and pass its id — the service
  // does NOT fall back to "the current active bank account" because
  // authorization must bind to a specific version.
  employeeBankAccountId: string;
}

export async function captureEmployeeDestination(
  principal: Principal,
  input: CaptureEmployeeDestinationInput,
  tx?: Prisma.TransactionClient,
): Promise<{ id: string }> {
  const client = tx ?? prisma;

  const bank = await client.employeeBankAccount.findFirst({
    where: { id: input.employeeBankAccountId, clubId: input.clubId, employeeId: input.employeeId },
    select: {
      id: true, clubId: true,
      institutionSecretRef: true, transitSecretRef: true, accountSecretRef: true,
      accountLastFour: true, bankFingerprint: true, status: true,
    },
  });
  if (!bank) throw new Error("PAY-1A: source EmployeeBankAccount not found or not owned by this tenant/employee.");
  assertTenantOwned({ clubId: bank.clubId }, principal);

  // Refuse to snapshot a non-active destination — payment must go to
  // an activated account (post-penny-test) per HR banking discipline.
  if (bank.status !== "ACTIVE") {
    throw new Error(`PAY-1A: source EmployeeBankAccount is not ACTIVE (status=${bank.status}); cannot snapshot.`);
  }

  const snap = await client.paymentDestinationSnapshot.create({
    data: {
      clubId: input.clubId,
      recipientType: "EMPLOYEE",
      recipientId: input.employeeId,
      sourceModel: "EmployeeBankAccount",
      sourceId: bank.id,
      sourceVersion: 1, // future: increment if source-side versioning is added
      maskedIdentifier: bank.accountLastFour ? `••••${bank.accountLastFour}` : "••••••••",
      bankFingerprint: bank.bankFingerprint,
      institutionSecretRef: bank.institutionSecretRef,
      transitSecretRef: bank.transitSecretRef,
      accountSecretRef: bank.accountSecretRef,
      currency: "CAD",
    },
    select: { id: true },
  });
  return snap;
}

// Read a snapshot's masked-only view (for Controller display).
// This intentionally omits the KMS refs so a caller with only
// `payment:read` cannot see the destination material even indirectly.
export async function readSnapshotMasked(
  principal: Principal,
  snapshotId: string,
): Promise<{
  id: string; clubId: string; recipientType: RecipientType; recipientId: string;
  maskedIdentifier: string; currency: string; capturedAt: Date;
}> {
  const row = await prisma.paymentDestinationSnapshot.findUnique({
    where: { id: snapshotId },
    select: {
      id: true, clubId: true, recipientType: true, recipientId: true,
      maskedIdentifier: true, currency: true, capturedAt: true,
    },
  });
  if (!row) throw new Error("PAY-1A: PaymentDestinationSnapshot not found.");
  assertTenantOwned({ clubId: row.clubId }, principal);
  return { ...row, recipientType: row.recipientType as RecipientType };
}
