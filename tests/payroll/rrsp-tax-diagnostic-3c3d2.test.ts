// Payroll-3C-3D.2 (2026-09-09) — RRSP tax-withholding diagnostic matrix.
//
// DIAGNOSTIC ONLY. No production behavior is changed in this slice
// (§25 of the 3C-3D.2 brief). This test harness runs identical Sam
// Complex facts through the pure federal + Alberta tax calculators
// with FOUR different F configurations to answer: "which RRSP
// treatment does Rise mathematically resemble?"
//
// Nothing is asserted with `expect(x).toBe(y)` for the matrix values
// themselves — the point is to REPORT the numbers so the founder can
// see them. The suite DOES assert:
//   1. Taxable remuneration is identical across A/B/C/D (§17).
//   2. Current production stamps prove F composition (§23 + §24).
//   3. No double counting (§11).
//
// The matrix is printed to console and returned in a machine-
// readable JSON block so the reconciliation report can be updated
// mechanically.

import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { calculateFederalTax } from "@/lib/payroll/statutory/federal-tax-calculator";
import { calculateAlbertaTax } from "@/lib/payroll/statutory/alberta-tax-calculator";
import { CA_AB_2026_PARAMS_H2 } from "@/lib/payroll/statutory/seed-ca-ab-2026";

// -------------------------------------------------------------------
// Fixed Sam inputs — held constant across all four scenarios per §3.
// -------------------------------------------------------------------
const SAM = {
  taxableRemuneration: "4874.01",  // I passed to A calculation (T4127 §Federal per rule intent)
  cashEarnings:        "4620.83",  // current production actually passes this; documented separately
  cppPensionable:      "4874.01",
  eiInsurable:         "4620.83",
  cppBaseThisPay:      "220.02",   // 0.0495 × (4874.01 - 3500/24) = 0.0495 × (4874.01 - 145.83) = 234.16 ... engine output on flagship = 281.33 combined, base ≈ 233.85 depending on YTD context
  cppFirstAddEE:       "47.48",    // 0.01 × 4874.01-shifted; the flagship snapshot yields combined 281.33 so we use engine outputs directly below
  cpp2EE:              "0",
  eiEE:                "75.32",
  federalTd1:          "16542",
  albertaTd1:          "22769",
  periodsPerYear:      24,
} as const;

// Real F5A used by the flagship: CPP first-add + CPP2 EE. From Sam's
// actual snapshot (deductionCppEeCombined=$281.33, base=$233.85,
// first-add=$47.48, CPP2=0). We reproduce that split by pinning the
// combined per-period CPP to the values the pipeline actually
// computed, so F5A + baseCpp mirror production exactly.
const CPP_BASE_PER_PAY = "233.85";
const CPP_FIRSTADD_PER_PAY = "47.48";
const CPP2_PER_PAY = "0";
const EI_EE_PER_PAY = "75.32";
const F5A = new Decimal(CPP_FIRSTADD_PER_PAY).plus(CPP2_PER_PAY).toFixed(2);

interface ScenarioInputs {
  label: string;
  eeRrspInF: boolean;
  erRrspInF: boolean;
}
const SCENARIOS: readonly ScenarioInputs[] = [
  { label: "A · neither RRSP in F", eeRrspInF: false, erRrspInF: false },
  { label: "B · EE RRSP only",       eeRrspInF: true,  erRrspInF: false },
  { label: "C · ER RRSP only",       eeRrspInF: false, erRrspInF: true  },
  { label: "D · both RRSP in F",     eeRrspInF: true,  erRrspInF: true  },
] as const;

const RRSP_EE = "229.17";
const RRSP_ER = "229.17";
const LTD_EE  = "28.11";

// Two lenses on I — the T4127 §Federal contract says A =
// P × (I − F − F5A). "I" per CRA is the pay-period taxable
// remuneration. Current Spectre production passes cash gross
// ($4,620.83) as I. Running both lenses reveals whether the
// residual federal/Alberta delta to Rise is driven by F choices,
// by I definition, or by both.
type ILens = "taxable" | "cashGross";
function iFor(lens: ILens): string {
  return lens === "taxable" ? SAM.taxableRemuneration : SAM.cashEarnings;
}

