// Payroll-3C-3B (2026-09-08) — Sam Complex source-paystub
// reconciliation.
//
// SCOPE (§Purpose of the 3C-3B brief):
//   This suite is a RECONCILIATION artifact — not an implementation
//   step. It seeds a synthetic Sam Complex batch that structurally
//   mirrors the founder-supplied reference paystub, produces a
//   reconciliation table (source vs. Spectre for every visible line),
//   and asserts ONLY the arithmetic that is independently derivable
//   from Spectre's own compensation + component configuration.
//
//   It DELIBERATELY does not:
//     • alter statutory formulas or constants,
//     • add SPECTRE_LIBRARY entries (no authoritative reference was
//       verified in this slice; every treatment stays CUSTOM_TEST),
//     • force CPP / CPP2 / EI / income tax / net to match,
//     • treat the source paystub as legally authoritative for any
//       Canadian classification.
//
//   The reconciliation report is written to
//     test-results/sam-complex-reconciliation.md
//   so the founder can inspect the exact source-vs-Spectre delta.

import { describe, it, expect, beforeEach } from "vitest";
import Decimal from "decimal.js";
import fs from "node:fs";
import path from "node:path";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import { upsertPayrollComponent, createRecurringComponentAssignment } from "@/lib/payroll/components-catalogue";
import { writeEncryptedTd1Claims } from "@/lib/hr/td1-secure-write";
import { preparePayrollBatch } from "@/lib/payroll/batch-preparation";
import { calculatePayrollBatch } from "@/lib/payroll/calculation-execute";
import { seedCanadaAlbertaPackages2026 } from "@/lib/payroll/statutory/seed-ca-ab-2026";
import { createDraftOpeningBalance, activateOpeningBalance, type OpeningBalanceFields } from "@/lib/payroll/opening-balance";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

// -------------------------------------------------------------------
// Reference paystub (SOURCE) — current-period values transcribed from
// the founder-supplied PDF. Personal identifiers stripped.
// -------------------------------------------------------------------
const SOURCE = {
  // Current period
  regularSalary:              new Decimal("4583.33"),
  cellPhoneAllowance:         new Decimal("37.50"),
  cashEarnings:               new Decimal("4620.83"),   // regular + cell
  employerBenefitsTotal:      new Decimal("253.18"),
  displayedInsurable:         new Decimal("4583.33"),
  displayedGrossTaxable:      new Decimal("4874.01"),   // "Gross Taxable Earnings and Benefits"
  // Employer contributions (line items)
  adAndD:                     new Decimal("2.25"),
  dependentLife:              new Decimal("0.83"),
  lifeInsurance:              new Decimal("20.93"),
  rrspER:                     new Decimal("229.17"),
  // Employee deductions (statutory + configured)
  cpp:                        new Decimal("279.10"),
  ei:                         new Decimal("74.71"),
  federalTax:                 new Decimal("652.27"),
  provincialTax:              new Decimal("317.42"),
  ltd:                        new Decimal("28.11"),
  rrspEE:                     new Decimal("229.17"),
  totalDeductions:            new Decimal("1580.78"),
  net:                        new Decimal("3040.05"),
  // YTD (as-displayed — reads on the source paystub include the current period)
  ytd: {
    cellPhoneAllowance:       new Decimal("506.25"),
    regularSalary:            new Decimal("61874.96"),
    grossTaxable:             new Decimal("65766.64"),
    adAndD:                   new Decimal("27.00"),
    dependentLife:            new Decimal("10.48"),
    lifeInsurance:            new Decimal("254.16"),
    rrspER:                   new Decimal("3093.79"),
    insurable:                new Decimal("61874.96"),
    cpp:                      new Decimal("3761.56"),
    ei:                       new Decimal("1008.58"),
    federalTax:               new Decimal("8670.86"),
    provincialTax:            new Decimal("4220.10"),
    ltd:                      new Decimal("351.42"),
    rrspEE:                   new Decimal("3093.79"),
    net:                      new Decimal("41274.90"),
  },
};

