// Payroll-3B-5B-3A — Payroll Review DTO tests.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import { preparePayrollBatch } from "@/lib/payroll/batch-preparation";
import { orchestratePayrollReviewHandoff } from "@/lib/payroll/orchestration";
import { calculatePayrollBatch } from "@/lib/payroll/calculation-execute";
import { getBatchReview, getBatchEmployeeReview } from "@/lib/payroll/review-dto";
import { seedCanadaAlbertaPackages2026 } from "@/lib/payroll/statutory/seed-ca-ab-2026";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function superAdminP() {
  const c = db();
  await c.user.deleteMany({ where: { email: "super-3a@spectre.test" } });
  const u = await c.user.create({
    data: {
      email: "super-3a@spectre.test", name: "Super3a",
      role: "SUPER_ADMIN", passwordHash: "x", status: "ACTIVE",
    },
  });
  await c.userClubRole.create({ data: { userId: u.id, clubId: null, roleKey: "SUPER_ADMIN" } });
  return principalFor("super-3a@spectre.test");
}

async function scenario() {
  const sup = await superAdminP();
  await seedCanadaAlbertaPackages2026(sup);

  const club = await makeClub("Club Review");
  const clubB = await makeClub("Other Club");
  const admin      = await makeUser({ email: "admin.rev@a.test", role: "CLUB_ADMIN", clubId: club.id });
  const pa         = await makeUser({ email: "pa.rev@a.test",    role: "PAYROLL_ADMIN", clubId: club.id });
  const controller = await makeUser({ email: "ctl.rev@a.test",   role: "CONTROLLER", clubId: club.id });
  const staff      = await makeUser({ email: "staff.rev@a.test", role: "STAFF", clubId: club.id });
  const adminP  = await principalFor(admin.email);
  const paP     = await principalFor(pa.email);
  const ctlP    = await principalFor(controller.email);
  const staffP  = await principalFor(staff.email);
  await upsertPayrollClubConfig(adminP, club.id, {
    provinceOfEmployment: "AB", payrollAdminUserId: pa.id, controllerUserId: controller.id,
  });

  async function makeSalariedEmp(number: string, annualSalary: string) {
    const emp = await db().employee.create({
      data: {
        clubId: club.id, firstName: `E${number}`, lastName: "X",
        email: `${number}@rev.test`, hireDate: utc(2026, 1, 1),
        dateOfBirth: utc(1990, 5, 12), status: "ACTIVE", employeeNumber: number,
      },
    });
    const assn = await db().employeeEmploymentAssignment.create({
      data: {
        clubId: club.id, employeeId: emp.id, role: "PRIMARY",
        employmentType: "FULL_TIME", effectiveFrom: utc(2026, 1, 1),
      },
    });
    await db().employeeCompensation.create({
      data: {
        clubId: club.id, employeeId: emp.id, assignmentId: assn.id,
        cadence: "SALARY", rate: annualSalary, currency: "CAD",
        effectiveFrom: utc(2026, 1, 1),
      },
    });
    await db().employeeBankAccount.create({
      data: {
        clubId: club.id, employeeId: emp.id,
        institutionSecretRef: "kms:test", transitSecretRef: "kms:test",
        accountSecretRef: "kms:test", holderName: `E${number}`,
        bankFingerprint: `fp-${number}`, status: "VERIFIED", activatedAt: utc(2026, 1, 1),
      },
    });
    await db().employeeTaxProfile.create({
      data: {
        clubId: club.id, employeeId: emp.id,
        province: "AB", td1FormVersion: "2026-01",
        effectiveFrom: utc(2026, 1, 1),
        federalClaimSecretRef: "16452", provincialClaimSecretRef: "22769",
      },
    });
    return emp;
  }
  const empA = await makeSalariedEmp("E-A", "52000"); // $2000 biweekly
  const empB = await makeSalariedEmp("E-B", "78000"); // $3000 biweekly

  const pg = await db().payrollPayGroup.create({
    data: {
      clubId: club.id, code: "PG-REV", name: "PG Review",
      payFrequency: "BIWEEKLY", payDateOffsetDays: 0,
      calendarAnchorDate: utc(2026, 1, 4),
    },
  });
  const yearStart = utc(2026, 1, 4);
  let pp: { id: string } | null = null;
  for (let seq = 1; seq <= 26; seq++) {
    const start = new Date(yearStart.getTime() + (seq - 1) * 14 * 86400_000);
    const end   = new Date(start.getTime() + 13 * 86400_000);
    const row = await db().payrollPayPeriod.create({
      data: {
        clubId: club.id, payGroupId: pg.id,
        sequenceInYear: seq, taxYear: 2026,
        periodStart: start, periodEnd: end, payDate: end,
      },
    });
    if (seq === 5) pp = row;
  }
  if (!pp) throw new Error("no pay period seeded");
  for (const emp of [empA, empB]) {
    await db().payrollPayGroupMember.create({
      data: { clubId: club.id, payGroupId: pg.id, employeeId: emp.id, effectiveFrom: utc(2026, 1, 1) },
    });
  }
  const prepared = await preparePayrollBatch(adminP, club.id, pp.id);
  await orchestratePayrollReviewHandoff(adminP, club.id, pp.id, prepared.batchId);
  const bes = await db().payrollBatchEmployee.findMany({ where: { batchId: prepared.batchId } });
  for (const be of bes) {
    const rate = be.employeeId === empA.id ? "2000.00" : "3000.00";
    await db().payrollBatchEarning.create({
      data: {
        clubId: club.id, batchId: prepared.batchId, batchEmployeeId: be.id,
        employeeId: be.employeeId, earningType: "SALARY",
        quantity: "1", rate, rateSource: "MANUAL",
      },
    });
  }
  await calculatePayrollBatch(paP, club.id, prepared.batchId);

  return { club, clubB, adminP, paP, ctlP, staffP, empA, empB, prepared };
}