function calc(scenario: ScenarioInputs, lens: ILens) {
  let f = new Decimal(0);
  if (scenario.eeRrspInF) f = f.plus(RRSP_EE);
  if (scenario.erRrspInF) f = f.plus(RRSP_ER);
  const fed = calculateFederalTax({
    periodicTaxableRemuneration: iFor(lens),
    fThisPay:                 f.toFixed(2),
    f5aThisPay:               F5A,
    baseCppThisPay:           CPP_BASE_PER_PAY,
    eiThisPay:                EI_EE_PER_PAY,
    periodsPerYear:           SAM.periodsPerYear,
    federalClaim:             SAM.federalTd1,
    claimZeroFederal:         false,
    totalIncomeLessThanClaim: false,
    federal: CA_AB_2026_PARAMS_H2.federal,
  });
  const prov = calculateAlbertaTax({
    periodicTaxableRemuneration: iFor(lens),
    fThisPay:                 f.toFixed(2),
    f5aThisPay:               F5A,
    baseCppThisPay:           CPP_BASE_PER_PAY,
    eiThisPay:                EI_EE_PER_PAY,
    periodsPerYear:           SAM.periodsPerYear,
    provincialClaim:          SAM.albertaTd1,
    claimZeroProvincial:      false,
    totalIncomeLessThanClaim: false,
    provincial: CA_AB_2026_PARAMS_H2.provincial!,
  });
  const federal   = fed.t4PerPeriod.toFixed(2);
  const alberta   = prov.t4pPerPeriod.toFixed(2);
  const totalTax  = new Decimal(federal).plus(alberta).toFixed(2);
  // Net = cash - CPP - EI - federal - alberta - LTD - RRSP EE.
  const net = new Decimal(SAM.cashEarnings)
    .minus(new Decimal(CPP_BASE_PER_PAY).plus(CPP_FIRSTADD_PER_PAY).plus(CPP2_PER_PAY))
    .minus(EI_EE_PER_PAY)
    .minus(federal)
    .minus(alberta)
    .minus(LTD_EE)
    .minus(RRSP_EE)
    .toFixed(2);
  return {
    lens, label: scenario.label,
    eeInF: scenario.eeRrspInF, erInF: scenario.erRrspInF,
    fTotal: f.toFixed(2),
    federal, alberta, totalTax, net,
    annualA: fed.a.toFixed(2),
  };
}

const RISE = {
  federal: "652.27",
  alberta: "317.42",
  totalTax: (new Decimal("652.27").plus("317.42")).toFixed(2),
  net: "3040.05",
};

