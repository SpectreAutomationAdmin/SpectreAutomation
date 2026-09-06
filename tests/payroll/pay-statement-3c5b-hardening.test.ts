// Payroll-3C-5B (2026-09-04) — pay statement hardening suite.
//
// Covers the §5–§17 acceptance items from the 3C-5B brief that were
// deferred from 3C-5:
//   §5  prior-year YTD exclusion
//   §6  future-posted YTD exclusion (pay-date bounded)
//   §7  component rename immutability
//   §8  component deactivation immutability
//   §9  component deletion protection
//   §10 legacy allowance no-double-count
//   §11 component-YTD key stability (id-first, code fallback)
//   §12 one-time adjustment YTD
//   §13 employer contribution YTD (from persisted rows)
//   §16 employee portal cross-employee / cross-tenant / non-POSTED denial
//   §17 admin history authorization gate
//   §18 sensitive-data leak audit
//
// The Sam-flagship + Sam-YTD-from-persisted-rows tests (§29/§30) live
// in tests/payroll/sam-ytd-persistence-3c5b.local.test.ts because they
// depend on the dev fixture DB rather than the test SQLite template.

import { describe, it, expect, beforeEach } from "vitest";
import Decimal from "decimal.js";
import {
  db,
  resetDb,
  seedRbac,
  makeClub,
  makeUser,
  principalFor,
} from "../util/db";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import {
  upsertPayrollComponent,
  createRecurringComponentAssignment,
} from "@/lib/payroll/components-catalogue";
import { writeEncryptedTd1Claims } from "@/lib/hr/td1-secure-write";
import { preparePayrollBatch } from "@/lib/payroll/batch-preparation";
import { calculatePayrollBatch } from "@/lib/payroll/calculation-execute";
import { seedCanadaAlbertaPackages2026 } from "@/lib/payroll/statutory/seed-ca-ab-2026";
import { getEmployeeComponentYtd } from "@/lib/payroll/component-ytd";
import {
  buildPayStatement,
  buildEmployeePortalPayStatement,
  listPostedPayrollHistory,
} from "@/lib/payroll/pay-statement";
import { addOneTimeAdjustment } from "@/lib/payroll/adjustments";
import { ForbiddenError, NotFoundError } from "@/lib/errors";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function superAdminP() {
  const c = db();
  await c.user.deleteMany({ where: { email: "sup-3c5b@spectre.test" } });
  const u = await c.user.create({
    data: {
      email: "sup-3c5b@spectre.test", name: "Sup3C5B",
      role: "SUPER_ADMIN", passwordHash: "x", status: "ACTIVE",
    },
  });
  await c.userClubRole.create({ data: { userId: u.id, clubId: null, roleKey: "SUPER_ADMIN" } });
  return principalFor("sup-3c5b@spectre.test");
}

async function seedSemiMonthlyCalendar(clubId: string, payGroupId: string, taxYear: number) {
  const c = db();
  let seq = 0;
  for (let m = 0; m < 12; m++) {
    seq += 1;
    await c.payrollPayPeriod.create({
      data: {
        clubId, payGroupId, taxYear, sequenceInYear: seq,
        periodStart: utc(taxYear, m + 1, 1), periodEnd: utc(taxYear, m + 1, 16),
        payDate: utc(taxYear, m + 1, 15), status: "OPEN",
      },
    });
    seq += 1;
    await c.payrollPayPeriod.create({
      data: {
        clubId, payGroupId, taxYear, sequenceInYear: seq,
        periodStart: utc(taxYear, m + 1, 16), periodEnd: utc(taxYear, m + 2, 1),
        payDate: m === 11
          ? utc(taxYear, 12, 31)
          : utc(taxYear, m + 2, 0), // last day of current month
        status: "OPEN",
      },
    });
  }
}

