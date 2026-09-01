// Payroll-3B-5B-2 pre-calc gate (2026-08-31) — opening-balance
// cutover boundary regression tests.
//
// These tests exist to make the double-count class of defect
// impossible: an ACTIVE opening balance now carries an explicit
// throughPayDate, and the YTD aggregator adds POSTED Spectre
// batches ONLY when their payDate is strictly > throughPayDate.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import {
  createDraftOpeningBalance,
  activateOpeningBalance,
  type OpeningBalanceFields,
} from "@/lib/payroll/opening-balance";
import { getEmployeePayrollYtd } from "@/lib/payroll/ytd";
import { ValidationError } from "@/lib/errors";

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));

// Representative same-employer opening balance covering H1 2026.
// Every YTD category exercised so a future contributor cannot
// forget one.
const openingH1: OpeningBalanceFields = {
  ytdGrossEarnings:       "42000",
  ytdTaxableEarnings:     "41000",
  ytdPensionableEarnings: "40000",
  ytdInsurableEarnings:   "40000",
  ytdCppEE_Base:          "2000.00",
  ytdCppEE_FirstAdd:      "372.60",
  ytdCppEE:               "2372.60",
  ytdCpp2EE:              "0",
  ytdEiEE:                "656.00",
  ytdFederalTax:          "5800.00",
  ytdProvincialTax:       "3200.00",
  ytdCppER_Base:          "2000.00",
  ytdCppER_FirstAdd:      "372.60",
  ytdCppER:               "2372.60",
  ytdCpp2ER:              "0",
  ytdEiER:                "918.40",
};

async function scenario() {
  const club = await makeClub("Club Cutover");
  const admin = await makeUser({ email: "admin@cutover.test", role: "CLUB_ADMIN", clubId: club.id });
  const pa    = await makeUser({ email: "pa@cutover.test",    role: "PAYROLL_ADMIN", clubId: club.id });
  const adminP = await principalFor(admin.email);
  const paP    = await principalFor(pa.email);
  await upsertPayrollClubConfig(adminP, club.id, {
    provinceOfEmployment: "AB",
    payrollAdminUserId: pa.id,
  });
  const emp = await db().employee.create({
    data: {
      clubId: club.id, firstName: "Casey", lastName: "Cutover",
      email: "casey@cutover.test", hireDate: d(2026, 1, 1), status: "ACTIVE",
      employeeNumber: "E-CUT-1",
    },
  });
  const pg  = await db().payrollPayGroup.create({
    data: { clubId: club.id, code: "PG-C", name: "PG Cutover", payFrequency: "BIWEEKLY", payDateOffsetDays: 5 },
  });
  return { club, paP, emp, pg };
}

async function seedPeriod(clubId: string, pgId: string, taxYear: number, seq: number, ps: Date, pe: Date, pd: Date) {
  return db().payrollPayPeriod.create({
    data: {
      clubId, payGroupId: pgId,
      sequenceInYear: seq, taxYear,
      periodStart: ps, periodEnd: pe, payDate: pd,
    },
  });
}

async function seedPostedBatch(clubId: string, pgId: string, payPeriodId: string, employeeId: string, grossPay: string) {
  const batch = await db().payrollBatch.create({
    data: { clubId, payGroupId: pgId, payPeriodId, status: "POSTED" },
  });
  await db().payrollBatchEmployee.create({
    data: {
      clubId, batchId: batch.id, employeeId,
      jurisdictionCountry: "CA", jurisdictionProvince: "AB",
      employeeLifecycleAtPrep: "ACTIVE",
      grossPay,
    },
  });
  return batch;
}

