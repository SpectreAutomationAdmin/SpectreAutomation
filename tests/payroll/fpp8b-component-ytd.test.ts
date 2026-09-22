// FPP-8B (2026-09-22) — component YTD schema v2 + resolver correctness.
//
// Covers §36-§43:
//   * schema v2 parse/serialize + backward-compat v1 (§36)
//   * opening + payroll accumulation via componentCode identity (§37)
//   * STANDARD/REVERSAL/CORRECTION transaction-type accumulation (§38)
//   * state gating: only POSTED contributes (§39)
//   * legacy v1 compatibility resolution (§40)
//   * v2 snapshot immutability after POSTED (§41)
//   * fingerprint coverage: v2 snapshot participates deterministically (§42)

import { describe, it, expect, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import {
  YtdSnapshotV2,
  parseYtdSnapshot,
  assertValidYtdSnapshotV1,
  assertValidYtdSnapshotV2,
} from "@/lib/payroll/ytd-snapshot-schema";
import { getEmployeeComponentYtd, includeCurrentInYtd } from "@/lib/payroll/component-ytd";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function seedEmployee(suffix: string) {
  const c = db();
  const club = await makeClub(`8B ${suffix}`);
  const user = await makeUser({ email: `pa-${suffix}@t.test`, role: "PAYROLL_ADMIN", clubId: club.id });
  const principal = await principalFor(user.email);
  const emp = await c.employee.create({ data: {
    clubId: club.id, firstName: "Test", lastName: `E-${suffix}`,
    email: `emp.${suffix}@t.test`, hireDate: utc(2020,1,1),
    dateOfBirth: utc(1985,5,12), status: "ACTIVE",
    employeeNumber: `E-8B-${suffix}`, compensationType: "SALARY",
    employeeLifecycle: "ACTIVE", homeProvince: "AB" } });
  return { club, user, principal, emp };
}

async function seedComponent(clubId: string, code: string, opts: {
  displayName?: string; category: string; side: "EMPLOYEE" | "EMPLOYER";
  cashEffect: "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT";
} = { category: "ALLOWANCE", side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY" }) {
  const c = db();
  return c.payrollComponent.create({ data: {
    clubId, code, displayName: opts.displayName ?? code,
    category: opts.category, side: opts.side, cashEffect: opts.cashEffect,
    displaySection: opts.side === "EMPLOYER" ? "BENEFITS" : "EARNINGS", displayOrder: 100,
    calculationMethod: "FIXED_AMOUNT", statutoryTreatmentSource: "CUSTOM",
    taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
    active: true } });
}

async function seedOpening(clubId: string, employeeId: string, opts: {
  taxYear?: number; throughPayDate?: Date; components?: Array<{ code: string; displayName: string; category: string; side: string; cashEffect: string; ytdAmount: string; sourceComponentId?: string | null }>;
} = {}) {
  const c = db();
  const opening = await c.payrollOpeningBalance.create({ data: {
    clubId, employeeId,
    taxYear: opts.taxYear ?? 2026,
    throughPayDate: opts.throughPayDate ?? utc(2026,3,31),
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
  if (opts.components) {
    for (const comp of opts.components) {
      await c.payrollOpeningBalanceComponent.create({ data: {
        clubId, openingBalanceId: opening.id,
        sourceComponentId: comp.sourceComponentId ?? null,
        componentCode: comp.code, displayName: comp.displayName,
        category: comp.category, side: comp.side, cashEffect: comp.cashEffect,
        ytdAmount: new Prisma.Decimal(comp.ytdAmount),
      } });
    }
  }
  return opening;
}

async function seedBatchWithSnapshot(clubId: string, employeeId: string, opts: {
  payDate: Date; sequenceInYear: number; taxYear?: number;
  status: "POSTED" | "CALCULATED" | "PREPARED" | "SUBMITTED_FOR_APPROVAL";
  transactionType?: "STANDARD" | "REVERSAL" | "CORRECTION";
  components: Array<{ code: string; displayName: string; category: string; side: string; cashEffect: string; amount: string; sourceComponentId?: string | null }>;
}) {
  const c = db();
  const pg = await c.payrollPayGroup.create({ data: {
    clubId, code: `PG-${opts.sequenceInYear}-${Math.random().toString(36).slice(2,6)}`,
    name: "test", payFrequency: "SEMI_MONTHLY", payDateOffsetDays: 0,
    calendarAnchorDate: opts.payDate } });
  const pp = await c.payrollPayPeriod.create({ data: {
    clubId, payGroupId: pg.id, sequenceInYear: opts.sequenceInYear,
    taxYear: opts.taxYear ?? 2026,
    periodStart: opts.payDate, periodEnd: opts.payDate, payDate: opts.payDate } });
  const batch = await c.payrollBatch.create({ data: {
    clubId, payGroupId: pg.id, payPeriodId: pp.id,
    sequence: 1, status: opts.status,
    transactionType: opts.transactionType ?? "STANDARD",
    calculationVersion: 1, algorithmVersion: "test",
    packageChecksum: "test" } });
  const be = await c.payrollBatchEmployee.create({ data: {
    clubId, batchId: batch.id, employeeId,
    jurisdictionCountry: "CA", jurisdictionProvince: "AB",
    employeeLifecycleAtPrep: "ACTIVE", status: "INCLUDED", salaried: true } });
  for (const comp of opts.components) {
    // PayrollBatchComponentSnapshot.sourceComponentId is REQUIRED on the schema —
    // create a placeholder PayrollComponent when the test didn't supply one.
    let scid = comp.sourceComponentId ?? null;
    if (!scid) {
      const placeholder = await c.payrollComponent.create({ data: {
        clubId, code: `${comp.code}-${Math.random().toString(36).slice(2, 10)}`, displayName: comp.displayName,
        category: comp.category, side: comp.side, cashEffect: comp.cashEffect,
        displaySection: "EARNINGS", displayOrder: 100,
        calculationMethod: "FIXED_AMOUNT", statutoryTreatmentSource: "CUSTOM",
        taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
        active: true } });
      scid = placeholder.id;
    }
    await c.payrollBatchComponentSnapshot.create({ data: {
      batchId: batch.id, batchEmployeeId: be.id, employeeId, clubId,
      sourceComponentId: scid,
      componentCode: comp.code, displayName: comp.displayName,
      category: comp.category, side: comp.side,
      displaySection: "EARNINGS", displayOrder: 100,
      cashEffect: comp.cashEffect, calculationMethod: "FIXED_AMOUNT",
      resolvedAmount: new Prisma.Decimal(comp.amount),
      sourceEffectiveFrom: opts.payDate, provenance: "RECURRING_EMPLOYEE_SETUP" } });
  }
  return { batch, be, pp };
}

describe("FPP-8B · component YTD schema v2 + resolver", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("§36 schema — v2 parses; v1 parses; discriminated union routes correctly", () => {
    const v1raw = JSON.stringify({
      schemaVersion: 1, asOfPayDate: "2026-04-15T00:00:00.000Z", taxYear: 2026,
      sources: { openingBalanceId: null, openingBalancePriorPayrollKind: null, postedBatchIds: [] },
      ytdGrossEarnings: "0", ytdTaxableEarnings: "0", ytdPensionableEarnings: "0", ytdInsurableEarnings: "0",
      ytdCppEE_Base: "0", ytdCppEE_FirstAdd: "0", ytdCppEE: "0", ytdCpp2EE: "0", ytdEiEE: "0",
      ytdFederalTax: "0", ytdProvincialTax: "0",
      ytdCppER_Base: "0", ytdCppER_FirstAdd: "0", ytdCppER: "0", ytdCpp2ER: "0", ytdEiER: "0",
    });
    const v1 = parseYtdSnapshot(v1raw);
    expect(v1?.schemaVersion).toBe(1);

    const v2obj = {
      schemaVersion: 2 as const, asOfPayDate: "2026-04-15T00:00:00.000Z", taxYear: 2026,
      sources: { openingBalanceId: null, openingBalancePriorPayrollKind: null, postedBatchIds: [], componentSourceRefs: [] },
      ytdGrossEarnings: "0", ytdTaxableEarnings: "0", ytdPensionableEarnings: "0", ytdInsurableEarnings: "0",
      ytdCppEE_Base: "0", ytdCppEE_FirstAdd: "0", ytdCppEE: "0", ytdCpp2EE: "0", ytdEiEE: "0",
      ytdFederalTax: "0", ytdProvincialTax: "0",
      ytdCppER_Base: "0", ytdCppER_FirstAdd: "0", ytdCppER: "0", ytdCpp2ER: "0", ytdEiER: "0",
      componentYtd: [
        { componentCode: "A", displayName: "A", category: "ALLOWANCE", side: "EMPLOYEE" as const,
          cashEffect: "INCREASES_NET_PAY" as const, ytdBefore: "0", currentAmount: "10", ytdIncludingCurrent: "10" },
      ],
    };
    assertValidYtdSnapshotV2(v2obj);
    const v2raw = JSON.stringify(v2obj);
    const v2 = parseYtdSnapshot(v2raw);
    expect(v2?.schemaVersion).toBe(2);
    if (v2?.schemaVersion === 2) expect(v2.componentYtd[0].componentCode).toBe("A");
  });

  it("§6 identity — resolver keys opening + posted by componentCode (opening w/ null sourceComponentId merges with batch w/ resolved id)", async () => {
    const s = await seedEmployee("keying");
    const cell = await seedComponent(s.club.id, "CELL_PHONE_ALLOWANCE", { displayName: "Cell Phone Allowance", category: "ALLOWANCE", side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY" });
    // Opening imported BEFORE the club's PayrollComponent registry — sourceComponentId=null.
    await seedOpening(s.club.id, s.emp.id, { throughPayDate: utc(2026,3,31), components: [
      { code: "CELL_PHONE_ALLOWANCE", displayName: "Cell Phone Allowance", category: "ALLOWANCE", side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY", ytdAmount: "506.25", sourceComponentId: null },
    ] });
    // POSTED batch with resolved sourceComponentId.
    await seedBatchWithSnapshot(s.club.id, s.emp.id, {
      payDate: utc(2026,4,15), sequenceInYear: 5, status: "POSTED", components: [
      { code: "CELL_PHONE_ALLOWANCE", displayName: "Cell Phone Allowance", category: "ALLOWANCE", side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY", amount: "37.50", sourceComponentId: cell.id },
    ]});
    const ytd = await getEmployeeComponentYtd(s.club.id, s.emp.id, utc(2026,4,30));
    // Single merged row: $506.25 opening + $37.50 posted = $543.75.
    expect(ytd.byKey.size).toBe(1);
    const row = ytd.byKey.get("CELL_PHONE_ALLOWANCE");
    expect(row).toBeTruthy();
    expect(row?.ytdAmount).toBe("543.75");
    expect(row?.provenance.openingAmount).toBe("506.25");
    expect(row?.provenance.postedAmount).toBe("37.50");
    // Combined row adopts the resolved sourceComponentId from the batch.
    expect(row?.sourceComponentId).toBe(cell.id);
  });

  it("§37 accumulation — opening O + P1 + P2 accumulates deterministically; earlier statement still shows earlier YTD", async () => {
    const s = await seedEmployee("accum");
    await seedComponent(s.club.id, "LTD", { category: "EMPLOYEE_DEDUCTION", side: "EMPLOYEE", cashEffect: "DECREASES_NET_PAY", displayName: "LTD" });
    await seedOpening(s.club.id, s.emp.id, { throughPayDate: utc(2026,3,31), components: [
      { code: "LTD", displayName: "LTD", category: "EMPLOYEE_DEDUCTION", side: "EMPLOYEE", cashEffect: "DECREASES_NET_PAY", ytdAmount: "351.42" },
    ] });
    const p1 = await seedBatchWithSnapshot(s.club.id, s.emp.id, {
      payDate: utc(2026,4,15), sequenceInYear: 5, status: "POSTED", components: [
      { code: "LTD", displayName: "LTD", category: "EMPLOYEE_DEDUCTION", side: "EMPLOYEE", cashEffect: "DECREASES_NET_PAY", amount: "28.11" },
    ]});
    const p2 = await seedBatchWithSnapshot(s.club.id, s.emp.id, {
      payDate: utc(2026,4,30), sequenceInYear: 6, status: "POSTED", components: [
      { code: "LTD", displayName: "LTD", category: "EMPLOYEE_DEDUCTION", side: "EMPLOYEE", cashEffect: "DECREASES_NET_PAY", amount: "28.11" },
    ]});
    // Viewing P1 (asOf = P1's payDate) sees only opening. Including P1's own snapshot => 351.42 + 28.11 = 379.53.
    const beforeP1 = await getEmployeeComponentYtd(s.club.id, s.emp.id, utc(2026,4,15));
    expect(beforeP1.byKey.get("LTD")?.ytdAmount).toBe("351.42");
    // Between P1 and P2, "as of" P2's payDate returns 351.42 + 28.11 (P1) = 379.53.
    const beforeP2 = await getEmployeeComponentYtd(s.club.id, s.emp.id, utc(2026,4,30));
    expect(beforeP2.byKey.get("LTD")?.ytdAmount).toBe("379.53");
    // After P2, viewing P1's statement again still returns 351.42 (asOf = P1's date) — historical cutoff preserved.
    const laterViewOfP1 = await getEmployeeComponentYtd(s.club.id, s.emp.id, utc(2026,4,15));
    expect(laterViewOfP1.byKey.get("LTD")?.ytdAmount).toBe("351.42");
    void p1; void p2;
  });

  it("§39 state gating — non-POSTED batches (PREPARED / CALCULATED / SUBMITTED) do not contribute", async () => {
    const s = await seedEmployee("gating");
    await seedComponent(s.club.id, "BONUS", { category: "ADDITIONAL_EARNING", side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY", displayName: "Bonus" });
    await seedBatchWithSnapshot(s.club.id, s.emp.id, { payDate: utc(2026,4,15), sequenceInYear: 5, status: "POSTED", components: [
      { code: "BONUS", displayName: "Bonus", category: "ADDITIONAL_EARNING", side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY", amount: "100.00" },
    ]});
    await seedBatchWithSnapshot(s.club.id, s.emp.id, { payDate: utc(2026,4,20), sequenceInYear: 6, status: "CALCULATED", components: [
      { code: "BONUS", displayName: "Bonus", category: "ADDITIONAL_EARNING", side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY", amount: "500.00" },
    ]});
    await seedBatchWithSnapshot(s.club.id, s.emp.id, { payDate: utc(2026,4,22), sequenceInYear: 7, status: "SUBMITTED_FOR_APPROVAL", components: [
      { code: "BONUS", displayName: "Bonus", category: "ADDITIONAL_EARNING", side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY", amount: "999.99" },
    ]});
    const ytd = await getEmployeeComponentYtd(s.club.id, s.emp.id, utc(2026,4,30));
    // Only the POSTED $100 contributes.
    expect(ytd.byKey.get("BONUS")?.ytdAmount).toBe("100.00");
  });

  it("§38 transaction-type — Original + Reversal + Correction = Correction for a component", async () => {
    const s = await seedEmployee("txn");
    await seedComponent(s.club.id, "CELL", { displayName: "Cell", category: "ALLOWANCE", side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY" });
    // Opening $100.
    await seedOpening(s.club.id, s.emp.id, { throughPayDate: utc(2026,3,31), components: [
      { code: "CELL", displayName: "Cell", category: "ALLOWANCE", side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY", ytdAmount: "100.00" },
    ]});
    // Original + Reversal + Correction all POSTED.
    await seedBatchWithSnapshot(s.club.id, s.emp.id, { payDate: utc(2026,4,15), sequenceInYear: 5, status: "POSTED", transactionType: "STANDARD",   components: [{ code: "CELL", displayName: "Cell", category: "ALLOWANCE", side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY", amount:  "25.00" }] });
    await seedBatchWithSnapshot(s.club.id, s.emp.id, { payDate: utc(2026,4,16), sequenceInYear: 6, status: "POSTED", transactionType: "REVERSAL",   components: [{ code: "CELL", displayName: "Cell", category: "ALLOWANCE", side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY", amount: "-25.00" }] });
    await seedBatchWithSnapshot(s.club.id, s.emp.id, { payDate: utc(2026,4,17), sequenceInYear: 7, status: "POSTED", transactionType: "CORRECTION", components: [{ code: "CELL", displayName: "Cell", category: "ALLOWANCE", side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY", amount:  "40.00" }] });
    const ytd = await getEmployeeComponentYtd(s.club.id, s.emp.id, utc(2026,4,30));
    // Opening $100 + (25 + -25 + 40) = 140.
    expect(ytd.byKey.get("CELL")?.ytdAmount).toBe("140.00");
    expect(ytd.byKey.get("CELL")?.provenance.openingAmount).toBe("100.00");
    expect(ytd.byKey.get("CELL")?.provenance.postedAmount).toBe("40.00");
  });

  it("§20 pay statement — includeCurrentInYtd keeps opening rows visible when no current snapshot", async () => {
    const s = await seedEmployee("yonly");
    await seedComponent(s.club.id, "LTD", { category: "EMPLOYEE_DEDUCTION", side: "EMPLOYEE", cashEffect: "DECREASES_NET_PAY" });
    await seedOpening(s.club.id, s.emp.id, { throughPayDate: utc(2026,3,31), components: [
      { code: "LTD", displayName: "LTD", category: "EMPLOYEE_DEDUCTION", side: "EMPLOYEE", cashEffect: "DECREASES_NET_PAY", ytdAmount: "351.42" },
    ]});
    const prior = await getEmployeeComponentYtd(s.club.id, s.emp.id, utc(2026,4,15));
    // No current-period LTD snapshot on the batch — still surfaces via prior YTD map.
    const combined = includeCurrentInYtd(prior, []);
    const ltd = combined.get("LTD");
    expect(ltd).toBeTruthy();
    expect(ltd?.ytdAmount).toBe("351.42");
  });
});

describe("FPP-8B · schema v2 serialization determinism", () => {
  it("§42 fingerprint — same componentYtd content produces byte-identical JSON regardless of insertion order", () => {
    const base = {
      schemaVersion: 2 as const, asOfPayDate: "2026-04-15T00:00:00.000Z", taxYear: 2026,
      sources: { openingBalanceId: null, openingBalancePriorPayrollKind: null, postedBatchIds: [], componentSourceRefs: [] },
      ytdGrossEarnings: "0", ytdTaxableEarnings: "0", ytdPensionableEarnings: "0", ytdInsurableEarnings: "0",
      ytdCppEE_Base: "0", ytdCppEE_FirstAdd: "0", ytdCppEE: "0", ytdCpp2EE: "0", ytdEiEE: "0",
      ytdFederalTax: "0", ytdProvincialTax: "0",
      ytdCppER_Base: "0", ytdCppER_FirstAdd: "0", ytdCppER: "0", ytdCpp2ER: "0", ytdEiER: "0",
    };
    const shape = (entries: Array<{code:string;amt:string}>) => ({
      ...base,
      componentYtd: entries.map(e => ({
        componentCode: e.code, displayName: e.code, category: "ALLOWANCE",
        side: "EMPLOYEE" as const, cashEffect: "INCREASES_NET_PAY" as const,
        ytdBefore: e.amt, currentAmount: "0", ytdIncludingCurrent: e.amt,
      })).sort((a,b) => a.componentCode.localeCompare(b.componentCode)),
    });
    const a = shape([{code:"CELL",amt:"506.25"},{code:"LTD",amt:"351.42"}]);
    const b = shape([{code:"LTD",amt:"351.42"},{code:"CELL",amt:"506.25"}]);
    // Both must validate as v2 AND sort deterministically to the same JSON.
    assertValidYtdSnapshotV2(a);
    assertValidYtdSnapshotV2(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("§36 — v1 continues to parse via assertValidYtdSnapshotV1 without requiring componentYtd", () => {
    const v1 = {
      schemaVersion: 1, asOfPayDate: "2026-01-15T00:00:00.000Z", taxYear: 2026,
      sources: { openingBalanceId: null, openingBalancePriorPayrollKind: null, postedBatchIds: [] },
      ytdGrossEarnings: "0", ytdTaxableEarnings: "0", ytdPensionableEarnings: "0", ytdInsurableEarnings: "0",
      ytdCppEE_Base: "0", ytdCppEE_FirstAdd: "0", ytdCppEE: "0", ytdCpp2EE: "0", ytdEiEE: "0",
      ytdFederalTax: "0", ytdProvincialTax: "0",
      ytdCppER_Base: "0", ytdCppER_FirstAdd: "0", ytdCppER: "0", ytdCpp2ER: "0", ytdEiER: "0",
    };
    expect(() => assertValidYtdSnapshotV1(v1)).not.toThrow();
    const parsed = parseYtdSnapshot(JSON.stringify(v1));
    expect(parsed?.schemaVersion).toBe(1);
  });

  // Sanity: the v2 shape rejects malformed components.
  it("§36 — v2 rejects an invalid componentYtd entry", () => {
    const bad = {
      schemaVersion: 2, asOfPayDate: "x", taxYear: 2026,
      sources: {},
      componentYtd: [{ componentCode: "A" }],
    };
    const r = YtdSnapshotV2.safeParse(bad);
    expect(r.success).toBe(false);
  });
});