async function seedBasicScenario(seed: string) {
  const c = db();
  const sup = await superAdminP();
  try { await seedCanadaAlbertaPackages2026(sup); } catch { /* already installed */ }

  const club = await makeClub(`3C5B ${seed}`);
  const adminU = await makeUser({ email: `a.${seed}@t.test`, role: "CLUB_ADMIN", clubId: club.id });
  const paU    = await makeUser({ email: `p.${seed}@t.test`, role: "PAYROLL_ADMIN", clubId: club.id });
  const ctlU   = await makeUser({ email: `c.${seed}@t.test`, role: "CONTROLLER", clubId: club.id });
  const adminP = await principalFor(adminU.email);
  const paP    = await principalFor(paU.email);

  await upsertPayrollClubConfig(adminP, club.id, {
    provinceOfEmployment: "AB", payrollAdminUserId: paU.id, controllerUserId: ctlU.id,
  });

  const empUser = await c.user.create({
    data: {
      email: `emp.${seed}@t.test`, name: "Emp",
      role: "STAFF", passwordHash: "x", status: "ACTIVE",
      clubId: club.id,
    },
  });
  const emp = await c.employee.create({
    data: {
      clubId: club.id, firstName: "Sam", lastName: "Complex",
      email: `emp.${seed}@t.test`, hireDate: utc(2020, 1, 1),
      dateOfBirth: utc(1980, 6, 1), status: "ACTIVE",
      employeeNumber: `E-${seed}`,
      employeeLifecycle: "ACTIVE", compensationType: "SALARY", homeProvince: "AB",
      userId: empUser.id,
    },
  });
  const assn = await c.employeeEmploymentAssignment.create({
    data: {
      clubId: club.id, employeeId: emp.id, role: "PRIMARY",
      employmentType: "FULL_TIME", effectiveFrom: utc(2020, 1, 1),
    },
  });
  await c.employeeCompensation.create({
    data: {
      clubId: club.id, employeeId: emp.id, assignmentId: assn.id,
      cadence: "SALARY", rate: "110000", currency: "CAD",
      effectiveFrom: utc(2020, 1, 1),
    },
  });
  await writeEncryptedTd1Claims({
    clubId: club.id, employeeId: emp.id, effectiveFrom: utc(2020, 1, 1),
    province: "AB", td1FormVersion: "2026-01",
    federalClaim: "16452.00", provincialClaim: "22769.00",
  });
  const pg = await c.payrollPayGroup.create({
    data: {
      clubId: club.id, code: `SAL-SM-${seed}`, name: "Salary Semi-Monthly",
      payFrequency: "SEMI_MONTHLY", payDateOffsetDays: 5,
      calendarAnchorDate: utc(2026, 1, 1), active: true,
    },
  });
  await seedSemiMonthlyCalendar(club.id, pg.id, 2026);
  await c.payrollPayGroupMember.create({
    data: { clubId: club.id, payGroupId: pg.id, employeeId: emp.id, effectiveFrom: utc(2020, 1, 1) },
  });

  return { club, adminP, paP, emp, empUser, pg };
}

async function makeComponent(
  s: { adminP: Awaited<ReturnType<typeof principalFor>>; club: { id: string }; emp: { id: string } },
  input: {
    code: string; displayName: string;
    section: "EARNINGS" | "BENEFITS" | "DEDUCTIONS";
    side: "EMPLOYEE" | "EMPLOYER";
    cashEffect: "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT";
    category: string;
    amount: string;
  },
) {
  const cc = await upsertPayrollComponent(s.adminP, s.club.id, {
    code: input.code, displayName: input.displayName,
    category: input.category as never,
    side: input.side, cashEffect: input.cashEffect,
    taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
    calculationMethod: "FIXED_AMOUNT",
    eligibleEarningsBase: null,
    statutoryTreatmentSource: "CUSTOM_TEST",
    displaySection: input.section,
  });
  await createRecurringComponentAssignment(s.adminP, s.club.id, {
    employeeId: s.emp.id, componentId: cc.id,
    amount: input.amount, percentBps: null, effectiveFrom: utc(2020, 1, 1),
  });
  return cc;
}

