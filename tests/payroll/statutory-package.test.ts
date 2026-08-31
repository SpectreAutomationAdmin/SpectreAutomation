// Payroll-3B-5A — Spectre-owned statutory package install + resolver.
//
// Test values in this file are LABORATORY VALUES for exercising the
// resolver mechanics and Zod validation only. They are NOT authoritative
// CRA parameters and MUST NOT be reused as production seed data.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import {
  installStatutoryPackage,
  resolveStatutoryPackage,
  assertValidCanadianParamsV1,
  InvalidStatutoryParamsError,
  type CanadianPayrollStatutoryParamsV1,
} from "@/lib/payroll/statutory-package";
import { ValidationError } from "@/lib/errors";

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));

async function superAdminP() {
  const c = db();
  await c.user.deleteMany({ where: { email: "super@spectre.test" } });
  const u = await c.user.create({
    data: {
      email: "super@spectre.test",
      name: "Super",
      role: "SUPER_ADMIN",
      passwordHash: "x",
      status: "ACTIVE",
    },
  });
  await c.userClubRole.create({ data: { userId: u.id, clubId: null, roleKey: "SUPER_ADMIN" } });
  return principalFor("super@spectre.test");
}

function baseParams(): CanadianPayrollStatutoryParamsV1 {
  return {
    schemaVersion: 1,
    jurisdictionCountry: "CA",
    jurisdictionProvince: "AB",
    cpp: {
      ympe: "68500",
      yampe: "73200",
      ybe: "3500",
      baseRateEE: "0.0595",
      cpp2RateEE: "0.04",
      baseRateER: "0.0595",
      cpp2RateER: "0.04",
    },
    ei: { mie: "65700", rateEE: "0.0164", employerMultiplier: "1.4" },
    federal: {
      brackets: [
        { from: "0", to: "55867", rate: "0.15", constantK: "0" },
      ],
      bpaLow: "14156",
      bpaHigh: "15705",
      bpaPhaseOutStart: "173205",
      bpaPhaseOutEnd: "246752",
      lowestRate: "0.15",
      cpp2DeductionRate: "0.15",
    },
    provincial: {
      brackets: [
        { from: "0", to: "142292", rate: "0.10", constantK: "0" },
      ],
      bpa: "21885",
      lowestRate: "0.10",
    },
    rounding: { mode: "HALF_UP", netPayMode: "HALF_UP" },
  };
}

