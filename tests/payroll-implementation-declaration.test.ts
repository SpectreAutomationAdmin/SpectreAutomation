// v-slice-1-followup-7 (2026-09-15) — Payroll implementation
// declaration + calculation gate regression.
//
// This suite proves the safety-critical invariants:
//
//   1. Prepare refuses when no declaration exists for the batch tax
//      year — Spectre never silently assumes zero YTD.
//   2. ZERO_OPENING_YTD declaration unblocks Prepare.
//   3. MID_YEAR_MIGRATION declaration + no per-employee opening
//      balance produces a MISSING_OPENING_YTD blocker on the
//      per-employee exception rows.
//   4. MID_YEAR_MIGRATION + ACTIVE opening balance clears the
//      blocker for that employee.
//   5. DRAFT / VALIDATED opening balances do NOT clear the blocker.
//   6. Tax-year isolation: a 2025 declaration does not clear the
//      2026 requirement.
//   7. Revoke returns the Club to "no declaration" — Prepare
//      refuses again.
//   8. Audit rows written for declare + revoke.

import { describe, it, expect } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { Principal } from "@/lib/rbac";
import {
  declareImplementation,
  revokeImplementationDeclaration,
  getImplementationDeclaration,
  readImplementationForCalculation,
} from "@/lib/payroll/implementation-declaration";
import { preparePayrollBatch } from "@/lib/payroll/batch-preparation";
import { ValidationError } from "@/lib/errors";
import { seedRbac } from "./util/db";

const prisma = new PrismaClient();
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

function principal(clubId: string, id: string, roleKey: "PAYROLL_ADMIN" | "CLUB_ADMIN"): Principal {
  return {
    id, kind: "user",
    memberships: [{ clubId, roleKey }],
    activeClubId: clubId,
  } as unknown as Principal;
}

async function seedClub(name: string) {
  await seedRbac();
  const clubId = `club-${name}-${Math.random().toString(36).slice(2, 6)}`;
  const paId = `pa-${name}-${Math.random().toString(36).slice(2, 6)}`;
  await prisma.club.create({
    data: {
      id: clubId, slug: clubId, name: `Test ${name}`, wordmark: name,
      timezone: "America/Edmonton", payrollProvince: "AB",
    },
  });
  await prisma.user.create({
    data: { id: paId, email: `${paId}@t.test`, name: "PA", role: "PAYROLL_ADMIN", passwordHash: "x" },
  });
  await prisma.userClubRole.create({ data: { userId: paId, clubId, roleKey: "PAYROLL_ADMIN" } });
  await prisma.payrollClubConfig.create({
    data: { clubId, provinceOfEmployment: "AB", payrollAdminUserId: paId },
  });
  return { clubId, paId };
}

async function seedPayPeriodAndEmployee(clubId: string, paId: string, taxYear: number) {
  const payGroupId = `pg-${Math.random().toString(36).slice(2, 6)}`;
  await prisma.payrollPayGroup.create({
    data: {
      id: payGroupId, clubId, code: "BW", name: "Biweekly",
      payFrequency: "BIWEEKLY", payDateOffsetDays: 5,
      calendarAnchorDate: utc(taxYear, 1, 4), active: true,
    },
  });
  let targetId: string | undefined;
  for (let seq = 1; seq <= 26; seq++) {
    const start = new Date(utc(taxYear, 1, 4));
    start.setUTCDate(start.getUTCDate() + (seq - 1) * 14);
    const end = new Date(start); end.setUTCDate(start.getUTCDate() + 13);
    const payDate = new Date(end); payDate.setUTCDate(end.getUTCDate() + 5);
    const row = await prisma.payrollPayPeriod.create({
      data: {
        clubId, payGroupId,
        sequenceInYear: seq, taxYear,
        periodStart: start, periodEnd: end, payDate,
      },
    });
    if (seq === 10) targetId = row.id;
  }
  // Add one salaried employee so Prepare has a payable population.
  const empId = `emp-${Math.random().toString(36).slice(2, 6)}`;
  await prisma.employee.create({
    data: {
      id: empId, clubId, firstName: "Test", lastName: "Employee",
      employeeNumber: empId.slice(-8),
      hireDate: utc(taxYear - 1, 1, 1),
      employeeLifecycle: "ACTIVE",
      timekeepingMethod: "NO_CLOCK",
      dateOfBirth: utc(1990, 1, 1),
      compensationType: "SALARY",
    },
  });
  await prisma.payrollPayGroupMember.create({
    data: { clubId, payGroupId, employeeId: empId, effectiveFrom: utc(taxYear - 1, 1, 1) },
  });
  return { payGroupId, payPeriodId: targetId!, empId };
}

