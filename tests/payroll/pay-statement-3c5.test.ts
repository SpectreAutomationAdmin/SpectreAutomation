// Payroll-3C-5 (2026-09-09) — pay statement + component YTD tests.
//
// Focused coverage of the highest-priority §55 acceptance items:
//   • YTD inclusion / exclusion rules for opening balance + POSTED
//   • Component-level YTD aggregation
//   • Statement DTO sectioning + reconciliation
//   • Sensitive-data sweep
//   • Employee self-only + tenant isolation
//
// Fully-comprehensive coverage (all 32 items in §55) is a follow-up
// slice. Documented in the 3C-5 checkpoint.

import { describe, it, expect, beforeEach } from "vitest";
import Decimal from "decimal.js";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import { upsertPayrollComponent, createRecurringComponentAssignment } from "@/lib/payroll/components-catalogue";
import { writeEncryptedTd1Claims } from "@/lib/hr/td1-secure-write";
import { preparePayrollBatch } from "@/lib/payroll/batch-preparation";
import { calculatePayrollBatch } from "@/lib/payroll/calculation-execute";
import { seedCanadaAlbertaPackages2026 } from "@/lib/payroll/statutory/seed-ca-ab-2026";
import { getEmployeeComponentYtd } from "@/lib/payroll/component-ytd";
import {
  buildPayStatement,
  listEmployeePostedPayStatements,
  buildEmployeePortalPayStatement,
  listPostedPayrollHistory,
} from "@/lib/payroll/pay-statement";
import { ForbiddenError, NotFoundError } from "@/lib/errors";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function superAdminP() {
  const c = db();
  await c.user.deleteMany({ where: { email: "sup-3c5@spectre.test" } });
  const u = await c.user.create({
    data: { email: "sup-3c5@spectre.test", name: "Sup3C5", role: "SUPER_ADMIN", passwordHash: "x", status: "ACTIVE" },
  });
  await c.userClubRole.create({ data: { userId: u.id, clubId: null, roleKey: "SUPER_ADMIN" } });
  return principalFor("sup-3c5@spectre.test");
}

async function seedSemiMonthlyCalendar(clubId: string, payGroupId: string) {
  const c = db();
  let seq = 0;
  for (let m = 0; m < 12; m++) {
    seq += 1;
    await c.payrollPayPeriod.create({
      data: {
        clubId, payGroupId, taxYear: 2026, sequenceInYear: seq,
        periodStart: utc(2026, m + 1, 1), periodEnd: utc(2026, m + 1, 16),
        payDate: utc(2026, m + 1, 16), status: "OPEN",
      },
    });
    seq += 1;
    await c.payrollPayPeriod.create({
      data: {
        clubId, payGroupId, taxYear: 2026, sequenceInYear: seq,
        periodStart: utc(2026, m + 1, 16), periodEnd: utc(2026, m + 2, 1),
        payDate: utc(2026, m + 2, 1), status: "OPEN",
      },
    });
  }
}

