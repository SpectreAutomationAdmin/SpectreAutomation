// Payroll MVP TD1 hotfix (2026-09-07) — round-trip + fail-closed
// tests for the canonical HR TD1 secure-write primitive.
//
// The write path MUST:
//   • encrypt via encryptSecret (envelope prefix present)
//   • round-trip through decryptSecret in the same process before
//     persisting — mismatched provider config surfaces here, not
//     as a downstream Payroll BLOCKER
//   • never store plaintext claim amounts
// The read path (resolveTd1ClaimAtPreparation) MUST:
//   • return the original claim value for a valid ciphertext
//   • FAIL CLOSED (decryptFailed / malformed / unknownFormat) for
//     tampered or unknown formats — never a plaintext default

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub } from "../util/db";
import { writeEncryptedTd1Claims } from "@/lib/hr/td1-secure-write";
import { resolveTd1ClaimAtPreparation, isResolvedTd1, isTd1ResolutionFailure } from "@/lib/payroll/td1-claim-resolver";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function seedEmployee(clubName: string) {
  const club = await makeClub(clubName);
  const emp = await db().employee.create({
    data: {
      clubId: club.id, firstName: "TD1", lastName: "Round",
      email: `td1.${club.id}@t.test`, hireDate: utc(2020, 1, 1),
      status: "ACTIVE", employeeNumber: `E-TD1-${club.id.slice(-4)}`,
      employeeLifecycle: "ACTIVE", compensationType: "SALARY", homeProvince: "AB",
    },
  });
  return { club, emp };
}

describe("writeEncryptedTd1Claims — round-trip", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("writes envelope-prefixed ciphertext and round-trips both claims", async () => {
    const s = await seedEmployee("TD1 Round A");
    const out = await writeEncryptedTd1Claims({
      clubId: s.club.id, employeeId: s.emp.id,
      effectiveFrom: utc(2026, 1, 1), province: "AB", td1FormVersion: "2026-01",
      federalClaim: "16452.00", provincialClaim: "22769.00",
    });
    expect(out.createdOrUpdated).toBe("created");

    const row = await db().employeeTaxProfile.findFirstOrThrow({
      where: { clubId: s.club.id, employeeId: s.emp.id },
    });
    // No plaintext leaked into the DB — every claim is envelope-prefixed.
    expect(row.federalClaimSecretRef!.startsWith("enc:")).toBe(true);
    expect(row.provincialClaimSecretRef!.startsWith("enc:")).toBe(true);
    expect(row.federalClaimSecretRef).not.toContain("16452");
    expect(row.provincialClaimSecretRef).not.toContain("22769");

    // Read through the canonical Payroll resolver — the same code the
    // batch-preparation service calls. This proves the write path
    // aligns with the read path in this process.
    const fed = await resolveTd1ClaimAtPreparation({
      secretReference: `td1-fed:${s.emp.id}`,
      ciphertext: row.federalClaimSecretRef,
      claimZero: false,
    });
    expect(isResolvedTd1(fed)).toBe(true);
    expect(fed.value).toBe("16452.00");

    const prov = await resolveTd1ClaimAtPreparation({
      secretReference: `td1-prov:${s.emp.id}`,
      ciphertext: row.provincialClaimSecretRef,
      claimZero: false,
    });
    expect(isResolvedTd1(prov)).toBe(true);
    expect(prov.value).toBe("22769.00");
  });

  it("re-running the writer updates the same row (idempotent)", async () => {
    const s = await seedEmployee("TD1 Round B");
    const first = await writeEncryptedTd1Claims({
      clubId: s.club.id, employeeId: s.emp.id,
      effectiveFrom: utc(2026, 1, 1), province: "AB", td1FormVersion: "2026-01",
      federalClaim: "16452.00", provincialClaim: "22769.00",
    });
    const second = await writeEncryptedTd1Claims({
      clubId: s.club.id, employeeId: s.emp.id,
      effectiveFrom: utc(2026, 1, 1), province: "AB", td1FormVersion: "2026-01",
      federalClaim: "16452.00", provincialClaim: "22769.00",
    });
    expect(first.taxProfileId).toBe(second.taxProfileId);
    expect(second.createdOrUpdated).toBe("updated");
    const rows = await db().employeeTaxProfile.count({
      where: { clubId: s.club.id, employeeId: s.emp.id },
    });
    expect(rows).toBe(1);
  });
});

describe("resolveTd1ClaimAtPreparation — fail-closed", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("returns decryptFailed for tampered envelope ciphertext", async () => {
    const s = await seedEmployee("TD1 FailClose A");
    await writeEncryptedTd1Claims({
      clubId: s.club.id, employeeId: s.emp.id,
      effectiveFrom: utc(2026, 1, 1), province: "AB", td1FormVersion: "2026-01",
      federalClaim: "16452.00", provincialClaim: "22769.00",
    });
    // Corrupt the ciphertext: keep the envelope prefix but scramble
    // the base64 blob so the auth tag verification fails.
    const original = (await db().employeeTaxProfile.findFirstOrThrow({
      where: { employeeId: s.emp.id },
    })).federalClaimSecretRef!;
    const parts = original.split(":");
    const tampered = [...parts.slice(0, 3), parts[3].slice(0, -8) + "AAAAAAAA"].join(":");
    const r = await resolveTd1ClaimAtPreparation({
      secretReference: "irrelevant", ciphertext: tampered, claimZero: false,
    });
    expect(isTd1ResolutionFailure(r)).toBe(true);
    // Underlying crypto message must not leak.
    expect(r.failureReason ?? "").not.toMatch(/(iv|auth|tag|base64)/i);
  });

  it("returns unknownFormat for a legacy 'kms:test' placeholder", async () => {
    const r = await resolveTd1ClaimAtPreparation({
      secretReference: "irrelevant", ciphertext: "kms:test", claimZero: false,
    });
    expect(r.kind).toBe("unknownFormat");
  });

  it("returns malformed when decrypted plaintext is not a decimal", async () => {
    // Directly craft a valid envelope holding a non-decimal payload.
    const { encryptSecret } = await import("@/lib/kms");
    const ct = await encryptSecret({
      scope: "HR", secretReference: "tax:probe:federal",
      plaintext: "not-a-decimal", clubId: null, actorUserId: null,
    });
    const r = await resolveTd1ClaimAtPreparation({
      secretReference: "tax:probe:federal", ciphertext: ct, claimZero: false,
    });
    expect(r.kind).toBe("malformed");
  });

  it("returns missing for null/empty ciphertext (WARNING path, not BLOCKER)", async () => {
    const rNull = await resolveTd1ClaimAtPreparation({
      secretReference: "irrelevant", ciphertext: null, claimZero: false,
    });
    const rEmpty = await resolveTd1ClaimAtPreparation({
      secretReference: "irrelevant", ciphertext: "", claimZero: false,
    });
    expect(rNull.kind).toBe("missing");
    expect(rEmpty.kind).toBe("missing");
  });
});