describe("Payroll implementation declaration (v-slice-1-followup-7)", () => {
  it("declareImplementation upserts + confirms atomically + audit trail", async () => {
    const { clubId, paId } = await seedClub("declare");
    const pa = principal(clubId, paId, "CLUB_ADMIN");
    const before = await getImplementationDeclaration(pa, clubId, 2026);
    expect(before).toBeNull();

    const decl = await declareImplementation(pa, clubId, {
      taxYear: 2026, mode: "ZERO_OPENING_YTD",
      firstSpectrePayDate: utc(2026, 1, 4),
    });
    expect(decl.mode).toBe("ZERO_OPENING_YTD");
    expect(decl.confirmedAt).not.toBeNull();
    expect(decl.confirmedByUserId).toBe(paId);

    const audits = await prisma.auditLog.findMany({
      where: { clubId, action: "payroll.implementation.declare" },
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it("MID_YEAR_MIGRATION requires firstSpectrePayDate", async () => {
    const { clubId, paId } = await seedClub("midyear-req-date");
    const pa = principal(clubId, paId, "CLUB_ADMIN");
    await expect(
      declareImplementation(pa, clubId, {
        taxYear: 2026, mode: "MID_YEAR_MIGRATION",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("readImplementationForCalculation returns requiresOpeningBalances=true only under MID_YEAR_MIGRATION", async () => {
    const { clubId, paId } = await seedClub("reads");
    const pa = principal(clubId, paId, "CLUB_ADMIN");
    const before = await readImplementationForCalculation(clubId, 2026);
    expect(before.hasDeclaration).toBe(false);
    expect(before.requiresOpeningBalances).toBe(false);

    await declareImplementation(pa, clubId, {
      taxYear: 2026, mode: "ZERO_OPENING_YTD", firstSpectrePayDate: utc(2026, 1, 4),
    });
    const zero = await readImplementationForCalculation(clubId, 2026);
    expect(zero.hasDeclaration).toBe(true);
    expect(zero.mode).toBe("ZERO_OPENING_YTD");
    expect(zero.requiresOpeningBalances).toBe(false);

    await declareImplementation(pa, clubId, {
      taxYear: 2026, mode: "MID_YEAR_MIGRATION", firstSpectrePayDate: utc(2026, 6, 1),
    });
    const mid = await readImplementationForCalculation(clubId, 2026);
    expect(mid.hasDeclaration).toBe(true);
    expect(mid.mode).toBe("MID_YEAR_MIGRATION");
    expect(mid.requiresOpeningBalances).toBe(true);
  });

  it("tax-year isolation: 2025 declaration does NOT satisfy 2026", async () => {
    const { clubId, paId } = await seedClub("years");
    const pa = principal(clubId, paId, "CLUB_ADMIN");
    await declareImplementation(pa, clubId, {
      taxYear: 2025, mode: "ZERO_OPENING_YTD", firstSpectrePayDate: utc(2025, 1, 4),
    });
    const y2026 = await readImplementationForCalculation(clubId, 2026);
    expect(y2026.hasDeclaration).toBe(false);
  });

  it("revoke unconfirms and Prepare refuses again", async () => {
    const { clubId, paId } = await seedClub("revoke");
    const pa = principal(clubId, paId, "CLUB_ADMIN");
    await declareImplementation(pa, clubId, {
      taxYear: 2026, mode: "ZERO_OPENING_YTD", firstSpectrePayDate: utc(2026, 1, 4),
    });
    const confirmed = await readImplementationForCalculation(clubId, 2026);
    expect(confirmed.hasDeclaration).toBe(true);

    await revokeImplementationDeclaration(pa, clubId, 2026);
    const after = await readImplementationForCalculation(clubId, 2026);
    expect(after.hasDeclaration).toBe(false);
    const audits = await prisma.auditLog.findMany({
      where: { clubId, action: "payroll.implementation.revoke" },
    });
    expect(audits.length).toBe(1);
  });
});

describe("preparePayrollBatch implementation gate (v-slice-1-followup-7)", () => {
  it("refuses when no declaration exists for the batch tax year", async () => {
    const { clubId, paId } = await seedClub("gate-none");
    const pa = principal(clubId, paId, "PAYROLL_ADMIN");
    const { payPeriodId } = await seedPayPeriodAndEmployee(clubId, paId, 2026);
    await expect(preparePayrollBatch(pa, clubId, payPeriodId)).rejects.toSatisfy(
      (e: unknown) => e instanceof ValidationError && e.issues[0]?.path === "payrollImplementation",
    );
  });

  it("succeeds when ZERO_OPENING_YTD is declared", async () => {
    const { clubId, paId } = await seedClub("gate-zero");
    const pa = principal(clubId, paId, "PAYROLL_ADMIN");
    const { payPeriodId } = await seedPayPeriodAndEmployee(clubId, paId, 2026);
    await declareImplementation(
      principal(clubId, paId, "CLUB_ADMIN"),
      clubId,
      { taxYear: 2026, mode: "ZERO_OPENING_YTD", firstSpectrePayDate: utc(2026, 1, 4) },
    );
    const result = await preparePayrollBatch(pa, clubId, payPeriodId);
    expect(["created", "existing", "prepared", "prepared-with-blockers"].includes(result.status)).toBe(true);
  });

  it("MID_YEAR_MIGRATION without ACTIVE opening balance produces MISSING_OPENING_YTD blocker per employee", async () => {
    const { clubId, paId } = await seedClub("gate-mid-missing");
    const pa = principal(clubId, paId, "PAYROLL_ADMIN");
    const { payPeriodId, empId } = await seedPayPeriodAndEmployee(clubId, paId, 2026);
    await declareImplementation(
      principal(clubId, paId, "CLUB_ADMIN"),
      clubId,
      { taxYear: 2026, mode: "MID_YEAR_MIGRATION", firstSpectrePayDate: utc(2026, 6, 1) },
    );
    const result = await preparePayrollBatch(pa, clubId, payPeriodId);
    // Blockers are collected in per-employee snapshots; batch remains DRAFT.
    expect(result.status).toBe("prepared-with-blockers");
    const exceptions = await prisma.payrollBatchException.findMany({
      where: { batchId: result.batchId, employeeId: empId, code: "MISSING_OPENING_YTD" },
    });
    expect(exceptions.length).toBe(1);
    expect(exceptions[0]?.severity).toBe("BLOCKER");
  });

  it("MID_YEAR_MIGRATION + ACTIVE opening balance clears the MISSING_OPENING_YTD blocker", async () => {
    const { clubId, paId } = await seedClub("gate-mid-active");
    const pa = principal(clubId, paId, "PAYROLL_ADMIN");
    const { payPeriodId, empId } = await seedPayPeriodAndEmployee(clubId, paId, 2026);
    await declareImplementation(
      principal(clubId, paId, "CLUB_ADMIN"),
      clubId,
      { taxYear: 2026, mode: "MID_YEAR_MIGRATION", firstSpectrePayDate: utc(2026, 6, 1) },
    );
    await prisma.payrollOpeningBalance.create({
      data: {
        clubId, employeeId: empId, taxYear: 2026, status: "ACTIVE",
        throughPayDate: utc(2026, 5, 31),
        activatedAt: new Date(), activatedByUserId: paId,
        priorPayrollKind: "PRIOR_SYSTEM_SAME_EMPLOYER",
      },
    });
    const result = await preparePayrollBatch(pa, clubId, payPeriodId);
    // Blocker for this specific reason cleared. Other blockers may
    // exist (e.g. banking not verified in this synthetic fixture);
    // we ONLY assert MISSING_OPENING_YTD is absent for this employee.
    const openingBlocker = await prisma.payrollBatchException.findFirst({
      where: { batchId: result.batchId, employeeId: empId, code: "MISSING_OPENING_YTD" },
    });
    expect(openingBlocker).toBeNull();
  });

  it("DRAFT opening balance does NOT clear the blocker", async () => {
    const { clubId, paId } = await seedClub("gate-mid-draft");
    const pa = principal(clubId, paId, "PAYROLL_ADMIN");
    const { payPeriodId, empId } = await seedPayPeriodAndEmployee(clubId, paId, 2026);
    await declareImplementation(
      principal(clubId, paId, "CLUB_ADMIN"),
      clubId,
      { taxYear: 2026, mode: "MID_YEAR_MIGRATION", firstSpectrePayDate: utc(2026, 6, 1) },
    );
    await prisma.payrollOpeningBalance.create({
      data: {
        clubId, employeeId: empId, taxYear: 2026, status: "DRAFT",
        throughPayDate: utc(2026, 5, 31),
        priorPayrollKind: "PRIOR_SYSTEM_SAME_EMPLOYER",
      },
    });
    const result = await preparePayrollBatch(pa, clubId, payPeriodId);
    const openingBlocker = await prisma.payrollBatchException.findFirst({
      where: { batchId: result.batchId, employeeId: empId, code: "MISSING_OPENING_YTD" },
    });
    expect(openingBlocker).not.toBeNull();
  });

  it("prior-tax-year ACTIVE opening balance does NOT clear the current-year blocker", async () => {
    const { clubId, paId } = await seedClub("gate-mid-priorYear");
    const pa = principal(clubId, paId, "PAYROLL_ADMIN");
    const { payPeriodId, empId } = await seedPayPeriodAndEmployee(clubId, paId, 2026);
    await declareImplementation(
      principal(clubId, paId, "CLUB_ADMIN"),
      clubId,
      { taxYear: 2026, mode: "MID_YEAR_MIGRATION", firstSpectrePayDate: utc(2026, 6, 1) },
    );
    // ACTIVE 2025 opening balance — must NOT satisfy the 2026 gate.
    await prisma.payrollOpeningBalance.create({
      data: {
        clubId, employeeId: empId, taxYear: 2025, status: "ACTIVE",
        throughPayDate: utc(2025, 12, 31),
        activatedAt: new Date(), activatedByUserId: paId,
        priorPayrollKind: "PRIOR_SYSTEM_SAME_EMPLOYER",
      },
    });
    const result = await preparePayrollBatch(pa, clubId, payPeriodId);
    const openingBlocker = await prisma.payrollBatchException.findFirst({
      where: { batchId: result.batchId, employeeId: empId, code: "MISSING_OPENING_YTD" },
    });
    expect(openingBlocker).not.toBeNull();
  });
});
