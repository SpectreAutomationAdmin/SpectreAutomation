// FPP-2 (2026-09-20) — atomic Opening YTD save + direct-edit tests.
//
// Pins the acceptance criteria the founder directive calls out:
//   1) Atomic single-save persists parent + components in one transaction.
//   2) Blank component amount is NOT persisted (no meaningless zero rows).
//   3) A component that had an amount then goes blank is REMOVED on save.
//   4) Existing amounts survive on re-save when unchanged.
//   5) Direct-edit updates ytdAmount without remove/re-add.
//   6) DRAFT-only lifecycle preserved on both new operations.
//   7) Cross-tenant isolation on atomic save + direct-edit.
//   8) Aggregate values are NOT increased by component rows.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { ValidationError } from "@/lib/errors";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import {
  saveOpeningBalanceWithComponents,
  updateOpeningComponentBalance,
  activateOpeningBalance,
  listOpeningComponentBalances,
  type OpeningBalanceFields,
} from "@/lib/payroll/opening-balance";

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));
const CUTOVER = d(2026, 8, 31);

const AGG: OpeningBalanceFields = {
  ytdGrossEarnings: "50000", ytdTaxableEarnings: "50000",
  ytdPensionableEarnings: "48000", ytdInsurableEarnings: "50000",
  ytdCppEE_Base: "0", ytdCppEE_FirstAdd: "0", ytdCppEE: "2500",
  ytdCpp2EE: "0", ytdEiEE: "800",
  ytdFederalTax: "6000", ytdProvincialTax: "3000",
  ytdCppER_Base: "0", ytdCppER_FirstAdd: "0", ytdCppER: "2500",
  ytdCpp2ER: "0", ytdEiER: "1120",
};

const ZERO: OpeningBalanceFields = {
  ytdGrossEarnings: "0", ytdTaxableEarnings: "0",
  ytdPensionableEarnings: "0", ytdInsurableEarnings: "0",
  ytdCppEE_Base: "0", ytdCppEE_FirstAdd: "0", ytdCppEE: "0",
  ytdCpp2EE: "0", ytdEiEE: "0",
  ytdFederalTax: "0", ytdProvincialTax: "0",
  ytdCppER_Base: "0", ytdCppER_FirstAdd: "0", ytdCppER: "0",
  ytdCpp2ER: "0", ytdEiER: "0",
};

async function seedComponent(clubId: string, code: string, opts: Partial<{
  displayName: string; category: string; side: "EMPLOYEE" | "EMPLOYER";
  cashEffect: "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT";
  active: boolean;
}> = {}) {
  return db().payrollComponent.create({
    data: {
      clubId,
      code,
      displayName: opts.displayName ?? code,
      category: opts.category ?? "EMPLOYEE_DEDUCTION",
      side: opts.side ?? "EMPLOYEE",
      cashEffect: opts.cashEffect ?? "DECREASES_NET_PAY",
      calculationMethod: "FIXED_AMOUNT",
      displaySection: "DEDUCTIONS",
      usage: "BOTH",
      active: opts.active ?? true,
    },
  });
}

async function scenario() {
  const clubA = await makeClub("FPP-2 Club A");
  const clubB = await makeClub("FPP-2 Club B");
  const admin = await makeUser({ email: "adminA@fpp2.test", role: "CLUB_ADMIN", clubId: clubA.id });
  const pa = await makeUser({ email: "paA@fpp2.test", role: "PAYROLL_ADMIN", clubId: clubA.id });
  const paB = await makeUser({ email: "paB@fpp2.test", role: "PAYROLL_ADMIN", clubId: clubB.id });
  const adminP = await principalFor(admin.email);
  const paP = await principalFor(pa.email);
  const paBP = await principalFor(paB.email);
  await upsertPayrollClubConfig(adminP, clubA.id, {
    provinceOfEmployment: "AB", payrollAdminUserId: pa.id,
  });
  const emp = await db().employee.create({
    data: {
      clubId: clubA.id, firstName: "Atomic", lastName: "Save",
      email: "as@fpp2.test", hireDate: d(2026, 2, 1), status: "ACTIVE",
      employeeNumber: "E-FPP2",
    },
  });
  const empB = await db().employee.create({
    data: {
      clubId: clubB.id, firstName: "Other", lastName: "Tenant",
      email: "ot@fpp2.test", hireDate: d(2026, 2, 1), status: "ACTIVE",
      employeeNumber: "E-FPP2-B",
    },
  });
  return { clubA, clubB, adminP, paP, paBP, emp, empB };
}