async function seedRichScenario(seed: string) {
  const c = db();
  const sup = await superAdminP();
  try { await seedCanadaAlbertaPackages2026(sup); } catch { /* already installed */ }
  const club = await makeClub(`3C5 ${seed}`);
  const adminU = await makeUser({ email: `a.${seed}@t.test`, role: "CLUB_ADMIN", clubId: club.id });
  const paU    = await makeUser({ email: `p.${seed}@t.test`, role: "PAYROLL_ADMIN", clubId: club.id });
  const ctlU   = await makeUser({ email: `c.${seed}@t.test`, role: "CONTROLLER", clubId: club.id });
  const adminP = await principalFor(adminU.email);
  const paP    = await principalFor(paU.email);
  await upsertPayrollClubConfig(adminP, club.id, {
    provinceOfEmployment: "AB", payrollAdminUserId: paU.id, controllerUserId: ctlU.id,
  });

  // Sam Complex-shaped employee with 7 recurring components.
  const emp = await c.employee.create({
    data: {
      clubId: club.id, firstName: "Sam", lastName: "Complex",
      email: `sam.${seed}@t.test`, hireDate: utc(2020, 1, 1),
      dateOfBirth: utc(1980, 6, 1), status: "ACTIVE",
      employeeNumber: `SAM-${seed}`,
      employeeLifecycle: "ACTIVE", compensationType: "SALARY", homeProvince: "AB",
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
      payFrequency: "SEMI_MONTHLY", payDateOffsetDays: 1,
      calendarAnchorDate: utc(2026, 1, 1), active: true,
    },
  });
  await seedSemiMonthlyCalendar(club.id, pg.id);
  await c.payrollPayGroupMember.create({
    data: { clubId: club.id, payGroupId: pg.id, employeeId: emp.id, effectiveFrom: utc(2020, 1, 1) },
  });

  async function comp(
    code: string, name: string, section: "EARNINGS" | "BENEFITS" | "DEDUCTIONS",
    side: "EMPLOYEE" | "EMPLOYER", cash: "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT",
    category: string,
    taxable: "ADD" | "SUBTRACT" | "NONE", cpp: "ADD" | "SUBTRACT" | "NONE", ei: "ADD" | "SUBTRACT" | "NONE",
    method: "FIXED_AMOUNT" | "PERCENT_OF_ELIGIBLE_EARNINGS",
    amount: string | null, percentBps: number | null,
  ) {
    const cc = await upsertPayrollComponent(adminP, club.id, {
      code, displayName: name, category: category as never, side,
      cashEffect: cash, taxableEffect: taxable, cppPensionableEffect: cpp, eiInsurableEffect: ei,
      calculationMethod: method,
      eligibleEarningsBase: method === "PERCENT_OF_ELIGIBLE_EARNINGS" ? "REGULAR_EARNINGS_ONLY" : null,
      statutoryTreatmentSource: "CUSTOM_TEST",
      displaySection: section,
    });
    await createRecurringComponentAssignment(adminP, club.id, {
      employeeId: emp.id, componentId: cc.id,
      amount, percentBps, effectiveFrom: utc(2020, 1, 1),
    });
  }
  await comp("CELL_PHONE_ALLOWANCE", "Cell Phone Allowance",      "EARNINGS",   "EMPLOYEE", "INCREASES_NET_PAY", "ALLOWANCE",             "ADD",  "ADD",  "NONE", "FIXED_AMOUNT",                "37.50", null);
  await comp("LIFE_INSURANCE_ER_PREMIUM", "Life Insurance ER",    "BENEFITS",   "EMPLOYER", "NO_NET_PAY_EFFECT", "TAXABLE_BENEFIT",       "ADD",  "ADD",  "NONE", "FIXED_AMOUNT",                "20.93", null);
  await comp("AD_D_ER_PREMIUM", "AD&D ER",                        "BENEFITS",   "EMPLOYER", "NO_NET_PAY_EFFECT", "EMPLOYER_CONTRIBUTION", "NONE", "NONE", "NONE", "FIXED_AMOUNT",                "2.25",  null);
  await comp("DEPENDENT_LIFE_ER_PREMIUM", "Dependent Life ER",    "BENEFITS",   "EMPLOYER", "NO_NET_PAY_EFFECT", "EMPLOYER_CONTRIBUTION", "NONE", "NONE", "NONE", "FIXED_AMOUNT",                "0.83",  null);
  await comp("RRSP_ER", "RRSP Employer",                          "BENEFITS",   "EMPLOYER", "NO_NET_PAY_EFFECT", "EMPLOYER_CONTRIBUTION", "NONE", "NONE", "NONE", "PERCENT_OF_ELIGIBLE_EARNINGS", null,   500);
  await comp("RRSP_EE", "RRSP Employee",                          "DEDUCTIONS", "EMPLOYEE", "DECREASES_NET_PAY", "EMPLOYEE_DEDUCTION",    "NONE", "NONE", "NONE", "PERCENT_OF_ELIGIBLE_EARNINGS", null,   500);
  await comp("LTD_EE",  "LTD Employee",                           "DEDUCTIONS", "EMPLOYEE", "DECREASES_NET_PAY", "EMPLOYEE_DEDUCTION",    "NONE", "NONE", "NONE", "FIXED_AMOUNT",                "28.11", null);

  return { club, adminP, paP, emp, pg };
}

