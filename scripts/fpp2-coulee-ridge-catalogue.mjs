// FPP-2 (2026-09-20) — Coulee Ridge PayrollComponent catalogue seed.
//
// Removes the synthetic `3C_ACCEPT_BONUS` (Payroll-3C test contamination)
// after confirming zero references, then seeds the canonical Coulee Ridge
// catalogue.
//
// STATUTORY TREATMENT PROVENANCE (see summary emitted by --status):
//
//   CELL_PHONE_ALLOWANCE       SPECTRE_LIBRARY  CA-TAXABLE-CASH-ALLOWANCE-V1
//   AD_D                       SPECTRE_LIBRARY  CA-ER-AD-AND-D-PREMIUM-V1
//   LIFE_INSURANCE             SPECTRE_LIBRARY  CA-ER-GROUP-LIFE-INSURANCE-PREMIUM-V1
//   DEPENDENT_LIFE_INSURANCE   SPECTRE_LIBRARY  CA-ER-GROUP-DEPENDENT-LIFE-PREMIUM-V1
//   RRSP_ER                    SPECTRE_LIBRARY  CA-ER-GROUP-RRSP-CONTRIBUTION-RESTRICTED-V1 *
//   RRSP_EE                    CUSTOM            (founder review — pre-tax vs post-tax) †
//   LTD                        CUSTOM            (founder review — EE-paid post-tax OR ER-paid) †
//   HEALTH_DENTAL              CUSTOM            (founder review — PHSP jurisdictional) †
//
//   * RRSP_ER default assumes withdrawal-restricted plan (T4130). If the
//     Club's group RRSP allows withdrawal before retirement/termination,
//     switch to CA-ER-GROUP-RRSP-CONTRIBUTION-WITHDRAWABLE-V1 (EI ADD).
//
//   † CUSTOM rows are seeded with SAFE defaults that DO NOT increase any
//     statutory base (taxableEffect=NONE, cppPensionableEffect=NONE,
//     eiInsurableEffect=NONE). Opening YTD entry is not affected by these
//     flags; POSTING requires the founder to review them before the first
//     Spectre payroll. GL mapping is NOT set — the GL readiness evaluator
//     refuses POSTING for any component with a missing required side.
//
// Modes:
//   --status  (default) — read-only report of the catalogue.
//   --apply             — remove the synthetic + seed canonical set.
//                         Idempotent: re-running is safe.
//
// Refuses production, any non-Coulee-Ridge club, and any component
// with existing references (recurring / one-time / opening / benefit /
// snapshot).