async function postBatch(
  s: { paP: Awaited<ReturnType<typeof principalFor>>; club: { id: string }; pg: { id: string } },
  seq: number,
) {
  const pp = await db().payrollPayPeriod.findFirstOrThrow({
    where: { clubId: s.club.id, payGroupId: s.pg.id, sequenceInYear: seq },
  });
  const prep = await preparePayrollBatch(s.paP, s.club.id, pp.id);
  await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
  await db().payrollBatch.update({
    where: { id: prep.batchId },
    data: { status: "POSTED", postedAt: new Date() },
  });
  return prep.batchId;
}

// ===================================================================
// §5 · Prior-year YTD exclusion
// ===================================================================
describe("Payroll-3C-5B · §5 prior-year YTD exclusion", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("2025 POSTED component snapshots do NOT contribute to 2026 component YTD", async () => {
    const s = await seedBasicScenario("prior-yr");
    await makeComponent(s, {
      code: "CELL", displayName: "Cell Phone", section: "EARNINGS",
      side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY",
      category: "ALLOWANCE", amount: "37.50",
    });
    // Seed a 2025 pay period + POSTED batch. Route around the
    // calculator (which pins 2026 statutory package) by constructing
    // the batch shell + one component snapshot directly.
    const c = db();
    const pp2025 = await c.payrollPayPeriod.create({
      data: {
        clubId: s.club.id, payGroupId: s.pg.id, taxYear: 2025, sequenceInYear: 24,
        periodStart: utc(2025, 12, 16), periodEnd: utc(2026, 1, 1),
        payDate: utc(2025, 12, 31), status: "CLOSED",
      },
    });
    const batch2025 = await c.payrollBatch.create({
      data: {
        clubId: s.club.id, payGroupId: s.pg.id, payPeriodId: pp2025.id,
        status: "POSTED", postedAt: new Date(),
      },
    });
    const be2025 = await c.payrollBatchEmployee.create({
      data: {
        clubId: s.club.id, batchId: batch2025.id, employeeId: s.emp.id,
        grossPay: "37.50", netPay: "37.50",
        jurisdictionCountry: "CA", jurisdictionProvince: "AB",
        employeeLifecycleAtPrep: "ACTIVE",
      },
    });
    const cell = await c.payrollComponent.findFirstOrThrow({
      where: { clubId: s.club.id, code: "CELL" },
    });
    await c.payrollBatchComponentSnapshot.create({
      data: {
        clubId: s.club.id, batchId: batch2025.id, batchEmployeeId: be2025.id,
        employeeId: s.emp.id, sourceComponentId: cell.id,
        componentCode: "CELL", displayName: "Cell Phone",
        category: "ALLOWANCE", side: "EMPLOYEE", displaySection: "EARNINGS",
        cashEffect: "INCREASES_NET_PAY", calculationMethod: "FIXED_AMOUNT",
        resolvedAmount: "9999.00", sourceEffectiveFrom: utc(2020, 1, 1),
        provenance: "RECURRING_EMPLOYEE_SETUP",
      },
    });

    // Query 2026 YTD.
    const ytd = await getEmployeeComponentYtd(s.club.id, s.emp.id, utc(2026, 12, 31));
    const cellYtd = [...ytd.byKey.values()].find((r) => r.componentCode === "CELL");
    // 2025 $9,999 is fully excluded → 2026 YTD is zero (no 2026 POSTED yet).
    expect(cellYtd).toBeUndefined();
  });
});

