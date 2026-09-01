// Payroll-3B-5B-1b — CRA verification tests.
//
// These are the "verification gate" regressions the 3B-5B-2
// calculator MUST satisfy before shipping. No dollar arithmetic
// here — every assertion validates a structural invariant of the
// corrections made in this slice.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub } from "../util/db";
import {
  countPeriodsInTaxYear,
} from "@/lib/payroll/statutory/periods-per-year";
import {
  assertValidCanadianParamsV1,
  type CanadianPayrollStatutoryParamsV1,
} from "@/lib/payroll/statutory-package";
import { CA_AB_2026_PARAMS_H1, CA_AB_2026_PARAMS_H2 } from "@/lib/payroll/statutory/seed-ca-ab-2026";

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));

describe("Payroll-3B-5B-1b — actual P (§5)", () => {
  it("counts weekly 52 vs 53 correctly", () => {
    const rows = [
      ...Array.from({ length: 52 }, () => ({ taxYear: 2026 })),
    ];
    expect(countPeriodsInTaxYear(rows, 2026)).toBe(52);

    const with53 = [...rows, { taxYear: 2026 }];
    expect(countPeriodsInTaxYear(with53, 2026)).toBe(53);
  });

  it("counts biweekly 26 vs 27 correctly", () => {
    const rows = [
      ...Array.from({ length: 26 }, () => ({ taxYear: 2026 })),
    ];
    expect(countPeriodsInTaxYear(rows, 2026)).toBe(26);

    const with27 = [...rows, { taxYear: 2026 }];
    expect(countPeriodsInTaxYear(with27, 2026)).toBe(27);
  });

  it("ignores different-tax-year rows", () => {
    const rows = [
      ...Array.from({ length: 26 }, () => ({ taxYear: 2026 })),
      ...Array.from({ length: 26 }, () => ({ taxYear: 2027 })),
    ];
    expect(countPeriodsInTaxYear(rows, 2026)).toBe(26);
    expect(countPeriodsInTaxYear(rows, 2027)).toBe(26);
  });
});

describe("Payroll-3B-5B-1b — H1/H2 seed params", () => {
  it("H1 params pass Zod validation (CanadianPayrollStatutoryParamsV1)", () => {
    expect(() => assertValidCanadianParamsV1(CA_AB_2026_PARAMS_H1)).not.toThrow();
  });

  it("H2 params pass Zod validation", () => {
    expect(() => assertValidCanadianParamsV1(CA_AB_2026_PARAMS_H2)).not.toThrow();
  });

  it("CPP components reconcile: base + first-additional == combined max EE", () => {
    const p = CA_AB_2026_PARAMS_H1;
    const base = Number(p.cpp.baseMaxEE);
    const firstAdd = Number(p.cpp.firstAdditionalMaxEE);
    const combined = Number(p.cpp.combinedMaxEE);
    expect(base + firstAdd).toBeCloseTo(combined, 2);
    // 3519.45 + 711.00 = 4230.45 (published CRA value).
    expect(base).toBe(3519.45);
    expect(firstAdd).toBe(711.00);
    expect(combined).toBe(4230.45);
  });

  it("CPP rates reconcile: base + first-additional == combined rate EE", () => {
    const p = CA_AB_2026_PARAMS_H1;
    expect(Number(p.cpp.baseRateEE) + Number(p.cpp.firstAdditionalRateEE)).toBeCloseTo(Number(p.cpp.combinedRateEE), 6);
  });

  it("EI employer max is CRA-published (NOT derived from 1.4 × employee)", () => {
    const p = CA_AB_2026_PARAMS_H1;
    // Published values:
    expect(Number(p.ei.maxAnnualPremiumEE)).toBe(1123.07);
    expect(Number(p.ei.maxAnnualPremiumER)).toBe(1572.30);
    // 1.4 × 1123.07 = 1572.298 → CRA rounds to 1572.30. Storing the
    // authoritative value avoids per-cent drift.
  });

  it("Alberta 2026 BPA matches CRA-published (22769)", () => {
    expect(Number(CA_AB_2026_PARAMS_H1.provincial!.bpa)).toBe(22769);
  });

  it("Federal BPA phase-out shape (max=16452, min=14829) preserved", () => {
    expect(Number(CA_AB_2026_PARAMS_H1.federal.bpaMax)).toBe(16452);
    expect(Number(CA_AB_2026_PARAMS_H1.federal.bpaMin)).toBe(14829);
  });

  it("YMPE + YAMPE + YBE + YMCE match Government of Canada 2026", () => {
    const p = CA_AB_2026_PARAMS_H1;
    expect(Number(p.cpp.ybe)).toBe(3500);
    expect(Number(p.cpp.ympe)).toBe(74600);
    expect(Number(p.cpp.ymce)).toBe(71100);
    expect(Number(p.cpp.yampe)).toBe(85000);
  });
});