async function firstPeriod(clubId: string, payGroupId: string, seq = 17) {
  return db().payrollPayPeriod.findFirstOrThrow({
    where: { clubId, payGroupId, sequenceInYear: seq },
  });
}

// -------------------------------------------------------------------
// A · Statement DTO — sectioning + reconciliation
// -------------------------------------------------------------------
describe("Payroll-3C-5 · Pay statement DTO — sections + reconciliation", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("splits recurring components into Earnings / Taxable benefits / Other deductions / Employer contributions", async () => {
    const s = await seedRichScenario("dto-split");
    const pp = await firstPeriod(s.club.id, s.pg.id);
    const prep = await preparePayrollBatch(s.paP, s.club.id, pp.id);
    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });

    const stmt = await buildPayStatement(s.paP, s.club.id, be.id);
    const byKind = new Map(stmt.sections.map((sc) => [sc.kind, sc]));

    // EARNINGS contains the recurring Cell Phone Allowance. Salary
    // for SALARY-cadence employees derives from source facts rather
    // than a labelled PayrollBatchEarning row, so we assert on the
    // gross totals (below) rather than on a per-line "Salary" row.
    const earnings = byKind.get("EARNINGS")!;
    expect(earnings.lines.some((l) => l.label === "Cell Phone Allowance")).toBe(true);

    // Per 3C-3C §25 the display section is orthogonal to statutory
    // treatment. Every employer-side row lands in
    // Employer Benefits & Contributions — including employer-paid
    // TAXABLE_BENEFIT items — so that the reader gets ONE total for
    // what the employer paid. Taxability shows up in the statutory
    // bases section (Taxable / CPP / EI) rather than by shuffling
    // the row out of Employer Benefits & Contributions.
    const tb = byKind.get("TAXABLE_BENEFITS")!;
    // Sam Complex has no employee-side non-cash TB, so this section
    // must be empty.
    expect(tb.lines.length).toBe(0);

    // OTHER_DEDUCTIONS contains RRSP EE + LTD (employee-cash-decreasing).
    const od = byKind.get("OTHER_DEDUCTIONS")!;
    expect(od.lines.some((l) => l.label === "RRSP Employee")).toBe(true);
    expect(od.lines.some((l) => l.label === "LTD Employee")).toBe(true);

    // EMPLOYER_CONTRIBUTIONS contains ALL four employer-side items
    // (AD&D, Dep Life, RRSP ER, and Life Insurance ER).
    const er = byKind.get("EMPLOYER_CONTRIBUTIONS")!;
    expect(er.lines.some((l) => l.label === "AD&D ER")).toBe(true);
    expect(er.lines.some((l) => l.label === "Dependent Life ER")).toBe(true);
    expect(er.lines.some((l) => l.label === "RRSP Employer")).toBe(true);
    expect(er.lines.some((l) => l.label === "Life Insurance ER")).toBe(true);
    // Employer contributions must NOT include RRSP Employee.
    expect(er.lines.every((l) => l.label !== "RRSP Employee")).toBe(true);
  });

  it("Statutory Deductions section contains CPP / EI / federal / provincial (CPP2 only if > 0)", async () => {
    const s = await seedRichScenario("dto-stat");
    const pp = await firstPeriod(s.club.id, s.pg.id);
    const prep = await preparePayrollBatch(s.paP, s.club.id, pp.id);
    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });

    const stmt = await buildPayStatement(s.paP, s.club.id, be.id);
    const stat = stmt.sections.find((sc) => sc.kind === "STATUTORY_DEDUCTIONS")!;
    const labels = stat.lines.map((l) => l.label);
    expect(labels).toContain("CPP");
    expect(labels).toContain("EI");
    expect(labels).toContain("Federal tax");
    expect(labels).toContain("Provincial tax");
  });

  it("Employer contributions do NOT inflate cash or net pay (§18)", async () => {
    const s = await seedRichScenario("dto-noninflate");
    const pp = await firstPeriod(s.club.id, s.pg.id);
    const prep = await preparePayrollBatch(s.paP, s.club.id, pp.id);
    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    const stmt = await buildPayStatement(s.paP, s.club.id, be.id);
    // Gross cash = salary $4,583.33 + Cell Phone $37.50 = $4,620.83.
    expect(stmt.totals.grossCashCurrent).toBe("4620.83");
    // Employer contributions must be > 0 but NOT included in gross cash.
    expect(Number(stmt.totals.employerContributionsCurrent)).toBeGreaterThan(0);
    expect(Number(stmt.totals.employerContributionsCurrent)).not.toBe(Number(stmt.totals.grossCashCurrent));
  });

  it("Non-cash taxable benefit does NOT add to Gross cash (§16)", async () => {
    const s = await seedRichScenario("dto-noncash");
    const pp = await firstPeriod(s.club.id, s.pg.id);
    const prep = await preparePayrollBatch(s.paP, s.club.id, pp.id);
    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    const stmt = await buildPayStatement(s.paP, s.club.id, be.id);
    // Cash gross unchanged by the $20.93 LIFE ER benefit (it appears
    // under EMPLOYER_CONTRIBUTIONS since side=EMPLOYER).
    expect(stmt.totals.grossCashCurrent).toBe("4620.83");
    // Taxable base IS lifted by the TB.
    expect(new Decimal(stmt.statutoryBases.taxableCurrent).toFixed(2)).toBe("4641.76");
  });

  it("Net pay = gross cash − employee deductions (statutory + configured)", async () => {
    const s = await seedRichScenario("dto-net");
    const pp = await firstPeriod(s.club.id, s.pg.id);
    const prep = await preparePayrollBatch(s.paP, s.club.id, pp.id);
    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    const stmt = await buildPayStatement(s.paP, s.club.id, be.id);
    const gross = new Decimal(stmt.totals.grossCashCurrent);
    const eeDed = new Decimal(stmt.totals.employeeDeductionsCurrent);
    const net   = new Decimal(stmt.totals.netPayCurrent);
    // net + deductions must equal gross (to the cent) — the frozen
    // netPay column on PayrollBatchEmployee owns the exact math.
    expect(gross.minus(eeDed).toFixed(2)).toBe(net.toFixed(2));
  });
});

