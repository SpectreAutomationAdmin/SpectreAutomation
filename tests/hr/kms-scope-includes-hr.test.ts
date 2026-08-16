// HR-1 architect-slice source-contract pin (2026-08-16).
//
// Guarantees the "HR" KMS scope stays wired into the shared KMS
// module so every HR ciphertext blob (EmployeeSensitiveIdentity,
// EmployeeBankAccount, EmployeeTaxProfile) can be envelope-encrypted
// under a rotate-in-one-operation scope key.
//
// Reads the source file with `readFileSync` (regex) instead of
// importing it — the shared KMS module transitively imports the
// Prisma client which triggers engine-file EPERM on Windows during
// unit test sweeps. Regex is safer + faster here.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const KMS_SOURCE = resolve(__dirname, "..", "..", "src", "lib", "kms", "index.ts");

describe("HR-1 · KmsScope union includes 'HR'", () => {
  it("declares 'HR' as a valid KMS scope", () => {
    const src = readFileSync(KMS_SOURCE, "utf-8");
    // Find the `KmsScope` type alias.
    const match = src.match(/export\s+type\s+KmsScope\s*=\s*([^;]+);/);
    expect(match, "KmsScope type alias not found in src/lib/kms/index.ts").toBeTruthy();
    const rhs = match![1];
    // Union member "HR" must be present as a bare string literal.
    expect(rhs).toMatch(/"HR"/);
  });
});
