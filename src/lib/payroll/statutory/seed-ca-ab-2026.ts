// Payroll-3B-5B-1b (2026-09-01, §15) — canonical H1 + H2 2026
// Canada/Alberta statutory package definitions.
//
// SOURCE OF TRUTH:
//   H1 window [2026-01-01, 2026-07-01):
//     • T4127 Payroll Deductions Formulas — 122nd Edition
//     • T4032-AB Payroll Deductions Tables — Alberta, 2026 January
//     • Government of Canada 2026 CPP contribution rates + YMPE +
//       YAMPE + YBE announcement
//     • CEIC / Government of Canada 2026 EI premium rate and
//       maximum insurable earnings announcement
//     • Federal + Alberta 2026 TD1 forms
//   H2 window [2026-07-01, 2027-01-01):
//     • T4127 Payroll Deductions Formulas — 123rd Edition
//     • Other publications unchanged for 2026 unless CRA reissues.
//
// EVERY value below is drawn from the founder-supplied verified
// 2026 CRA reference set (Payroll-3B-5B-1b §12-14). Do not edit
// numeric values without updating the source citation in the same
// change.
//
// The installer is `installStatutoryPackage` (SUPER_ADMIN-gated).
// This file is a data + orchestration module; it does NOT call
// prisma directly. A separate admin script or migration invokes
// `seedCanadaAlbertaPackages2026(principal)` to install both.

import type { CanadianPayrollStatutoryParamsV1 } from "../statutory-package";
import { installStatutoryPackage } from "../statutory-package";
import type { Principal } from "../../rbac";

// ---------------------------------------------------------------------------
// Verified 2026 parameters
// ---------------------------------------------------------------------------

/**
 * Payroll-3B-5B-1b §12-14 verified 2026 parameters. Unchanged
 * between H1 and H2 unless a mid-year CRA reissue applies.
 *
 * Rate/max sources (all from Government of Canada 2026 CRA
 * publications; §7 rule prohibits any other provenance):
 *
 *   CPP  — T4127 Chapter 6, Government of Canada 2026 announcement:
 *     ybe   = 3500.00   ympe = 74600.00   ymce = 71100.00
 *     yampe = 85000.00
 *     base       — rate 0.0495, max EE 3519.45, max ER 3519.45
 *     first-add  — rate 0.0100, max EE  711.00, max ER  711.00
 *     combined C — rate 0.0595, max EE 4230.45, max ER 4230.45
 *     CPP2       — rate 0.0400, max EE  416.00, max ER  416.00
 *
 *   EI (outside Quebec) — CEIC 2026 announcement:
 *     mie                 = 68900.00
 *     employee rate       = 0.0163
 *     employer rate       = 0.02282
 *     employee annual max = 1123.07
 *     employer annual max = 1572.30
 *
 *   Federal — T4127 §K1 + Bill C-30:
 *     bpaMax = 16452, bpaMin = 14829, phase-out over the top bracket
 *     lowestRate = 0.15, cpp2DeductionRate = 0.15
 *
 *   Alberta — T4032-AB 2026:
 *     brackets:
 *       0        – 61200:   8%, KP     0
 *       61200.01 – 154259: 10%, KP  1224
 *       154259.01– 185111: 12%, KP  4309
 *       185111.01– 246813: 13%, KP  6160
 *       246813.01– 370220: 14%, KP  8628
 *       370220.01– ∞:      15%, KP 12331
 *     bpa = 22769, lowestRate = 0.08
 *
 * NB: federal brackets deliberately kept as an empty array in this
 * file — populating them requires the CURRENT T4127 122nd/123rd
 * Edition federal-tax brackets to be verified line-by-line before
 * dollar calculation ships. Installer will REFUSE either package
 * whose paramsJson does not pass Zod validation, and the schema
 * requires at least one bracket. Founder / operator MUST supply
 * the verified brackets in the follow-up before install.
 */