const COULEE_CLUB_ID = "cmrvdeny7000144372ktmmg9c";
const COULEE_MARKER = "COULEE";
const SYNTHETIC_CODE = "3C_ACCEPT_BONUS";
const CANONICAL_COMPONENTS = [
  {
    code: "CELL_PHONE_ALLOWANCE",
    displayName: "Cell Phone Allowance",
    description: "Flat taxable cash allowance for cell-phone use. Taxable, CPP-pensionable, EI-insurable.",
    category: "ALLOWANCE",
    side: "EMPLOYEE",
    cashEffect: "INCREASES_NET_PAY",
    taxableEffect: "ADD",
    cppPensionableEffect: "ADD",
    eiInsurableEffect: "ADD",
    statutoryTreatmentSource: "SPECTRE_LIBRARY",
    statutoryRuleKey: "CA-TAXABLE-CASH-ALLOWANCE-V1",
    statutoryRuleVariant: "DEFAULT",
    displaySection: "EARNINGS",
    displayOrder: 30,
  },
  {
    code: "RRSP_EE",
    displayName: "RRSP — Employee",
    description: "Employee RRSP contribution. Statutory treatment CUSTOM — founder must review whether pre-tax (RRSP_DEDUCTED_AT_SOURCE) or post-tax before first POSTING.",
    category: "EMPLOYEE_DEDUCTION",
    side: "EMPLOYEE",
    cashEffect: "DECREASES_NET_PAY",
    taxableEffect: "NONE",
    cppPensionableEffect: "NONE",
    eiInsurableEffect: "NONE",
    statutoryTreatmentSource: "CUSTOM",
    statutoryRuleKey: null,
    statutoryRuleVariant: null,
    displaySection: "DEDUCTIONS",
    displayOrder: 40,
  },
  {
    code: "RRSP_ER",
    displayName: "RRSP — Employer",
    description: "Employer RRSP contribution. Default variant = withdrawal-restricted (T4130 RESTRICTED). Founder must confirm plan withdrawal rules; switch to WITHDRAWABLE if employee may withdraw before retirement/termination.",
    category: "EMPLOYER_CONTRIBUTION",
    side: "EMPLOYER",
    cashEffect: "NO_NET_PAY_EFFECT",
    taxableEffect: "ADD",
    cppPensionableEffect: "ADD",
    eiInsurableEffect: "NONE",
    statutoryTreatmentSource: "SPECTRE_LIBRARY",
    statutoryRuleKey: "CA-ER-GROUP-RRSP-CONTRIBUTION-RESTRICTED-V1",
    statutoryRuleVariant: "RRSP_RESTRICTED_UNTIL_RETIREMENT_OR_TERMINATION",
    displaySection: "BENEFITS",
    displayOrder: 41,
  },
  {
    code: "LTD",
    displayName: "Long Term Disability (LTD)",
    description: "Long Term Disability premium. Statutory treatment CUSTOM — founder must confirm whether EE-paid (post-tax, benefits non-taxable) or ER-paid (taxable benefit) before first POSTING.",
    category: "EMPLOYEE_DEDUCTION",
    side: "EMPLOYEE",
    cashEffect: "DECREASES_NET_PAY",
    taxableEffect: "NONE",
    cppPensionableEffect: "NONE",
    eiInsurableEffect: "NONE",
    statutoryTreatmentSource: "CUSTOM",
    statutoryRuleKey: null,
    statutoryRuleVariant: null,
    displaySection: "DEDUCTIONS",
    displayOrder: 50,
  },
  {
    code: "AD_D",
    displayName: "AD&D",
    description: "Employer-paid Accidental Death & Dismemberment premium. Non-cash taxable benefit. Taxable + CPP-pensionable; not EI-insurable.",
    category: "TAXABLE_BENEFIT",
    side: "EMPLOYER",
    cashEffect: "NO_NET_PAY_EFFECT",
    taxableEffect: "ADD",
    cppPensionableEffect: "ADD",
    eiInsurableEffect: "NONE",
    statutoryTreatmentSource: "SPECTRE_LIBRARY",
    statutoryRuleKey: "CA-ER-AD-AND-D-PREMIUM-V1",
    statutoryRuleVariant: "DEFAULT",
    displaySection: "BENEFITS",
    displayOrder: 60,
  },
  {
    code: "LIFE_INSURANCE",
    displayName: "Life Insurance",
    description: "Employer-paid group Life Insurance premium. Non-cash taxable benefit. Taxable + CPP-pensionable; not EI-insurable.",
    category: "TAXABLE_BENEFIT",
    side: "EMPLOYER",
    cashEffect: "NO_NET_PAY_EFFECT",
    taxableEffect: "ADD",
    cppPensionableEffect: "ADD",
    eiInsurableEffect: "NONE",
    statutoryTreatmentSource: "SPECTRE_LIBRARY",
    statutoryRuleKey: "CA-ER-GROUP-LIFE-INSURANCE-PREMIUM-V1",
    statutoryRuleVariant: "DEFAULT",
    displaySection: "BENEFITS",
    displayOrder: 61,
  },
  {
    code: "DEPENDENT_LIFE_INSURANCE",
    displayName: "Dependent Life Insurance",
    description: "Employer-paid group Dependent Life Insurance premium. Non-cash taxable benefit. Taxable + CPP-pensionable; not EI-insurable.",
    category: "TAXABLE_BENEFIT",
    side: "EMPLOYER",
    cashEffect: "NO_NET_PAY_EFFECT",
    taxableEffect: "ADD",
    cppPensionableEffect: "ADD",
    eiInsurableEffect: "NONE",
    statutoryTreatmentSource: "SPECTRE_LIBRARY",
    statutoryRuleKey: "CA-ER-GROUP-DEPENDENT-LIFE-PREMIUM-V1",
    statutoryRuleVariant: "DEFAULT",
    displaySection: "BENEFITS",
    displayOrder: 62,
  },
  {
    code: "HEALTH_DENTAL",
    displayName: "Health & Dental (Canada Life)",
    description: "Employer-paid Canada Life Health & Dental premium. Statutory treatment CUSTOM — PHSP treatment is jurisdictional (federal: non-taxable; Québec: taxable). Founder must confirm before first POSTING.",
    category: "EMPLOYER_CONTRIBUTION",
    side: "EMPLOYER",
    cashEffect: "NO_NET_PAY_EFFECT",
    taxableEffect: "NONE",
    cppPensionableEffect: "NONE",
    eiInsurableEffect: "NONE",
    statutoryTreatmentSource: "CUSTOM",
    statutoryRuleKey: null,
    statutoryRuleVariant: null,
    displaySection: "BENEFITS",
    displayOrder: 63,
  },
];