// Prior YTD (immediately before this pay period) — backsolved:
//   priorYTD = displayed YTD − current amount, where the source
//   paystub's YTD is a running total INCLUDING the current period.
// (The source paystub layout — Rise — puts current + YTD side by
//  side, and the YTD figures back-solve cleanly to current × N for
//  every field EXCEPT regular-salary and RRSP EE/ER, which give a
//  non-integer N. That anomaly is reported in the doc; it does not
//  block reconciliation for the CURRENT period.)
const PRIOR_YTD = {
  regularSalary:    SOURCE.ytd.regularSalary.minus(SOURCE.regularSalary),
  insurable:        SOURCE.ytd.insurable.minus(SOURCE.displayedInsurable),
  grossTaxable:     SOURCE.ytd.grossTaxable.minus(SOURCE.displayedGrossTaxable),
  cpp:              SOURCE.ytd.cpp.minus(SOURCE.cpp),
  ei:               SOURCE.ytd.ei.minus(SOURCE.ei),
  federalTax:       SOURCE.ytd.federalTax.minus(SOURCE.federalTax),
  provincialTax:    SOURCE.ytd.provincialTax.minus(SOURCE.provincialTax),
};

const CURRENT_PAY_DATE = utc(2026, 8, 31);
const CURRENT_PERIOD_START = utc(2026, 8, 9);
const CURRENT_PERIOD_END = utc(2026, 8, 24); // exclusive (Aug 9→23 inclusive = end 24 exclusive)

async function superAdminP() {
  const c = db();
  await c.user.deleteMany({ where: { email: "sup-recon@spectre.test" } });
  const u = await c.user.create({
    data: { email: "sup-recon@spectre.test", name: "Sup", role: "SUPER_ADMIN", passwordHash: "x", status: "ACTIVE" },
  });
  await c.userClubRole.create({ data: { userId: u.id, clubId: null, roleKey: "SUPER_ADMIN" } });
  return principalFor("sup-recon@spectre.test");
}

async function seedSemiMonthlyCalendar2026(clubId: string, payGroupId: string) {
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
  // Payroll-3C-3B — the reference paystub reports Payroll #16 running
  // Aug 9→23 with a deposit on Aug 31. That does NOT fit the ordinary
  // 1-15 / 16-EOM semi-monthly boundary Spectre uses today (§K of the
  // checkpoint report). For a salaried FULL-PERIOD employee the per-
  // period economics are identical regardless of calendar boundary,
  // so the reconciliation runs against Spectre's standard sequence-16
  // semi-monthly period (Aug 16 → Sept 1 with payDate Sept 1). If we
  // seeded an extra 25th period, `periodsPerYear` would become 25 and
  // Sam's per-period salary would drop to $4,400, breaking the
  // structural target of $4,583.33.
}

// -------------------------------------------------------------------
// Fixture setup — Sam Complex mirror.
// -------------------------------------------------------------------
interface SamScenario {
  clubId:      string;
  employeeId:  string;
  payPeriodId: string;
  adminP:      Awaited<ReturnType<typeof principalFor>>;
  paP:         Awaited<ReturnType<typeof principalFor>>;
}

