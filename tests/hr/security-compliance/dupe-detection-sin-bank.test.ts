// HR mobile-hotfix (2026-08-30) — SIN + Bank duplicate detection.
//
// Founder deliberately onboarded Lise with the SAME SIN + same
// banking as Chris on staging; Spectre accepted both. This suite
// pins the invariants that prevent that regression:
//
//   * (clubId, sinFingerprint) UNIQUE — different employees in
//     the same Club cannot share a SIN.
//   * (clubId, bankFingerprint) UNIQUE where status IN
//     ('PENDING_PENNY_TEST','VERIFIED') — different employees
//     cannot share an ACTIVE payroll destination. Historical /
//     INACTIVE rows may share (an ex-employee's bank can be
//     re-used by the next hire).
//   * Same-employee re-entry allowed (typo, replacement).
//   * SIN normalisation: "123 456 789", "123-456-789",
//     "123456789" fingerprint identically.
//   * Bank normalisation: separators / spaces / hyphens stripped
//     before fingerprinting.
//   * Employee-facing error copy is neutral (§13, §16) — never
//     names the other employee, never returns full SIN / bank.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { upsertSin } from "@/lib/hr/sensitive-identity";
import { upsertBankAccount } from "@/lib/hr/bank-account";
import { AppError } from "@/lib/errors";
import { sinFingerprint, bankFingerprint } from "@/lib/kms/keyed-fingerprint";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture, type AdminHrFixture } from "../admin-workflows/_helpers";

async function makeEmployee(fx: AdminHrFixture, opts?: { clubId?: string; suffix?: string }) {
  const clubId = opts?.clubId ?? fx.club.id;
  return prisma.employee.create({
    data: {
      clubId, employeeNumber: `DUPE-${opts?.suffix ?? Math.floor(Math.random() * 90000 + 10000)}`,
      firstName: "T", lastName: "E",
      employeeLifecycle: "ACTIVE", status: "ACTIVE",
    },
  });
}

describe("HR mobile-hotfix · SIN duplicate detection", () => {
  let fx: AdminHrFixture;
  beforeAll(async () => { await resetDb(); await seedRbac(); }, 60_000);
  beforeEach(async () => {
    await resetDb(); await seedRbac();
    fx = await makeAdminHrFixture("HRDupSin");
  }, 60_000);

  it("§11 — second employee in same Club with same SIN is refused (neutral error)", async () => {
    const a = await makeEmployee(fx);
    const b = await makeEmployee(fx);
    await upsertSin(fx.payrollAdmin, a.id, "123456789");
    await expect(upsertSin(fx.payrollAdmin, b.id, "123456789"))
      .rejects.toBeInstanceOf(AppError);
    // Ensure the error is user-safe and never names the other employee.
    try {
      await upsertSin(fx.payrollAdmin, b.id, "123456789");
      expect.fail("expected rejection");
    } catch (e) {
      const err = e as AppError;
      expect(err.safeMessage).not.toMatch(/Chris|Turcato|Lise|T E|A|B/);
      expect(err.safeMessage).toContain("check the number");
      expect(err.httpStatus).toBe(409);
    }
  });

  it("§31 — SIN normalisation: '123 456 789', '123-456-789', '123456789' all fingerprint identically", () => {
    expect(sinFingerprint("123 456 789")).toBe(sinFingerprint("123-456-789"));
    expect(sinFingerprint("123-456-789")).toBe(sinFingerprint("123456789"));
  });

  it("§31 — same-employee re-entry is permitted (row updated in place, no duplicate error)", async () => {
    const a = await makeEmployee(fx);
    await upsertSin(fx.payrollAdmin, a.id, "123 456 789");
    // Re-submit with different formatting.
    await expect(upsertSin(fx.payrollAdmin, a.id, "123-456-789")).resolves.toBeDefined();
    const rows = await prisma.employeeSensitiveIdentity.findMany({ where: { employeeId: a.id } });
    expect(rows).toHaveLength(1);
  });

  it("§35 — cross-Club: same SIN in another Club is permitted (per-Club scoping)", async () => {
    const a = await makeEmployee(fx);
    const bForeign = await makeEmployee(fx, { clubId: fx.foreignClub.id });
    await upsertSin(fx.payrollAdmin, a.id, "111222333");
    await expect(upsertSin(fx.foreignClubAdmin, bForeign.id, "111222333")).resolves.toBeDefined();
  });

  it("audit never includes plaintext SIN even on rejection", async () => {
    const a = await makeEmployee(fx);
    const b = await makeEmployee(fx);
    await upsertSin(fx.payrollAdmin, a.id, "999888777");
    try { await upsertSin(fx.payrollAdmin, b.id, "999888777"); } catch { /* expected */ }
    const rows = await prisma.auditLog.findMany({
      where: { entityType: "EmployeeSensitiveIdentity" },
      select: { beforeJson: true, afterJson: true },
    });
    for (const r of rows) {
      const joined = JSON.stringify(r);
      expect(joined).not.toContain("999888777");
      expect(joined).not.toContain("111222333");
    }
  });
});

