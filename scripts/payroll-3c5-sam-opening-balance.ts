// Payroll-3C-5 (2026-09-09) — Sam Complex per-Component opening YTD
// fixture.
//
// Seeds an ACTIVE PayrollOpeningBalance for Sam Complex (Coulee Ridge)
// for tax-year 2026 with a `throughPayDate` set to 2026-08-31 (so the
// September 2026 pay period is the FIRST Spectre-posted pay period
// that contributes to YTD).
//
// Per-Component opening amounts mirror the source-reconciliation
// paystub structure (§10 of the 3C-5 brief). All numbers are
// synthetic and are not derived from any real employee.
//
// Idempotent — safe to rerun. Emits the openingBalance ID on stdout.
//
// Preconditions:
//   • `npm run fixture:payroll-founder-preview`
//   • `npm run fixture:payroll-3c1-components`

import { loadEnvFiles } from "./_lib/load-env";
loadEnvFiles();

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const COMPLEX_EMAIL = "complex.pay@preview.spectre.test";
const TAX_YEAR = 2026;

// Per-Component prior-YTD contributions. Every entry maps to a
// Sam-Complex catalogue component seeded by
// scripts/payroll-founder-preview-components.ts.
const COMPONENT_OPENING: Array<{
  code: string; displayName: string;
  category: string; side: "EMPLOYEE" | "EMPLOYER";
  cashEffect: "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT";
  ytdAmount: string;
}> = [
  { code: "CELL_PHONE_ALLOWANCE",       displayName: "Cell Phone Allowance",         category: "ALLOWANCE",             side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY", ytdAmount: "468.75" },
  { code: "AD_D_ER_PREMIUM",            displayName: "AD&D ER Premium",              category: "EMPLOYER_CONTRIBUTION", side: "EMPLOYER", cashEffect: "NO_NET_PAY_EFFECT", ytdAmount: "24.75"  },
  { code: "DEPENDENT_LIFE_ER_PREMIUM",  displayName: "Dependent Life ER",            category: "EMPLOYER_CONTRIBUTION", side: "EMPLOYER", cashEffect: "NO_NET_PAY_EFFECT", ytdAmount: "9.65"   },
  { code: "LIFE_INSURANCE_ER_PREMIUM",  displayName: "Life Insurance ER Premium",    category: "TAXABLE_BENEFIT",       side: "EMPLOYER", cashEffect: "NO_NET_PAY_EFFECT", ytdAmount: "233.23" },
  { code: "RRSP_ER",                    displayName: "RRSP Employer",                category: "EMPLOYER_CONTRIBUTION", side: "EMPLOYER", cashEffect: "NO_NET_PAY_EFFECT", ytdAmount: "2864.62"},
  { code: "RRSP_EE",                    displayName: "RRSP Employee",                category: "EMPLOYEE_DEDUCTION",    side: "EMPLOYEE", cashEffect: "DECREASES_NET_PAY", ytdAmount: "2864.62"},
  { code: "LTD_EE",                     displayName: "LTD Employee",                 category: "EMPLOYEE_DEDUCTION",    side: "EMPLOYEE", cashEffect: "DECREASES_NET_PAY", ytdAmount: "323.31" },
];

async function main() {
  const club = await prisma.club.findFirstOrThrow({ where: { slug: "coulee-ridge" } });
  const emp = await prisma.employee.findFirstOrThrow({
    where: { clubId: club.id, email: COMPLEX_EMAIL },
  });

  // Locate or create the ACTIVE opening balance for 2026. Use the
  // canonical model shape from src/lib/payroll/opening-balance.ts —
  // status ACTIVE + throughPayDate = 2026-08-31.
  const throughPayDate = new Date(Date.UTC(2026, 7, 31)); // Aug 31, 2026
  let ob = await prisma.payrollOpeningBalance.findFirst({
    where: { clubId: club.id, employeeId: emp.id, taxYear: TAX_YEAR, status: "ACTIVE" },
  });

  const openingFields = {
    // Coarse YTD numbers derived from the source paystub structure:
    // 12 prior semi-monthly regular payrolls at $4,583.33 = $54,999.96
    // plus $37.50 cell phone × 12 = $450 → but the source paystub
    // shows regular YTD = $61,874.96 which reflects a slightly
    // different rounding path. We honor the source structural target
    // and let the aggregator lay Spectre-posted rows on top.
    ytdGrossEarnings:       "62343.71",  // 61874.96 (regular) + 468.75 (cell)
    ytdTaxableEarnings:     "62576.94",  // + life insurance TB
    ytdPensionableEarnings: "62576.94",
    ytdInsurableEarnings:   "61874.96",  // cell + life not insurable
    // Payroll-3C-3D §37 — surface the statutory YTD opening values
    // supplied by the founder's source-reconciliation paystub so the
    // 3C-5 pay statement no longer shows $0 CPP/EI/tax YTD when a
    // valid opening balance exists. Combined-CPP mirrors the base
    // total (base + first-additional split not exposed by the source).
    ytdCppEE_Base:          "3482.46",
    ytdCppEE_FirstAdd:      "0",
    ytdCppEE:               "3482.46",
    ytdCpp2EE:              "0",
    ytdEiEE:                "933.87",
    ytdFederalTax:          "8018.59",
    ytdProvincialTax:       "3902.68",
    ytdCppER_Base:          "3482.46",
    ytdCppER_FirstAdd:      "0",
    ytdCppER:               "3482.46",
    ytdCpp2ER:              "0",
    ytdEiER:                "1307.42",
  };

  if (!ob) {
    ob = await prisma.payrollOpeningBalance.create({
      data: {
        clubId: club.id, employeeId: emp.id, taxYear: TAX_YEAR,
        status: "ACTIVE", throughPayDate,
        activatedAt: new Date(),
        importSource: "MANUAL", importedAt: new Date(),
        priorPayrollKind: "PRIOR_SYSTEM_SAME_EMPLOYER",
        notes: "Payroll-3C-5 fixture — Sam Complex source-reconciliation opening YTD (synthetic).",
        ...openingFields,
      },
    });
  } else {
    ob = await prisma.payrollOpeningBalance.update({
      where: { id: ob.id },
      data: { throughPayDate, ...openingFields },
    });
  }

  // Per-Component opening YTD rows. Look up sourceComponentId by
  // (clubId, code) so historical rows link to the current catalogue.
  let created = 0, updated = 0;
  for (const c of COMPONENT_OPENING) {
    const comp = await prisma.payrollComponent.findFirst({
      where: { clubId: club.id, code: c.code },
      select: { id: true },
    });
    const existing = await prisma.payrollOpeningBalanceComponent.findFirst({
      where: { openingBalanceId: ob.id, componentCode: c.code },
    });
    if (existing) {
      await prisma.payrollOpeningBalanceComponent.update({
        where: { id: existing.id },
        data: {
          sourceComponentId: comp?.id ?? null,
          displayName: c.displayName, category: c.category,
          side: c.side, cashEffect: c.cashEffect,
          ytdAmount: c.ytdAmount,
        },
      });
      updated += 1;
    } else {
      await prisma.payrollOpeningBalanceComponent.create({
        data: {
          clubId: club.id, openingBalanceId: ob.id,
          sourceComponentId: comp?.id ?? null,
          componentCode: c.code, displayName: c.displayName,
          category: c.category, side: c.side, cashEffect: c.cashEffect,
          ytdAmount: c.ytdAmount,
        },
      });
      created += 1;
    }
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    openingBalanceId: ob.id,
    employeeEmail: COMPLEX_EMAIL,
    throughPayDate: ob.throughPayDate?.toISOString(),
    componentsCreated: created,
    componentsUpdated: updated,
  }));
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