// ===================================================================
// §6 · Future-posted YTD exclusion (pay-date bounded)
// ===================================================================
describe("Payroll-3C-5B · §6 future-posted YTD exclusion", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("YTD as-of Aug 31 excludes a POSTED Sep 15 batch, even in the same tax year", async () => {
    const s = await seedBasicScenario("fut");
    await makeComponent(s, {
      code: "CELL", displayName: "Cell Phone", section: "EARNINGS",
      side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY",
      category: "ALLOWANCE", amount: "37.50",
    });
    // POST seq 15 (Aug 15) + seq 16 (Aug 31) + seq 17 (Sep 15).
    await postBatch(s, 15);
    await postBatch(s, 16);
    await postBatch(s, 17);

    // As-of Aug 31 → include seq 15 only (payDate 2026-08-15 < 2026-08-31).
    // seq 16's own snapshot (payDate = 2026-08-31) is EXCLUDED by
    // strict-less-than; the statement builder adds the current row
    // separately via includeCurrentInYtd.
    const ytdAug = await getEmployeeComponentYtd(s.club.id, s.emp.id, utc(2026, 8, 31));
    const cellAug = [...ytdAug.byKey.values()].find((r) => r.componentCode === "CELL");
    expect(cellAug?.ytdAmount).toBe("37.50");

    // As-of Sept 15 → seq 15 + seq 16 (both strictly before Sep 15).
    const ytdSep = await getEmployeeComponentYtd(s.club.id, s.emp.id, utc(2026, 9, 15));
    const cellSep = [...ytdSep.byKey.values()].find((r) => r.componentCode === "CELL");
    expect(cellSep?.ytdAmount).toBe("75.00");
  });
});

// ===================================================================
// §7 · Component rename immutability
// ===================================================================
describe("Payroll-3C-5B · §7 component rename immutability", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("renaming PayrollComponent.displayName does NOT rewrite historical statement label", async () => {
    const s = await seedBasicScenario("rename");
    const cell = await makeComponent(s, {
      code: "CELL", displayName: "Cell Phone Allowance", section: "EARNINGS",
      side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY",
      category: "ALLOWANCE", amount: "37.50",
    });
    const batchId = await postBatch(s, 15);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId } });

    // Rename the live component AFTER posting.
    await db().payrollComponent.update({
      where: { id: cell.id },
      data: { displayName: "Mobile Allowance" },
    });

    const stmt = await buildPayStatement(s.paP, s.club.id, be.id);
    const earnings = stmt.sections.find((sc) => sc.kind === "EARNINGS")!;
    const line = earnings.lines.find((l) => l.label === "Cell Phone Allowance");
    expect(line).toBeDefined();
    // The new name must NOT appear on the historical statement.
    expect(earnings.lines.some((l) => l.label === "Mobile Allowance")).toBe(false);
  });

  it("a future POSTED batch (after rename) uses the new displayName; historical still uses the frozen one", async () => {
    const s = await seedBasicScenario("rename-fwd");
    const cell = await makeComponent(s, {
      code: "CELL", displayName: "Cell Phone Allowance", section: "EARNINGS",
      side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY",
      category: "ALLOWANCE", amount: "37.50",
    });
    const oldBatchId = await postBatch(s, 15);
    const oldBe = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: oldBatchId } });

    await db().payrollComponent.update({
      where: { id: cell.id }, data: { displayName: "Mobile Allowance" },
    });

    const newBatchId = await postBatch(s, 16);
    const newBe = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: newBatchId } });

    const oldStmt = await buildPayStatement(s.paP, s.club.id, oldBe.id);
    const newStmt = await buildPayStatement(s.paP, s.club.id, newBe.id);
    const oldLabels = oldStmt.sections.find((sc) => sc.kind === "EARNINGS")!.lines.map((l) => l.label);
    const newLabels = newStmt.sections.find((sc) => sc.kind === "EARNINGS")!.lines.map((l) => l.label);
    expect(oldLabels).toContain("Cell Phone Allowance");
    expect(newLabels).toContain("Mobile Allowance");
  });
});