// ------------------------------------------------------------
// §11 — Mid-year cutover: pre-cutover Spectre batches EXCLUDED
// ------------------------------------------------------------
describe("Payroll-3B-5B-2 pre-calc gate — mid-year cutover (§11)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("opening balance through 2026-06-30 + June 15 (pre-cutover) + July 10 (post-cutover) → YTD = opening + July 10 ONLY", async () => {
    const s = await scenario();

    const draft = await createDraftOpeningBalance(s.paP, s.club.id, {
      employeeId: s.emp.id,
      taxYear: 2026,
      throughPayDate: d(2026, 6, 30),
      values: openingH1,
    });
    await activateOpeningBalance(s.paP, s.club.id, draft.id);

    // Pre-cutover POSTED Spectre batch (June 15).
    const ppJun = await seedPeriod(s.club.id, s.pg.id, 2026, 12, d(2026, 6, 1),  d(2026, 6, 14), d(2026, 6, 15));
    const bJun  = await seedPostedBatch(s.club.id, s.pg.id, ppJun.id, s.emp.id, "3000.00");

    // Post-cutover POSTED Spectre batch (July 10).
    const ppJul = await seedPeriod(s.club.id, s.pg.id, 2026, 14, d(2026, 6, 28), d(2026, 7, 10), d(2026, 7, 10));
    const bJul  = await seedPostedBatch(s.club.id, s.pg.id, ppJul.id, s.emp.id, "2500.00");

    const ytd = await getEmployeePayrollYtd(s.club.id, s.emp.id, d(2026, 7, 24));

    // Opening 42000 + July 10 batch 2500 = 44500 — June 15 EXCLUDED.
    expect(Number(ytd.ytdGrossEarnings)).toBe(44500);
    expect(ytd.sources.postedBatchIds).toContain(bJul.id);
    expect(ytd.sources.postedBatchIds).not.toContain(bJun.id);
    expect(ytd.sources.openingBalanceId).toBe(draft.id);
  });
});

// ------------------------------------------------------------
// §12 — Strict "> throughPayDate" boundary
// ------------------------------------------------------------
describe("Payroll-3B-5B-2 pre-calc gate — cutover boundary strictness (§12)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("POSTED batch with payDate == opening.throughPayDate is EXCLUDED (opening already includes it)", async () => {
    const s = await scenario();
    const draft = await createDraftOpeningBalance(s.paP, s.club.id, {
      employeeId: s.emp.id,
      taxYear: 2026,
      throughPayDate: d(2026, 6, 30),
      values: openingH1,
    });
    await activateOpeningBalance(s.paP, s.club.id, draft.id);

    const pp = await seedPeriod(s.club.id, s.pg.id, 2026, 13, d(2026, 6, 15), d(2026, 6, 28), d(2026, 6, 30));
    const b  = await seedPostedBatch(s.club.id, s.pg.id, pp.id, s.emp.id, "1000.00");

    const ytd = await getEmployeePayrollYtd(s.club.id, s.emp.id, d(2026, 7, 24));
    expect(ytd.sources.postedBatchIds).not.toContain(b.id);
    expect(Number(ytd.ytdGrossEarnings)).toBe(42000);
  });
  it("POSTED batch with payDate == opening.throughPayDate + 1 day is INCLUDED", async () => {
    const s = await scenario();
    const draft = await createDraftOpeningBalance(s.paP, s.club.id, {
      employeeId: s.emp.id,
      taxYear: 2026,
      throughPayDate: d(2026, 6, 30),
      values: openingH1,
    });
    await activateOpeningBalance(s.paP, s.club.id, draft.id);

    const pp = await seedPeriod(s.club.id, s.pg.id, 2026, 14, d(2026, 6, 28), d(2026, 7, 11), d(2026, 7, 1));
    const b  = await seedPostedBatch(s.club.id, s.pg.id, pp.id, s.emp.id, "1000.00");

    const ytd = await getEmployeePayrollYtd(s.club.id, s.emp.id, d(2026, 7, 24));
    expect(ytd.sources.postedBatchIds).toContain(b.id);
    expect(Number(ytd.ytdGrossEarnings)).toBe(43000);
  });
});