const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();

function bail(msg) { console.error(`\n[FPP2-CAT][REFUSE] ${msg}\n`); process.exit(2); }
function log(msg)  { console.log(`[FPP2-CAT] ${msg}`); }

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

async function countRefs(componentId) {
  const [recurring, oneTime, openings, benefitEE, benefitER, snapshots] = await Promise.all([
    p.employeeRecurringPayrollComponent.count({ where: { componentId } }),
    p.payrollScheduledOneTimeEarning.count({ where: { componentId } }),
    p.payrollOpeningBalanceComponent.count({ where: { sourceComponentId: componentId } }),
    p.payrollBenefitPlan.count({ where: { employeeComponentId: componentId } }),
    p.payrollBenefitPlan.count({ where: { employerComponentId: componentId } }),
    p.payrollBatchComponentSnapshot.count({ where: { sourceComponentId: componentId } }),
  ]);
  return { recurring, oneTime, openings, benefitEE, benefitER, snapshots };
}

async function status(club) {
  const rows = await p.payrollComponent.findMany({
    where: { clubId: club.id },
    orderBy: [{ side: "asc" }, { category: "asc" }, { displayName: "asc" }],
  });
  const out = [];
  for (const r of rows) {
    const refs = await countRefs(r.id);
    out.push({
      code: r.code, displayName: r.displayName, category: r.category,
      side: r.side, cashEffect: r.cashEffect, active: r.active,
      taxableEffect: r.taxableEffect,
      cppPensionableEffect: r.cppPensionableEffect,
      eiInsurableEffect: r.eiInsurableEffect,
      statutoryTreatmentSource: r.statutoryTreatmentSource,
      statutoryRuleKey: r.statutoryRuleKey,
      statutoryRuleVariant: r.statutoryRuleVariant,
      calculationMethod: r.calculationMethod,
      displaySection: r.displaySection,
      displayOrder: r.displayOrder,
      refs,
    });
  }
  console.log(JSON.stringify({ club: { id: club.id, name: club.name }, components: out }, null, 2));
}

async function apply(club) {
  const synth = await p.payrollComponent.findFirst({
    where: { clubId: club.id, code: SYNTHETIC_CODE },
    select: { id: true, displayName: true },
  });
  if (synth) {
    const refs = await countRefs(synth.id);
    const total = Object.values(refs).reduce((a, b) => a + b, 0);
    if (total > 0) {
      bail(`Synthetic ${SYNTHETIC_CODE} has ${total} references (${JSON.stringify(refs)}) — refuse to delete.`);
    }
    await p.payrollComponent.delete({ where: { id: synth.id } });
    log(`Removed synthetic ${SYNTHETIC_CODE} (id=${synth.id}, zero references).`);
  } else {
    log(`Synthetic ${SYNTHETIC_CODE} not present. No change.`);
  }
  for (const spec of CANONICAL_COMPONENTS) {
    const existing = await p.payrollComponent.findFirst({
      where: { clubId: club.id, code: spec.code },
      select: { id: true },
    });
    if (existing) {
      log(`Component ${spec.code} already present (id=${existing.id}). No change.`);
      continue;
    }
    const row = await p.payrollComponent.create({
      data: {
        clubId: club.id,
        code: spec.code,
        displayName: spec.displayName,
        description: spec.description,
        category: spec.category,
        side: spec.side,
        cashEffect: spec.cashEffect,
        taxableEffect: spec.taxableEffect,
        cppPensionableEffect: spec.cppPensionableEffect,
        eiInsurableEffect: spec.eiInsurableEffect,
        calculationMethod: "FIXED_AMOUNT",
        statutoryTreatmentSource: spec.statutoryTreatmentSource,
        statutoryRuleKey: spec.statutoryRuleKey,
        statutoryRuleVariant: spec.statutoryRuleVariant,
        displaySection: spec.displaySection,
        displayOrder: spec.displayOrder,
        usage: "BOTH",
        active: true,
      },
    });
    log(`Seeded ${spec.code} (id=${row.id}, source=${spec.statutoryTreatmentSource}${spec.statutoryRuleKey ? ` ${spec.statutoryRuleKey}` : ""}).`);
  }
}

(async () => {
  await assertStagingEnvironment();
  const club = await assertCouleeClub();
  const wantsApply = process.argv.includes("--apply");
  const wantsStatus = process.argv.includes("--status") || !wantsApply;
  if (wantsStatus) await status(club);
  if (wantsApply) await apply(club);
  await p.$disconnect();
})().catch((e) => { console.error(`[FPP2-CAT][ERROR]`, e); process.exit(1); });
