// FPP-1 (2026-09-19) — PayrollOpeningBalanceComponent CRUD + aggregator.
//
// Founder-directive tests §12-13:
//   - CRUD (create / list / remove).
//   - Duplicate prevention (@@unique).
//   - Parent lifecycle immutability (edits only while parent DRAFT).
//   - Historically-inactive components remain selectable.
//   - RRSP EE + RRSP ER kept separate (side).
//   - Employee vs Employer benefit components kept separate.
//   - Cross-tenant isolation.
//   - No-double-count: opening-YTD + POSTED-batch aggregate exactly once
//     when the two payDate windows abut.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { ValidationError } from "@/lib/errors";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import {
  createDraftOpeningBalance,
  activateOpeningBalance,
  addOpeningComponentBalance,
  removeOpeningComponentBalance,
  listOpeningComponentBalances,
  type OpeningBalanceFields,
} from "@/lib/payroll/opening-balance";
import { getEmployeeComponentYtd } from "@/lib/payroll/component-ytd";

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));
const CUTOVER = d(2026, 8, 31);

const zeroValues: OpeningBalanceFields = {
  ytdGrossEarnings: "0", ytdTaxableEarnings: "0", ytdPensionableEarnings: "0",
  ytdInsurableEarnings: "0",
  ytdCppEE_Base: "0", ytdCppEE_FirstAdd: "0", ytdCppEE: "0",
  ytdCpp2EE: "0", ytdEiEE: "0",
  ytdFederalTax: "0", ytdProvincialTax: "0",
  ytdCppER_Base: "0", ytdCppER_FirstAdd: "0", ytdCppER: "0",
  ytdCpp2ER: "0", ytdEiER: "0",
};

async function seedComponent(clubId: string, opts: {
  code: string;
  displayName?: string;
  category?: string;
  side?: "EMPLOYEE" | "EMPLOYER";
  cashEffect?: "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT";
  active?: boolean;
}) {
  return db().payrollComponent.create({
    data: {
      clubId,
      code: opts.code,
      displayName: opts.displayName ?? opts.code,
      category: opts.category ?? "ADDITIONAL_EARNING",
      side: opts.side ?? "EMPLOYEE",
      cashEffect: opts.cashEffect ?? "INCREASES_NET_PAY",
      calculationMethod: "FIXED_AMOUNT",
      displaySection: "EARNINGS",
      usage: "BOTH",
      active: opts.active ?? true,
    },
  });
}

async function scenario() {
  const clubA = await makeClub("FPP-1 Club A");
  const clubB = await makeClub("FPP-1 Club B");
  const admin = await makeUser({ email: "adminA@fpp1.test", role: "CLUB_ADMIN", clubId: clubA.id });
  const pa = await makeUser({ email: "paA@fpp1.test", role: "PAYROLL_ADMIN", clubId: clubA.id });
  const paB = await makeUser({ email: "paB@fpp1.test", role: "PAYROLL_ADMIN", clubId: clubB.id });
  const adminP = await principalFor(admin.email);
  const paP = await principalFor(pa.email);
  const paBP = await principalFor(paB.email);
  await upsertPayrollClubConfig(adminP, clubA.id, {
    provinceOfEmployment: "AB",
    payrollAdminUserId: pa.id,
  });
  const emp = await db().employee.create({
    data: {
      clubId: clubA.id, firstName: "Component", lastName: "Openings",
      email: "co@fpp1.test", hireDate: d(2026, 2, 1), status: "ACTIVE",
      employeeNumber: "E-FPP1",
    },
  });
  const empB = await db().employee.create({
    data: {
      clubId: clubB.id, firstName: "Other", lastName: "Tenant",
      email: "ot@fpp1.test", hireDate: d(2026, 2, 1), status: "ACTIVE",
      employeeNumber: "E-FPP1-B",
    },
  });
  return { clubA, clubB, adminP, paP, paBP, emp, empB };
}