// ------------------------------------------------------------
// §13 — Tax-year boundary
// ------------------------------------------------------------
describe("Payroll-3B-5B-2 pre-calc gate — tax-year boundary (§13)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("2026 opening balance does NOT flow into 2027 YTD", async () => {
    const s = await scenario();
    const draft = await createDraftOpeningBalance(s.paP, s.club.id, {
      employeeId: s.emp.id,
      taxYear: 2026,
      throughPayDate: d(2026, 12, 31),
      values: openingH1,
    });
    await activateOpeningBalance(s.paP, s.club.id, draft.id);

    // A January 2027 pay date starts from a clean 2027 YTD — no OB and no batches.
    const ytd2027 = await getEmployeePayrollYtd(s.club.id, s.emp.id, d(2027, 1, 15));
    expect(ytd2027.taxYear).toBe(2027);
    expect(Number(ytd2027.ytdGrossEarnings)).toBe(0);
    expect(ytd2027.sources.openingBalanceId).toBeNull();
    expect(ytd2027.sources.postedBatchIds).toEqual([]);
  });
  it("throughPayDate cross-year is REFUSED at draft creation", async () => {
    const s = await scenario();
    await expect(
      createDraftOpeningBalance(s.paP, s.club.id, {
        employeeId: s.emp.id,
        taxYear: 2026,
        throughPayDate: d(2027, 1, 15),
        values: openingH1,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ------------------------------------------------------------
// §14 — Supersession
// ------------------------------------------------------------
describe("Payroll-3B-5B-2 pre-calc gate — supersession (§14)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("SUPERSEDED opening balance does NOT contribute; ACTIVE replacement carries its own throughPayDate", async () => {
    const s = await scenario();

    // First (incorrect) opening balance — through 2026-06-15.
    const first = await createDraftOpeningBalance(s.paP, s.club.id, {
      employeeId: s.emp.id,
      taxYear: 2026,
      throughPayDate: d(2026, 6, 15),
      values: { ...openingH1, ytdGrossEarnings: "9999" }, // wrong number
    });
    await activateOpeningBalance(s.paP, s.club.id, first.id);

    // Correction — through 2026-06-30 with the correct numbers.
    const second = await createDraftOpeningBalance(s.paP, s.club.id, {
      employeeId: s.emp.id,
      taxYear: 2026,
      throughPayDate: d(2026, 6, 30),
      values: openingH1,
    });
    await activateOpeningBalance(s.paP, s.club.id, second.id);

    const supersededRow = await db().payrollOpeningBalance.findUniqueOrThrow({ where: { id: first.id } });
    expect(supersededRow.status).toBe("SUPERSEDED");
    expect(supersededRow.supersededById).toBe(second.id);
    // Historical row remains immutable — its throughPayDate must not
    // be silently overwritten by the successor.
    expect(supersededRow.throughPayDate?.toISOString().slice(0, 10)).toBe("2026-06-15");

    // YTD reads only the ACTIVE row (second), NOT the superseded one.
    const ytd = await getEmployeePayrollYtd(s.club.id, s.emp.id, d(2026, 7, 24));
    expect(ytd.sources.openingBalanceId).toBe(second.id);
    expect(Number(ytd.ytdGrossEarnings)).toBe(42000); // second.values, not first.values
  });
});

// ------------------------------------------------------------
// §5 — Refusal when ACTIVE opening balance has null throughPayDate
// ------------------------------------------------------------
describe("Payroll-3B-5B-2 pre-calc gate — null throughPayDate refusal (§5)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("YTD aggregator REFUSES to consume an ACTIVE opening balance with null throughPayDate", async () => {
    const s = await scenario();
    // Craft an ACTIVE opening balance directly, bypassing the service,
    // to simulate a legacy row (no throughPayDate).
    await db().payrollOpeningBalance.create({
      data: {
        clubId: s.club.id, employeeId: s.emp.id, taxYear: 2026,
        status: "ACTIVE", ...openingH1,
        activatedAt: new Date(),
        // throughPayDate deliberately omitted.
      },
    });
    await expect(getEmployeePayrollYtd(s.club.id, s.emp.id, d(2026, 7, 24)))
      .rejects.toBeInstanceOf(ValidationError);
  });
});