async function seedSamComplexScenario(): Promise<SamScenario> {
  const c = db();
  const sup = await superAdminP();
  await seedCanadaAlbertaPackages2026(sup);
  const club = await makeClub("Sam Complex Recon");
  const admin = await makeUser({ email: `a.${club.id}@t.test`, role: "CLUB_ADMIN", clubId: club.id });
  const pa    = await makeUser({ email: `p.${club.id}@t.test`, role: "PAYROLL_ADMIN", clubId: club.id });
  const ctl   = await makeUser({ email: `c.${club.id}@t.test`, role: "CONTROLLER",    clubId: club.id });
  const adminP = await principalFor(admin.email);
  const paP    = await principalFor(pa.email);
  await upsertPayrollClubConfig(adminP, club.id, {
    provinceOfEmployment: "AB", payrollAdminUserId: pa.id, controllerUserId: ctl.id,
  });

  const emp = await c.employee.create({
    data: {
      clubId: club.id, firstName: "Sam", lastName: "Complex",
      email: `sam.${club.id}@t.test`, hireDate: utc(2020, 1, 1),
      dateOfBirth: utc(1980, 6, 1), status: "ACTIVE",
      employeeNumber: `SAM-${club.id.slice(-4)}`,
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
      clubId: club.id, code: "SAL-SM", name: "Salary Semi-Monthly",
      payFrequency: "SEMI_MONTHLY", payDateOffsetDays: 1,
      calendarAnchorDate: utc(2026, 1, 1), active: true,
    },
  });
  await seedSemiMonthlyCalendar2026(club.id, pg.id);
  // Reconciliation batch runs on the standard sequence-16 period
  // (Aug 16 → Sept 1) — see the calendar seed comment above.
  const pp = await c.payrollPayPeriod.findFirstOrThrow({
    where: { clubId: club.id, payGroupId: pg.id, sequenceInYear: 16 },
  });
  await c.payrollPayGroupMember.create({
    data: { clubId: club.id, payGroupId: pg.id, employeeId: emp.id, effectiveFrom: utc(2020, 1, 1) },
  });

  // Components — same seven as the founder-preview complex fixture.
  async function mkFixed(code: string, section: "EARNINGS" | "BENEFITS" | "DEDUCTIONS",
                         side: "EMPLOYEE" | "EMPLOYER",
                         cashEffect: "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT",
                         category: string, amount: string,
                         taxable = "NONE", cpp = "NONE", ei = "NONE") {
    const comp = await upsertPayrollComponent(adminP, club.id, {
      code, displayName: code, category: category as never, side,
      cashEffect,
      taxableEffect: taxable as never, cppPensionableEffect: cpp as never, eiInsurableEffect: ei as never,
      calculationMethod: "FIXED_AMOUNT",
      statutoryTreatmentSource: "CUSTOM_TEST",
      displaySection: section,
    });
    await createRecurringComponentAssignment(adminP, club.id, {
      employeeId: emp.id, componentId: comp.id, amount, effectiveFrom: utc(2020, 1, 1),
    });
  }
  async function mkPct(code: string, section: "EARNINGS" | "BENEFITS" | "DEDUCTIONS",
                       side: "EMPLOYEE" | "EMPLOYER",
                       cashEffect: "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT",
                       category: string, percentBps: number) {
    const comp = await upsertPayrollComponent(adminP, club.id, {
      code, displayName: code, category: category as never, side,
      cashEffect,
      taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
      calculationMethod: "PERCENT_OF_ELIGIBLE_EARNINGS",
      eligibleEarningsBase: "REGULAR_EARNINGS_ONLY",
      statutoryTreatmentSource: "CUSTOM_TEST",
      displaySection: section,
    });
    await createRecurringComponentAssignment(adminP, club.id, {
      employeeId: emp.id, componentId: comp.id, percentBps, effectiveFrom: utc(2020, 1, 1),
    });
  }
  await mkFixed("CELL_PHONE_ALLOWANCE", "EARNINGS", "EMPLOYEE", "INCREASES_NET_PAY", "ALLOWANCE", "37.50", "ADD", "ADD", "NONE");
  await mkFixed("AD_D_ER_PREMIUM",           "BENEFITS", "EMPLOYER", "NO_NET_PAY_EFFECT", "EMPLOYER_CONTRIBUTION", "2.25");
  await mkFixed("DEPENDENT_LIFE_ER_PREMIUM", "BENEFITS", "EMPLOYER", "NO_NET_PAY_EFFECT", "EMPLOYER_CONTRIBUTION", "0.83");
  await mkFixed("LIFE_INSURANCE_ER_PREMIUM", "BENEFITS", "EMPLOYER", "NO_NET_PAY_EFFECT", "TAXABLE_BENEFIT", "20.93", "ADD", "ADD", "NONE");
  await mkFixed("LTD_EE", "DEDUCTIONS", "EMPLOYEE", "DECREASES_NET_PAY", "EMPLOYEE_DEDUCTION", "28.11");
  await mkPct("RRSP_EE", "DEDUCTIONS", "EMPLOYEE", "DECREASES_NET_PAY", "EMPLOYEE_DEDUCTION", 500);
  await mkPct("RRSP_ER", "BENEFITS",   "EMPLOYER", "NO_NET_PAY_EFFECT", "EMPLOYER_CONTRIBUTION", 500);

  // ---------------- Opening balance (prior YTD, ACTIVE) -----------------
  // The reference paystub is Payroll #16 for the year — some prior YTD
  // state exists. Backsolve prior = displayed YTD − current amount.
  // Some rows (regular salary; RRSP EE/ER) yield NON-integer period
  // counts, an anomaly we call out in the checkpoint report but do
  // NOT reject: the calculator only reads YTD as a Decimal accumulator.
  const priorFields: OpeningBalanceFields = {
    ytdGrossEarnings:       PRIOR_YTD.regularSalary.toFixed(2),
    ytdTaxableEarnings:     PRIOR_YTD.grossTaxable.toFixed(2),
    ytdPensionableEarnings: PRIOR_YTD.regularSalary.toFixed(2),  // best-available proxy; source doesn't display a separate CPP-pensionable YTD
    ytdInsurableEarnings:   PRIOR_YTD.insurable.toFixed(2),
    ytdCppEE_Base:          "0",
    ytdCppEE_FirstAdd:      "0",
    ytdCppEE:               PRIOR_YTD.cpp.toFixed(2),
    ytdCpp2EE:              "0",
    ytdEiEE:                PRIOR_YTD.ei.toFixed(2),
    ytdFederalTax:          PRIOR_YTD.federalTax.toFixed(2),
    ytdProvincialTax:       PRIOR_YTD.provincialTax.toFixed(2),
    ytdCppER_Base:          "0",
    ytdCppER_FirstAdd:      "0",
    ytdCppER:               PRIOR_YTD.cpp.toFixed(2), // employer typically matches employee
    ytdCpp2ER:              "0",
    ytdEiER:                PRIOR_YTD.ei.times(new Decimal("1.4")).toFixed(2),
  };
  const draft = await createDraftOpeningBalance(paP, club.id, {
    employeeId: emp.id, taxYear: 2026, values: priorFields,
    throughPayDate: utc(2026, 8, 15),   // day before the sequence-16 period start (2026-08-16)
    importSource: "MANUAL",
    priorPayrollKind: "PRIOR_SYSTEM_SAME_EMPLOYER",
    notes: "Payroll-3C-3B reconciliation seed — backsolved from source paystub Payroll #16 YTD.",
  });
  await activateOpeningBalance(paP, club.id, draft.id);

  return { clubId: club.id, employeeId: emp.id, payPeriodId: pp.id, adminP, paP };
}

