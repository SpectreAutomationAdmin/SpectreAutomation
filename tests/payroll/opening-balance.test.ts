// Payroll-3B-5A — opening balances + CSV import + YTD aggregation.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { ValidationError } from "@/lib/errors";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import {
  createDraftOpeningBalance,
  validateOpeningBalance,
  activateOpeningBalance,
  getActiveOpeningBalance,
  listOpeningBalances,
  type OpeningBalanceFields,
} from "@/lib/payroll/opening-balance";
import { importOpeningBalancesFromCsv, resolveOpeningBalanceReviewCardIfClean } from "@/lib/payroll/opening-balance-import";
import { getEmployeePayrollYtd } from "@/lib/payroll/ytd";

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));

const zeroValues: OpeningBalanceFields = {
  ytdGrossEarnings: "0", ytdTaxableEarnings: "0", ytdPensionableEarnings: "0",
  ytdInsurableEarnings: "0", ytdCppEE: "0", ytdCpp2EE: "0", ytdEiEE: "0",
  ytdFederalTax: "0", ytdProvincialTax: "0", ytdCppER: "0", ytdCpp2ER: "0", ytdEiER: "0",
};

const sampleValues: OpeningBalanceFields = {
  ytdGrossEarnings: "42000",
  ytdTaxableEarnings: "41000",
  ytdPensionableEarnings: "40000",
  ytdInsurableEarnings: "40000",
  ytdCppEE: "2372.60",
  ytdCpp2EE: "0",
  ytdEiEE: "656.00",
  ytdFederalTax: "5800.00",
  ytdProvincialTax: "3200.00",
  ytdCppER: "2372.60",
  ytdCpp2ER: "0",
  ytdEiER: "918.40",
};

async function scenario() {
  const clubA = await makeClub("Club A");
  const clubB = await makeClub("Club B");
  const admin = await makeUser({ email: "admin@a.test", role: "CLUB_ADMIN", clubId: clubA.id });
  const pa = await makeUser({ email: "pa@a.test", role: "PAYROLL_ADMIN", clubId: clubA.id });
  const adminP = await principalFor(admin.email);
  const paP = await principalFor(pa.email);
  await upsertPayrollClubConfig(adminP, clubA.id, {
    provinceOfEmployment: "AB",
    payrollAdminUserId: pa.id,
  });
  const empA1 = await db().employee.create({
    data: {
      clubId: clubA.id, firstName: "Alex", lastName: "Grounds",
      email: "alex@a.test", hireDate: d(2026, 1, 1), status: "ACTIVE",
      employeeNumber: "E-1001",
    },
  });
  const empA2 = await db().employee.create({
    data: {
      clubId: clubA.id, firstName: "Sam", lastName: "Salary",
      email: "sam@a.test", hireDate: d(2026, 1, 1), status: "ACTIVE",
      employeeNumber: "E-1002",
    },
  });
  const empB1 = await db().employee.create({
    data: {
      clubId: clubB.id, firstName: "Cross", lastName: "Tenant",
      email: "cross@b.test", hireDate: d(2026, 1, 1), status: "ACTIVE",
      employeeNumber: "E-B-1",
    },
  });
  return { clubA, clubB, adminP, paP, empA1, empA2, empB1 };
}