describe("FPP-2 · atomic Opening YTD save + direct-edit", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("persists parent + supplied component amounts in ONE call, ignoring blanks", async () => {
    const s = await scenario();
    const rrspEE = await seedComponent(s.clubA.id, "RRSP_EE", { displayName: "RRSP — Employee" });
    const ltd    = await seedComponent(s.clubA.id, "LTD",    { displayName: "Long Term Disability" });
    const cell   = await seedComponent(s.clubA.id, "CELL",   {
      displayName: "Cell Phone", category: "ALLOWANCE", cashEffect: "INCREASES_NET_PAY",
    });

    const result = await saveOpeningBalanceWithComponents(s.paP, s.clubA.id, {
      employeeId: s.emp.id,
      taxYear: 2026,
      values: AGG,
      throughPayDate: CUTOVER,
      priorPayrollKind: "PRIOR_SYSTEM_SAME_EMPLOYER",
      components: [
        { componentId: rrspEE.id, ytdAmount: "1500.00" },
        { componentId: ltd.id,    ytdAmount: "" },   // blank — NOT persisted
        { componentId: cell.id,   ytdAmount: "375" },
      ],
    });

    expect(result.parent.status).toBe("DRAFT");
    expect(result.parent.values.ytdGrossEarnings).toBe("50000");
    // Blank LTD row is NOT persisted.
    expect(result.components.map((c) => c.componentCode).sort()).toEqual(["CELL", "RRSP_EE"]);
    const rrspRow = result.components.find((c) => c.componentCode === "RRSP_EE")!;
    expect(rrspRow.ytdAmount).toBe("1500");
    const cellRow = result.components.find((c) => c.componentCode === "CELL")!;
    expect(cellRow.ytdAmount).toBe("375");
  });

  it("component-first: a NEW employee's first save may carry only component amounts (aggregates ZERO)", async () => {
    const s = await scenario();
    const rrspEE = await seedComponent(s.clubA.id, "RRSP_EE");

    const result = await saveOpeningBalanceWithComponents(s.paP, s.clubA.id, {
      employeeId: s.emp.id,
      taxYear: 2026,
      values: ZERO,
      throughPayDate: CUTOVER,
      components: [{ componentId: rrspEE.id, ytdAmount: "1500" }],
    });

    expect(result.parent.status).toBe("DRAFT");
    expect(result.parent.values.ytdGrossEarnings).toBe("0");
    expect(result.components).toHaveLength(1);
    expect(result.components[0].componentCode).toBe("RRSP_EE");
    expect(result.components[0].ytdAmount).toBe("1500");
  });

  it("clears a previously-persisted component row when it comes back blank", async () => {
    const s = await scenario();
    const rrspEE = await seedComponent(s.clubA.id, "RRSP_EE");
    const ltd    = await seedComponent(s.clubA.id, "LTD");

    // Save with both amounts.
    await saveOpeningBalanceWithComponents(s.paP, s.clubA.id, {
      employeeId: s.emp.id, taxYear: 2026, values: AGG, throughPayDate: CUTOVER,
      components: [
        { componentId: rrspEE.id, ytdAmount: "1500" },
        { componentId: ltd.id,    ytdAmount: "400" },
      ],
    });

    // Save again with LTD blank — it should be removed.
    const result = await saveOpeningBalanceWithComponents(s.paP, s.clubA.id, {
      employeeId: s.emp.id, taxYear: 2026, values: AGG, throughPayDate: CUTOVER,
      components: [
        { componentId: rrspEE.id, ytdAmount: "1500" },
        { componentId: ltd.id,    ytdAmount: "" }, // remove
      ],
    });

    expect(result.components.map((c) => c.componentCode)).toEqual(["RRSP_EE"]);
  });

  it("directly edits a component amount in place (no remove/re-add) — value updates, id preserved", async () => {
    const s = await scenario();
    const rrspEE = await seedComponent(s.clubA.id, "RRSP_EE");
    const initial = await saveOpeningBalanceWithComponents(s.paP, s.clubA.id, {
      employeeId: s.emp.id, taxYear: 2026, values: AGG, throughPayDate: CUTOVER,
      components: [{ componentId: rrspEE.id, ytdAmount: "3093.97" }],
    });
    const rowId = initial.components[0].id;

    const updated = await updateOpeningComponentBalance(s.paP, s.clubA.id, rowId, {
      ytdAmount: "3093.79",
    });
    expect(updated.id).toBe(rowId);
    expect(updated.ytdAmount).toBe("3093.79");
  });

  it("direct-edit refuses when the parent is not DRAFT (ACTIVE lifecycle immutability)", async () => {
    const s = await scenario();
    const rrspEE = await seedComponent(s.clubA.id, "RRSP_EE");
    const saved = await saveOpeningBalanceWithComponents(s.paP, s.clubA.id, {
      employeeId: s.emp.id, taxYear: 2026, values: AGG, throughPayDate: CUTOVER,
      components: [{ componentId: rrspEE.id, ytdAmount: "1500" }],
    });
    await activateOpeningBalance(s.paP, s.clubA.id, saved.parent.id);

    await expect(
      updateOpeningComponentBalance(s.paP, s.clubA.id, saved.components[0].id, {
        ytdAmount: "1600",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("atomic save refuses to write into a foreign tenant", async () => {
    const s = await scenario();
    const rrspEE = await seedComponent(s.clubA.id, "RRSP_EE");

    // paBP (Club B principal) tries to save into Club A on ClubA employee.
    await expect(
      saveOpeningBalanceWithComponents(s.paBP, s.clubA.id, {
        employeeId: s.emp.id, taxYear: 2026, values: AGG, throughPayDate: CUTOVER,
        components: [{ componentId: rrspEE.id, ytdAmount: "1500" }],
      }),
    ).rejects.toBeTruthy();
  });

  it("atomic save is DRAFT-only — refuses to silently duplicate over an ACTIVE row", async () => {
    const s = await scenario();
    const initial = await saveOpeningBalanceWithComponents(s.paP, s.clubA.id, {
      employeeId: s.emp.id, taxYear: 2026, values: AGG, throughPayDate: CUTOVER,
      components: [],
    });
    await activateOpeningBalance(s.paP, s.clubA.id, initial.parent.id);

    await expect(
      saveOpeningBalanceWithComponents(s.paP, s.clubA.id, {
        employeeId: s.emp.id, taxYear: 2026, values: AGG, throughPayDate: CUTOVER,
        components: [],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("component rows do NOT increase the aggregate opening YTD (§16 no-double-count)", async () => {
    const s = await scenario();
    const rrspEE = await seedComponent(s.clubA.id, "RRSP_EE");

    const result = await saveOpeningBalanceWithComponents(s.paP, s.clubA.id, {
      employeeId: s.emp.id, taxYear: 2026, values: AGG, throughPayDate: CUTOVER,
      components: [{ componentId: rrspEE.id, ytdAmount: "9999" }],
    });
    // Aggregate values are untouched by the component row.
    expect(result.parent.values.ytdGrossEarnings).toBe("50000");
    expect(result.parent.values.ytdTaxableEarnings).toBe("50000");
    expect(result.parent.values.ytdCppEE).toBe("2500");
  });

  it("catches duplicate componentId inside a single submission (guardrail)", async () => {
    const s = await scenario();
    const rrspEE = await seedComponent(s.clubA.id, "RRSP_EE");
    await expect(
      saveOpeningBalanceWithComponents(s.paP, s.clubA.id, {
        employeeId: s.emp.id, taxYear: 2026, values: AGG, throughPayDate: CUTOVER,
        components: [
          { componentId: rrspEE.id, ytdAmount: "1000" },
          { componentId: rrspEE.id, ytdAmount: "1500" },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("preserves an existing DRAFT parent's throughPayDate + refresh on subsequent atomic save", async () => {
    const s = await scenario();
    const rrspEE = await seedComponent(s.clubA.id, "RRSP_EE");
    const first = await saveOpeningBalanceWithComponents(s.paP, s.clubA.id, {
      employeeId: s.emp.id, taxYear: 2026, values: AGG, throughPayDate: CUTOVER,
      components: [{ componentId: rrspEE.id, ytdAmount: "1000" }],
    });
    const firstId = first.parent.id;

    const second = await saveOpeningBalanceWithComponents(s.paP, s.clubA.id, {
      employeeId: s.emp.id, taxYear: 2026, values: AGG, throughPayDate: CUTOVER,
      components: [{ componentId: rrspEE.id, ytdAmount: "2500" }],
    });
    // Same parent row (idempotent DRAFT refresh) — no duplicate parent.
    expect(second.parent.id).toBe(firstId);
    // Same component row, updated amount.
    expect(second.components).toHaveLength(1);
    expect(second.components[0].ytdAmount).toBe("2500");

    const listed = await listOpeningComponentBalances(s.paP, s.clubA.id, firstId);
    expect(listed).toHaveLength(1);
    expect(listed[0].ytdAmount).toBe("2500");
  });
});