// -------------------------------------------------------------------
// Reconciliation report writer
// -------------------------------------------------------------------
interface ReportRow {
  metric:      string;
  source:      string | null;
  spectre:     string | null;
  difference:  string | null;
  explanation: string;
}

function money(d: Decimal | null | undefined): string {
  return d == null ? "—" : d.toFixed(2);
}
function delta(source: Decimal | null, spectre: Decimal | null): string {
  if (source == null || spectre == null) return "—";
  return spectre.minus(source).toFixed(2);
}

function writeReport(rows: ReportRow[], meta: Record<string, string>) {
  const out = path.resolve("test-results/sam-complex-reconciliation.md");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const lines: string[] = [];
  lines.push("# Sam Complex — Source Paystub Reconciliation");
  lines.push("");
  lines.push("> Payroll-3C-3B (2026-09-08). Synthetic Sam Complex vs the founder-supplied reference paystub.");
  lines.push("> Personal identifiers stripped. Every treatment applied by Spectre in this run is CUSTOM_TEST.");
  lines.push("> No SPECTRE_LIBRARY entries have been added — authoritative Canadian payroll treatments have");
  lines.push("> not been independently verified in this slice.");
  lines.push("");
  lines.push("## Fixture metadata");
  for (const [k, v] of Object.entries(meta)) lines.push(`- **${k}**: ${v}`);
  lines.push("");
  lines.push("## Reconciliation table");
  lines.push("");
  lines.push("| Metric | Source | Spectre | Δ (Spectre − Source) | Explanation |");
  lines.push("|---|---:|---:|---:|---|");
  for (const r of rows) {
    lines.push(`| ${r.metric} | ${r.source ?? "—"} | ${r.spectre ?? "—"} | ${r.difference ?? "—"} | ${r.explanation} |`);
  }
  fs.writeFileSync(out, lines.join("\n") + "\n", "utf8");
  return out;
}