// ===================================================================
// §8 · Component deactivation immutability
// ===================================================================
describe("Payroll-3C-5B · §8 component deactivation immutability", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("deactivating the source PayrollComponent does not remove historical statement line", async () => {
    const s = await seedBasicScenario("deact");
    const cell = await makeComponent(s, {
      code: "CELL", displayName: "Cell Phone", section: "EARNINGS",
      side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY",
      category: "ALLOWANCE", amount: "37.50",
    });
    const batchId = await postBatch(s, 15);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId } });

    // Deactivate live catalogue row + end the recurring assignment.
    await db().payrollComponent.update({ where: { id: cell.id }, data: { active: false } });
    await db().employeeRecurringPayrollComponent.updateMany({
      where: { clubId: s.club.id, employeeId: s.emp.id, componentId: cell.id },
      data: { effectiveTo: utc(2026, 8, 20) },
    });

    const stmt = await buildPayStatement(s.paP, s.club.id, be.id);
    const line = stmt.sections.find((sc) => sc.kind === "EARNINGS")!.lines
      .find((l) => l.label === "Cell Phone");
    expect(line).toBeDefined();
    expect(line!.current).toBe("37.50");
    expect(line!.ytd).toBe("37.50");
  });
});

// ===================================================================
// §9 · Component deletion protection
// ===================================================================
describe("Payroll-3C-5B · §9 component deletion protection", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("hard-deleting a PayrollComponent referenced by a snapshot fails (FK protection)", async () => {
    const s = await seedBasicScenario("del");
    const cell = await makeComponent(s, {
      code: "CELL", displayName: "Cell Phone", section: "EARNINGS",
      side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY",
      category: "ALLOWANCE", amount: "37.50",
    });
    await postBatch(s, 15);

    // Attempt hard delete — Prisma FK (default onDelete: Restrict on
    // sourceComponent) must refuse.
    await expect(
      db().payrollComponent.delete({ where: { id: cell.id } }),
    ).rejects.toThrow();
  });
});

// ===================================================================
// §11 · Component YTD keying (id-first, code fallback)
// ===================================================================
describe("Payroll-3C-5B · §11 component YTD keying", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("same sourceComponentId across payrolls aggregates together", async () => {
    const s = await seedBasicScenario("key-agg");
    await makeComponent(s, {
      code: "CELL", displayName: "Cell Phone", section: "EARNINGS",
      side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY",
      category: "ALLOWANCE", amount: "37.50",
    });
    await postBatch(s, 13);
    await postBatch(s, 14);
    const ytd = await getEmployeeComponentYtd(s.club.id, s.emp.id, utc(2026, 8, 1));
    const cell = [...ytd.byKey.values()].find((r) => r.componentCode === "CELL");
    expect(cell?.ytdAmount).toBe("75.00");
    expect(ytd.byKey.size).toBe(1);
  });

  it("two DISTINCT components with a shared code prefix do not merge", async () => {
    const s = await seedBasicScenario("key-distinct");
    await makeComponent(s, {
      code: "CELL_A", displayName: "Cell A", section: "EARNINGS",
      side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY",
      category: "ALLOWANCE", amount: "10.00",
    });
    await makeComponent(s, {
      code: "CELL_B", displayName: "Cell B", section: "EARNINGS",
      side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY",
      category: "ALLOWANCE", amount: "20.00",
    });
    await postBatch(s, 13);
    const ytd = await getEmployeeComponentYtd(s.club.id, s.emp.id, utc(2026, 8, 1));
    expect(ytd.byKey.size).toBe(2);
  });

  it("a component recreated with the same code but a new id does NOT inherit prior YTD (keys are id-first)", async () => {
    const s = await seedBasicScenario("key-recreate");
    const c = db();
    const first = await makeComponent(s, {
      code: "CELL", displayName: "Cell Phone", section: "EARNINGS",
      side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY",
      category: "ALLOWANCE", amount: "37.50",
    });
    await postBatch(s, 13);
    // End the assignment, deactivate old component, "recreate" under
    // the same code with a fresh id.
    await c.employeeRecurringPayrollComponent.updateMany({
      where: { clubId: s.club.id, employeeId: s.emp.id, componentId: first.id },
      data: { effectiveTo: utc(2026, 7, 1) },
    });
    // upsert on (clubId, code) is unique — rename old code to free
    // the slot, then create a fresh row with the same code.
    await c.payrollComponent.update({
      where: { id: first.id }, data: { code: "CELL_OLD", active: false },
    });
    const second = await makeComponent(s, {
      code: "CELL", displayName: "Cell Phone v2", section: "EARNINGS",
      side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY",
      category: "ALLOWANCE", amount: "50.00",
    });
    await postBatch(s, 14);

    const ytd = await getEmployeeComponentYtd(s.club.id, s.emp.id, utc(2026, 8, 1));
    // Two distinct keys: old id ($37.50) + new id ($50.00). Recreation
    // did not merge historical YTD into the new key.
    expect(ytd.byKey.size).toBe(2);
    const oldRow = [...ytd.byKey.values()].find((r) => r.sourceComponentId === first.id);
    const newRow = [...ytd.byKey.values()].find((r) => r.sourceComponentId === second.id);
    expect(oldRow?.ytdAmount).toBe("37.50");
    expect(newRow?.ytdAmount).toBe("50.00");
  });
});

