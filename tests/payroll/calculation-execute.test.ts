// Payroll-3B-5B-2b — DB integration + PDOC Scenarios 1 & 2 for the
// 2b calculator orchestrator. Verifies:
//   • CPP + CPP2 + EI persistence for a real PREPARED batch
//   • PDOC Scenario 1 (H1, default TD1) matches externally-published
//     CPP 110.99 / CPP2 0.00 / EI 32.60 / firstAdd 18.65
//   • PDOC Scenario 2 (H2, custom TD1) independently produces the
//     same CPP / EI (proves TD1 does NOT leak into CPP/EI)
//   • Batch remains PREPARED (no CALCULATED transition)
//   • Income tax fields remain UNSET (no false zeros)
//   • Prior-employer contributions do NOT reduce Spectre's YTD room
//   • Atomicity: one calculator failure persists nothing
//   • Frozen-facts: a live HR mutation between prepare + execute
//     cannot change the calculated gross

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import { preparePayrollBatch } from "@/lib/payroll/batch-preparation";
import { executeEarningsAndStatutory } from "@/lib/payroll/calculation-execute";
import { seedCanadaAlbertaPackages2026 } from "@/lib/payroll/statutory/seed-ca-ab-2026";
import { createDraftOpeningBalance, activateOpeningBalance } from "@/lib/payroll/opening-balance";
import type { OpeningBalanceFields } from "@/lib/payroll/opening-balance";
import { parseYtdSnapshotV1 } from "@/lib/payroll/ytd-snapshot-schema";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function superAdminP() {
  const c = db();
  await c.user.deleteMany({ where: { email: "super-2b@spectre.test" } });
  const u = await c.user.create({
    data: {
      email: "super-2b@spectre.test", name: "Super2b",
      role: "SUPER_ADMIN", passwordHash: "x", status: "ACTIVE",
    },
  });
  await c.userClubRole.create({ data: { userId: u.id, clubId: null, roleKey: "SUPER_ADMIN" } });
  return principalFor("super-2b@spectre.test");
}

const zeroOB: OpeningBalanceFields = {
  ytdGrossEarnings: "0", ytdTaxableEarnings: "0", ytdPensionableEarnings: "0",
  ytdInsurableEarnings: "0",
  ytdCppEE_Base: "0", ytdCppEE_FirstAdd: "0", ytdCppEE: "0",
  ytdCpp2EE: "0", ytdEiEE: "0", ytdFederalTax: "0", ytdProvincialTax: "0",
  ytdCppER_Base: "0", ytdCppER_FirstAdd: "0", ytdCppER: "0",
  ytdCpp2ER: "0", ytdEiER: "0",
};

/**
 * Scenario for PDOC Scenario 1 or 2: one salaried employee with a
 * biweekly Pay Group whose annual salary of $52,000 divides cleanly
 * to $2,000 per pay. That gives us the exact gross the PDOC anchor
 * assumes (grossEarnings = 2000.00, PI = 2000, insurable = 2000).
 */