// -------------------------------------------------------------------
// Suite
// -------------------------------------------------------------------
describe("Payroll-3C-3B · Sam Complex source-paystub reconciliation", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("current-period arithmetic reconciles; statutory delta is reported (not force-matched)", async () => {
    const s = await seedSamComplexScenario();
    const prep = await preparePayrollBatch(s.paP, s.clubId, s.payPeriodId);
    await calculatePayrollBatch(s.paP, s.clubId, prep.batchId);
    const be = await db().payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
    const snaps = await db().payrollBatchComponentSnapshot.findMany({ where: { batchId: prep.batchId } });
    const byCode = new Map(snaps.map((snap) => [snap.componentCode, snap]));

    // ---- Pre-statutory arithmetic (assert) ---------------------------
    const cellPhone = new Decimal(byCode.get("CELL_PHONE_ALLOWANCE")!.resolvedAmount!.toString());
    const adAndD    = new Decimal(byCode.get("AD_D_ER_PREMIUM")!.resolvedAmount!.toString());
    const depLife   = new Decimal(byCode.get("DEPENDENT_LIFE_ER_PREMIUM")!.resolvedAmount!.toString());
    const lifeIns   = new Decimal(byCode.get("LIFE_INSURANCE_ER_PREMIUM")!.resolvedAmount!.toString());
    const ltd       = new Decimal(byCode.get("LTD_EE")!.resolvedAmount!.toString());
    const rrspEe    = new Decimal(byCode.get("RRSP_EE")!.resolvedAmount!.toString());
    const rrspEr    = new Decimal(byCode.get("RRSP_ER")!.resolvedAmount!.toString());

    // §13 — RRSP arithmetic identity.
    expect(rrspEe.toFixed(2)).toBe("229.17");
    expect(rrspEr.toFixed(2)).toBe("229.17");
    // §14 — employer benefits total.
    expect(adAndD.plus(depLife).plus(lifeIns).plus(rrspEr).toFixed(2)).toBe("253.18");
    // §15 — employee configured deductions total.
    expect(rrspEe.plus(ltd).toFixed(2)).toBe("257.28");
    // §2 — cash earnings.
    const spectreCash = new Decimal(be.grossPay!.toString());
    expect(spectreCash.toFixed(2)).toBe("4620.83");
    // §2 anti-defect: the source `Gross Taxable Earnings and Benefits`
    // ($4,874.01) equals cash + employer benefits total. Assert that
    // identity holds in the source's arithmetic — a fact independent
    // of any Spectre choice.
    expect(SOURCE.cashEarnings.plus(SOURCE.employerBenefitsTotal).toFixed(2))
      .toBe(SOURCE.displayedGrossTaxable.toFixed(2));

    // ---- Statutory pull-through (RECORD only; no force-match) --------
    // Spectre's CUSTOM_TEST treatment differs from what the source
    // paystub implies. We report the delta so the founder can inspect.
    const spectreTaxable    = new Decimal(be.earningsTaxable!.toString());
    const spectrePensionable = new Decimal(be.earningsPensionable!.toString());
    const spectreInsurable  = new Decimal(be.earningsInsurable!.toString());
    const spectreCpp        = new Decimal(be.deductionCppEeCombined?.toString() ?? "0");
    const spectreCpp2       = new Decimal(be.deductionCpp2Ee?.toString() ?? "0");
    const spectreEi         = new Decimal(be.deductionEiEe?.toString() ?? "0");
    const spectreFed        = new Decimal(be.deductionFederalTax?.toString() ?? "0");
    const spectreProv       = new Decimal(be.deductionProvincialTax?.toString() ?? "0");
    const spectreTotalDed   = new Decimal(be.totalEmployeeDeductions?.toString() ?? "0");
    const spectreNet        = new Decimal(be.netPay?.toString() ?? "0");

    const rows: ReportRow[] = [
      // ---- Cash earnings ----
      { metric: "Regular salary",                source: money(SOURCE.regularSalary),      spectre: "4583.33",              difference: "0.00", explanation: "$110,000 / 24 = $4,583.33 (Decimal, half-up)." },
      { metric: "Cell phone allowance",          source: money(SOURCE.cellPhoneAllowance), spectre: money(cellPhone),        difference: delta(SOURCE.cellPhoneAllowance, cellPhone), explanation: "FIXED_AMOUNT component." },
      { metric: "Cash earnings",                 source: money(SOURCE.cashEarnings),       spectre: money(spectreCash),      difference: delta(SOURCE.cashEarnings, spectreCash), explanation: "Reconciled: regular + cash allowance." },
      // ---- Statutory bases ----
      { metric: "Taxable remuneration",          source: money(SOURCE.displayedGrossTaxable), spectre: money(spectreTaxable), difference: delta(SOURCE.displayedGrossTaxable, spectreTaxable), explanation: "Δ = source − Spectre. Source implies ALL four employer benefit items ($253.18) landed in taxable base. Spectre CUSTOM_TEST currently marks only Cell Phone + Life Insurance as ADD-taxable; AD&D, Dep Life, RRSP ER are NONE. No authoritative CRA verification performed in this slice — treatments remain CUSTOM_TEST." },
      { metric: "CPP pensionable remuneration",  source: null,                              spectre: money(spectrePensionable), difference: null, explanation: "Source does not display a separate CPP pensionable line; cannot compare directly." },
      { metric: "EI insurable remuneration",     source: money(SOURCE.displayedInsurable),  spectre: money(spectreInsurable), difference: delta(SOURCE.displayedInsurable, spectreInsurable), explanation: "Source insurable = regular salary only. Spectre matches when cell phone allowance is EI-non-insurable (current CUSTOM_TEST)." },
      // ---- Employer contributions ----
      { metric: "AD&D",                          source: money(SOURCE.adAndD),        spectre: money(adAndD),  difference: delta(SOURCE.adAndD, adAndD),  explanation: "FIXED_AMOUNT reconciles." },
      { metric: "Dependent Life",                source: money(SOURCE.dependentLife), spectre: money(depLife), difference: delta(SOURCE.dependentLife, depLife), explanation: "FIXED_AMOUNT reconciles." },
      { metric: "Life Insurance (employer)",     source: money(SOURCE.lifeInsurance), spectre: money(lifeIns), difference: delta(SOURCE.lifeInsurance, lifeIns), explanation: "FIXED_AMOUNT reconciles." },
      { metric: "RRSP ER",                       source: money(SOURCE.rrspER),        spectre: money(rrspEr),  difference: delta(SOURCE.rrspER, rrspEr),  explanation: "5% × REGULAR_EARNINGS_ONLY ($4,583.33) = $229.17." },
      { metric: "Employer benefits total",       source: money(SOURCE.employerBenefitsTotal), spectre: money(adAndD.plus(depLife).plus(lifeIns).plus(rrspEr)), difference: delta(SOURCE.employerBenefitsTotal, adAndD.plus(depLife).plus(lifeIns).plus(rrspEr)), explanation: "Reconciled: 2.25 + 0.83 + 20.93 + 229.17 = 253.18." },
      // ---- Employee configured deductions ----
      { metric: "LTD (employee)",                source: money(SOURCE.ltd),           spectre: money(ltd),     difference: delta(SOURCE.ltd, ltd),        explanation: "FIXED_AMOUNT reconciles." },
      { metric: "RRSP EE",                       source: money(SOURCE.rrspEE),        spectre: money(rrspEe),  difference: delta(SOURCE.rrspEE, rrspEe),  explanation: "5% × REGULAR_EARNINGS_ONLY ($4,583.33) = $229.17." },
      { metric: "Employee non-stat deductions",  source: money(SOURCE.ltd.plus(SOURCE.rrspEE)), spectre: money(ltd.plus(rrspEe)), difference: delta(SOURCE.ltd.plus(SOURCE.rrspEE), ltd.plus(rrspEe)), explanation: "Reconciled: $28.11 + $229.17 = $257.28." },
      // ---- Statutory deductions (report only) ----
      { metric: "CPP",                           source: money(SOURCE.cpp),           spectre: money(spectreCpp),  difference: delta(SOURCE.cpp, spectreCpp), explanation: "Not asserted. Depends on verified pensionable remuneration + YTD; opening-balance seed uses source YTD backsolve. Source paystub does not separate CPP2." },
      { metric: "CPP2",                          source: null,                        spectre: money(spectreCpp2), difference: null, explanation: "Source does not display CPP2 separately. Spectre CPP2 shown for transparency; cannot cross-check without source-system data." },
      { metric: "EI",                            source: money(SOURCE.ei),            spectre: money(spectreEi),   difference: delta(SOURCE.ei, spectreEi), explanation: "Not asserted. Depends on insurable remuneration + YTD EI state." },
      { metric: "Federal income tax",            source: money(SOURCE.federalTax),    spectre: money(spectreFed),  difference: delta(SOURCE.federalTax, spectreFed), explanation: "Not asserted. Depends on TD1 claims (source paystub does not disclose), taxable remuneration classification, and YTD state." },
      { metric: "Provincial income tax",         source: money(SOURCE.provincialTax), spectre: money(spectreProv), difference: delta(SOURCE.provincialTax, spectreProv), explanation: "Not asserted (same reasons as federal)." },
      { metric: "Total employee deductions",     source: money(SOURCE.totalDeductions), spectre: money(spectreTotalDed), difference: delta(SOURCE.totalDeductions, spectreTotalDed), explanation: "Not asserted (statutory pieces above)." },
      { metric: "Net pay",                       source: money(SOURCE.net),           spectre: money(spectreNet), difference: delta(SOURCE.net, spectreNet), explanation: "Not asserted (statutory pieces above)." },
    ];

    const outPath = writeReport(rows, {
      "Source Payroll #":         "16",
      "Pay Period":               "09-Aug-2026 → 23-Aug-2026",
      "Date of Deposit":          "31-Aug-2026",
      "Annual Salary":            "$110,000 (Sam Complex synthetic; matches structural target)",
      "Semi-monthly regular":     "$4,583.33 ($110,000 / 24, Decimal half-up)",
      "SPECTRE_LIBRARY entries":  "0 (no authoritative CRA verification in this slice)",
      "Component treatments":     "All CUSTOM_TEST (Spectre-side classification chosen for capability testing, NOT canonical Canadian treatment)",
      "Opening balance":          "ACTIVE, throughPayDate 2026-08-15, prior YTD backsolved from source paystub (displayed − current)",
    });
    // eslint-disable-next-line no-console
    console.log(`\n[Payroll-3C-3B] reconciliation report written: ${outPath}`);
  });
});