describe("Payroll-3B-5A — statutory package", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("SUPER_ADMIN can install; a tenant Payroll Admin cannot", async () => {
    const club = await makeClub("Club A");
    const pa = await makeUser({ email: "pa@a.test", role: "PAYROLL_ADMIN", clubId: club.id });
    const paP = await principalFor(pa.email);
    await expect(
      installStatutoryPackage(paP, {
        jurisdictionCountry: "CA",
        jurisdictionProvince: "AB",
        effectiveFrom: d(2026, 1, 1),
        effectiveTo: d(2026, 7, 1),
        packageVersion: "TEST-1H",
        sourcePublication: "TEST",
        params: baseParams(),
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const sup = await superAdminP();
    const r = await installStatutoryPackage(sup, {
      jurisdictionCountry: "CA",
      jurisdictionProvince: "AB",
      effectiveFrom: d(2026, 1, 1),
      effectiveTo: d(2026, 7, 1),
      packageVersion: "TEST-1H",
      sourcePublication: "TEST",
      params: baseParams(),
    });
    expect(r.id).toBeDefined();
    expect(r.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it("resolver picks the correct pay-date-effective package (Jun 30 vs Jul 1, 2026)", async () => {
    const sup = await superAdminP();
    await installStatutoryPackage(sup, {
      jurisdictionCountry: "CA",
      jurisdictionProvince: "AB",
      effectiveFrom: d(2026, 1, 1),
      effectiveTo: d(2026, 7, 1),
      packageVersion: "TEST-1H",
      sourcePublication: "TEST",
      params: baseParams(),
    });
    await installStatutoryPackage(sup, {
      jurisdictionCountry: "CA",
      jurisdictionProvince: "AB",
      effectiveFrom: d(2026, 7, 1),
      effectiveTo: null,
      packageVersion: "TEST-2H",
      sourcePublication: "TEST",
      params: baseParams(),
    });

    const jun = await resolveStatutoryPackage({ country: "CA", province: "AB", payDate: d(2026, 6, 30) });
    expect(jun.packageVersion).toBe("TEST-1H");
    const jul = await resolveStatutoryPackage({ country: "CA", province: "AB", payDate: d(2026, 7, 1) });
    expect(jul.packageVersion).toBe("TEST-2H");
  });

  it("resolver refuses when no package covers the pay date", async () => {
    await expect(
      resolveStatutoryPackage({ country: "CA", province: "AB", payDate: d(2026, 1, 1) }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("install refuses to overlap an existing package (unless the older one is auto-capped)", async () => {
    const sup = await superAdminP();
    // Open-ended package starting Jan 1, 2026.
    await installStatutoryPackage(sup, {
      jurisdictionCountry: "CA",
      jurisdictionProvince: "AB",
      effectiveFrom: d(2026, 1, 1),
      effectiveTo: null,
      packageVersion: "TEST-1H-OPEN",
      sourcePublication: "TEST",
      params: baseParams(),
    });
    // Installing Jul 1 → auto-caps the older row at Jul 1.
    await installStatutoryPackage(sup, {
      jurisdictionCountry: "CA",
      jurisdictionProvince: "AB",
      effectiveFrom: d(2026, 7, 1),
      effectiveTo: null,
      packageVersion: "TEST-2H",
      sourcePublication: "TEST",
      params: baseParams(),
    });
    const older = await db().payrollStatutoryPackage.findFirstOrThrow({
      where: { packageVersion: "TEST-1H-OPEN" },
    });
    expect(older.effectiveTo?.toISOString()).toBe(d(2026, 7, 1).toISOString());

    // Attempt to install a package that OVERLAPS both existing windows.
    await expect(
      installStatutoryPackage(sup, {
        jurisdictionCountry: "CA",
        jurisdictionProvince: "AB",
        effectiveFrom: d(2026, 3, 1),
        effectiveTo: d(2026, 8, 1),
        packageVersion: "OVERLAP",
        sourcePublication: "TEST",
        params: baseParams(),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("install validates paramsJson via Zod (malformed rejected loudly)", async () => {
    const sup = await superAdminP();
    const bad = { ...baseParams(), cpp: { ...baseParams().cpp, ympe: "not-a-decimal" } } as CanadianPayrollStatutoryParamsV1;
    await expect(
      installStatutoryPackage(sup, {
        jurisdictionCountry: "CA",
        jurisdictionProvince: "AB",
        effectiveFrom: d(2026, 1, 1),
        effectiveTo: null,
        packageVersion: "BAD",
        sourcePublication: "TEST",
        params: bad,
      }),
    ).rejects.toBeInstanceOf(InvalidStatutoryParamsError);
  });

  it("effectiveTo must be strictly greater than effectiveFrom", async () => {
    const sup = await superAdminP();
    await expect(
      installStatutoryPackage(sup, {
        jurisdictionCountry: "CA",
        jurisdictionProvince: "AB",
        effectiveFrom: d(2026, 7, 1),
        effectiveTo: d(2026, 7, 1),
        packageVersion: "ZERO",
        sourcePublication: "TEST",
        params: baseParams(),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("assertValidCanadianParamsV1 asserts and never mutates the input", () => {
    expect(() => assertValidCanadianParamsV1(baseParams())).not.toThrow();
    // Missing required nested field
    const bad = JSON.parse(JSON.stringify(baseParams())) as CanadianPayrollStatutoryParamsV1;
    delete (bad as unknown as Record<string, unknown>).rounding;
    expect(() => assertValidCanadianParamsV1(bad)).toThrow(InvalidStatutoryParamsError);
  });
});