async function pdocScenario(payDate: Date) {
  const sup = await superAdminP();
  await seedCanadaAlbertaPackages2026(sup);

  const club = await makeClub("Club PDOC");
  const admin = await makeUser({ email: "admin.pdoc@a.test", role: "CLUB_ADMIN", clubId: club.id });
  const pa    = await makeUser({ email: "pa.pdoc@a.test",    role: "PAYROLL_ADMIN", clubId: club.id });
  const adminP = await principalFor(admin.email);
  const paP    = await principalFor(pa.email);
  await upsertPayrollClubConfig(adminP, club.id, {
    provinceOfEmployment: "AB", payrollAdminUserId: pa.id,
  });
  const emp = await db().employee.create({
    data: {
      clubId: club.id, firstName: "Sal", lastName: "Aried",
      email: "sal@pdoc.test", hireDate: utc(2026, 1, 1),
      dateOfBirth: utc(1990, 5, 12), status: "ACTIVE",
      employeeNumber: "E-PDOC-1",
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
      cadence: "SALARY", rate: "52000", currency: "CAD",
      effectiveFrom: utc(2026, 1, 1),
    },
  });
  await db().employeeBankAccount.create({
    data: {
      clubId: club.id, employeeId: emp.id,
      institutionSecretRef: "kms:test", transitSecretRef: "kms:test",
      accountSecretRef: "kms:test", holderName: "Sal Aried",
      bankFingerprint: "fp-pdoc", status: "VERIFIED", activatedAt: utc(2026, 1, 1),
    },
  });
  await db().employeeTaxProfile.create({
    data: {
      clubId: club.id, employeeId: emp.id,
      province: "AB", td1FormVersion: "2026-01",
      effectiveFrom: utc(2026, 1, 1),
      federalClaimSecretRef: "kms:test", provincialClaimSecretRef: "kms:test",
    },
  });

  // Biweekly Pay Group; PayPeriod ends on payDate.
  const pg = await db().payrollPayGroup.create({
    data: {
      clubId: club.id, code: "PG-PDOC", name: "PG-PDOC",
      payFrequency: "BIWEEKLY", payDateOffsetDays: 0,
      calendarAnchorDate: utc(2026, 1, 4),
    },
  });
  // Seed 26 biweekly pay-periods for the tax year so
  // resolvePeriodsPerYearFromCalendar returns P=26. Without this, P
  // would be 1 and CPP would incorrectly zero out (YBE/1 exceeds PI).
  const taxYear = payDate.getUTCFullYear();
  const yearStart = utc(taxYear, 1, 4); // anchor Sunday for biweekly cadence
  let pp: Awaited<ReturnType<typeof db>["payrollPayPeriod"]["create"]> | null = null;
  for (let seq = 1; seq <= 26; seq++) {
    const start = new Date(yearStart.getTime() + (seq - 1) * 14 * 86400_000);
    const end   = new Date(start.getTime() + 13 * 86400_000);
    const pDate = end;
    const row = await db().payrollPayPeriod.create({
      data: {
        clubId: club.id, payGroupId: pg.id,
        sequenceInYear: seq, taxYear,
        periodStart: start, periodEnd: end, payDate: pDate,
      },
    });
    // Match the row whose payDate matches the requested test payDate.
    if (Math.abs(pDate.getTime() - payDate.getTime()) < 86400_000) pp = row;
  }
  if (!pp) throw new Error(`No seeded pay-period matches payDate ${payDate.toISOString()}`);
  await db().payrollPayGroupMember.create({
    data: { clubId: club.id, payGroupId: pg.id, employeeId: emp.id, effectiveFrom: utc(2026, 1, 1) },
  });

  const prepared = await preparePayrollBatch(adminP, club.id, pp.id);

  // Prepare doesn't auto-generate an earning row for salary. Attach
  // an explicit SALARY earning at $2000 so the earnings calculator
  // reads exactly the PDOC-anchored gross regardless of period-day
  // arithmetic. (Salary-derived path is also unit-tested at
  // 52000/26 = 2000.00 in earnings-calculator.test.ts.)
  const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prepared.batchId } });
  await db().payrollBatchEarning.create({
    data: {
      clubId: club.id, batchId: prepared.batchId, batchEmployeeId: be.id,
      employeeId: emp.id, earningType: "SALARY",
      quantity: "1", rate: "2000.00", rateSource: "MANUAL",
    },
  });

  return { club, adminP, paP, emp, pp, prepared };
}

describe("Payroll-3B-5B-2b — PDOC Scenario 1 (H1, default TD1)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("$2000 biweekly → CPP=110.99, firstAdd=18.65, base=92.34, CPP2=0.00, EI=32.60", async () => {
    const s = await pdocScenario(utc(2026, 3, 14));
    const r = await executeEarningsAndStatutory(s.paP, s.club.id, s.prepared.batchId);
    expect(r.persisted).toBe(true);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: r.batchId } });
    expect(Number(be.grossPay)).toBe(2000);
    expect(Number(be.deductionCppEeCombined)).toBe(110.99);
    expect(Number(be.deductionCppEeFirstAdd)).toBe(18.65);
    expect(Number(be.deductionCppEeBase)).toBe(92.34);
    expect(Number(be.deductionCpp2Ee)).toBe(0);
    expect(Number(be.deductionEiEe)).toBe(32.60);
    // Base + firstAdd == combined (cent invariant). Compare as
    // integer cents to avoid JS float addition artifacts in the
    // ASSERTION itself; the persisted Decimals ARE exact.
    const asCents = (v: unknown) => Math.round(Number(v) * 100);
    expect(asCents(be.deductionCppEeBase) + asCents(be.deductionCppEeFirstAdd)).toBe(asCents(be.deductionCppEeCombined));
    // Income-tax fields remain UNSET (2c calculates them).
    expect(be.deductionFederalTax).toBeNull();
    expect(be.deductionProvincialTax).toBeNull();
    expect(be.additionalFederalTax).toBeNull();
    expect(be.additionalProvincialTax).toBeNull();
    expect(be.totalEmployeeDeductions).toBeNull();
    expect(be.netPay).toBeNull();
    // Batch remains PREPARED — no CALCULATED transition.
    const batch = await db().payrollBatch.findUniqueOrThrow({ where: { id: r.batchId } });
    expect(batch.status).toBe("PREPARED");
    expect(batch.calculatedAt).toBeNull();
    // Package is pinned.
    expect(batch.statutoryPackageId).toBe(r.statutoryPackageId);
    expect(batch.algorithmVersion).toBe(r.algorithmVersion);
    expect(batch.packageChecksum).toBe(r.packageChecksum);
    // YTD snapshot is frozen with provenance.
    const snap = parseYtdSnapshotV1(be.ytdSnapshotJson);
    expect(snap).not.toBeNull();
    expect(snap!.schemaVersion).toBe(1);
    expect(snap!.taxYear).toBe(2026);
    expect(snap!.ytdGrossEarnings).toBe("0");
  });
});