// ------------------------------------------------------------
// §17 — Full YTD vector (all categories preserved from opening)
// ------------------------------------------------------------
describe("Payroll-3B-5B-2 pre-calc gate — full YTD vector (§17)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("every canonical YTD field on the ACTIVE opening balance is exposed on the aggregate", async () => {
    const s = await scenario();
    const draft = await createDraftOpeningBalance(s.paP, s.club.id, {
      employeeId: s.emp.id,
      taxYear: 2026,
      throughPayDate: d(2026, 6, 30),
      values: openingH1,
    });
    await activateOpeningBalance(s.paP, s.club.id, draft.id);
    const ytd = await getEmployeePayrollYtd(s.club.id, s.emp.id, d(2026, 7, 24));

    // Compare numerically — Prisma Decimal normalises trailing zeros.
    expect(Number(ytd.ytdGrossEarnings)).toBe(42000);
    expect(Number(ytd.ytdTaxableEarnings)).toBe(41000);
    expect(Number(ytd.ytdPensionableEarnings)).toBe(40000);
    expect(Number(ytd.ytdInsurableEarnings)).toBe(40000);
    expect(Number(ytd.ytdCppEE_Base)).toBe(2000);
    expect(Number(ytd.ytdCppEE_FirstAdd)).toBe(372.60);
    expect(Number(ytd.ytdCppEE)).toBe(2372.60);
    expect(Number(ytd.ytdCpp2EE)).toBe(0);
    expect(Number(ytd.ytdEiEE)).toBe(656.00);
    expect(Number(ytd.ytdFederalTax)).toBe(5800.00);
    expect(Number(ytd.ytdProvincialTax)).toBe(3200.00);
    expect(Number(ytd.ytdCppER_Base)).toBe(2000);
    expect(Number(ytd.ytdCppER_FirstAdd)).toBe(372.60);
    expect(Number(ytd.ytdCppER)).toBe(2372.60);
    expect(Number(ytd.ytdCpp2ER)).toBe(0);
    expect(Number(ytd.ytdEiER)).toBe(918.40);
  });
});

