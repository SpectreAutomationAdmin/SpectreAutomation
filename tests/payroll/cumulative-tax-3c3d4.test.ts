// Payroll-3C-3D.4 (2026-09-09) — Rise cumulative-averaging investigation.
//
// DIAGNOSTIC ONLY — no production tax behavior changes.
//
// Session limitation: this session cannot fetch CRA / Rise URLs
// directly. The cumulative harness is coded per the standard T4127
// §Chapter 5 formula shape as documented in Spectre's existing
// package + the 3C-3D.4 brief. A live-verification pass MUST run
// before any production adoption.

import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { calculateFederalTax, type FederalTaxInput } from "@/lib/payroll/statutory/federal-tax-calculator";
import { calculateAlbertaTax, type AlbertaTaxInput } from "@/lib/payroll/statutory/alberta-tax-calculator";
import { calculateCumulativeFederalTax, calculateCumulativeAlbertaTax } from "@/lib/payroll/statutory/cumulative-tax-diagnostic";
import { CA_AB_2026_PARAMS_H1, CA_AB_2026_PARAMS_H2 } from "@/lib/payroll/statutory/seed-ca-ab-2026";

// --- Sam current-period fixed inputs -------------------------------
const SAM = {
  taxable:         "4874.01",
  cash:            "4620.83",
  cppPensionable:  "4874.01",
  eiInsurable:     "4620.83",
  cppBase:         "233.85",
  cppFirstAdd:     "47.28",
  cpp2:            "0",
  eiEe:            "75.32",
  rrspEe:          "229.17",
  ltdEe:           "28.11",
  federalTd1:      "16542",
  albertaTd1:      "22769",
} as const;

const P = 24;
const F5A_PER_PAY = new Decimal(SAM.cppFirstAdd).plus(SAM.cpp2).toFixed(2);

const RISE = { federal: "652.27", alberta: "317.42" };

// --- Spectre-history YTD through pay 13 (inclusive) ----------------
const SPECTRE_YTD = {
  taxable:    (new Decimal(SAM.taxable).times(13)).toFixed(2),      // 63,362.13
  f:          (new Decimal(SAM.rrspEe).times(13)).toFixed(2),        // 2,979.21
  f5a:        (new Decimal(F5A_PER_PAY).times(13)).toFixed(2),       // 614.64
  baseCpp:    (new Decimal(SAM.cppBase).times(13)).toFixed(2),       // 3,040.05
  ei:         (new Decimal(SAM.eiEe).times(13)).toFixed(2),          // 979.16
  priorFedT:  (new Decimal("635.44").times(12)).toFixed(2),          // 7,625.28
  priorAbT:   (new Decimal("308.11").times(12)).toFixed(2),          // 3,697.32
} as const;

// --- Source YTD (Rise reference) through pay 13 (inclusive) --------
const SOURCE_YTD = {
  taxable:    "65766.64",
  cash:       "62381.21",
  cppEe:      "3761.56",
  eiEe:       "1008.58",
  federalWH:  "8670.86",
  albertaWH:  "4220.10",
  rrspEe:     "3093.79",
  // Prior (source YTD − source current):
  priorFedT:  (new Decimal("8670.86").minus("652.27")).toFixed(2),   // 8,018.59
  priorAbT:   (new Decimal("4220.10").minus("317.42")).toFixed(2),   // 3,902.68
  priorCppEe: (new Decimal("3761.56").minus("279.10")).toFixed(2),   // 3,482.46
  priorEiEe:  (new Decimal("1008.58").minus("74.71")).toFixed(2),    // 933.87
} as const;

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------
function fedOption1(td1Federal: string = SAM.federalTd1): string {
  const r = calculateFederalTax({
    periodicTaxableRemuneration: SAM.taxable,
    fThisPay:                    SAM.rrspEe,
    f5aThisPay:                  F5A_PER_PAY,
    baseCppThisPay:              SAM.cppBase,
    eiThisPay:                   SAM.eiEe,
    periodsPerYear:              P,
    federalClaim:                td1Federal,
    claimZeroFederal:            false,
    totalIncomeLessThanClaim:    false,
    federal:                     CA_AB_2026_PARAMS_H2.federal,
  } as FederalTaxInput);
  return r.t4PerPeriod.toFixed(2);
}
function abOption1(): string {
  const r = calculateAlbertaTax({
    periodicTaxableRemuneration: SAM.taxable,
    fThisPay:                    SAM.rrspEe,
    f5aThisPay:                  F5A_PER_PAY,
    baseCppThisPay:              SAM.cppBase,
    eiThisPay:                   SAM.eiEe,
    periodsPerYear:              P,
    provincialClaim:             SAM.albertaTd1,
    claimZeroProvincial:         false,
    totalIncomeLessThanClaim:    false,
    provincial:                  CA_AB_2026_PARAMS_H2.provincial!,
  } as AlbertaTaxInput);
  return r.t4pPerPeriod.toFixed(2);
}

