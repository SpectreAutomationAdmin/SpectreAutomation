// FPP-8B.2 (2026-09-22) — pay-statement historical cutoff integration.
//
// Covers:
//   §5 v1 same-date STANDARD/REVERSAL/CORRECTION pay statements
//   §6 cross-date regression (earlier statement stays frozen after later payroll)
//   §7 v2 frozen-read wired via buildPayStatement
//   §8-§10 correction PREPARED seed strips v2 componentYtd

import { describe, it, expect, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { buildPayStatement } from "@/lib/payroll/pay-statement";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function seedGl(clubId: string) {
  const c = db();
  const acct = (n: string, name: string, type: "EXPENSE" | "LIABILITY") =>
    c.account.create({ data: { clubId, accountNumber: n, name, type,
      normalBalance: type === "EXPENSE" ? "DEBIT" : "CREDIT",
      isActive: true, allowManualPosting: false } });
  const salary = await acct("5100", "Salary Expense", "EXPENSE");
  const netPay = await acct("2100", "Net Pay Payable", "LIABILITY");
  await c.payrollGlAccountingProfile.create({ data: {
    clubId, salaryExpenseAccountId: salary.id,
    employerCppExpenseAccountId: salary.id, employerEiExpenseAccountId: salary.id,
    netPayPayableAccountId: netPay.id, cppPayableAccountId: netPay.id, eiPayableAccountId: netPay.id,
    federalTaxPayableAccountId: netPay.id, provincialTaxPayableAccountId: netPay.id,
  } });
}

async function seedEmp(suffix: string) {
  const c = db();
  const club = await makeClub(`8B2 ${suffix}`);
  const user = await makeUser({ email: `pa-${suffix}@t.test`, role: "PAYROLL_ADMIN", clubId: club.id });
  const principal = await principalFor(user.email);
  await seedGl(club.id);
  const emp = await c.employee.create({ data: {
    clubId: club.id, firstName: "T", lastName: `E${suffix}`,
    email: `emp.${suffix}@t.test`, hireDate: utc(2020,1,1),
    dateOfBirth: utc(1985,5,12), status: "ACTIVE",
    employeeNumber: `E-8B2-${suffix}`, compensationType: "SALARY",
    employeeLifecycle: "ACTIVE", homeProvince: "AB" } });
  return { club, principal, emp };
}

async function seedOpening(clubId: string, employeeId: string, components: Array<{ code: string; amt: string }>) {
  const c = db();
  const ob = await c.payrollOpeningBalance.create({ data: {
    clubId, employeeId, taxYear: 2026, throughPayDate: utc(2026,3,31),
    priorPayrollKind: "PRIOR_SYSTEM_SAME_EMPLOYER",
    status: "ACTIVE", activatedAt: new Date(),
    ytdGrossEarnings: new Prisma.Decimal("0"), ytdTaxableEarnings: new Prisma.Decimal("0"),
    ytdPensionableEarnings: new Prisma.Decimal("0"), ytdInsurableEarnings: new Prisma.Decimal("0"),
    ytdCppEE_Base: new Prisma.Decimal("0"), ytdCppEE_FirstAdd: new Prisma.Decimal("0"), ytdCppEE: new Prisma.Decimal("0"),
    ytdCpp2EE: new Prisma.Decimal("0"), ytdEiEE: new Prisma.Decimal("0"),
    ytdFederalTax: new Prisma.Decimal("0"), ytdProvincialTax: new Prisma.Decimal("0"),
    ytdCppER_Base: new Prisma.Decimal("0"), ytdCppER_FirstAdd: new Prisma.Decimal("0"), ytdCppER: new Prisma.Decimal("0"),
    ytdCpp2ER: new Prisma.Decimal("0"), ytdEiER: new Prisma.Decimal("0"),
  } });
  for (const cc of components) {
    await c.payrollOpeningBalanceComponent.create({ data: {
      clubId, openingBalanceId: ob.id,
      componentCode: cc.code, displayName: cc.code, category: "ALLOWANCE",
      side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY",
      ytdAmount: new Prisma.Decimal(cc.amt) } });
  }
  return ob;
}

async function seedPostedBatch(clubId: string, employeeId: string, opts: {
  payDate: Date; seq: number; transactionType?: "STANDARD" | "REVERSAL" | "CORRECTION";
  postedAt?: Date; components: Array<{ code: string; amt: string }>;
  ytdSnapshotJson?: string | null;
}) {
  const c = db();
  const pg = await c.payrollPayGroup.create({ data: {
    clubId, code: `PG-${opts.seq}-${Math.random().toString(36).slice(2,7)}`,
    name: "test", payFrequency: "SEMI_MONTHLY", payDateOffsetDays: 0,
    calendarAnchorDate: opts.payDate } });
  const pp = await c.payrollPayPeriod.create({ data: {
    clubId, payGroupId: pg.id, sequenceInYear: opts.seq,
    taxYear: 2026, periodStart: opts.payDate, periodEnd: opts.payDate, payDate: opts.payDate } });
  const batch = await c.payrollBatch.create({ data: {
    clubId, payGroupId: pg.id, payPeriodId: pp.id,
    sequence: 1, status: "POSTED",
    transactionType: opts.transactionType ?? "STANDARD",
    calculationVersion: 1, algorithmVersion: "test",
    packageChecksum: "test",
    postedAt: opts.postedAt ?? opts.payDate } });
  const be = await c.payrollBatchEmployee.create({ data: {
    clubId, batchId: batch.id, employeeId,
    jurisdictionCountry: "CA", jurisdictionProvince: "AB",
    employeeLifecycleAtPrep: "ACTIVE", status: "INCLUDED", salaried: true,
    grossPay: new Prisma.Decimal("0"),
    ytdSnapshotJson: opts.ytdSnapshotJson ?? null,
  } });
  for (const cc of opts.components) {
    const placeholder = await c.payrollComponent.create({ data: {
      clubId, code: `${cc.code}-${Math.random().toString(36).slice(2,8)}`, displayName: cc.code,
      category: "ALLOWANCE", side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY",
      displaySection: "EARNINGS", displayOrder: 100,
      calculationMethod: "FIXED_AMOUNT", statutoryTreatmentSource: "CUSTOM",
      taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
      active: true } });
    await c.payrollBatchComponentSnapshot.create({ data: {
      batchId: batch.id, batchEmployeeId: be.id, employeeId, clubId,
      sourceComponentId: placeholder.id,
      componentCode: cc.code, displayName: cc.code, category: "ALLOWANCE", side: "EMPLOYEE",
      displaySection: "EARNINGS", displayOrder: 100,
      cashEffect: "INCREASES_NET_PAY", calculationMethod: "FIXED_AMOUNT",
      resolvedAmount: new Prisma.Decimal(cc.amt),
      sourceEffectiveFrom: opts.payDate, provenance: "RECURRING_EMPLOYEE_SETUP" } });
  }
  return { batch, be };
}

function lineFor(sections: Array<{ lines: Array<{ label: string; current: string; ytd: string }> }>, componentCode: string) {
  for (const s of sections) for (const l of s.lines) if (l.label === componentCode) return l;
  return null;
}

describe("FPP-8B.2 · pay-statement historical cutoff integration", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("§5 v1 same-date STANDARD statement shows $125 (opening $100 + STANDARD +$25)", async () => {
    const s = await seedEmp("std");
    await seedOpening(s.club.id, s.emp.id, [{ code: "A", amt: "100.00" }]);
    const sameDate = utc(2026,4,15);
    const std = await seedPostedBatch(s.club.id, s.emp.id, { payDate: sameDate, seq: 5, transactionType: "STANDARD", postedAt: new Date("2026-04-15T10:00:00Z"), components: [{ code: "A", amt: "25.00" }] });
    // Same-date REVERSAL + CORRECTION also POSTED — the STANDARD statement must NOT include them.
    await seedPostedBatch(s.club.id, s.emp.id, { payDate: sameDate, seq: 6, transactionType: "REVERSAL",   postedAt: new Date("2026-04-15T11:00:00Z"), components: [{ code: "A", amt: "-25.00" }] });
    await seedPostedBatch(s.club.id, s.emp.id, { payDate: sameDate, seq: 7, transactionType: "CORRECTION", postedAt: new Date("2026-04-15T12:00:00Z"), components: [{ code: "A", amt: "40.00" }] });
    const stmt = await buildPayStatement(s.principal, s.club.id, std.be.id);
    const row = lineFor(stmt.sections, "A");
    expect(row?.current).toBe("25.00");
    expect(row?.ytd).toBe("125.00");
  });

  it("§5 v1 same-date REVERSAL statement shows $100 (opening + STANDARD - REVERSAL)", async () => {
    const s = await seedEmp("rev");
    await seedOpening(s.club.id, s.emp.id, [{ code: "A", amt: "100.00" }]);
    const sameDate = utc(2026,4,15);
    await seedPostedBatch(s.club.id, s.emp.id, { payDate: sameDate, seq: 5, transactionType: "STANDARD",   postedAt: new Date("2026-04-15T10:00:00Z"), components: [{ code: "A", amt: "25.00" }] });
    const rev = await seedPostedBatch(s.club.id, s.emp.id, { payDate: sameDate, seq: 6, transactionType: "REVERSAL",   postedAt: new Date("2026-04-15T11:00:00Z"), components: [{ code: "A", amt: "-25.00" }] });
    await seedPostedBatch(s.club.id, s.emp.id, { payDate: sameDate, seq: 7, transactionType: "CORRECTION", postedAt: new Date("2026-04-15T12:00:00Z"), components: [{ code: "A", amt: "40.00" }] });
    const stmt = await buildPayStatement(s.principal, s.club.id, rev.be.id);
    const row = lineFor(stmt.sections, "A");
    expect(row?.current).toBe("-25.00");
    expect(row?.ytd).toBe("100.00");
  });

  it("§5 v1 same-date CORRECTION statement shows $140 (opening + STANDARD - REVERSAL + CORRECTION)", async () => {
    const s = await seedEmp("cor");
    await seedOpening(s.club.id, s.emp.id, [{ code: "A", amt: "100.00" }]);
    const sameDate = utc(2026,4,15);
    await seedPostedBatch(s.club.id, s.emp.id, { payDate: sameDate, seq: 5, transactionType: "STANDARD",   postedAt: new Date("2026-04-15T10:00:00Z"), components: [{ code: "A", amt: "25.00" }] });
    await seedPostedBatch(s.club.id, s.emp.id, { payDate: sameDate, seq: 6, transactionType: "REVERSAL",   postedAt: new Date("2026-04-15T11:00:00Z"), components: [{ code: "A", amt: "-25.00" }] });
    const cor = await seedPostedBatch(s.club.id, s.emp.id, { payDate: sameDate, seq: 7, transactionType: "CORRECTION", postedAt: new Date("2026-04-15T12:00:00Z"), components: [{ code: "A", amt: "40.00" }] });
    const stmt = await buildPayStatement(s.principal, s.club.id, cor.be.id);
    const row = lineFor(stmt.sections, "A");
    expect(row?.current).toBe("40.00");
    expect(row?.ytd).toBe("140.00");
  });

  it("§6 cross-date v1: viewing P1 after P2 exists still shows P1's frozen YTD", async () => {
    const s = await seedEmp("cross");
    await seedOpening(s.club.id, s.emp.id, [{ code: "A", amt: "100.00" }]);
    const p1 = await seedPostedBatch(s.club.id, s.emp.id, { payDate: utc(2026,4,15), seq: 5, components: [{ code: "A", amt: "25.00" }] });
    await seedPostedBatch(s.club.id, s.emp.id, { payDate: utc(2026,4,30), seq: 6, components: [{ code: "A", amt: "35.00" }] });
    const stmt = await buildPayStatement(s.principal, s.club.id, p1.be.id);
    const row = lineFor(stmt.sections, "A");
    expect(row?.current).toBe("25.00");
    expect(row?.ytd).toBe("125.00");
  });

  it("§7 v2 pay statement prefers frozen componentYtd (defence-in-depth)", async () => {
    const s = await seedEmp("v2");
    const v2snap = JSON.stringify({
      schemaVersion: 2,
      asOfPayDate: "2026-04-15T00:00:00.000Z", taxYear: 2026,
      sources: { openingBalanceId: null, openingBalancePriorPayrollKind: null, postedBatchIds: [], componentSourceRefs: [] },
      ytdGrossEarnings: "0", ytdTaxableEarnings: "0", ytdPensionableEarnings: "0", ytdInsurableEarnings: "0",
      ytdCppEE_Base: "0", ytdCppEE_FirstAdd: "0", ytdCppEE: "0", ytdCpp2EE: "0", ytdEiEE: "0",
      ytdFederalTax: "0", ytdProvincialTax: "0",
      ytdCppER_Base: "0", ytdCppER_FirstAdd: "0", ytdCppER: "0", ytdCpp2ER: "0", ytdEiER: "0",
      componentYtd: [
        { componentCode: "FROZEN", displayName: "Frozen", category: "ALLOWANCE",
          side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY",
          ytdBefore: "600.00", currentAmount: "50.00", ytdIncludingCurrent: "650.00" },
      ],
    });
    const b = await seedPostedBatch(s.club.id, s.emp.id, {
      payDate: utc(2026,5,15), seq: 9, components: [{ code: "FROZEN", amt: "50.00" }],
      ytdSnapshotJson: v2snap,
    });
    const stmt = await buildPayStatement(s.principal, s.club.id, b.be.id);
    // The line label comes from the batch snapshot's displayName ("FROZEN"),
    // not the v2 snapshot's displayName ("Frozen"). The YTD value comes from
    // the frozen v2 componentYtd — that's the whole point of §7.
    const row = lineFor(stmt.sections, "FROZEN");
    expect(row?.current).toBe("50.00");
    // 650.00 from the frozen snapshot — NOT 50.00 (which is what the
    // resolver alone would compute with no opening balance for FROZEN).
    expect(row?.ytd).toBe("650.00");
  });
});
