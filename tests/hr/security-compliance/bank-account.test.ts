// HR-1 security-compliance slice — EmployeeBankAccount behavioural
// tests.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { ForbiddenError, ConflictError } from "@/lib/errors";
import {
  upsertBankAccount,
  getBankAccountMasked,
  revealBankAccount,
  activateBankAccount,
  rejectBankAccount,
  deactivateBankAccount,
} from "@/lib/hr/bank-account";
import { prisma } from "@/lib/prisma";
import { resetDb, seedRbac } from "../../util/db";
import { auditRowText, latestAuditFor, makeHrFixture } from "./_helpers";

const INSTITUTION = "003";
const TRANSIT = "12345";
const ACCOUNT = "9876543210";
const HOLDER = "River Sensitive";
const EXPECTED_LAST_FOUR = "3210";
const EXPECTED_MASK = "•••• 3210";

describe("HR EmployeeBankAccount", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("upsertBankAccount encrypts all three secret refs and stores lastFour", async () => {
    const { employee, payrollAdmin } = await makeHrFixture();
    const result = await upsertBankAccount(payrollAdmin, employee.id, {
      institutionNumber: INSTITUTION,
      transitNumber: TRANSIT,
      accountNumber: ACCOUNT,
      holderName: HOLDER,
    });
    expect(result.accountLastFour).toBe(EXPECTED_LAST_FOUR);
    expect(result.status).toBe("PENDING_PENNY_TEST");

    const row = await prisma.employeeBankAccount.findFirst({
      where: { employeeId: employee.id },
      orderBy: { updatedAt: "desc" },
    });
    expect(row).toBeTruthy();
    expect(row!.institutionSecretRef.startsWith("enc:")).toBe(true);
    expect(row!.transitSecretRef.startsWith("enc:")).toBe(true);
    expect(row!.accountSecretRef.startsWith("enc:")).toBe(true);
    expect(row!.institutionSecretRef).not.toContain(INSTITUTION);
    expect(row!.transitSecretRef).not.toContain(TRANSIT);
    expect(row!.accountSecretRef).not.toContain(ACCOUNT);
    expect(row!.accountLastFour).toBe(EXPECTED_LAST_FOUR);
    expect(row!.holderName).toBe(HOLDER);
  });

  it("getBankAccountMasked returns '•••• 3210' + holderName + status", async () => {
    const { employee, payrollAdmin } = await makeHrFixture();
    await upsertBankAccount(payrollAdmin, employee.id, {
      institutionNumber: INSTITUTION, transitNumber: TRANSIT,
      accountNumber: ACCOUNT, holderName: HOLDER,
    });
    const masked = await getBankAccountMasked(payrollAdmin, employee.id);
    expect(masked).toBeTruthy();
    expect(masked!.accountMasked).toBe(EXPECTED_MASK);
    expect(masked!.holderName).toBe(HOLDER);
    expect(masked!.status).toBe("PENDING_PENNY_TEST");
  });

  it("revealBankAccount requires hr:banking:reveal (auditor is denied)", async () => {
    const { employee, payrollAdmin, auditor } = await makeHrFixture();
    await upsertBankAccount(payrollAdmin, employee.id, {
      institutionNumber: INSTITUTION, transitNumber: TRANSIT,
      accountNumber: ACCOUNT, holderName: HOLDER,
    });
    await expect(revealBankAccount(auditor, employee.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("revealBankAccount returns plaintext trio for a payroll admin", async () => {
    const { employee, payrollAdmin } = await makeHrFixture();
    await upsertBankAccount(payrollAdmin, employee.id, {
      institutionNumber: INSTITUTION, transitNumber: TRANSIT,
      accountNumber: ACCOUNT, holderName: HOLDER,
    });
    const plain = await revealBankAccount(payrollAdmin, employee.id);
    expect(plain.institutionNumber).toBe(INSTITUTION);
    expect(plain.transitNumber).toBe(TRANSIT);
    expect(plain.accountNumber).toBe(ACCOUNT);
    expect(plain.holderName).toBe(HOLDER);
  });

  it("activateBankAccount requires hr:banking:approve and audits with hr.bank.approve.post", async () => {
    const { employee, payrollAdmin, clubAdmin } = await makeHrFixture();
    await upsertBankAccount(payrollAdmin, employee.id, {
      institutionNumber: INSTITUTION, transitNumber: TRANSIT,
      accountNumber: ACCOUNT, holderName: HOLDER,
    });
    // CLUB_ADMIN has hr:banking:approve — allowed.
    const activated = await activateBankAccount(clubAdmin, employee.id);
    expect(activated.status).toBe("VERIFIED");
    expect(activated.activatedAt).toBeInstanceOf(Date);

    const row = await prisma.employeeBankAccount.findFirst({
      where: { employeeId: employee.id },
    });
    const audit = await latestAuditFor(row!.id);
    expect(audit?.action).toBe("hr.bank.approve.post");
  });

  it("activateBankAccount refuses to re-activate an already-VERIFIED row", async () => {
    const { employee, payrollAdmin, clubAdmin } = await makeHrFixture();
    await upsertBankAccount(payrollAdmin, employee.id, {
      institutionNumber: INSTITUTION, transitNumber: TRANSIT,
      accountNumber: ACCOUNT, holderName: HOLDER,
    });
    await activateBankAccount(clubAdmin, employee.id);
    await expect(activateBankAccount(clubAdmin, employee.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejectBankAccount and deactivateBankAccount audit and change status", async () => {
    const { employee, payrollAdmin, clubAdmin } = await makeHrFixture();
    await upsertBankAccount(payrollAdmin, employee.id, {
      institutionNumber: INSTITUTION, transitNumber: TRANSIT,
      accountNumber: ACCOUNT, holderName: HOLDER,
    });
    await rejectBankAccount(clubAdmin, employee.id, "penny test failed");
    let row = await prisma.employeeBankAccount.findFirst({
      where: { employeeId: employee.id },
      orderBy: { updatedAt: "desc" },
    });
    expect(row?.status).toBe("REJECTED");

    // A fresh upsert after REJECTED creates a NEW PENDING row (the
    // rejected row is terminal and preserved as history). Deactivate
    // then moves the fresh PENDING to INACTIVE.
    await upsertBankAccount(payrollAdmin, employee.id, {
      institutionNumber: INSTITUTION, transitNumber: TRANSIT,
      accountNumber: ACCOUNT, holderName: HOLDER,
    });
    await deactivateBankAccount(clubAdmin, employee.id);
    row = await prisma.employeeBankAccount.findFirst({
      where: { employeeId: employee.id },
      orderBy: { updatedAt: "desc" },
    });
    expect(row?.status).toBe("INACTIVE");
    // Historical REJECTED row is preserved.
    const rejected = await prisma.employeeBankAccount.findFirst({
      where: { employeeId: employee.id, status: "REJECTED" },
    });
    expect(rejected).toBeTruthy();
  });

  it("audit row for reveal contains NO plaintext institution/transit/account", async () => {
    const { employee, payrollAdmin } = await makeHrFixture();
    await upsertBankAccount(payrollAdmin, employee.id, {
      institutionNumber: INSTITUTION, transitNumber: TRANSIT,
      accountNumber: ACCOUNT, holderName: HOLDER,
    });
    await revealBankAccount(payrollAdmin, employee.id);
    const row = await prisma.auditLog.findFirst({
      where: { action: "hr.bank.reveal.issue" },
      orderBy: { createdAt: "desc" },
    });
    const text = auditRowText(row);
    expect(text.includes(INSTITUTION)).toBe(false);
    expect(text.includes(TRANSIT)).toBe(false);
    expect(text.includes(ACCOUNT)).toBe(false);
    // Masked helper suffix + holder is fine.
    expect(text.includes(EXPECTED_LAST_FOUR)).toBe(true);
  });

  // HR-1H (2026-08-16): editing a VERIFIED account creates a NEW
  // PENDING_PENNY_TEST row and moves the old row to INACTIVE, in one
  // transaction. Prior behaviour destructively updated the same row
  // in place, losing banking history.
  it("HR-1H: upsertBankAccount on a VERIFIED row preserves history (old row → INACTIVE, new PENDING row created)", async () => {
    const { employee, payrollAdmin, clubAdmin } = await makeHrFixture();
    await upsertBankAccount(payrollAdmin, employee.id, {
      institutionNumber: INSTITUTION, transitNumber: TRANSIT,
      accountNumber: ACCOUNT, holderName: HOLDER,
    });
    await activateBankAccount(clubAdmin, employee.id);
    const verifiedBefore = await prisma.employeeBankAccount.findFirst({
      where: { employeeId: employee.id, status: "VERIFIED" },
    });
    expect(verifiedBefore?.accountLastFour).toBe("3210");
    const verifiedActivatedAt = verifiedBefore!.activatedAt;

    // Employee changes accounts — new banking data.
    await upsertBankAccount(payrollAdmin, employee.id, {
      institutionNumber: INSTITUTION, transitNumber: TRANSIT,
      accountNumber: "1234567890", holderName: HOLDER,
    });

    // Old row is retained as INACTIVE history; activatedAt preserved.
    const oldRow = await prisma.employeeBankAccount.findUnique({
      where: { id: verifiedBefore!.id },
    });
    expect(oldRow?.status).toBe("INACTIVE");
    expect(oldRow?.accountLastFour).toBe("3210");
    expect(oldRow?.activatedAt).toEqual(verifiedActivatedAt);

    // New row is PENDING_PENNY_TEST with the fresh banking data.
    const newRow = await prisma.employeeBankAccount.findFirst({
      where: { employeeId: employee.id, status: "PENDING_PENNY_TEST" },
    });
    expect(newRow).toBeTruthy();
    expect(newRow?.accountLastFour).toBe("7890");
    expect(newRow?.activatedAt).toBeNull();

    // getBankAccountMasked returns the current non-terminal row (the new PENDING).
    const masked = await getBankAccountMasked(payrollAdmin, employee.id);
    expect(masked?.status).toBe("PENDING_PENNY_TEST");
    expect(masked?.accountMasked).toBe("•••• 7890");
  });

  it("HR-1H: upsertBankAccount on a PENDING row updates in place (typo-correction workflow)", async () => {
    const { employee, payrollAdmin } = await makeHrFixture();
    const first = await upsertBankAccount(payrollAdmin, employee.id, {
      institutionNumber: INSTITUTION, transitNumber: TRANSIT,
      accountNumber: ACCOUNT, holderName: HOLDER,
    });
    // No activation. Same row is edited with a corrected account number.
    const second = await upsertBankAccount(payrollAdmin, employee.id, {
      institutionNumber: INSTITUTION, transitNumber: TRANSIT,
      accountNumber: "1234567890", holderName: HOLDER,
    });
    expect(second.id).toBe(first.id); // same row, updated in place
    const rowCount = await prisma.employeeBankAccount.count({ where: { employeeId: employee.id } });
    expect(rowCount).toBe(1);
    const row = await prisma.employeeBankAccount.findUnique({ where: { id: second.id } });
    expect(row?.status).toBe("PENDING_PENNY_TEST");
    expect(row?.accountLastFour).toBe("7890");
  });

  it("HR-1H: replacement account can go PENDING → VERIFIED; old VERIFIED remains INACTIVE + preserved", async () => {
    const { employee, payrollAdmin, clubAdmin } = await makeHrFixture();
    await upsertBankAccount(payrollAdmin, employee.id, {
      institutionNumber: INSTITUTION, transitNumber: TRANSIT,
      accountNumber: ACCOUNT, holderName: HOLDER,
    });
    await activateBankAccount(clubAdmin, employee.id);
    await upsertBankAccount(payrollAdmin, employee.id, {
      institutionNumber: INSTITUTION, transitNumber: TRANSIT,
      accountNumber: "1234567890", holderName: HOLDER,
    });
    await activateBankAccount(clubAdmin, employee.id);

    const verified = await prisma.employeeBankAccount.findMany({
      where: { employeeId: employee.id, status: "VERIFIED" },
    });
    expect(verified).toHaveLength(1);
    expect(verified[0].accountLastFour).toBe("7890");
    const inactive = await prisma.employeeBankAccount.findMany({
      where: { employeeId: employee.id, status: "INACTIVE" },
    });
    expect(inactive).toHaveLength(1);
    expect(inactive[0].accountLastFour).toBe("3210");
  });

  it("HR-1H: DB partial unique index rejects a second VERIFIED row for the same employee (raw insert bypass)", async () => {
    const { employee, payrollAdmin, clubAdmin } = await makeHrFixture();
    await upsertBankAccount(payrollAdmin, employee.id, {
      institutionNumber: INSTITUTION, transitNumber: TRANSIT,
      accountNumber: ACCOUNT, holderName: HOLDER,
    });
    await activateBankAccount(clubAdmin, employee.id);
    // Attempt to bypass the service and force a second VERIFIED row
    // via a direct DB write. The partial unique index must reject it.
    // We use $executeRawUnsafe because Prisma's typed API would refuse
    // to insert without unique-safe fields.
    const row = await prisma.employeeBankAccount.findFirst({
      where: { employeeId: employee.id, status: "VERIFIED" },
    });
    await expect(
      prisma.employeeBankAccount.create({
        data: {
          clubId: row!.clubId,
          employeeId: employee.id,
          institutionSecretRef: "enc:local:test:aaaa",
          transitSecretRef: "enc:local:test:bbbb",
          accountSecretRef: "enc:local:test:cccc",
          accountLastFour: "9999",
          holderName: "Bypass Attempt",
          status: "VERIFIED",
          activatedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
    // The invariant held: still exactly one VERIFIED row.
    const verifiedRows = await prisma.employeeBankAccount.count({
      where: { employeeId: employee.id, status: "VERIFIED" },
    });
    expect(verifiedRows).toBe(1);
  });
});