// ------------------------------------------------------------
// §8, §9 — no opening balance & non-POSTED batches
// ------------------------------------------------------------
describe("Payroll-3B-5B-2 pre-calc gate — no OB / non-POSTED (§8, §9)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("no opening balance → YTD is just qualifying POSTED batches in the same tax year with payDate < asOf", async () => {
    const s = await scenario();
    const ppJan = await seedPeriod(s.club.id, s.pg.id, 2026, 1, d(2026, 1, 1),  d(2026, 1, 14), d(2026, 1, 20));
    const ppFeb = await seedPeriod(s.club.id, s.pg.id, 2026, 3, d(2026, 2, 1),  d(2026, 2, 14), d(2026, 2, 15));
    await seedPostedBatch(s.club.id, s.pg.id, ppJan.id, s.emp.id, "1000.00");
    await seedPostedBatch(s.club.id, s.pg.id, ppFeb.id, s.emp.id, "1500.00");
    const ytd = await getEmployeePayrollYtd(s.club.id, s.emp.id, d(2026, 3, 1));
    expect(Number(ytd.ytdGrossEarnings)).toBe(2500);
    expect(ytd.sources.openingBalanceId).toBeNull();
    expect(ytd.sources.postedBatchIds.length).toBe(2);
  });
  it("current pay (POSTED after asOf) does NOT contribute to its own prior YTD", async () => {
    const s = await scenario();
    const ppNow = await seedPeriod(s.club.id, s.pg.id, 2026, 5, d(2026, 3, 1),  d(2026, 3, 14), d(2026, 3, 20));
    const bNow  = await seedPostedBatch(s.club.id, s.pg.id, ppNow.id, s.emp.id, "9999.00");
    // asOfPayDate == payDate → excluded (strict <).
    const ytdAtSelf = await getEmployeePayrollYtd(s.club.id, s.emp.id, d(2026, 3, 20));
    expect(ytdAtSelf.sources.postedBatchIds).not.toContain(bNow.id);
    expect(Number(ytdAtSelf.ytdGrossEarnings)).toBe(0);
  });
  it("DRAFT / PREPARED / CALCULATED / VOIDED batches never contribute to YTD", async () => {
    const s = await scenario();
    const pp = await seedPeriod(s.club.id, s.pg.id, 2026, 7, d(2026, 4, 1), d(2026, 4, 14), d(2026, 4, 15));
    let seq = 1;
    for (const status of ["DRAFT", "PREPARED", "CALCULATED", "VOIDED"] as const) {
      // Batch's `sequence` is unique within (clubId, payGroupId, payPeriodId).
      const b = await db().payrollBatch.create({
        data: { clubId: s.club.id, payGroupId: s.pg.id, payPeriodId: pp.id, sequence: seq++, status },
      });
      await db().payrollBatchEmployee.create({
        data: {
          clubId: s.club.id, batchId: b.id, employeeId: s.emp.id,
          jurisdictionCountry: "CA", jurisdictionProvince: "AB",
          employeeLifecycleAtPrep: "ACTIVE", grossPay: "1000.00",
        },
      });
    }
    const ytd = await getEmployeePayrollYtd(s.club.id, s.emp.id, d(2026, 5, 1));
    expect(Number(ytd.ytdGrossEarnings)).toBe(0);
    expect(ytd.sources.postedBatchIds).toEqual([]);
  });
});

// ------------------------------------------------------------
// §10 — PRIOR_EMPLOYER remains excluded from YTD (regression)
// ------------------------------------------------------------
describe("Payroll-3B-5B-2 pre-calc gate — PRIOR_EMPLOYER remains zeroed (§10)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("PRIOR_EMPLOYER opening balance contributes ZERO to every YTD category", async () => {
    const s = await scenario();
    const draft = await createDraftOpeningBalance(s.paP, s.club.id, {
      employeeId: s.emp.id,
      taxYear: 2026,
      throughPayDate: d(2026, 6, 30),
      values: openingH1,
      priorPayrollKind: "PRIOR_EMPLOYER",
      priorEmployerId: "OTHER-BN-987654321",
    });
    await activateOpeningBalance(s.paP, s.club.id, draft.id);

    const ytd = await getEmployeePayrollYtd(s.club.id, s.emp.id, d(2026, 7, 24));
    // Every category must be zero — kind zeros the whole row.
    expect(Number(ytd.ytdGrossEarnings)).toBe(0);
    expect(Number(ytd.ytdTaxableEarnings)).toBe(0);
    expect(Number(ytd.ytdPensionableEarnings)).toBe(0);
    expect(Number(ytd.ytdInsurableEarnings)).toBe(0);
    expect(Number(ytd.ytdCppEE)).toBe(0);
    expect(Number(ytd.ytdCpp2EE)).toBe(0);
    expect(Number(ytd.ytdEiEE)).toBe(0);
    expect(Number(ytd.ytdFederalTax)).toBe(0);
    expect(Number(ytd.ytdProvincialTax)).toBe(0);
    expect(Number(ytd.ytdCppER)).toBe(0);
    expect(Number(ytd.ytdCpp2ER)).toBe(0);
    expect(Number(ytd.ytdEiER)).toBe(0);
    // Sourced from the ACTIVE row so the kind is exposed to the caller.
    expect(ytd.sources.openingBalanceId).toBe(draft.id);
    expect(ytd.sources.openingBalancePriorPayrollKind).toBe("PRIOR_EMPLOYER");
  });
});