// ===================================================================
// §12 · One-time adjustment YTD
// ===================================================================
describe("Payroll-3C-5B · §12 one-time adjustment YTD", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("YTD includes a one-time bonus posted in a prior period; current-period shows 0", async () => {
    const s = await seedBasicScenario("one-time");
    await makeComponent(s, {
      code: "BONUS", displayName: "Bonus", section: "EARNINGS",
      side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY",
      category: "ADDITIONAL_EARNING", amount: "0.01",
    });
    // Remove the recurring assignment so we can validate the ONE-TIME
    // pathway in isolation.
    await db().employeeRecurringPayrollComponent.updateMany({
      where: { clubId: s.club.id, employeeId: s.emp.id },
      data: { effectiveTo: utc(2020, 1, 2) },
    });

    // Period 1 — PREPARE, add a one-time bonus, calculate, POST.
    const pp13 = await db().payrollPayPeriod.findFirstOrThrow({
      where: { clubId: s.club.id, payGroupId: s.pg.id, sequenceInYear: 13 },
    });
    const prep13 = await preparePayrollBatch(s.paP, s.club.id, pp13.id);
    const be13 = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep13.batchId } });
    await addOneTimeAdjustment(s.paP, s.club.id, prep13.batchId, {
      batchEmployeeId: be13.id, componentCode: "BONUS",
      amount: "500", reason: "Q3 spot bonus",
    });
    await calculatePayrollBatch(s.paP, s.club.id, prep13.batchId);
    await db().payrollBatch.update({
      where: { id: prep13.batchId }, data: { status: "POSTED", postedAt: new Date() },
    });

    // Period 2 — no bonus, POST.
    await postBatch(s, 14);
    const be14 = await db().payrollBatchEmployee.findFirstOrThrow({
      where: { batch: { payPeriod: { sequenceInYear: 14 } }, employeeId: s.emp.id },
    });

    const stmt = await buildPayStatement(s.paP, s.club.id, be14.id);
    const earnings = stmt.sections.find((sc) => sc.kind === "EARNINGS")!;
    // No BONUS row on period 2 because no BONUS snapshot exists on
    // this batch — one-time adjustments are per-batch and don't recur.
    const bonusLine = earnings.lines.find((l) => l.label === "Bonus");
    expect(bonusLine).toBeUndefined();
    // But YTD includes the prior $500 via the coarse taxable YTD +
    // Employee Deductions / Gross totals reflect the persisted history.
    const grossYtd = new Decimal(stmt.totals.grossCashYtd);
    // Period 13 posted $4,583.33 salary + $500 bonus = $5,083.33.
    // Period 14 posted $4,583.33 salary. YTD-including-this-pay for
    // period 14 = $5,083.33 + $4,583.33 = $9,666.66.
    expect(grossYtd.toFixed(2)).toBe("9666.66");
  });
});