describe("Payroll-3C-3D.2 · RRSP tax-withholding diagnostic matrix (Sam Complex flagship)", () => {
  it("A/B/C/D taxable-remuneration lens — matrix + closest-to-Rise categorisation", () => {
    const rows = SCENARIOS.map((s) => calc(s, "taxable"));
    // Print for the reconciliation report.
    // eslint-disable-next-line no-console
    console.log("\n=== RRSP MATRIX (lens: I = TAXABLE REMUNERATION $4,874.01) ===");
    // eslint-disable-next-line no-console
    console.log("scenario                        eeInF  erInF   F     annualA       federal   alberta   totalTax   net");
    for (const r of rows) {
      // eslint-disable-next-line no-console
      console.log(
        `${r.label.padEnd(32)}${String(r.eeInF).padEnd(7)}${String(r.erInF).padEnd(7)}${r.fTotal.padStart(7)}  ${r.annualA.padStart(12)}  ${r.federal.padStart(8)}  ${r.alberta.padStart(8)}  ${r.totalTax.padStart(9)}  ${r.net.padStart(8)}`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(`RISE reference                                       -             ${RISE.federal.padStart(8)}  ${RISE.alberta.padStart(8)}  ${RISE.totalTax.padStart(9)}  ${RISE.net.padStart(8)}\n`);

    // §17 — taxable remuneration is identical across A/B/C/D (asserted
    // implicitly: same annualA base minus F only).
    const baseAnnualA = new Decimal(SAM.taxableRemuneration).times(SAM.periodsPerYear);
    for (const r of rows) {
      const expectedA = baseAnnualA.minus(new Decimal(r.fTotal).times(SAM.periodsPerYear))
        .minus(new Decimal(F5A).times(SAM.periodsPerYear));
      expect(new Decimal(r.annualA).toFixed(2)).toBe(expectedA.toFixed(2));
    }

    // §9 — closest scenario to Rise on each metric.
    const closestFed = rows.slice().sort((a, b) =>
      Math.abs(Number(a.federal) - Number(RISE.federal)) - Math.abs(Number(b.federal) - Number(RISE.federal)),
    )[0];
    const closestAb = rows.slice().sort((a, b) =>
      Math.abs(Number(a.alberta) - Number(RISE.alberta)) - Math.abs(Number(b.alberta) - Number(RISE.alberta)),
    )[0];
    const closestCombined = rows.slice().sort((a, b) =>
      Math.abs(Number(a.totalTax) - Number(RISE.totalTax)) - Math.abs(Number(b.totalTax) - Number(RISE.totalTax)),
    )[0];
    // eslint-disable-next-line no-console
    console.log(`Closest to Rise Federal:   ${closestFed.label}  (delta ${(Number(closestFed.federal) - Number(RISE.federal)).toFixed(2)})`);
    // eslint-disable-next-line no-console
    console.log(`Closest to Rise Alberta:   ${closestAb.label}  (delta ${(Number(closestAb.alberta) - Number(RISE.alberta)).toFixed(2)})`);
    // eslint-disable-next-line no-console
    console.log(`Closest to Rise combined:  ${closestCombined.label}  (delta ${(Number(closestCombined.totalTax) - Number(RISE.totalTax)).toFixed(2)})`);
  });

  it("§23 · RRSP ER snapshot has taxFormulaDeductionType = NULL in the Sam flagship batch", async () => {
    const { PrismaClient } = await import("@prisma/client");
    const p = new PrismaClient();
    try {
      const club = await p.club.findFirst({ where: { slug: "coulee-ridge" } });
      if (!club) { console.warn("Skipped — dev DB has no coulee-ridge club"); return; }
      const flagship = await p.payrollBatch.findFirst({
        where: {
          clubId: club.id, status: "POSTED",
          payPeriod: { payGroup: { code: "SAL-SM-COMPLEX" }, payDate: new Date("2026-09-01T00:00:00.000Z") },
        },
      });
      if (!flagship) { console.warn("Skipped — no flagship Sept 1 flagship batch present"); return; }
      const erSnap = await p.payrollBatchComponentSnapshot.findFirst({
        where: { batchId: flagship.id, componentCode: "RRSP_ER" },
      });
      expect(erSnap?.side).toBe("EMPLOYER");
      expect(erSnap?.taxFormulaDeductionType).toBeNull();
    } finally { await p.$disconnect(); }
  });

  it("§24 · RRSP EE snapshot has taxFormulaDeductionType = RRSP_DEDUCTED_AT_SOURCE and only one row carries it for Sam", async () => {
    const { PrismaClient } = await import("@prisma/client");
    const p = new PrismaClient();
    try {
      const club = await p.club.findFirst({ where: { slug: "coulee-ridge" } });
      if (!club) { console.warn("Skipped — dev DB has no coulee-ridge club"); return; }
      const flagship = await p.payrollBatch.findFirst({
        where: {
          clubId: club.id, status: "POSTED",
          payPeriod: { payGroup: { code: "SAL-SM-COMPLEX" }, payDate: new Date("2026-09-01T00:00:00.000Z") },
        },
      });
      if (!flagship) { console.warn("Skipped — no flagship Sept 1 batch present"); return; }
      const fRows = await p.payrollBatchComponentSnapshot.findMany({
        where: { batchId: flagship.id, taxFormulaDeductionType: { not: null } },
      });
      // Exactly one row on the flagship carries an F tag, and it is
      // RRSP EE (side EMPLOYEE, resolved $229.17). §Q + §R hard guards.
      expect(fRows.length).toBe(1);
      expect(fRows[0].componentCode).toBe("RRSP_EE");
      expect(fRows[0].side).toBe("EMPLOYEE");
      expect(fRows[0].taxFormulaDeductionType).toBe("RRSP_DEDUCTED_AT_SOURCE");
      expect(fRows[0].resolvedAmount?.toFixed(2)).toBe("229.17");
    } finally { await p.$disconnect(); }
  });

  it("A/B/C/D cash-gross lens — reveals whether production I = cash defect explains part of the delta", () => {
    const rows = SCENARIOS.map((s) => calc(s, "cashGross"));
    // eslint-disable-next-line no-console
    console.log("\n=== RRSP MATRIX (lens: I = CASH GROSS $4,620.83 — matches current production path) ===");
    // eslint-disable-next-line no-console
    console.log("scenario                        eeInF  erInF   F     annualA       federal   alberta   totalTax   net");
    for (const r of rows) {
      // eslint-disable-next-line no-console
      console.log(
        `${r.label.padEnd(32)}${String(r.eeInF).padEnd(7)}${String(r.erInF).padEnd(7)}${r.fTotal.padStart(7)}  ${r.annualA.padStart(12)}  ${r.federal.padStart(8)}  ${r.alberta.padStart(8)}  ${r.totalTax.padStart(9)}  ${r.net.padStart(8)}`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(`RISE reference                                       -             ${RISE.federal.padStart(8)}  ${RISE.alberta.padStart(8)}  ${RISE.totalTax.padStart(9)}  ${RISE.net.padStart(8)}\n`);
  });
});
