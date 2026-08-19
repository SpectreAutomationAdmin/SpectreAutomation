// HR-1 security-compliance slice — sensitive identity (SIN)
// behavioural tests.
//
// Confirms the load-bearing invariants:
//   1. upsertSin encrypts the plaintext, stores only ciphertext +
//      last-three.
//   2. getSinMasked returns "XXX XXX ###" and requires hr:sin:read
//      (which auditor + payroll admin have; a member does not).
//   3. revealSin requires hr:sin:reveal (auditor lacks it).
//   4. The audit row for hr.sin.reveal.issue does NOT contain the
//      plaintext SIN in any of before / after / meta.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import {
  upsertSin,
  getSinMasked,
  revealSin,
  clearSin,
} from "@/lib/hr/sensitive-identity";
import { prisma } from "@/lib/prisma";
import { resetDb, seedRbac } from "../../util/db";
import { auditRowText, latestAuditFor, makeHrFixture } from "./_helpers";

const PLAINTEXT_SIN = "123456789";
const EXPECTED_LAST_THREE = "789";
const EXPECTED_MASK = "XXX XXX 789";

describe("HR sensitive-identity (SIN)", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("upsertSin stores ciphertext + last-three; plaintext never lands in the DB column", async () => {
    const { employee, payrollAdmin } = await makeHrFixture();
    const result = await upsertSin(payrollAdmin, employee.id, PLAINTEXT_SIN);
    expect(result.sinLastThree).toBe(EXPECTED_LAST_THREE);
    const row = await prisma.employeeSensitiveIdentity.findUnique({
      where: { employeeId: employee.id },
    });
    expect(row).toBeTruthy();
    expect(row!.sinLastThree).toBe(EXPECTED_LAST_THREE);
    // The stored column carries the KMS envelope prefix — never the
    // raw 9 digits.
    expect(row!.sinSecretRef.startsWith("enc:")).toBe(true);
    expect(row!.sinSecretRef).not.toContain(PLAINTEXT_SIN);
  });

  it("getSinMasked returns 'XXX XXX ###' when present", async () => {
    const { employee, payrollAdmin } = await makeHrFixture();
    await upsertSin(payrollAdmin, employee.id, PLAINTEXT_SIN);
    const masked = await getSinMasked(payrollAdmin, employee.id);
    expect(masked).toBe(EXPECTED_MASK);
  });

  it("getSinMasked returns null when no SIN on file", async () => {
    const { employee, payrollAdmin } = await makeHrFixture();
    const masked = await getSinMasked(payrollAdmin, employee.id);
    expect(masked).toBeNull();
  });

  it("revealSin returns plaintext for a principal with hr:sin:reveal", async () => {
    const { employee, payrollAdmin } = await makeHrFixture();
    await upsertSin(payrollAdmin, employee.id, PLAINTEXT_SIN);
    const revealed = await revealSin(payrollAdmin, employee.id);
    expect(revealed).toBe(PLAINTEXT_SIN);
  });

  it("revealSin rejects CLUB_ADMIN (write grant but no reveal grant)", async () => {
    const { employee, payrollAdmin, clubAdmin } = await makeHrFixture();
    await upsertSin(payrollAdmin, employee.id, PLAINTEXT_SIN);
    await expect(revealSin(clubAdmin, employee.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("revealSin rejects AUDITOR_READ_ONLY (read grant but no reveal grant)", async () => {
    const { employee, payrollAdmin, auditor } = await makeHrFixture();
    await upsertSin(payrollAdmin, employee.id, PLAINTEXT_SIN);
    await expect(revealSin(auditor, employee.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("hr.sin.reveal.issue audit row carries NO plaintext SIN in before/after/meta", async () => {
    const { employee, payrollAdmin } = await makeHrFixture();
    await upsertSin(payrollAdmin, employee.id, PLAINTEXT_SIN);
    await revealSin(payrollAdmin, employee.id);

    const row = await prisma.auditLog.findFirst({
      where: { action: "hr.sin.reveal.issue" },
      orderBy: { createdAt: "desc" },
    });
    expect(row).toBeTruthy();
    const text = auditRowText(row);
    // Plaintext SIN must not appear anywhere in the row's stringified
    // audit columns.
    expect(text.includes(PLAINTEXT_SIN)).toBe(false);
    // The masked helper suffix is fine — it's what UI callers see.
    expect(text.includes(EXPECTED_LAST_THREE)).toBe(true);
  });

  it("hr.sin.write.update audit row is emitted and carries only sinLastThree", async () => {
    const { employee, payrollAdmin } = await makeHrFixture();
    await upsertSin(payrollAdmin, employee.id, PLAINTEXT_SIN);
    const row = await latestAuditFor(
      (await prisma.employeeSensitiveIdentity.findUnique({ where: { employeeId: employee.id } }))!.id,
    );
    expect(row?.action).toBe("hr.sin.write.update");
    const text = auditRowText(row);
    expect(text.includes(PLAINTEXT_SIN)).toBe(false);
    expect(text.includes(EXPECTED_LAST_THREE)).toBe(true);
  });

  it("clearSin removes the row and audits with the pre-delete last-three", async () => {
    const { employee, payrollAdmin } = await makeHrFixture();
    await upsertSin(payrollAdmin, employee.id, PLAINTEXT_SIN);
    await clearSin(payrollAdmin, employee.id);
    const row = await prisma.employeeSensitiveIdentity.findUnique({
      where: { employeeId: employee.id },
    });
    expect(row).toBeNull();
    const audit = await prisma.auditLog.findFirst({
      where: { action: "hr.sin.write.delete" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).toBeTruthy();
    const text = auditRowText(audit);
    expect(text.includes(PLAINTEXT_SIN)).toBe(false);
    expect(text.includes(EXPECTED_LAST_THREE)).toBe(true);
  });

  it("upsertSin rejects a SIN that is not exactly 9 digits", async () => {
    const { employee, payrollAdmin } = await makeHrFixture();
    await expect(upsertSin(payrollAdmin, employee.id, "12345")).rejects.toThrow();
    await expect(upsertSin(payrollAdmin, employee.id, "not a number")).rejects.toThrow();
  });
});