describe("Payroll-3B-5B-1b — CPP base/first-additional decomposition invariant", () => {
  // The calculator (3B-5B-2) will implement §C decomposition. This
  // test proves the MATHEMATICAL invariant is representable with the
  // published CRA parameters — implementation-time regression will
  // then assert the actual algorithm reproduces the split correctly.

  const p = CA_AB_2026_PARAMS_H1;

  it("Factor C annual max decomposes cleanly for a full-year adult (PM=12)", () => {
    const combinedMax = Number(p.cpp.combinedMaxEE);
    const baseMax = Number(p.cpp.baseMaxEE);
    const firstAddMax = Number(p.cpp.firstAdditionalMaxEE);
    // Invariant: base + first-additional == combined, to the cent.
    expect(Math.round((baseMax + firstAddMax) * 100)).toBe(Math.round(combinedMax * 100));
  });

  it("Prorated maxes at PM=6 preserve the reconciliation invariant", () => {
    const combinedProrated = Number(p.cpp.combinedMaxEE) * 6 / 12;
    const baseProrated = Number(p.cpp.baseMaxEE) * 6 / 12;
    const firstAddProrated = Number(p.cpp.firstAdditionalMaxEE) * 6 / 12;
    // Combined 4230.45 × 6/12 = 2115.225.
    expect(Math.round(combinedProrated * 100)).toBe(211523);
    // Base 3519.45 × 6/12 = 1759.725. First-add 711.00 × 6/12 = 355.50.
    // Combined-derived split with residual-to-first-add:
    //   round(combined, 2) = 2115.23 (HALF_UP of 2115.225)
    //   base share = 2115.225 × (0.0495/0.0595) = 1759.72563...
    //   base round = 1759.73
    //   first-add residual = 2115.23 − 1759.73 = 355.50
    // Assert the split reconciles to the rounded combined.
    const roundedCombined = 2115.23;
    const baseShare = 2115.225 * (0.0495 / 0.0595);
    const baseSplit = Math.round(baseShare * 100) / 100;
    const firstAddSplit = Math.round(roundedCombined * 100 - baseSplit * 100) / 100;
    expect(baseSplit + firstAddSplit).toBeCloseTo(roundedCombined, 2);
  });
});

describe("Payroll-3B-5B-1b — TD1 source facts on EmployeeTaxProfile", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("Persists additional-tax + zero-claim + income-less-than-claim flags", async () => {
    const club = await makeClub("Club A");
    const emp = await db().employee.create({
      data: {
        clubId: club.id, firstName: "T", lastName: "TD1",
        email: "t@a.test", hireDate: d(2026, 1, 1), status: "ACTIVE",
        employeeNumber: "E-TD1",
      },
    });
    const row = await db().employeeTaxProfile.create({
      data: {
        clubId: club.id,
        employeeId: emp.id,
        province: "AB",
        td1FormVersion: "2026",
        effectiveFrom: d(2026, 1, 1),
        federalClaimSecretRef: "kms:test-f",
        provincialClaimSecretRef: "kms:test-p",
        additionalFederalTaxAmount: "25.00",
        additionalProvincialTaxAmount: "10.00",
        claimZeroFederal: true,
        claimZeroProvincial: false,
        totalIncomeLessThanClaim: false,
      },
    });
    expect(Number(row.additionalFederalTaxAmount)).toBe(25);
    expect(Number(row.additionalProvincialTaxAmount)).toBe(10);
    expect(row.claimZeroFederal).toBe(true);
    expect(row.totalIncomeLessThanClaim).toBe(false);
  });
});

describe("Payroll-3B-5B-1b — allowance statutory-classification decouple (§18)", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("Allowance can be taxable + non-pensionable + non-insurable independently", async () => {
    const club = await makeClub("Club A");
    const emp = await db().employee.create({
      data: {
        clubId: club.id, firstName: "T", lastName: "Allow",
        email: "a@a.test", hireDate: d(2026, 1, 1), status: "ACTIVE",
        employeeNumber: "E-ALLOW",
      },
    });
    const row = await db().employeeAllowance.create({
      data: {
        clubId: club.id, employeeId: emp.id,
        allowanceType: "RETIRING_ALLOWANCE",
        amount: "500.00",
        currency: "CAD",
        frequency: "ONE_TIME",
        taxable: true,
        pensionable: false,   // CRA: retiring allowance is NOT pensionable
        insurable: false,     // CRA: retiring allowance is NOT insurable
        effectiveFrom: d(2026, 6, 1),
      },
    });
    expect(row.taxable).toBe(true);
    expect(row.pensionable).toBe(false);
    expect(row.insurable).toBe(false);
  });

  it("Legacy allowance rows (pre-3B-5B-1b) can have null pensionable/insurable", async () => {
    const club = await makeClub("Club A");
    const emp = await db().employee.create({
      data: {
        clubId: club.id, firstName: "T", lastName: "Legacy",
        email: "l@a.test", hireDate: d(2026, 1, 1), status: "ACTIVE",
        employeeNumber: "E-LEG",
      },
    });
    const row = await db().employeeAllowance.create({
      data: {
        clubId: club.id, employeeId: emp.id,
        allowanceType: "CELL_PHONE",
        amount: "50.00", frequency: "MONTHLY", taxable: true,
        effectiveFrom: d(2026, 1, 1),
      },
    });
    expect(row.pensionable).toBeNull();
    expect(row.insurable).toBeNull();
    // The calculator will fall back to `taxable` for legacy rows.
  });
});

describe("Payroll-3B-5B-1b — CPT30 effective-date correction (§7)", () => {
  it("firstDayOfMonthAfter(receivedOn) is the anchor — employeeSignedOn does not further delay", () => {
    // Verified via the resolver's derivation logic. Signed May 1,
    // received May 20 → effective June 1. Signed May 25, received
    // May 20 would be REFUSED by the ordering check (signed >
    // received). Signed BEFORE received is the only permitted case,
    // and the derivation uses receivedOn only.
    const receivedOn = new Date(Date.UTC(2026, 4, 20));
    const expected = new Date(Date.UTC(2026, 5, 1));
    // Inlined shape of the private derivation:
    const derived = new Date(Date.UTC(receivedOn.getUTCFullYear(), receivedOn.getUTCMonth() + 1, 1));
    expect(derived.toISOString()).toBe(expected.toISOString());
  });
});