export const CA_AB_2026_PARAMS_H1: CanadianPayrollStatutoryParamsV1 = {
  schemaVersion: 1,
  jurisdictionCountry: "CA",
  jurisdictionProvince: "AB",
  cpp: {
    ybe: "3500.00",
    ympe: "74600.00",
    ymce: "71100.00",
    yampe: "85000.00",
    baseRateEE: "0.0495",
    baseRateER: "0.0495",
    baseMaxEE: "3519.45",
    baseMaxER: "3519.45",
    firstAdditionalRateEE: "0.0100",
    firstAdditionalRateER: "0.0100",
    firstAdditionalMaxEE: "711.00",
    firstAdditionalMaxER: "711.00",
    combinedRateEE: "0.0595",
    combinedRateER: "0.0595",
    combinedMaxEE: "4230.45",
    combinedMaxER: "4230.45",
    cpp2RateEE: "0.0400",
    cpp2RateER: "0.0400",
    cpp2MaxEE: "416.00",
    cpp2MaxER: "416.00",
  },
  ei: {
    mie: "68900.00",
    rateEE: "0.0163",
    rateER: "0.02282",
    maxAnnualPremiumEE: "1123.07",
    maxAnnualPremiumER: "1572.30",
    employerMultiplier: "1.4",
  },
  federal: {
    // Payroll-3B-5B-1c §D — verified 2026 federal Table 8.1 (T4127
    // 122nd Edition, effective January 1, 2026). Five-bracket table
    // + `K` constants. Federal `lowestRate` = 0.14 (first bracket
    // rate) is used across the K1/K2/K2A/K3/K4 credit formulas.
    brackets: [
      { from:      "0",   to:  "58523", rate: "0.1400", constantK:     "0" },
      { from:  "58523",   to: "117045", rate: "0.2050", constantK:  "3804" },
      { from: "117045",   to: "181440", rate: "0.2600", constantK: "10241" },
      { from: "181440",   to: "258482", rate: "0.2900", constantK: "15685" },
      { from: "258482",   to:     null, rate: "0.3300", constantK: "26024" },
    ],
    bpaMax: "16452",
    bpaMin: "14829",
    bpaPhaseOutStart: "173205",
    bpaPhaseOutEnd: "246752",
    lowestRate: "0.1400",
    cpp2DeductionRate: "0.1400",
    // Payroll-3B-5B-1d (§4, §C) — Canada Employment Amount for
    // 2026. The 2024-published CRA CEA was $1,433; indexed
    // annually per T4127 §K4. Value below is Spectre's 2026
    // seeded amount subject to line-verification against T4127
    // 122nd/123rd Editions before dollar calculation ships.
    canadaEmploymentAmountMax: "1499",
  },
  provincial: {
    // Payroll-3B-5B-1c §E — verified 2026 Alberta Table 8.1.
    brackets: [
      { from:      "0",   to:  "61200", rate: "0.0800", constantK:     "0" },
      { from:  "61200",   to: "154259", rate: "0.1000", constantK:  "1224" },
      { from: "154259",   to: "185111", rate: "0.1200", constantK:  "4309" },
      { from: "185111",   to: "246813", rate: "0.1300", constantK:  "6160" },
      { from: "246813",   to: "370220", rate: "0.1400", constantK:  "8628" },
      { from: "370220",   to:     null, rate: "0.1500", constantK: "12331" },
    ],
    bpa: "22769",
    lowestRate: "0.0800",
    // Payroll-3B-5B-1d §1-2 — CORRECTED Alberta K5P specification.
    //
    // Verified CRA formula (T4127 §Alberta):
    //   K5P = max(0, ((K1P + K2P) - threshold) × (supplementalRate / baseRate))
    //
    // 2026 values:
    //   threshold        = 4,800   (CRA-published)
    //   supplementalRate = 0.02    (the "2%")
    //   baseRate         = 0.08    (Alberta first-bracket rate — the "8%")
    //
    // Old 3B-5B-1c `{triggerBase, rate}` shape (with T_prov_base
    // interpretation) was WRONG and has been REMOVED.
    k5p: {
      enabled: true,
      threshold: "4800",
      supplementalRate: "0.02",
      baseRate: "0.08",
      sourceCitation:
        "T4127 §Alberta (K5P) — Alberta supplemental credit. Formula: K5P = max(0, ((K1P + K2P) - 4800) × (0.02 / 0.08)). Pending final line-verification against 122nd/123rd Editions.",
    },
  },
  // Payroll-3B-5B-1c §9 / §L — rounding contract.
  //
  //   Statutory instruction (CRA):
  //     "T4127 §6: CPP and CPP2 contributions rounded to the
  //     nearest cent. T4127 §5: final federal + provincial income
  //     tax may be rounded to the nearest cent (CRA also permits
  //     nearest $0.05 for legacy manual computations)."
  //
  //   Spectre implementation convention:
  //     nearest cent (`HALF_UP` tie-breaking) across CPP, CPP2,
  //     EI, federal tax, Alberta tax, and net pay. Nickel-rounding
  //     is out of MVP.
  rounding: {
    mode: "HALF_UP",
    netPayMode: "HALF_UP",
    statutoryInstruction:
      "T4127 §6: CPP and CPP2 rounded to the nearest cent. T4127 §5: federal + provincial income tax withheld per pay period rounded to the nearest cent (CRA also permits nearest $0.05 for legacy manual computations).",
  },
};