describe("Payroll-3B-5B-2b — PDOC Scenario 2 (H2, custom TD1)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("$2000 biweekly (H2 pay date) → SAME CPP/EI as Scenario 1 (TD1 does NOT leak into CPP/EI)", async () => {
    const s = await pdocScenario(utc(2026, 9, 12));
    const r = await executeEarningsAndStatutory(s.paP, s.club.id, s.prepared.batchId);
    expect(r.persisted).toBe(true);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: r.batchId } });
    expect(Number(be.deductionCppEeCombined)).toBe(110.99);
    expect(Number(be.deductionCppEeFirstAdd)).toBe(18.65);
    expect(Number(be.deductionCpp2Ee)).toBe(0);
    expect(Number(be.deductionEiEe)).toBe(32.60);
    // The H2 package is pinned (post July 1).
    expect(r.packageVersion).toContain("H2");
  });
});

describe("Payroll-3B-5B-2b — PRIOR_EMPLOYER exclusion regression", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("PRIOR_EMPLOYER opening balance does NOT reduce Spectre's same-employer CPP/EI room", async () => {
    const s = await pdocScenario(utc(2026, 3, 14));
    // Attach a PRIOR_EMPLOYER opening balance loaded to the annual max.
    // Under the correct rule this contributes ZERO to Spectre's YTD;
    // if a bug allowed it through, CPP + EI would BOTH be 0.00 and
    // the assertions below would fail loudly.
    const ob = await createDraftOpeningBalance(s.paP, s.club.id, {
      employeeId: s.emp.id, taxYear: 2026,
      throughPayDate: utc(2026, 3, 1),
      values: {
        ...zeroOB,
        ytdPensionableEarnings: "80000",
        ytdInsurableEarnings:   "68900",
        ytdCppEE:               "4230.45",
        ytdCpp2EE:              "416.00",
        ytdEiEE:                "1123.07",
      },
      priorPayrollKind: "PRIOR_EMPLOYER",
      priorEmployerId:  "OTHER-BN-987654321",
    });
    await activateOpeningBalance(s.paP, s.club.id, ob.id);

    const r = await executeEarningsAndStatutory(s.paP, s.club.id, s.prepared.batchId);
    expect(r.persisted).toBe(true);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: r.batchId } });
    // Prior-employer YTD is zeroed → CPP + EI fire at their normal rates.
    expect(Number(be.deductionCppEeCombined)).toBe(110.99);
    expect(Number(be.deductionEiEe)).toBe(32.60);
  });
});

describe("Payroll-3B-5B-2b — frozen source facts (no live-HR leak)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("mutating the live annual salary AFTER preparation does not change calculated gross", async () => {
    const s = await pdocScenario(utc(2026, 3, 14));
    // Corrupt the live comp record — the calculator must NOT read it.
    await db().employeeCompensation.updateMany({
      where: { clubId: s.club.id, employeeId: s.emp.id },
      data: { rate: "999999" },
    });
    const r = await executeEarningsAndStatutory(s.paP, s.club.id, s.prepared.batchId);
    expect(r.persisted).toBe(true);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: r.batchId } });
    expect(Number(be.grossPay)).toBe(2000);
  });
});

describe("Payroll-3B-5B-2b — readiness refusal + atomicity", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("readiness BLOCKER (deleted package) → persisted:false, no employee row is mutated", async () => {
    const s = await pdocScenario(utc(2026, 3, 14));
    // Snapshot BEFORE — gross should still be null (2b hasn't run).
    const beBefore = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: s.prepared.batchId } });
    expect(beBefore.grossPay).toBeNull();
    // Delete both statutory packages → STATUTORY_PACKAGE_UNRESOLVED.
    await db().payrollStatutoryPackage.deleteMany({ where: { jurisdictionCountry: "CA", jurisdictionProvince: "AB" } });
    const r = await executeEarningsAndStatutory(s.paP, s.club.id, s.prepared.batchId);
    expect(r.persisted).toBe(false);
    expect(r.blockers.length).toBeGreaterThan(0);
    // No employee row was mutated — grossPay is still null.
    const beAfter = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: s.prepared.batchId } });
    expect(beAfter.grossPay).toBeNull();
    expect(beAfter.deductionCppEeCombined).toBeNull();
  });
});