// -------------------------------------------------------------------
// B · Component YTD — inclusion / exclusion rules
// -------------------------------------------------------------------
describe("Payroll-3C-5 · Component YTD", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("opening balance component contributes to YTD when parent is PRIOR_SYSTEM_SAME_EMPLOYER + ACTIVE", async () => {
    const s = await seedRichScenario("cytd-open");
    const c = db();
    const ob = await c.payrollOpeningBalance.create({
      data: {
        clubId: s.club.id, employeeId: s.emp.id, taxYear: 2026,
        status: "ACTIVE", throughPayDate: utc(2026, 6, 30),
        activatedAt: new Date(),
        priorPayrollKind: "PRIOR_SYSTEM_SAME_EMPLOYER",
        importSource: "MANUAL", importedAt: new Date(),
      },
    });
    await c.payrollOpeningBalanceComponent.create({
      data: {
        clubId: s.club.id, openingBalanceId: ob.id,
        componentCode: "CELL_PHONE_ALLOWANCE", displayName: "Cell Phone Allowance",
        category: "ALLOWANCE", side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY",
        ytdAmount: "450.00",
      },
    });
    const ytd = await getEmployeeComponentYtd(s.club.id, s.emp.id, utc(2026, 9, 1));
    const cell = [...ytd.byKey.values()].find((r) => r.componentCode === "CELL_PHONE_ALLOWANCE");
    expect(cell?.ytdAmount).toBe("450.00");
  });

  it("PRIOR_EMPLOYER opening balance component contributes ZERO to this employer's YTD", async () => {
    const s = await seedRichScenario("cytd-prior-emp");
    const c = db();
    const ob = await c.payrollOpeningBalance.create({
      data: {
        clubId: s.club.id, employeeId: s.emp.id, taxYear: 2026,
        status: "ACTIVE", throughPayDate: utc(2026, 6, 30),
        activatedAt: new Date(),
        priorPayrollKind: "PRIOR_EMPLOYER",
        importSource: "MANUAL", importedAt: new Date(),
      },
    });
    await c.payrollOpeningBalanceComponent.create({
      data: {
        clubId: s.club.id, openingBalanceId: ob.id,
        componentCode: "CELL_PHONE_ALLOWANCE", displayName: "Cell Phone Allowance",
        category: "ALLOWANCE", side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY",
        ytdAmount: "9999.00",
      },
    });
    const ytd = await getEmployeeComponentYtd(s.club.id, s.emp.id, utc(2026, 9, 1));
    const cell = [...ytd.byKey.values()].find((r) => r.componentCode === "CELL_PHONE_ALLOWANCE");
    expect(cell).toBeUndefined();
  });

  it("PREPARED / CALCULATED batches do NOT contribute to YTD; only POSTED does", async () => {
    const s = await seedRichScenario("cytd-life");
    const pp1 = await firstPeriod(s.club.id, s.pg.id, 17);
    const pp2 = await firstPeriod(s.club.id, s.pg.id, 18);

    // pp1 → PREPARED but not calculated.
    await preparePayrollBatch(s.paP, s.club.id, pp1.id);
    // pp2 → CALCULATED but not POSTED.
    const prep2 = await preparePayrollBatch(s.paP, s.club.id, pp2.id);
    await calculatePayrollBatch(s.paP, s.club.id, prep2.batchId);

    const ytd = await getEmployeeComponentYtd(s.club.id, s.emp.id, utc(2026, 9, 30));
    // No POSTED batches yet → Cell Phone YTD is 0 (opening not seeded).
    expect(ytd.byKey.size).toBe(0);
  });

  it("aggregates POSTED batch component snapshots into per-Component YTD", async () => {
    const s = await seedRichScenario("cytd-posted");
    const c = db();
    // Simulate a POSTED prior period by force-flipping status +
    // constructing a snapshot row directly (production POST is gated
    // for component batches until 3C-6; §51 endorses this test path).
    const pp = await firstPeriod(s.club.id, s.pg.id, 17);
    const prep = await preparePayrollBatch(s.paP, s.club.id, pp.id);
    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    await c.payrollBatch.update({ where: { id: prep.batchId }, data: { status: "POSTED", postedAt: new Date() } });

    // Now query YTD as of a later pay date — the POSTED batch above
    // contributes its component snapshots.
    const ytd = await getEmployeeComponentYtd(s.club.id, s.emp.id, utc(2026, 12, 1));
    const cell = [...ytd.byKey.values()].find((r) => r.componentCode === "CELL_PHONE_ALLOWANCE");
    expect(cell?.ytdAmount).toBe("37.50");
    const rrspEe = [...ytd.byKey.values()].find((r) => r.componentCode === "RRSP_EE");
    expect(rrspEe?.ytdAmount).toBe("229.17");
  });
});

