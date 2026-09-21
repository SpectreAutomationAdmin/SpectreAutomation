// FPP-5A (2026-09-20) — Set RRSP_EE.taxFormulaDeductionType = RRSP_DEDUCTED_AT_SOURCE.
//
// Chris's Coulee Ridge RRSP arrangement is a payroll-deducted employee
// RRSP contribution (5% election with 100% match capped at 5% of
// eligible earnings). CRA T4127 factor F applies to employee RRSP
// contributions deducted directly through payroll when the employer
// has reasonable grounds to believe the contribution is deductible.
// Factor F reduces the taxable remuneration used in the income-tax
// withholding formula.
//
// FPP-2 seeded RRSP_EE with taxFormulaDeductionType = null, flagged for
// founder review. This corrects it at the CATALOGUE level for all
// future Prepare snapshots. Existing PayrollBatchComponentSnapshot rows
// are IMMUTABLE (Payroll-3C-2 §31) and unchanged — the founder's
// CALCULATED Sep 15 batch will keep its frozen null flag until the
// founder Returns-to-Preparation and re-Prepares.
//
// Modes:
//   --status  (default) — read-only report of current + planned state.
//   --apply             — set taxFormulaDeductionType = RRSP_DEDUCTED_AT_SOURCE
//                         on RRSP_EE only. Every other field unchanged.
//
// Refuses production, non-Coulee clubs, and any conflicting flag state.

const COULEE_CLUB_ID = "cmrvdeny7000144372ktmmg9c";
const COULEE_MARKER = "COULEE";
const CODE = "RRSP_EE";
const TARGET_TFDT = "RRSP_DEDUCTED_AT_SOURCE";

const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();

function bail(msg) { console.error(`\n[FPP5A][REFUSE] ${msg}\n`); process.exit(2); }
function log(msg)  { console.log(`[FPP5A] ${msg}`); }

async function assertStagingEnvironment() {
  const bypass = process.argv.includes("--i-know-this-is-staging");
  const env = process.env.SPECTRE_ENV ?? "";
  if (!bypass && env !== "staging") {
    bail(`SPECTRE_ENV="${env}" — refuse. Pass --i-know-this-is-staging inside spectre-staging.`);
  }
  const flyApp = process.env.FLY_APP_NAME ?? "";
  if (flyApp && flyApp !== "spectre-staging") bail(`FLY_APP_NAME="${flyApp}" — refuse.`);
}

async function assertCouleeClub() {
  const club = await p.club.findUnique({ where: { id: COULEE_CLUB_ID }, select: { id: true, name: true } });
  if (!club) bail(`Coulee Ridge club ${COULEE_CLUB_ID} not found.`);
  if (!club.name.toUpperCase().includes(COULEE_MARKER)) bail(`Club name "${club.name}" lacks marker.`);
  return club;
}

async function loadTarget() {
  const row = await p.payrollComponent.findFirst({
    where: { clubId: COULEE_CLUB_ID, code: CODE },
  });
  if (!row) bail(`RRSP_EE not found on Coulee Ridge.`);
  return row;
}

function summarise(c) {
  return {
    id: c.id, code: c.code, displayName: c.displayName,
    side: c.side, category: c.category, cashEffect: c.cashEffect,
    calculationMethod: c.calculationMethod, eligibleEarningsBase: c.eligibleEarningsBase,
    taxableEffect: c.taxableEffect, cppPensionableEffect: c.cppPensionableEffect,
    eiInsurableEffect: c.eiInsurableEffect,
    statutoryTreatmentSource: c.statutoryTreatmentSource,
    taxFormulaDeductionType: c.taxFormulaDeductionType,
    active: c.active,
  };
}

async function status(club) {
  const row = await loadTarget();
  const openings = await p.payrollOpeningBalanceComponent.count({
    where: { sourceComponentId: row.id },
  });
  const snapshots = await p.payrollBatchComponentSnapshot.count({
    where: { sourceComponentId: row.id },
  });
  const assignments = await p.employeeRecurringPayrollComponent.count({
    where: { componentId: row.id },
  });
  console.log(JSON.stringify({
    club: { id: club.id, name: club.name },
    before: summarise(row),
    intended: { ...summarise(row), taxFormulaDeductionType: TARGET_TFDT },
    references: { openings, snapshots, recurringAssignments: assignments },
    idempotent: row.taxFormulaDeductionType === TARGET_TFDT,
  }, null, 2));
}

async function apply(club) {
  const before = await loadTarget();
  if (before.taxFormulaDeductionType === TARGET_TFDT) {
    log(`RRSP_EE already carries taxFormulaDeductionType=${TARGET_TFDT}. No change.`);
    return;
  }
  if (before.taxFormulaDeductionType != null) {
    bail(`RRSP_EE has taxFormulaDeductionType="${before.taxFormulaDeductionType}" — refuse to overwrite a non-null non-target value.`);
  }
  await p.payrollComponent.update({
    where: { id: before.id },
    data: { taxFormulaDeductionType: TARGET_TFDT },
  });
  log(`Set RRSP_EE (id=${before.id}) taxFormulaDeductionType: null → ${TARGET_TFDT}`);
  const after = await loadTarget();
  console.log(JSON.stringify({ before: summarise(before), after: summarise(after) }, null, 2));
}

(async () => {
  await assertStagingEnvironment();
  const club = await assertCouleeClub();
  const wantsApply = process.argv.includes("--apply");
  const wantsStatus = process.argv.includes("--status") || !wantsApply;
  if (wantsStatus) await status(club);
  if (wantsApply) await apply(club);
  await p.$disconnect();
})().catch((e) => { console.error(`[FPP5A][ERROR]`, e); process.exit(1); });