describe("Payroll-3B-5B-3A — Review DTO totals + reconciliation", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("aggregates gross / deductions / net / employer contributions with Decimal precision", async () => {
    const s = await scenario();
    const r = await getBatchReview(s.paP, s.club.id, s.prepared.batchId);
    expect(r.header.status).toBe("CALCULATED");
    expect(r.header.employeeCount).toBe(2);
    // Two salaried employees at $2000 + $3000 → gross $5000.00.
    expect(r.totals.gross).toBe("5000.00");
    // Net is calculated per-employee; sum should reconcile to the
    // cent regardless of individual rounding.
    expect(r.totals.reconciled).toBe(true);
    expect(r.totals.reconciliation.differenceCents).toBe(0);
    // Employer contributions > 0.
    expect(Number(r.totals.employerContributions)).toBeGreaterThan(0);
  });
});

describe("Payroll-3B-5B-3A — Employee row + detail DTO", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("employee row exposes calculated fields + no SIN / bank / KMS material", async () => {
    const s = await scenario();
    const r = await getBatchReview(s.paP, s.club.id, s.prepared.batchId);
    const rowA = r.employees.find((e) => e.employeeId === s.empA.id)!;
    expect(rowA).toBeDefined();
    expect(rowA.displayName).toContain("E-A");
    expect(rowA.earningsGross).toBe("2000");
    expect(Number(rowA.cppCombined)).toBeGreaterThan(0);
    // The JSON serialisation of any row MUST NOT contain forbidden strings.
    const blob = JSON.stringify(r);
    expect(blob).not.toMatch(/enc:/);
    expect(blob).not.toMatch(/SIN|socialInsurance/i);
    expect(blob).not.toMatch(/bankAccount|transitSecretRef|institutionSecretRef|accountSecretRef/i);
    expect(blob).not.toMatch(/holderName/);
  });
  it("employee detail includes explanation, but never raw KMS material or bank data", async () => {
    const s = await scenario();
    const r = await getBatchReview(s.paP, s.club.id, s.prepared.batchId);
    const rowA = r.employees.find((e) => e.employeeId === s.empA.id)!;
    const detail = await getBatchEmployeeReview(s.paP, s.club.id, rowA.batchEmployeeId);
    expect(detail.explanation).not.toBeNull();
    // Federal / Alberta claim tiers must be present but bank / KMS material must not.
    const blob = JSON.stringify(detail);
    expect(blob).not.toMatch(/enc:/);
    expect(blob).not.toMatch(/institutionSecretRef|transitSecretRef|accountSecretRef|holderName/i);
    expect(blob).not.toMatch(/socialInsurance/i);
    // Employer contribution amounts are separately exposed.
    expect(Number(detail.employerContributions.cppCombined)).toBeGreaterThan(0);
    // Human-readable "Deductible CPP additional contributions" (F5A) surfaces.
    expect(detail.explanation!.cpp.deductibleAdditional).toBeDefined();
    // No `F5A` string as a DTO key.
    expect(Object.keys(detail.explanation!.cpp)).not.toContain("F5A");
  });
});

describe("Payroll-3B-5B-3A — Permission + tenant enforcement", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("STAFF without payroll:read is refused", async () => {
    const s = await scenario();
    await expect(getBatchReview(s.staffP, s.club.id, s.prepared.batchId)).rejects.toThrow();
  });
  it("Controller (payroll:read) is authorised", async () => {
    const s = await scenario();
    const r = await getBatchReview(s.ctlP, s.club.id, s.prepared.batchId);
    expect(r.header.batchId).toBe(s.prepared.batchId);
  });
  it("cross-tenant read is refused", async () => {
    const s = await scenario();
    await expect(getBatchReview(s.paP, s.clubB.id, s.prepared.batchId)).rejects.toThrow();
  });
});

describe("Payroll-3B-5B-3A — WI back-link", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("header exposes workIntakeItemId so the UI can back-link to the WI card", async () => {
    const s = await scenario();
    const r = await getBatchReview(s.paP, s.club.id, s.prepared.batchId);
    // PayrollBatch.workIntakeItemId is set at PAYROLL_REVIEW handoff.
    expect(r.header.workIntakeItemId).not.toBeNull();
  });
});