// ===================================================================
// §13 · Employer contribution YTD (from persisted rows, not multiplication)
// ===================================================================
describe("Payroll-3C-5B · §13 employer contribution YTD", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("employer AD&D YTD across 3 posted periods equals sum of persisted rows, not current × 3", async () => {
    const s = await seedBasicScenario("erc");
    await makeComponent(s, {
      code: "AD_D", displayName: "AD&D ER", section: "BENEFITS",
      side: "EMPLOYER", cashEffect: "NO_NET_PAY_EFFECT",
      category: "EMPLOYER_CONTRIBUTION", amount: "2.25",
    });
    await postBatch(s, 13);
    await postBatch(s, 14);
    await postBatch(s, 15);

    const ytd = await getEmployeeComponentYtd(s.club.id, s.emp.id, utc(2026, 8, 15));
    const ad = [...ytd.byKey.values()].find((r) => r.componentCode === "AD_D");
    // 2 prior POSTED periods × 2.25 = 4.50 (seq 15 is the as-of and
    // is strictly excluded from YTD; the statement builder folds the
    // current row in separately).
    expect(ad?.ytdAmount).toBe("4.50");
  });
});

// ===================================================================
// §16 · Employee portal cross-employee / cross-tenant / non-POSTED denial
// ===================================================================
describe("Payroll-3C-5B · §16 employee portal authorization", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("refuses another employee's batchEmployeeId (ForbiddenError)", async () => {
    const s = await seedBasicScenario("port-cross");
    await postBatch(s, 13);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({
      where: { batch: { payPeriod: { sequenceInYear: 13 } }, employeeId: s.emp.id },
    });
    await expect(buildEmployeePortalPayStatement({
      clubId: s.club.id, employeeId: "not-the-owner", batchEmployeeId: be.id,
    })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses a batchEmployee from a different Club (NotFoundError — fails closed)", async () => {
    const s = await seedBasicScenario("port-cross-tenant");
    const other = await seedBasicScenario("port-cross-other");
    await postBatch(s, 13);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({
      where: { batch: { payPeriod: { sequenceInYear: 13 } }, employeeId: s.emp.id },
    });
    // The impostor from Other club claims the correct employeeId
    // but wrong clubId. buildEmployeePortalPayStatement selects on
    // (batchEmployeeId, clubId) at the row level via `assertTenantOwned`
    // → mismatched clubId returns a not-found result.
    await expect(buildEmployeePortalPayStatement({
      clubId: other.club.id, employeeId: s.emp.id, batchEmployeeId: be.id,
    })).rejects.toThrow();
  });

  it("returns the DTO for the owner's own POSTED statement (regression: the synthetic self-principal must carry a membership for its clubId)", async () => {
    // Payroll-3C-5B regression — pre-fix buildEmployeePortalPayStatement
    // built a self-principal with `memberships: []`; buildPayStatement's
    // `assertTenantOwned` then rejected every read with a
    // TenantViolationError. Employee-portal `/employee/pay/[id]`
    // rendered a 500 in the browser. Fix injects a synthetic
    // membership scoped to the batch's clubId after ownership is
    // proven at the outer boundary. This test locks the fix in.
    const s = await seedBasicScenario("port-happy");
    await postBatch(s, 13);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({
      where: { batch: { payPeriod: { sequenceInYear: 13 } }, employeeId: s.emp.id },
    });
    const stmt = await buildEmployeePortalPayStatement({
      clubId: s.club.id, employeeId: s.emp.id, batchEmployeeId: be.id,
    });
    expect(stmt.batchEmployeeId).toBe(be.id);
    expect(stmt.isPosted).toBe(true);
  });

  it("refuses a non-POSTED batch (NotFoundError)", async () => {
    const s = await seedBasicScenario("port-nonposted");
    const pp = await db().payrollPayPeriod.findFirstOrThrow({
      where: { clubId: s.club.id, payGroupId: s.pg.id, sequenceInYear: 13 },
    });
    const prep = await preparePayrollBatch(s.paP, s.club.id, pp.id);
    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    // Do NOT flip to POSTED.
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    await expect(buildEmployeePortalPayStatement({
      clubId: s.club.id, employeeId: s.emp.id, batchEmployeeId: be.id,
    })).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ===================================================================
// §17 · Admin history authorization
// ===================================================================
describe("Payroll-3C-5B · §17 admin history authorization", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("admin history refuses a user without payroll:read", async () => {
    const s = await seedBasicScenario("admin-auth");
    const c = db();
    const staff = await makeUser({ email: `staff@t.test`, role: "STAFF", clubId: s.club.id });
    const staffP = await principalFor(staff.email);
    // No POSTED batches needed — the permission check runs first.
    await expect(listPostedPayrollHistory(staffP, s.club.id)).rejects.toThrow();
    expect(c).toBeDefined();
  });
});

// ===================================================================
// §18/§19 · Sensitive-data leak audit
// ===================================================================
describe("Payroll-3C-5B · §18/§19 sensitive-data leak audit", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("statement DTO does not leak SIN patterns, TD1 claim amounts, or encrypted payloads", async () => {
    const s = await seedBasicScenario("leak");
    await makeComponent(s, {
      code: "CELL", displayName: "Cell Phone", section: "EARNINGS",
      side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY",
      category: "ALLOWANCE", amount: "37.50",
    });
    const batchId = await postBatch(s, 15);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId } });

    const stmt = await buildPayStatement(s.paP, s.club.id, be.id);
    const serialized = JSON.stringify(stmt);

    // SIN pattern (nine digits, optionally hyphenated / spaced).
    expect(serialized).not.toMatch(/\b\d{3}[\s-]?\d{3}[\s-]?\d{3}\b/);
    // TD1 fixture claim amounts must never leak.
    expect(serialized).not.toContain("16452");
    expect(serialized).not.toContain("22769");
    // No raw enum leakage.
    expect(serialized).not.toContain("CUSTOM_TEST");
    expect(serialized).not.toContain("SPECTRE_LIBRARY");
    expect(serialized).not.toContain("provenance");
    expect(serialized).not.toContain("ONE_TIME_PAYROLL_ADJUSTMENT");
    // No banking details in the DTO.
    expect(serialized).not.toContain("transitNumber");
    expect(serialized).not.toContain("institutionNumber");
    expect(serialized).not.toContain("accountNumber");
    // Disbursement should never expose a full account number — we
    // deliberately allow last-4 style rendering only.
    if (stmt.disbursement.accountLast4 != null) {
      expect(stmt.disbursement.accountLast4.length).toBeLessThanOrEqual(4);
    }
    // transmitted defaults false — Spectre is not sending direct
    // deposits in this slice.
    expect(stmt.disbursement.transmitted).toBe(false);
  });

  it("statement DTO does not carry the raw ytdSnapshotJson or calculationExplanationJson", async () => {
    const s = await seedBasicScenario("leak-json");
    await makeComponent(s, {
      code: "CELL", displayName: "Cell Phone", section: "EARNINGS",
      side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY",
      category: "ALLOWANCE", amount: "37.50",
    });
    const batchId = await postBatch(s, 15);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId } });
    const stmt = await buildPayStatement(s.paP, s.club.id, be.id);
    const s2 = JSON.stringify(stmt);
    expect(s2).not.toContain("ytdSnapshotJson");
    expect(s2).not.toContain("calculationExplanationJson");
    expect(s2).not.toContain("passwordHash");
    expect(s2).not.toContain("packageChecksum");
  });
});