describe("HR mobile-hotfix · Bank duplicate detection", () => {
  let fx: AdminHrFixture;
  beforeAll(async () => { await resetDb(); await seedRbac(); }, 60_000);
  beforeEach(async () => {
    await resetDb(); await seedRbac();
    fx = await makeAdminHrFixture("HRDupBank");
  }, 60_000);

  it("§14 — second employee with same ACTIVE bank triple is refused (neutral error)", async () => {
    const a = await makeEmployee(fx);
    const b = await makeEmployee(fx);
    await upsertBankAccount(fx.payrollAdmin, a.id, {
      holderName: "Chris A",
      institutionNumber: "003", transitNumber: "12345", accountNumber: "987654321",
    });
    await expect(upsertBankAccount(fx.payrollAdmin, b.id, {
      holderName: "Lise B",
      institutionNumber: "003", transitNumber: "12345", accountNumber: "987654321",
    })).rejects.toBeInstanceOf(AppError);
    try {
      await upsertBankAccount(fx.payrollAdmin, b.id, {
        holderName: "Lise B",
        institutionNumber: "003", transitNumber: "12345", accountNumber: "987654321",
      });
      expect.fail("expected rejection");
    } catch (e) {
      const err = e as AppError;
      expect(err.safeMessage).not.toMatch(/Chris|Lise|A|B|987654321/);
      expect(err.safeMessage).toContain("check the information");
      expect(err.httpStatus).toBe(409);
    }
  });

  it("§32 — different formatting fingerprints identically", () => {
    const a = bankFingerprint({ institution: "003", transit: "12345", account: "987654321" });
    const b = bankFingerprint({ institution: " 003 ", transit: "12-345", account: "987 654 321" });
    const c = bankFingerprint({ institution: "003", transit: "12345", account: "987/654/321" });
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it("§32 — same last-4 but different account is NOT a false positive", () => {
    const a = bankFingerprint({ institution: "003", transit: "12345", account: "999994321" });
    const b = bankFingerprint({ institution: "003", transit: "12345", account: "888884321" });
    expect(a).not.toBe(b);
  });

  it("§15 — same-employee historical INACTIVE row + new active row is permitted", async () => {
    const a = await makeEmployee(fx);
    // First submission (creates PENDING).
    await upsertBankAccount(fx.payrollAdmin, a.id, {
      holderName: "Employee", institutionNumber: "003", transitNumber: "12345", accountNumber: "1111111",
    });
    // Manually promote to VERIFIED so the next write moves it to INACTIVE.
    const row = await prisma.employeeBankAccount.findFirstOrThrow({ where: { employeeId: a.id } });
    await prisma.employeeBankAccount.update({ where: { id: row.id }, data: { status: "VERIFIED", activatedAt: new Date() } });
    // Second submission (creates new PENDING; old moves to INACTIVE).
    await expect(upsertBankAccount(fx.payrollAdmin, a.id, {
      holderName: "Employee", institutionNumber: "003", transitNumber: "12345", accountNumber: "2222222",
    })).resolves.toBeDefined();
    const rows = await prisma.employeeBankAccount.findMany({
      where: { employeeId: a.id }, orderBy: { createdAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.status).toBe("INACTIVE");
    expect(rows[1]!.status).toBe("PENDING_PENNY_TEST");
  });

  it("§35 — cross-Club: same bank triple in another Club is permitted", async () => {
    const a = await makeEmployee(fx);
    const bForeign = await makeEmployee(fx, { clubId: fx.foreignClub.id });
    await upsertBankAccount(fx.payrollAdmin, a.id, {
      holderName: "Alice A", institutionNumber: "003", transitNumber: "12345", accountNumber: "1111111",
    });
    await expect(upsertBankAccount(fx.foreignClubAdmin, bForeign.id, {
      holderName: "Bob B", institutionNumber: "003", transitNumber: "12345", accountNumber: "1111111",
    })).resolves.toBeDefined();
  });
});
