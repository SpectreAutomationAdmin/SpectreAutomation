// HR-1 security-compliance slice — EmployeeTaxProfile behavioural
// tests.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import {
  upsertTaxProfile,
  getTaxProfileMasked,
  revealTaxProfile,
} from "@/lib/hr/tax-profile";
import { prisma } from "@/lib/prisma";
import { resetDb, seedRbac } from "../../util/db";
import { auditRowText, makeHrFixture } from "./_helpers";

const FEDERAL_CLAIM = "15705.00";
const PROVINCIAL_CLAIM = "12399.00";
const ADDITIONAL = "50.00";

describe("HR EmployeeTaxProfile", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("upsertTaxProfile encrypts the three claim secrets and stores plaintext metadata", async () => {
    const { employee, payrollAdmin } = await makeHrFixture();
    const row = await upsertTaxProfile(payrollAdmin, employee.id, {
      province: "ON",
      td1FormVersion: "2026-01",
      effectiveFrom: new Date("2026-01-01"),
      federalClaim: FEDERAL_CLAIM,
      provincialClaim: PROVINCIAL_CLAIM,
      additionalDeductions: ADDITIONAL,
    });
    const stored = await prisma.employeeTaxProfile.findUnique({ where: { id: row.id } });
    expect(stored).toBeTruthy();
    expect(stored!.province).toBe("ON");
    expect(stored!.td1FormVersion).toBe("2026-01");
    expect(stored!.federalClaimSecretRef.startsWith("enc:")).toBe(true);
    expect(stored!.provincialClaimSecretRef.startsWith("enc:")).toBe(true);
    expect(stored!.additionalDeductionSecretRef?.startsWith("enc:")).toBe(true);
    expect(stored!.federalClaimSecretRef).not.toContain(FEDERAL_CLAIM);
    expect(stored!.provincialClaimSecretRef).not.toContain(PROVINCIAL_CLAIM);
    expect(stored!.additionalDeductionSecretRef ?? "").not.toContain(ADDITIONAL);
  });

  it("getTaxProfileMasked returns non-sensitive metadata only", async () => {
    const { employee, payrollAdmin } = await makeHrFixture();
    await upsertTaxProfile(payrollAdmin, employee.id, {
      province: "BC",
      td1FormVersion: "2026-01",
      effectiveFrom: new Date("2026-01-01"),
      federalClaim: FEDERAL_CLAIM,
      provincialClaim: PROVINCIAL_CLAIM,
    });
    const masked = await getTaxProfileMasked(payrollAdmin, employee.id);
    expect(masked).toBeTruthy();
    expect(masked!.province).toBe("BC");
    expect(masked!.td1FormVersion).toBe("2026-01");
    expect(masked!.hasAdditionalDeductions).toBe(false);
    // Explicit check: masked response type shape does NOT expose claim
    // amounts.
    expect(Object.keys(masked!)).not.toContain("federalClaim");
    expect(Object.keys(masked!)).not.toContain("provincialClaim");
  });

  it("revealTaxProfile requires hr:tax:reveal (auditor is denied)", async () => {
    const { employee, payrollAdmin, auditor } = await makeHrFixture();
    const row = await upsertTaxProfile(payrollAdmin, employee.id, {
      province: "ON",
      td1FormVersion: "2026-01",
      effectiveFrom: new Date("2026-01-01"),
      federalClaim: FEDERAL_CLAIM,
      provincialClaim: PROVINCIAL_CLAIM,
    });
    await expect(revealTaxProfile(auditor, row.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("revealTaxProfile returns plaintext claim amounts to a payroll admin", async () => {
    const { employee, payrollAdmin } = await makeHrFixture();
    const row = await upsertTaxProfile(payrollAdmin, employee.id, {
      province: "ON",
      td1FormVersion: "2026-01",
      effectiveFrom: new Date("2026-01-01"),
      federalClaim: FEDERAL_CLAIM,
      provincialClaim: PROVINCIAL_CLAIM,
      additionalDeductions: ADDITIONAL,
    });
    const revealed = await revealTaxProfile(payrollAdmin, row.id);
    expect(revealed.federalClaim).toBe(FEDERAL_CLAIM);
    expect(revealed.provincialClaim).toBe(PROVINCIAL_CLAIM);
    expect(revealed.additionalDeductions).toBe(ADDITIONAL);
    expect(revealed.province).toBe("ON");
  });

  it("audit for hr.tax.reveal.issue contains NO plaintext claim amounts", async () => {
    const { employee, payrollAdmin } = await makeHrFixture();
    const row = await upsertTaxProfile(payrollAdmin, employee.id, {
      province: "ON",
      td1FormVersion: "2026-01",
      effectiveFrom: new Date("2026-01-01"),
      federalClaim: FEDERAL_CLAIM,
      provincialClaim: PROVINCIAL_CLAIM,
      additionalDeductions: ADDITIONAL,
    });
    await revealTaxProfile(payrollAdmin, row.id);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "hr.tax.reveal.issue" },
      orderBy: { createdAt: "desc" },
    });
    const text = auditRowText(audit);
    expect(text.includes(FEDERAL_CLAIM)).toBe(false);
    expect(text.includes(PROVINCIAL_CLAIM)).toBe(false);
    expect(text.includes(ADDITIONAL)).toBe(false);
    // Province + version + effectiveFrom are safe metadata.
    expect(text.includes("ON")).toBe(true);
    expect(text.includes("2026-01")).toBe(true);
  });

  it("audit for hr.tax.write.update also carries no plaintext claim amounts", async () => {
    const { employee, payrollAdmin } = await makeHrFixture();
    await upsertTaxProfile(payrollAdmin, employee.id, {
      province: "ON",
      td1FormVersion: "2026-01",
      effectiveFrom: new Date("2026-01-01"),
      federalClaim: FEDERAL_CLAIM,
      provincialClaim: PROVINCIAL_CLAIM,
      additionalDeductions: ADDITIONAL,
    });
    const audit = await prisma.auditLog.findFirst({
      where: { action: "hr.tax.write.update" },
      orderBy: { createdAt: "desc" },
    });
    const text = auditRowText(audit);
    expect(text.includes(FEDERAL_CLAIM)).toBe(false);
    expect(text.includes(PROVINCIAL_CLAIM)).toBe(false);
    expect(text.includes(ADDITIONAL)).toBe(false);
  });

  it("upsertTaxProfile rejects invalid province and malformed money", async () => {
    const { employee, payrollAdmin } = await makeHrFixture();
    await expect(
      upsertTaxProfile(payrollAdmin, employee.id, {
        province: "XX",
        td1FormVersion: "2026-01",
        effectiveFrom: new Date("2026-01-01"),
        federalClaim: FEDERAL_CLAIM,
        provincialClaim: PROVINCIAL_CLAIM,
      }),
    ).rejects.toThrow();
    await expect(
      upsertTaxProfile(payrollAdmin, employee.id, {
        province: "ON",
        td1FormVersion: "2026-01",
        effectiveFrom: new Date("2026-01-01"),
        federalClaim: "not-a-number",
        provincialClaim: PROVINCIAL_CLAIM,
      }),
    ).rejects.toThrow();
  });
});