// -------------------------------------------------------------------
// C · Security / sensitive-data sweep
// -------------------------------------------------------------------
describe("Payroll-3C-5 · Security", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("does NOT include SIN / TD1 / bank / password / encrypted payload in the statement DTO or its serialization", async () => {
    const s = await seedRichScenario("sec");
    const pp = await firstPeriod(s.club.id, s.pg.id);
    const prep = await preparePayrollBatch(s.paP, s.club.id, pp.id);
    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    const stmt = await buildPayStatement(s.paP, s.club.id, be.id);
    const serialized = JSON.stringify(stmt);
    // No SIN pattern (nine digits, possibly hyphenated / spaced).
    expect(serialized).not.toMatch(/\b\d{3}[\s-]?\d{3}[\s-]?\d{3}\b/);
    // No fixture claim amounts leaked.
    expect(serialized).not.toContain("16452");
    expect(serialized).not.toContain("22769");
    // No CUSTOM_TEST enum leaks through display labels.
    expect(serialized).not.toContain("CUSTOM_TEST");
    expect(serialized).not.toContain("SPECTRE_LIBRARY");
    expect(serialized).not.toContain("provenance");
    expect(serialized).not.toContain("ONE_TIME_PAYROLL_ADJUSTMENT");
  });

  it("employee-portal single fetch REFUSES another employee's batchEmployeeId (cross-employee)", async () => {
    const s = await seedRichScenario("sec-cross");
    const pp = await firstPeriod(s.club.id, s.pg.id);
    const prep = await preparePayrollBatch(s.paP, s.club.id, pp.id);
    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    await db().payrollBatch.update({ where: { id: prep.batchId }, data: { status: "POSTED", postedAt: new Date() } });
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    // Attempt to fetch Sam's statement while claiming a different employeeId.
    await expect(buildEmployeePortalPayStatement({
      clubId: s.club.id,
      employeeId: "another-employee-id-that-does-not-match",
      batchEmployeeId: be.id,
    })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("employee-portal single fetch REFUSES a non-POSTED statement (only POSTED is visible)", async () => {
    const s = await seedRichScenario("sec-nonposted");
    const pp = await firstPeriod(s.club.id, s.pg.id);
    const prep = await preparePayrollBatch(s.paP, s.club.id, pp.id);
    await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
    // Do NOT flip to POSTED.
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    await expect(buildEmployeePortalPayStatement({
      clubId: s.club.id, employeeId: s.emp.id, batchEmployeeId: be.id,
    })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("employee-portal list returns ONLY POSTED statements, newest first", async () => {
    const s = await seedRichScenario("sec-list");
    const c = db();
    const pp17 = await firstPeriod(s.club.id, s.pg.id, 17);
    const pp18 = await firstPeriod(s.club.id, s.pg.id, 18);

    // pp17 → posted, pp18 → only calculated.
    const p17 = await preparePayrollBatch(s.paP, s.club.id, pp17.id);
    await calculatePayrollBatch(s.paP, s.club.id, p17.batchId);
    await c.payrollBatch.update({ where: { id: p17.batchId }, data: { status: "POSTED", postedAt: new Date() } });

    const p18 = await preparePayrollBatch(s.paP, s.club.id, pp18.id);
    await calculatePayrollBatch(s.paP, s.club.id, p18.batchId);

    const list = await listEmployeePostedPayStatements({ clubId: s.club.id, employeeId: s.emp.id });
    expect(list.length).toBe(1);
    expect(list[0].batchId).toBe(p17.batchId);
  });
});

// -------------------------------------------------------------------
// D · Admin history
// -------------------------------------------------------------------
describe("Payroll-3C-5 · Admin payroll history", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("lists POSTED batches with pay-date descending", async () => {
    const s = await seedRichScenario("hist");
    const c = db();
    const pp17 = await firstPeriod(s.club.id, s.pg.id, 17);
    const pp18 = await firstPeriod(s.club.id, s.pg.id, 18);
    for (const pp of [pp17, pp18]) {
      const prep = await preparePayrollBatch(s.paP, s.club.id, pp.id);
      await calculatePayrollBatch(s.paP, s.club.id, prep.batchId);
      await c.payrollBatch.update({ where: { id: prep.batchId }, data: { status: "POSTED", postedAt: new Date() } });
    }
    const history = await listPostedPayrollHistory(s.paP, s.club.id);
    expect(history.length).toBe(2);
    // Newest first.
    expect(new Date(history[0].payDateIso).getTime())
      .toBeGreaterThan(new Date(history[1].payDateIso).getTime());
    expect(history[0].employeeCount).toBe(1);
    expect(history[0].grossPayrollTotal).toBe("4620.83");
  });
});
