// HR TD1 secure-write primitive (2026-09-07).
//
// A single low-level helper that both the authorised HR service
// (upsertTaxProfile) and internal fixtures / migrations use to
// persist encrypted TD1 claim amounts. Never a plaintext fallback.
//
// Guarantees:
//   • Encrypts every claim via the canonical `encryptSecret`.
//   • Round-trips the ciphertext through `decryptSecret` BEFORE
//     writing the row. A KMS provider mismatch (e.g. fixture wrote
//     `enc:local:` but the runtime is configured for AWS) fails
//     LOUDLY here, not silently at Payroll-preparation time.
//   • Idempotent per (employeeId, effectiveFrom): existing rows
//     are updated (fresh ciphertext); no historical row is deleted.
//
// This module does NO authorization. Callers that want RBAC (the
// HR API layer, upsertTaxProfile) enforce it BEFORE calling here.
// Fixtures / migrations invoke this directly.

import { prisma } from "../prisma";
import { encryptSecret, decryptSecret } from "../kms";
import { randomUUID } from "node:crypto";

export interface WriteTd1ClaimsInput {
  clubId:          string;
  employeeId:      string;
  effectiveFrom:   Date;
  province:        string;       // canonical two-letter code (e.g. "AB")
  td1FormVersion:  string;       // e.g. "2026-01"
  federalClaim:    string;       // fixed-2 decimal string (e.g. "16452.00")
  provincialClaim: string;       // fixed-2 decimal string (e.g. "22769.00")
  actorUserId?:    string | null;
  notes?:          string | null;
}

export interface WriteTd1ClaimsResult {
  taxProfileId:    string;
  createdOrUpdated: "created" | "updated";
  provider:        string;       // KMS provider name that produced the envelopes
}

function federalRef(id: string) { return `tax:${id}:federal`; }
function provincialRef(id: string) { return `tax:${id}:provincial`; }

/**
 * Encrypt federal + provincial TD1 claims, verify decrypt round-trip,
 * then upsert the tax profile row. Throws — never persists — if the
 * round-trip fails.
 */
export async function writeEncryptedTd1Claims(
  input: WriteTd1ClaimsInput,
): Promise<WriteTd1ClaimsResult> {
  const {
    clubId, employeeId, effectiveFrom, province, td1FormVersion,
    federalClaim, provincialClaim, actorUserId = null, notes = null,
  } = input;

  const existing = await prisma.employeeTaxProfile.findFirst({
    where: { clubId, employeeId, effectiveFrom },
    select: { id: true },
  });
  const rowId = existing?.id ?? randomUUID();

  // Encrypt through the canonical service.
  const federalCipher = await encryptSecret({
    scope: "HR", secretReference: federalRef(rowId),
    plaintext: federalClaim, clubId, actorUserId,
  });
  const provincialCipher = await encryptSecret({
    scope: "HR", secretReference: provincialRef(rowId),
    plaintext: provincialClaim, clubId, actorUserId,
  });

  // Verify each ciphertext round-trips under the *same active provider*
  // BEFORE persisting. Any environment mismatch (e.g. .env not loaded,
  // AWS provider selected but the fixture just wrote enc:local:...)
  // surfaces here as a clear error instead of a downstream Payroll
  // BLOCKER at preparation time.
  const fedRoundTrip = await decryptSecret({
    scope: "HR", secretReference: federalRef(rowId), ciphertext: federalCipher, clubId, actorUserId,
  });
  const provRoundTrip = await decryptSecret({
    scope: "HR", secretReference: provincialRef(rowId), ciphertext: provincialCipher, clubId, actorUserId,
  });
  if (fedRoundTrip !== federalClaim) {
    throw new Error(
      `TD1 round-trip failed for federal claim (employeeId=${employeeId}). ` +
      `Configured KMS provider cannot decrypt the ciphertext it just produced — ` +
      `check SPECTRE_KMS_PROVIDER / SPECTRE_LOCAL_KMS_KEY / AWS credentials.`,
    );
  }
  if (provRoundTrip !== provincialClaim) {
    throw new Error(
      `TD1 round-trip failed for provincial claim (employeeId=${employeeId}). ` +
      `Configured KMS provider cannot decrypt the ciphertext it just produced.`,
    );
  }

  // Persist.
  let createdOrUpdated: "created" | "updated";
  if (existing) {
    await prisma.employeeTaxProfile.update({
      where: { id: existing.id },
      data: {
        province, td1FormVersion,
        federalClaimSecretRef: federalCipher,
        provincialClaimSecretRef: provincialCipher,
        notes,
      },
    });
    createdOrUpdated = "updated";
  } else {
    await prisma.employeeTaxProfile.create({
      data: {
        id: rowId, clubId, employeeId,
        province, td1FormVersion,
        effectiveFrom,
        federalClaimSecretRef: federalCipher,
        provincialClaimSecretRef: provincialCipher,
        notes,
      },
    });
    createdOrUpdated = "created";
  }

  // Provider name is stamped on encryptedSecretMetadata by encryptSecret;
  // read it back for the diagnostic result.
  const meta = await prisma.encryptedSecretMetadata.findFirst({
    where: { scope: "HR", secretReference: federalRef(rowId) },
    select: { provider: true },
  });

  return {
    taxProfileId: rowId,
    createdOrUpdated,
    provider: meta?.provider ?? "unknown",
  };
}
