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
    let row = await prisma.employeeBankAccount.findFirst({ where: { employeeId: employee.id } });
    expect(row?.status).toBe("REJECTED");

    // Reset to PENDING via a new upsert, then deactivate.
    await upsertBankAccount(payrollAdmin, employee.id, {
      institutionNumber: INSTITUTION, transitNumber: TRANSIT,
      accountNumber: ACCOUNT, holderName: HOLDER,
    });
    await deactivateBankAccount(clubAdmin, employee.id);
    row = await prisma.employeeBankAccount.findFirst({ where: { employeeId: employee.id } });
    expect(row?.status).toBe("INACTIVE");
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

  it("upsertBankAccount voids activation (status returns to PENDING_PENNY_TEST) when the row is edited", async () => {
    const { employee, payrollAdmin, clubAdmin } = await makeHrFixture();
    await upsertBankAccount(payrollAdmin, employee.id, {
      institutionNumber: INSTITUTION, transitNumber: TRANSIT,
      accountNumber: ACCOUNT, holderName: HOLDER,
    });
    await activateBankAccount(clubAdmin, employee.id);
    let row = await prisma.employeeBankAccount.findFirst({ where: { employeeId: employee.id } });
    expect(row?.status).toBe("VERIFIED");

    // Edit — status should reset.
    await upsertBankAccount(payrollAdmin, employee.id, {
      institutionNumber: INSTITUTION, transitNumber: TRANSIT,
      accountNumber: "1234567890", holderName: HOLDER,
    });
    row = await prisma.employeeBankAccount.findFirst({ where: { employeeId: employee.id } });
    expect(row?.status).toBe("PENDING_PENNY_TEST");
    expect(row?.accountLastFour).toBe("7890");
    expect(row?.activatedAt).toBeNull();
  });
});