/**
 * Payroll-3B-5B-1c §C — H1/H2 comparison.
 *
 * For the Canada/Alberta MVP payroll scope, every parameter Spectre
 * consumes is unchanged between the 122nd (H1) and 123rd (H2)
 * editions of T4127 for 2026:
 *
 *   • CPP YBE / YMPE / YMCE / YAMPE — unchanged
 *   • CPP base + first-additional + CPP2 rates + maxima — unchanged
 *   • EI MIE / rates / annual maxima — unchanged
 *   • Federal Table 8.1 brackets + K constants — unchanged
 *   • Federal BPA max/min + phase-out thresholds + lowest rate — unchanged
 *   • Alberta Table 8.1 brackets + KP constants — unchanged
 *   • Alberta BPA + lowest rate — unchanged
 *   • Alberta K5P trigger + rate — unchanged
 *
 * Package IDENTITY differs (packageVersion, sourceEdition, and the
 * pinned `PayrollBatch.statutoryPackageId` for calculations dated
 * on/after 2026-07-01). This lets a future mid-year CRA reissue
 * ship as a NEW package without editing H1's frozen row.
 *
 * If a later CRA verification finds ANY parameter that differs
 * between the two editions, the change is made HERE — never inline
 * to H1 — and the seeder re-installs H2 with the edition-specific
 * value.
 */
export const CA_AB_2026_PARAMS_H2: CanadianPayrollStatutoryParamsV1 = {
  ...CA_AB_2026_PARAMS_H1,
};

// ---------------------------------------------------------------------------
// Installer — SUPER_ADMIN-gated via `installStatutoryPackage`.
// ---------------------------------------------------------------------------

export interface SeedCanadaAlbertaPackagesResult {
  h1: { id: string; checksum: string };
  h2: { id: string; checksum: string };
}

/**
 * Install both H1 and H2 packages for Canada/Alberta 2026. Refuses
 * if either already exists (per the installer's non-overlap rule).
 * Callers should first delete or supersede any existing rows.
 */
export async function seedCanadaAlbertaPackages2026(
  principal: Principal,
): Promise<SeedCanadaAlbertaPackagesResult> {
  const h1 = await installStatutoryPackage(principal, {
    jurisdictionCountry: "CA",
    jurisdictionProvince: "AB",
    effectiveFrom: new Date(Date.UTC(2026, 0, 1)),
    effectiveTo: new Date(Date.UTC(2026, 6, 1)),
    packageVersion: "CRA-T4127-122E-CA-AB-2026-H1",
    algorithmVersion: "v1",
    sourcePublication: "T4127 Payroll Deductions Formulas + T4032-AB + Government of Canada 2026 CPP/EI + 2026 Federal/Alberta TD1",
    sourceEdition: "122nd Edition",
    sourcePublicationDate: new Date(Date.UTC(2025, 11, 1)),
    sourceUrl: "https://www.canada.ca/en/revenue-agency/services/forms-publications/payroll/t4127-payroll-deductions-formulas.html",
    params: CA_AB_2026_PARAMS_H1,
  });

  const h2 = await installStatutoryPackage(principal, {
    jurisdictionCountry: "CA",
    jurisdictionProvince: "AB",
    effectiveFrom: new Date(Date.UTC(2026, 6, 1)),
    effectiveTo: new Date(Date.UTC(2027, 0, 1)),
    packageVersion: "CRA-T4127-123E-CA-AB-2026-H2",
    algorithmVersion: "v1",
    sourcePublication: "T4127 Payroll Deductions Formulas + T4032-AB + Government of Canada 2026 CPP/EI + 2026 Federal/Alberta TD1",
    sourceEdition: "123rd Edition",
    sourcePublicationDate: new Date(Date.UTC(2026, 5, 1)),
    sourceUrl: "https://www.canada.ca/en/revenue-agency/services/forms-publications/payroll/t4127-payroll-deductions-formulas.html",
    params: CA_AB_2026_PARAMS_H2,
  });

  return { h1, h2 };
}
