// Payroll-3B-5B-1 (§23) — prior-payroll distinction: PRIOR_EMPLOYER
// opening balances must NOT reduce this employer's CPP/EI YTD
// aggregate; PRIOR_SYSTEM_SAME_EMPLOYER must contribute.

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

function values(overrides?: Partial<OpeningBalanceFields>): OpeningBalanceFields {
  return {
    ytdGrossEarnings: "40000",
    ytdTaxableEarnings: "38000",
    ytdPensionableEarnings: "38000",
    ytdInsurableEarnings: "38000",
    ytdCppEE_Base: "1900",
    ytdCppEE_FirstAdd: "380",
    ytdCppEE: "2280",
    ytdCpp2EE: "0",
    ytdEiEE: "620",
    ytdFederalTax: "5000",
    ytdProvincialTax: "3000",
    ytdCppER_Base: "1900",
    ytdCppER_FirstAdd: "380",
    ytdCppER: "2280",
    ytdCpp2ER: "0",
    ytdEiER: "868",
    ...overrides,
  };
}

async function scenario() {
  const club = await makeClub("Club A");
  const admin = await makeUser({ email: "admin@a.test", role: "CLUB_ADMIN", clubId: club.id });
  const pa = await makeUser({ email: "pa@a.test", role: "PAYROLL_ADMIN", clubId: club.id });
  const adminP = await principalFor(admin.email);
  const paP = await principalFor(pa.email);
  await upsertPayrollClubConfig(adminP, club.id, {
    provinceOfEmployment: "AB", payrollAdminUserId: pa.id,
  });
  const emp = await db().employee.create({
    data: {
      clubId: club.id, firstName: "T", lastName: "Emp",
      email: "t@a.test", hireDate: d(2026, 6, 1), status: "ACTIVE",
      employeeNumber: "E-YTD-1", dateOfBirth: d(1980, 5, 12),
    },
  });
  return { club, paP, emp };
}

describe("Payroll-3B-5B-1 — prior-payroll YTD distinction", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("PRIOR_SYSTEM_SAME_EMPLOYER opening balance contributes to CPP/EI YTD", async () => {
    const s = await scenario();
    const draft = await createDraftOpeningBalance(s.paP, s.club.id, {
      employeeId: s.emp.id, taxYear: 2026, values: values(),
      priorPayrollKind: "PRIOR_SYSTEM_SAME_EMPLOYER",
    });
    await activateOpeningBalance(s.paP, s.club.id, draft.id);
    const ytd = await getEmployeePayrollYtd(s.club.id, s.emp.id, d(2026, 9, 1));
    expect(Number(ytd.ytdPensionableEarnings)).toBe(38000);
    expect(Number(ytd.ytdCppEE)).toBe(2280);
    expect(Number(ytd.ytdEiEE)).toBe(620);
    expect(ytd.sources.openingBalancePriorPayrollKind).toBe("PRIOR_SYSTEM_SAME_EMPLOYER");
  });

  it("PRIOR_EMPLOYER contributes ZERO to every employer-YTD category (§9-10)", async () => {
    const s = await scenario();
    const draft = await createDraftOpeningBalance(s.paP, s.club.id, {
      employeeId: s.emp.id, taxYear: 2026, values: values(),
      priorPayrollKind: "PRIOR_EMPLOYER",
      priorEmployerId: "BN9-123456789",
    });
    await activateOpeningBalance(s.paP, s.club.id, draft.id);
    const ytd = await getEmployeePayrollYtd(s.club.id, s.emp.id, d(2026, 9, 1));
    // §9-10: another employer's history contributes ZERO to THIS
    // employer's Payroll YTD in every category — earnings, statutory
    // bases, deductions, and tax withholdings alike. Each employer
    // reports its own T4 independently.
    expect(Number(ytd.ytdGrossEarnings)).toBe(0);
    expect(Number(ytd.ytdTaxableEarnings)).toBe(0);
    expect(Number(ytd.ytdPensionableEarnings)).toBe(0);
    expect(Number(ytd.ytdInsurableEarnings)).toBe(0);
    expect(Number(ytd.ytdCppEE)).toBe(0);
    expect(Number(ytd.ytdCppEE_Base)).toBe(0);
    expect(Number(ytd.ytdCppEE_FirstAdd)).toBe(0);
    expect(Number(ytd.ytdCpp2EE)).toBe(0);
    expect(Number(ytd.ytdEiEE)).toBe(0);
    expect(Number(ytd.ytdFederalTax)).toBe(0);
    expect(Number(ytd.ytdProvincialTax)).toBe(0);
    expect(Number(ytd.ytdCppER)).toBe(0);
    expect(Number(ytd.ytdCpp2ER)).toBe(0);
    expect(Number(ytd.ytdEiER)).toBe(0);
    // Provenance is still exposed so a reviewer can see the row exists.
    expect(ytd.sources.openingBalancePriorPayrollKind).toBe("PRIOR_EMPLOYER");
    expect(ytd.sources.openingBalanceId).toBe(draft.id);
  });

  it("PRIOR_EMPLOYER requires priorEmployerId — refused when missing", async () => {
    const s = await scenario();
    await expect(
      createDraftOpeningBalance(s.paP, s.club.id, {
        employeeId: s.emp.id, taxYear: 2026, values: values(),
        priorPayrollKind: "PRIOR_EMPLOYER",
        // no priorEmployerId → refused
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("PRIOR_ADJUSTMENT contributes to CPP/EI YTD (same-employer correction)", async () => {
    const s = await scenario();
    const draft = await createDraftOpeningBalance(s.paP, s.club.id, {
      employeeId: s.emp.id, taxYear: 2026, values: values(),
      priorPayrollKind: "PRIOR_ADJUSTMENT",
    });
    await activateOpeningBalance(s.paP, s.club.id, draft.id);
    const ytd = await getEmployeePayrollYtd(s.club.id, s.emp.id, d(2026, 9, 1));
    expect(Number(ytd.ytdCppEE)).toBe(2280);
    expect(Number(ytd.ytdEiEE)).toBe(620);
    expect(ytd.sources.openingBalancePriorPayrollKind).toBe("PRIOR_ADJUSTMENT");
  });
});