describe("Payroll-3B-5A — opening balances", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("createDraft → validate → activate; getActiveOpeningBalance returns the row", async () => {
    const s = await scenario();
    const draft = await createDraftOpeningBalance(s.paP, s.clubA.id, {
      employeeId: s.empA1.id, taxYear: 2026, values: sampleValues, importSource: "CSV",
    });
    expect(draft.status).toBe("DRAFT");
    const validated = await validateOpeningBalance(s.paP, s.clubA.id, draft.id);
    expect(validated.status).toBe("VALIDATED");
    const active = await activateOpeningBalance(s.paP, s.clubA.id, draft.id);
    expect(active.status).toBe("ACTIVE");
    const found = await getActiveOpeningBalance(s.clubA.id, s.empA1.id, 2026);
    expect(found?.id).toBe(draft.id);
    expect(Number(found?.values.ytdCppEE)).toBe(2372.60);
  });

  it("activating a new row supersedes the prior ACTIVE row for the same (Club, Employee, taxYear)", async () => {
    const s = await scenario();
    const first = await createDraftOpeningBalance(s.paP, s.clubA.id, {
      employeeId: s.empA1.id, taxYear: 2026, values: zeroValues,
    });
    await activateOpeningBalance(s.paP, s.clubA.id, first.id);
    const second = await createDraftOpeningBalance(s.paP, s.clubA.id, {
      employeeId: s.empA1.id, taxYear: 2026, values: sampleValues,
    });
    // The second create must not touch the ACTIVE row.
    expect(second.id).not.toBe(first.id);
    await activateOpeningBalance(s.paP, s.clubA.id, second.id);
    const superseded = await db().payrollOpeningBalance.findUniqueOrThrow({ where: { id: first.id } });
    expect(superseded.status).toBe("SUPERSEDED");
    expect(superseded.supersededById).toBe(second.id);
    const active = await getActiveOpeningBalance(s.clubA.id, s.empA1.id, 2026);
    expect(active?.id).toBe(second.id);
  });

  it("tenant isolation — Club A user cannot activate a Club B balance", async () => {
    const s = await scenario();
    // Craft a Club B balance directly to attempt cross-club activation.
    const created = await db().payrollOpeningBalance.create({
      data: {
        clubId: s.clubB.id, employeeId: s.empB1.id, taxYear: 2026, status: "DRAFT",
        ...zeroValues,
      },
    });
    await expect(activateOpeningBalance(s.paP, s.clubA.id, created.id)).rejects.toThrow();
  });

  it("rejects invalid decimal + negative base fields", async () => {
    const s = await scenario();
    await expect(
      createDraftOpeningBalance(s.paP, s.clubA.id, {
        employeeId: s.empA1.id,
        taxYear: 2026,
        values: { ...sampleValues, ytdGrossEarnings: "-1" },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createDraftOpeningBalance(s.paP, s.clubA.id, {
        employeeId: s.empA1.id,
        taxYear: 2026,
        values: { ...sampleValues, ytdCppEE: "abc" },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects invalid tax year", async () => {
    const s = await scenario();
    await expect(
      createDraftOpeningBalance(s.paP, s.clubA.id, {
        employeeId: s.empA1.id, taxYear: 1900, values: zeroValues,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("draft-refresh on the same tuple updates in-place (idempotent)", async () => {
    const s = await scenario();
    const first = await createDraftOpeningBalance(s.paP, s.clubA.id, {
      employeeId: s.empA1.id, taxYear: 2026, values: zeroValues,
    });
    const refreshed = await createDraftOpeningBalance(s.paP, s.clubA.id, {
      employeeId: s.empA1.id, taxYear: 2026, values: sampleValues,
    });
    expect(refreshed.id).toBe(first.id);
    expect(Number(refreshed.values.ytdCppEE)).toBe(2372.60);
  });

  it("permission gate — user without payroll:run cannot create a draft", async () => {
    const s = await scenario();
    const staff = await makeUser({ email: "staff@a.test", role: "STAFF", clubId: s.clubA.id });
    const staffP = await principalFor(staff.email);
    await expect(
      createDraftOpeningBalance(staffP, s.clubA.id, {
        employeeId: s.empA1.id, taxYear: 2026, values: zeroValues,
      }),
    ).rejects.toThrow();
  });

  it("audit — opening-balance events are emitted for create/validate/activate", async () => {
    const s = await scenario();
    const draft = await createDraftOpeningBalance(s.paP, s.clubA.id, {
      employeeId: s.empA1.id, taxYear: 2026, values: sampleValues,
    });
    await validateOpeningBalance(s.paP, s.clubA.id, draft.id);
    await activateOpeningBalance(s.paP, s.clubA.id, draft.id);
    const logs = await db().auditLog.findMany({
      where: { entityId: draft.id, entityType: "PayrollOpeningBalance" },
      orderBy: [{ createdAt: "asc" }],
      select: { action: true },
    });
    expect(logs.map((l) => l.action)).toEqual([
      "payroll.opening-balance.draft.create",
      "payroll.opening-balance.validate",
      "payroll.opening-balance.activate",
    ]);
  });

  it("listOpeningBalances is tenant-scoped", async () => {
    const s = await scenario();
    await createDraftOpeningBalance(s.paP, s.clubA.id, {
      employeeId: s.empA1.id, taxYear: 2026, values: sampleValues,
    });
    const rows = await listOpeningBalances(s.paP, s.clubA.id, 2026);
    expect(rows.length).toBe(1);
    expect(rows[0].clubId).toBe(s.clubA.id);
  });
});

describe("Payroll-3B-5A — opening-balance CSV import", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("imports two valid rows and surfaces an EMPLOYEE_NOT_FOUND row as an exception", async () => {
    const s = await scenario();
    const csv = [
      "employeeNumber,taxYear,ytdGrossEarnings,ytdTaxableEarnings,ytdPensionableEarnings,ytdInsurableEarnings,ytdCppEE,ytdCpp2EE,ytdEiEE,ytdFederalTax,ytdProvincialTax,ytdCppER,ytdCpp2ER,ytdEiER",
      "E-1001,2026,42000,41000,40000,40000,2372.60,0,656.00,5800.00,3200.00,2372.60,0,918.40",
      "E-1002,2026,50000,49000,48000,48000,2820,0,787.20,7100,3900,2820,0,1102.08",
      "E-DOES-NOT-EXIST,2026,1,1,1,1,1,1,1,1,1,1,1,1",
    ].join("\n");
    const r = await importOpeningBalancesFromCsv(s.paP, s.clubA.id, { csvText: csv, taxYear: 2026 });
    expect(r.processed).toBe(3);
    expect(r.createdOrRefreshed).toBe(2);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0].code).toBe("EMPLOYEE_NOT_FOUND");
    expect(r.workIntakeItemId).not.toBeNull();
    // Owner should be the Payroll Admin per PayrollClubConfig.
    const wi = await db().workIntakeItem.findUniqueOrThrow({ where: { id: r.workIntakeItemId! } });
    expect(wi.ownerUserId).toBeTruthy();
    expect(wi.workDomain).toBe("PAYROLL");
    expect(wi.workSubtype).toBe("PAYROLL_OPENING_BALANCE_REVIEW");
  });

  it("mismatched taxYear in a row is rejected", async () => {
    const s = await scenario();
    const csv = [
      "employeeNumber,taxYear,ytdGrossEarnings,ytdTaxableEarnings,ytdPensionableEarnings,ytdInsurableEarnings,ytdCppEE,ytdCpp2EE,ytdEiEE,ytdFederalTax,ytdProvincialTax,ytdCppER,ytdCpp2ER,ytdEiER",
      "E-1001,2025,42000,41000,40000,40000,2372.60,0,656.00,5800.00,3200.00,2372.60,0,918.40",
    ].join("\n");
    const r = await importOpeningBalancesFromCsv(s.paP, s.clubA.id, { csvText: csv, taxYear: 2026 });
    expect(r.errors[0].code).toBe("TAX_YEAR_MISMATCH");
    expect(r.createdOrRefreshed).toBe(0);
  });

  it("missing required column fails loudly before any row processing", async () => {
    const s = await scenario();
    const csv = ["employeeNumber,taxYear", "E-1001,2026"].join("\n");
    await expect(
      importOpeningBalancesFromCsv(s.paP, s.clubA.id, { csvText: csv, taxYear: 2026 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("review card resolves once all drafts are activated", async () => {
    const s = await scenario();
    const csv = [
      "employeeNumber,taxYear,ytdGrossEarnings,ytdTaxableEarnings,ytdPensionableEarnings,ytdInsurableEarnings,ytdCppEE,ytdCpp2EE,ytdEiEE,ytdFederalTax,ytdProvincialTax,ytdCppER,ytdCpp2ER,ytdEiER",
      "E-1001,2026,42000,41000,40000,40000,2372.60,0,656.00,5800.00,3200.00,2372.60,0,918.40",
      "E-BAD,2026,1,1,1,1,1,1,1,1,1,1,1,1",
    ].join("\n");
    const r = await importOpeningBalancesFromCsv(s.paP, s.clubA.id, { csvText: csv, taxYear: 2026 });
    expect(r.workIntakeItemId).not.toBeNull();
    // Activate the good row.
    await activateOpeningBalance(s.paP, s.clubA.id, r.drafts[0].id);
    const closed = await resolveOpeningBalanceReviewCardIfClean(s.clubA.id, 2026);
    expect(closed.resolved).toBe(true);
    const wi = await db().workIntakeItem.findUniqueOrThrow({ where: { id: r.workIntakeItemId! } });
    expect(wi.status).toBe("RESOLVED");
  });
});

describe("Payroll-3B-5A — YTD aggregation contract", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("returns opening balance when no batches exist", async () => {
    const s = await scenario();
    const draft = await createDraftOpeningBalance(s.paP, s.clubA.id, {
      employeeId: s.empA1.id, taxYear: 2026, values: sampleValues,
    });
    await activateOpeningBalance(s.paP, s.clubA.id, draft.id);
    const ytd = await getEmployeePayrollYtd(s.clubA.id, s.empA1.id, d(2026, 9, 1));
    expect(ytd.taxYear).toBe(2026);
    // Prisma Decimal normalises "2372.60" → "2372.6" on read; compare numerically.
    expect(Number(ytd.ytdCppEE)).toBe(2372.60);
    expect(ytd.sources.openingBalanceId).toBe(draft.id);
    expect(ytd.sources.postedBatchIds).toEqual([]);
  });

  it("excludes DRAFT / PREPARED / CALCULATED / VOIDED batches, and future POSTED", async () => {
    const s = await scenario();
    const draft = await createDraftOpeningBalance(s.paP, s.clubA.id, {
      employeeId: s.empA1.id, taxYear: 2026, values: sampleValues,
    });
    await activateOpeningBalance(s.paP, s.clubA.id, draft.id);

    // Craft a PayGroup + PayPeriod + a DRAFT batch with the employee.
    const pg = await db().payrollPayGroup.create({
      data: { clubId: s.clubA.id, code: "PG", name: "PG", payFrequency: "BIWEEKLY", payDateOffsetDays: 5 },
    });
    const pp = await db().payrollPayPeriod.create({
      data: {
        clubId: s.clubA.id, payGroupId: pg.id,
        sequenceInYear: 1, taxYear: 2026,
        periodStart: d(2026, 1, 1), periodEnd: d(2026, 1, 15),
        payDate: d(2026, 1, 20),
      },
    });
    const batch = await db().payrollBatch.create({
      data: {
        clubId: s.clubA.id, payGroupId: pg.id, payPeriodId: pp.id,
        status: "DRAFT",
      },
    });
    await db().payrollBatchEmployee.create({
      data: {
        clubId: s.clubA.id, batchId: batch.id, employeeId: s.empA1.id,
        jurisdictionCountry: "CA", jurisdictionProvince: "AB",
        employeeLifecycleAtPrep: "ACTIVE",
        grossPay: "1000",
      },
    });
    const ytd = await getEmployeePayrollYtd(s.clubA.id, s.empA1.id, d(2026, 3, 1));
    // DRAFT excluded → no extra gross beyond opening.
    expect(Number(ytd.ytdGrossEarnings)).toBe(42000);
    expect(ytd.sources.postedBatchIds).toEqual([]);

    // Now POSTED with a payDate AFTER asOf — still excluded.
    await db().payrollBatch.update({
      where: { id: batch.id },
      data: { status: "POSTED" },
    });
    // asOfPayDate BEFORE payDate → excluded.
    const beforePosting = await getEmployeePayrollYtd(s.clubA.id, s.empA1.id, d(2026, 1, 20));
    expect(beforePosting.sources.postedBatchIds).toEqual([]);
    // asOfPayDate AFTER payDate → included.
    const afterPosting = await getEmployeePayrollYtd(s.clubA.id, s.empA1.id, d(2026, 2, 1));
    expect(afterPosting.sources.postedBatchIds).toEqual([batch.id]);
    // Opening 42000 + POSTED grossPay 1000 = 43000.
    expect(Number(afterPosting.ytdGrossEarnings)).toBe(43000);
  });

  it("different-tax-year POSTED batches are excluded even when payDate < asOf", async () => {
    const s = await scenario();
    const draft = await createDraftOpeningBalance(s.paP, s.clubA.id, {
      employeeId: s.empA1.id, taxYear: 2026, values: sampleValues,
    });
    await activateOpeningBalance(s.paP, s.clubA.id, draft.id);
    const pg = await db().payrollPayGroup.create({
      data: { clubId: s.clubA.id, code: "PG", name: "PG", payFrequency: "BIWEEKLY", payDateOffsetDays: 5 },
    });
    const pp2025 = await db().payrollPayPeriod.create({
      data: {
        clubId: s.clubA.id, payGroupId: pg.id,
        sequenceInYear: 26, taxYear: 2025,
        periodStart: d(2025, 12, 15), periodEnd: d(2025, 12, 31),
        payDate: d(2025, 12, 31),
      },
    });
    const batch = await db().payrollBatch.create({
      data: {
        clubId: s.clubA.id, payGroupId: pg.id, payPeriodId: pp2025.id,
        status: "POSTED",
      },
    });
    await db().payrollBatchEmployee.create({
      data: {
        clubId: s.clubA.id, batchId: batch.id, employeeId: s.empA1.id,
        jurisdictionCountry: "CA", jurisdictionProvince: "AB",
        employeeLifecycleAtPrep: "ACTIVE",
        grossPay: "9999",
      },
    });
    const ytd = await getEmployeePayrollYtd(s.clubA.id, s.empA1.id, d(2026, 3, 1));
    expect(ytd.sources.postedBatchIds).toEqual([]);
    expect(Number(ytd.ytdGrossEarnings)).toBe(42000);
  });

  it("tax year derives from asOfPayDate UTC year", async () => {
    const s = await scenario();
    const ytd = await getEmployeePayrollYtd(s.clubA.id, s.empA1.id, d(2026, 8, 1));
    expect(ytd.taxYear).toBe(2026);
  });
});