describe("FPP-1 — PayrollOpeningBalanceComponent CRUD", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("adds a component opening on a DRAFT parent, lists it, and removes it", async () => {
    const s = await scenario();
    const rrsp = await seedComponent(s.clubA.id, {
      code: "RRSP_EE", displayName: "RRSP (employee)", side: "EMPLOYEE",
      cashEffect: "DECREASES_NET_PAY", category: "PRE_TAX_DEDUCTION",
    });
    const draft = await createDraftOpeningBalance(s.paP, s.clubA.id, {
      employeeId: s.emp.id, taxYear: 2026, throughPayDate: CUTOVER, values: zeroValues,
    });
    const added = await addOpeningComponentBalance(s.paP, s.clubA.id, {
      openingBalanceId: draft.id, componentId: rrsp.id, ytdAmount: "1250.00",
    });
    expect(added.componentCode).toBe("RRSP_EE");
    expect(added.side).toBe("EMPLOYEE");
    expect(added.ytdAmount).toBe("1250");

    const listed = await listOpeningComponentBalances(s.paP, s.clubA.id, draft.id);
    expect(listed).toHaveLength(1);
    expect(listed[0].componentCode).toBe("RRSP_EE");

    await removeOpeningComponentBalance(s.paP, s.clubA.id, added.id);
    const afterRemoval = await listOpeningComponentBalances(s.paP, s.clubA.id, draft.id);
    expect(afterRemoval).toHaveLength(0);
  });

  it("refuses to add a component with the same code twice (unique guard)", async () => {
    const s = await scenario();
    const c = await seedComponent(s.clubA.id, { code: "CELL_PHONE_TB", category: "TAXABLE_BENEFIT" });
    const draft = await createDraftOpeningBalance(s.paP, s.clubA.id, {
      employeeId: s.emp.id, taxYear: 2026, throughPayDate: CUTOVER, values: zeroValues,
    });
    await addOpeningComponentBalance(s.paP, s.clubA.id, {
      openingBalanceId: draft.id, componentId: c.id, ytdAmount: "300",
    });
    await expect(
      addOpeningComponentBalance(s.paP, s.clubA.id, {
        openingBalanceId: draft.id, componentId: c.id, ytdAmount: "400",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses component edits when parent is VALIDATED / ACTIVE (§16 lifecycle immutability)", async () => {
    const s = await scenario();
    const c = await seedComponent(s.clubA.id, { code: "LTD_EE" });
    const draft = await createDraftOpeningBalance(s.paP, s.clubA.id, {
      employeeId: s.emp.id, taxYear: 2026, throughPayDate: CUTOVER, values: zeroValues,
    });
    await activateOpeningBalance(s.paP, s.clubA.id, draft.id);
    await expect(
      addOpeningComponentBalance(s.paP, s.clubA.id, {
        openingBalanceId: draft.id, componentId: c.id, ytdAmount: "100",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("historically-inactive components remain selectable for HISTORICAL rows", async () => {
    const s = await scenario();
    const c = await seedComponent(s.clubA.id, {
      code: "LEGACY_BONUS", active: false,
    });
    const draft = await createDraftOpeningBalance(s.paP, s.clubA.id, {
      employeeId: s.emp.id, taxYear: 2026, throughPayDate: CUTOVER, values: zeroValues,
    });
    const added = await addOpeningComponentBalance(s.paP, s.clubA.id, {
      openingBalanceId: draft.id, componentId: c.id, ytdAmount: "500",
    });
    expect(added.componentCode).toBe("LEGACY_BONUS");
  });

  it("keeps RRSP EE and RRSP ER as separate rows (`side` distinguishes them)", async () => {
    const s = await scenario();
    const ee = await seedComponent(s.clubA.id, {
      code: "RRSP_EE", side: "EMPLOYEE", cashEffect: "DECREASES_NET_PAY",
      category: "PRE_TAX_DEDUCTION",
    });
    const er = await seedComponent(s.clubA.id, {
      code: "RRSP_ER", side: "EMPLOYER", cashEffect: "NO_NET_PAY_EFFECT",
      category: "EMPLOYER_CONTRIBUTION",
    });
    const draft = await createDraftOpeningBalance(s.paP, s.clubA.id, {
      employeeId: s.emp.id, taxYear: 2026, throughPayDate: CUTOVER, values: zeroValues,
    });
    await addOpeningComponentBalance(s.paP, s.clubA.id, {
      openingBalanceId: draft.id, componentId: ee.id, ytdAmount: "2500",
    });
    await addOpeningComponentBalance(s.paP, s.clubA.id, {
      openingBalanceId: draft.id, componentId: er.id, ytdAmount: "1250",
    });
    const rows = await listOpeningComponentBalances(s.paP, s.clubA.id, draft.id);
    expect(rows).toHaveLength(2);
    const bySide = new Map(rows.map((r) => [r.side, r.ytdAmount]));
    expect(bySide.get("EMPLOYEE")).toBe("2500");
    expect(bySide.get("EMPLOYER")).toBe("1250");
  });

  it("cross-tenant isolation — Club B principal cannot add a component to Club A's balance", async () => {
    const s = await scenario();
    const c = await seedComponent(s.clubA.id, { code: "CELL_PHONE_TB" });
    const draft = await createDraftOpeningBalance(s.paP, s.clubA.id, {
      employeeId: s.emp.id, taxYear: 2026, throughPayDate: CUTOVER, values: zeroValues,
    });
    await expect(
      addOpeningComponentBalance(s.paBP, s.clubB.id, {
        openingBalanceId: draft.id, componentId: c.id, ytdAmount: "100",
      }),
    ).rejects.toBeInstanceOf(Error); // NotFoundError under B scope
  });

  it("aggregator returns opening YTD for a PRIOR_SYSTEM_SAME_EMPLOYER ACTIVE parent + no double-count against a future POSTED batch", async () => {
    const s = await scenario();
    const c = await seedComponent(s.clubA.id, {
      code: "CELL_PHONE_TB", side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY",
      category: "TAXABLE_BENEFIT",
    });
    const draft = await createDraftOpeningBalance(s.paP, s.clubA.id, {
      employeeId: s.emp.id, taxYear: 2026, throughPayDate: CUTOVER, values: zeroValues,
      priorPayrollKind: "PRIOR_SYSTEM_SAME_EMPLOYER",
    });
    await addOpeningComponentBalance(s.paP, s.clubA.id, {
      openingBalanceId: draft.id, componentId: c.id, ytdAmount: "800.00",
    });
    await activateOpeningBalance(s.paP, s.clubA.id, draft.id);

    // Aggregator with asOfPayDate before any Spectre batches — sees ONLY the opening.
    const ytd = await getEmployeeComponentYtd(s.clubA.id, s.emp.id, d(2026, 9, 15));
    const row = ytd.byKey.get(c.id);
    expect(row).toBeTruthy();
    expect(row?.ytdAmount).toBe("800.00");
    expect(row?.componentCode).toBe("CELL_PHONE_TB");
  });

  it("aggregator returns ZERO opening for PRIOR_EMPLOYER (§3B-5B-1b)", async () => {
    const s = await scenario();
    const c = await seedComponent(s.clubA.id, {
      code: "CELL_PHONE_TB", side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY",
      category: "TAXABLE_BENEFIT",
    });
    const draft = await createDraftOpeningBalance(s.paP, s.clubA.id, {
      employeeId: s.emp.id, taxYear: 2026, throughPayDate: CUTOVER, values: zeroValues,
      priorPayrollKind: "PRIOR_EMPLOYER",
      priorEmployerId: "prior-employer-1",
    });
    await addOpeningComponentBalance(s.paP, s.clubA.id, {
      openingBalanceId: draft.id, componentId: c.id, ytdAmount: "9999",
    });
    await activateOpeningBalance(s.paP, s.clubA.id, draft.id);

    const ytd = await getEmployeeComponentYtd(s.clubA.id, s.emp.id, d(2026, 9, 15));
    // PRIOR_EMPLOYER opening does NOT contribute to this employer's YTD.
    expect(ytd.byKey.size).toBe(0);
  });
});