// -------------------------------------------------------------------
// A · Statutory package edition audit (§15-18)
// -------------------------------------------------------------------
describe("Payroll-3C-3D.4 · T4127 edition-by-pay-date audit", () => {
  it("H1 (122E) and H2 (123E) params are numerically identical for 2026 → zero engine delta", () => {
    // Deep-compare federal + provincial fields we consume.
    const feds = ["brackets", "lowestRate", "bpaMax", "bpaMin", "bpaPhaseOutStart", "bpaPhaseOutEnd", "canadaEmploymentAmountMax"] as const;
    for (const k of feds) {
      expect(JSON.stringify(CA_AB_2026_PARAMS_H1.federal[k])).toBe(JSON.stringify(CA_AB_2026_PARAMS_H2.federal[k]));
    }
    const provs = ["brackets", "lowestRate", "bpa", "k5p"] as const;
    for (const k of provs) {
      expect(JSON.stringify(CA_AB_2026_PARAMS_H1.provincial![k])).toBe(JSON.stringify(CA_AB_2026_PARAMS_H2.provincial![k]));
    }
  });

  it("resolveStatutoryPackage picks 123E for a Sept 1 2026 pay date (runtime check)", async () => {
    const { PrismaClient } = await import("@prisma/client");
    const p = new PrismaClient();
    try {
      const club = await p.club.findFirst({ where: { slug: "coulee-ridge" } });
      if (!club) { console.warn("Skipped — no coulee-ridge in dev DB"); return; }
      const flagship = await p.payrollBatch.findFirst({
        where: {
          clubId: club.id, status: "POSTED",
          payPeriod: { payGroup: { code: "SAL-SM-COMPLEX" }, payDate: new Date("2026-09-01T00:00:00.000Z") },
        },
      });
      if (!flagship?.statutoryPackageId) { console.warn("Skipped — no flagship batch"); return; }
      const pkg = await p.payrollStatutoryPackage.findUnique({ where: { id: flagship.statutoryPackageId } });
      expect(pkg?.sourceEdition).toBe("123rd Edition");
      expect(pkg?.effectiveFrom.toISOString()).toBe("2026-07-01T00:00:00.000Z");
      expect(pkg?.effectiveTo?.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    } finally { await p.$disconnect(); }
  });
});

// -------------------------------------------------------------------
// B · CRA Option 1 baseline (current Spectre production)
// -------------------------------------------------------------------
describe("Payroll-3C-3D.4 · Option 1 baseline (with corrected I)", () => {
  it("Sam Option 1 Federal ≈ $635.44 / Alberta ≈ $308.11 (within cent of engine)", () => {
    // Synthetic CPP-base split in this harness produces $635.47 fed /
    // $308.13 AB; production engine (which computes CPP base itself)
    // shows $635.44 / $308.11. Within cent-tolerance either way.
    const fed = Number(fedOption1());
    const ab  = Number(abOption1());
    expect(Math.abs(fed - 635.44)).toBeLessThan(0.10);
    expect(Math.abs(ab  - 308.11)).toBeLessThan(0.10);
  });
});

// -------------------------------------------------------------------
// C · TD1 $90 anomaly quantification (§21)
// -------------------------------------------------------------------
describe("Payroll-3C-3D.4 · Federal TD1 $16,542 vs $16,452 anomaly", () => {
  it("switching TD1 from 16,542 to 16,452 changes per-period federal tax by $0.53", () => {
    const withEntered = new Decimal(fedOption1("16542"));
    const withPrinted = new Decimal(fedOption1("16452"));
    // K1_annual differs by 0.14 × ($90) = $12.60 annual = $0.525/pay.
    // Higher TD1 → higher credit → lower tax. So printed (lower TD1) → higher tax.
    expect(withPrinted.minus(withEntered).toFixed(2)).toBe("0.52");
  });
});

// -------------------------------------------------------------------
// D · Cumulative averaging — Spectre history
// -------------------------------------------------------------------
describe("Payroll-3C-3D.4 · CRA Option 2 cumulative averaging — Spectre history", () => {
  it("Sam cumulative Federal + Alberta with 13-period Spectre YTD", () => {
    const fed = calculateCumulativeFederalTax({
      ytdTaxableThroughCurrent: SPECTRE_YTD.taxable,
      ytdFThroughCurrent:       SPECTRE_YTD.f,
      ytdF5AThroughCurrent:     SPECTRE_YTD.f5a,
      ytdBaseCppThroughCurrent: SPECTRE_YTD.baseCpp,
      ytdEiThroughCurrent:      SPECTRE_YTD.ei,
      nPayPeriodsThroughCurrent: 13,
      periodsPerYear:           P,
      priorYtdFederalWithheld:  SPECTRE_YTD.priorFedT,
      federalClaim:             SAM.federalTd1,
      claimZeroFederal:         false,
      totalIncomeLessThanClaim: false,
      federal:                  CA_AB_2026_PARAMS_H2.federal,
    });
    const ab = calculateCumulativeAlbertaTax({
      ytdTaxableThroughCurrent: SPECTRE_YTD.taxable,
      ytdFThroughCurrent:       SPECTRE_YTD.f,
      ytdF5AThroughCurrent:     SPECTRE_YTD.f5a,
      ytdBaseCppThroughCurrent: SPECTRE_YTD.baseCpp,
      ytdEiThroughCurrent:      SPECTRE_YTD.ei,
      nPayPeriodsThroughCurrent: 13,
      periodsPerYear:           P,
      priorYtdProvincialWithheld: SPECTRE_YTD.priorAbT,
      provincialClaim:          SAM.albertaTd1,
      claimZeroProvincial:      false,
      totalIncomeLessThanClaim: false,
      provincial:               CA_AB_2026_PARAMS_H2.provincial!,
    });
    // eslint-disable-next-line no-console
    console.log("\n=== Cumulative — Spectre 13-period history ===");
    // eslint-disable-next-line no-console
    console.log(`  Federal: ${fed.currentPeriodT.toFixed(2)}  (Rise ${RISE.federal}, delta ${new Decimal(RISE.federal).minus(fed.currentPeriodT).toFixed(2)})`);
    // eslint-disable-next-line no-console
    console.log(`  Alberta: ${ab.currentPeriodTp.toFixed(2)}  (Rise ${RISE.alberta}, delta ${new Decimal(RISE.alberta).minus(ab.currentPeriodTp).toFixed(2)})`);
    // Cumulative on stable Spectre history should converge close to Option 1.
    // Assert it doesn't produce a wildly different result (sanity).
    expect(Math.abs(Number(fed.currentPeriodT) - 635.44)).toBeLessThan(5);
    expect(Math.abs(Number(ab.currentPeriodTp) - 308.11)).toBeLessThan(5);
  });
});

// -------------------------------------------------------------------
// E · Cumulative averaging — source (Rise) prior YTD
// -------------------------------------------------------------------
describe("Payroll-3C-3D.4 · CRA Option 2 cumulative averaging — source-derived prior YTD", () => {
  it("Sam cumulative with source prior YTD — does it materially close the $16.83 / $9.31 residual?", () => {
    const fed = calculateCumulativeFederalTax({
      ytdTaxableThroughCurrent: SOURCE_YTD.taxable,     // $65,766.64
      ytdFThroughCurrent:       SOURCE_YTD.rrspEe,       // $3,093.79
      ytdF5AThroughCurrent:     SPECTRE_YTD.f5a,         // unchanged assumption
      ytdBaseCppThroughCurrent: SOURCE_YTD.cppEe,        // $3,761.56
      ytdEiThroughCurrent:      SOURCE_YTD.eiEe,         // $1,008.58
      nPayPeriodsThroughCurrent: 13,
      periodsPerYear:           P,
      priorYtdFederalWithheld:  SOURCE_YTD.priorFedT,    // $8,018.59
      federalClaim:             SAM.federalTd1,
      claimZeroFederal:         false,
      totalIncomeLessThanClaim: false,
      federal:                  CA_AB_2026_PARAMS_H2.federal,
    });
    const ab = calculateCumulativeAlbertaTax({
      ytdTaxableThroughCurrent: SOURCE_YTD.taxable,
      ytdFThroughCurrent:       SOURCE_YTD.rrspEe,
      ytdF5AThroughCurrent:     SPECTRE_YTD.f5a,
      ytdBaseCppThroughCurrent: SOURCE_YTD.cppEe,
      ytdEiThroughCurrent:      SOURCE_YTD.eiEe,
      nPayPeriodsThroughCurrent: 13,
      periodsPerYear:           P,
      priorYtdProvincialWithheld: SOURCE_YTD.priorAbT,
      provincialClaim:          SAM.albertaTd1,
      claimZeroProvincial:      false,
      totalIncomeLessThanClaim: false,
      provincial:               CA_AB_2026_PARAMS_H2.provincial!,
    });
    const fedDelta = new Decimal(RISE.federal).minus(fed.currentPeriodT).toFixed(2);
    const abDelta  = new Decimal(RISE.alberta).minus(ab.currentPeriodTp).toFixed(2);
    // eslint-disable-next-line no-console
    console.log("\n=== Cumulative — SOURCE (Rise) prior YTD ===");
    // eslint-disable-next-line no-console
    console.log(`  Federal: ${fed.currentPeriodT.toFixed(2)}  (Rise ${RISE.federal}, delta ${fedDelta})`);
    // eslint-disable-next-line no-console
    console.log(`  Alberta: ${ab.currentPeriodTp.toFixed(2)}  (Rise ${RISE.alberta}, delta ${abDelta})`);
    // Sanity: cumulative with source YTD should be non-negative and finite.
    expect(fed.currentPeriodT.gte(0)).toBe(true);
    expect(ab.currentPeriodTp.gte(0)).toBe(true);
  });
});

// -------------------------------------------------------------------
// F · Full comparison matrix (§13)
// -------------------------------------------------------------------
describe("Payroll-3C-3D.4 · Comparison matrix", () => {
  it("prints matrix: Option 1 vs cumulative-Spectre vs cumulative-source vs Rise", () => {
    // eslint-disable-next-line no-console
    console.log("\n=== Comparison Matrix ===");
    // eslint-disable-next-line no-console
    console.log("Method                                Federal    Δ vs Rise   Alberta    Δ vs Rise");
    const rows = [
      { label: "Spectre current Option 1",    fed: fedOption1(),                          ab: abOption1() },
      { label: "CRA cumulative — Spectre YTD", fed: cumSpectreFed(),                       ab: cumSpectreAb() },
      { label: "CRA cumulative — source YTD",  fed: cumSourceFed(),                        ab: cumSourceAb() },
      { label: "Rise reference",               fed: RISE.federal,                          ab: RISE.alberta },
    ];
    for (const r of rows) {
      const fedD = new Decimal(RISE.federal).minus(r.fed).toFixed(2);
      const abD  = new Decimal(RISE.alberta).minus(r.ab).toFixed(2);
      // eslint-disable-next-line no-console
      console.log(`${r.label.padEnd(37)} ${r.fed.padStart(8)}   ${fedD.padStart(8)}   ${r.ab.padStart(8)}   ${abD.padStart(8)}`);
    }
  });
});

function cumSpectreFed(): string {
  return calculateCumulativeFederalTax({
    ytdTaxableThroughCurrent: SPECTRE_YTD.taxable,
    ytdFThroughCurrent: SPECTRE_YTD.f, ytdF5AThroughCurrent: SPECTRE_YTD.f5a,
    ytdBaseCppThroughCurrent: SPECTRE_YTD.baseCpp, ytdEiThroughCurrent: SPECTRE_YTD.ei,
    nPayPeriodsThroughCurrent: 13, periodsPerYear: P,
    priorYtdFederalWithheld: SPECTRE_YTD.priorFedT,
    federalClaim: SAM.federalTd1, claimZeroFederal: false, totalIncomeLessThanClaim: false,
    federal: CA_AB_2026_PARAMS_H2.federal,
  }).currentPeriodT.toFixed(2);
}
function cumSpectreAb(): string {
  return calculateCumulativeAlbertaTax({
    ytdTaxableThroughCurrent: SPECTRE_YTD.taxable,
    ytdFThroughCurrent: SPECTRE_YTD.f, ytdF5AThroughCurrent: SPECTRE_YTD.f5a,
    ytdBaseCppThroughCurrent: SPECTRE_YTD.baseCpp, ytdEiThroughCurrent: SPECTRE_YTD.ei,
    nPayPeriodsThroughCurrent: 13, periodsPerYear: P,
    priorYtdProvincialWithheld: SPECTRE_YTD.priorAbT,
    provincialClaim: SAM.albertaTd1, claimZeroProvincial: false, totalIncomeLessThanClaim: false,
    provincial: CA_AB_2026_PARAMS_H2.provincial!,
  }).currentPeriodTp.toFixed(2);
}
function cumSourceFed(): string {
  return calculateCumulativeFederalTax({
    ytdTaxableThroughCurrent: SOURCE_YTD.taxable,
    ytdFThroughCurrent: SOURCE_YTD.rrspEe, ytdF5AThroughCurrent: SPECTRE_YTD.f5a,
    ytdBaseCppThroughCurrent: SOURCE_YTD.cppEe, ytdEiThroughCurrent: SOURCE_YTD.eiEe,
    nPayPeriodsThroughCurrent: 13, periodsPerYear: P,
    priorYtdFederalWithheld: SOURCE_YTD.priorFedT,
    federalClaim: SAM.federalTd1, claimZeroFederal: false, totalIncomeLessThanClaim: false,
    federal: CA_AB_2026_PARAMS_H2.federal,
  }).currentPeriodT.toFixed(2);
}
function cumSourceAb(): string {
  return calculateCumulativeAlbertaTax({
    ytdTaxableThroughCurrent: SOURCE_YTD.taxable,
    ytdFThroughCurrent: SOURCE_YTD.rrspEe, ytdF5AThroughCurrent: SPECTRE_YTD.f5a,
    ytdBaseCppThroughCurrent: SOURCE_YTD.cppEe, ytdEiThroughCurrent: SOURCE_YTD.eiEe,
    nPayPeriodsThroughCurrent: 13, periodsPerYear: P,
    priorYtdProvincialWithheld: SOURCE_YTD.priorAbT,
    provincialClaim: SAM.albertaTd1, claimZeroProvincial: false, totalIncomeLessThanClaim: false,
    provincial: CA_AB_2026_PARAMS_H2.provincial!,
  }).currentPeriodTp.toFixed(2);
}
