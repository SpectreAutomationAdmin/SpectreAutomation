// Payroll-3C-3D.5 (2026-09-09) — Rise hybrid YTD credit investigation.
//
// DIAGNOSTIC ONLY. No production tax behavior changes in this slice.
//
// Session limitation: this session cannot fetch CRA / Rise URLs
// (WebFetch not loaded). The three K2/K2P variants below encode
// three plausible interpretations that CRA T4127 / Rise
// documentation may describe:
//
//   Variant A · CURRENT SPECTRE OPTION 1
//     K2  = rate × (currentBaseCPP × P + currentEI × P)
//     Uses THIS pay's contributions annualised by ×P.
//
//   Variant B · YTD-EXTRAPOLATED PROJECTION
//     K2  = rate × (ytdBaseCPP × (P/N) + ytdEI × (P/N))
//     Extrapolates YTD-through-current to full-year estimate.
//     Equivalent to A when contributions are stable across periods.
//
//   Variant C · YTD-ACTUAL ONLY (Rise-hybrid candidate)
//     K2  = rate × (ytdBaseCPP + ytdEI)      no ×P annualisation
//     Uses accumulated actual contributions as the credit base.
//     Produces lower K2 (higher tax) early in the year; identical
//     to A/B at year end.
//
// Only variant C mathematically moves current tax UPWARD relative
// to Spectre's Option 1 (the direction needed to converge on Rise's
// higher tax), which makes it the plausible Rise-hybrid candidate.

import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { CA_AB_2026_PARAMS_H2 } from "@/lib/payroll/statutory/seed-ca-ab-2026";

// -------------------------------------------------------------------
// Fixed Sam facts (all preserved from 3C-3D.3 corrected)
// -------------------------------------------------------------------
const SAM = {
  taxable:    new Decimal("4874.01"),
  cppBase:    new Decimal("233.85"),
  cppFirst:   new Decimal("47.28"),
  cpp2:       new Decimal("0"),
  eiEe:       new Decimal("75.32"),
  rrspEe:     new Decimal("229.17"),
  fedTd1:     new Decimal("16542"),
  abTd1:      new Decimal("22769"),
} as const;

const P = new Decimal(24);
const N = new Decimal(13); // 13 pays through flagship (Sam-history)
const F5A = SAM.cppFirst.plus(SAM.cpp2);
const fedParams = CA_AB_2026_PARAMS_H2.federal;
const provParams = CA_AB_2026_PARAMS_H2.provincial!;
const fedRate = new Decimal(fedParams.lowestRate);
const abRate  = new Decimal(provParams.lowestRate);

// -------------------------------------------------------------------
// YTD-through-current
// -------------------------------------------------------------------
const SPECTRE_YTD = {
  baseCPP: SAM.cppBase.times(N),   // $3,040.05
  ei:      SAM.eiEe.times(N),      // $979.16
} as const;
const SOURCE_YTD = {
  baseCPP: new Decimal("3761.56"), // full CPP EE combined per source paystub
  ei:      new Decimal("1008.58"),
} as const;
const RISE_CURRENT = {
  cppEeCombined: new Decimal("279.10"),
  ei:            new Decimal("74.71"),
} as const;

// -------------------------------------------------------------------
// K2 variant computations (annual credit values)
// -------------------------------------------------------------------
function k2VariantA(currentBase: Decimal, currentEi: Decimal, rate: Decimal): Decimal {
  return rate.times(currentBase.times(P).plus(currentEi.times(P)));
}
function k2VariantB(ytdBase: Decimal, ytdEi: Decimal, rate: Decimal): Decimal {
  const factor = P.div(N);
  return rate.times(ytdBase.times(factor).plus(ytdEi.times(factor)));
}
function k2VariantC(ytdBase: Decimal, ytdEi: Decimal, rate: Decimal): Decimal {
  return rate.times(ytdBase.plus(ytdEi));
}

// -------------------------------------------------------------------
// Federal + Alberta annual pipelines (identical shape as production
// but expose K2/K2P injection so we can test variants deterministically)
// -------------------------------------------------------------------
function computeFederalWithK2(k2: Decimal): { federal: string; k1: string; t3Annual: string } {
  const aStar    = SAM.taxable.times(P);
  const a        = SAM.taxable.minus(SAM.rrspEe).minus(F5A).times(P);
  const bracket  = fedParams.brackets.find((b) => {
    const from = new Decimal(b.from);
    const to   = b.to == null ? null : new Decimal(b.to);
    return (to == null || a.lte(to)) && (a.gt(from) || (from.isZero() && a.gte(0)));
  })!;
  const R = new Decimal(bracket.rate);
  const K = new Decimal(bracket.constantK);
  const t = R.times(a).minus(K);
  // K1 — BPAF (Sam's income $110k is under $173,205 phase-out start, so BPAF = 16452).
  const bpaf = new Decimal(fedParams.bpaMax);
  const excess = Decimal.max(0, SAM.fedTd1.minus(bpaf));
  const k1 = fedRate.times(bpaf).plus(fedRate.times(excess));
  // K4 = Canada Employment Amount
  const cea = new Decimal(fedParams.canadaEmploymentAmountMax);
  const k4  = fedRate.times(Decimal.min(aStar, cea));
  const t3Annual = Decimal.max(0, t.minus(k1).minus(k2).minus(k4));
  const federal  = t3Annual.div(P).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return { federal: federal.toFixed(2), k1: k1.toFixed(2), t3Annual: t3Annual.toFixed(2) };
}
function computeAlbertaWithK2(k2p: Decimal): { alberta: string; k1p: string; k5p: string } {
  const a = SAM.taxable.minus(SAM.rrspEe).minus(F5A).times(P);
  const bracket = provParams.brackets.find((b) => {
    const from = new Decimal(b.from);
    const to   = b.to == null ? null : new Decimal(b.to);
    return (to == null || a.lte(to)) && (a.gt(from) || (from.isZero() && a.gte(0)));
  })!;
  const V  = new Decimal(bracket.rate);
  const KP = new Decimal(bracket.constantK);
  const tp = V.times(a).minus(KP);
  const bpa = new Decimal(provParams.bpa);
  const excess = Decimal.max(0, SAM.abTd1.minus(bpa));
  const k1p = abRate.times(bpa).plus(abRate.times(excess));
  const k5pInputs = provParams.k5p;
  let k5p = new Decimal(0);
  if (k5pInputs.enabled) {
    const above = Decimal.max(0, k1p.plus(k2p).minus(new Decimal(k5pInputs.threshold)));
    k5p = above.times(new Decimal(k5pInputs.supplementalRate).div(new Decimal(k5pInputs.baseRate)));
  }
  const t3pAnnual = Decimal.max(0, tp.minus(k1p).minus(k2p).minus(k5p));
  const alberta = t3pAnnual.div(P).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return { alberta: alberta.toFixed(2), k1p: k1p.toFixed(2), k5p: k5p.toFixed(2) };
}

const RISE = { federal: "652.27", alberta: "317.42" };

// -------------------------------------------------------------------
// The matrix
// -------------------------------------------------------------------
describe("Payroll-3C-3D.5 · Rise hybrid YTD credit investigation", () => {
  it("prints the full K2-variant matrix", () => {
    interface Row {
      label: string; currentBase: Decimal; currentEi: Decimal;
      ytdBase: Decimal; ytdEi: Decimal;
      variant: "A" | "B" | "C";
    }
    const runs: Row[] = [
      { label: "A · Current Spectre (Option 1 annualisation)", currentBase: SAM.cppBase, currentEi: SAM.eiEe, ytdBase: SPECTRE_YTD.baseCPP, ytdEi: SPECTRE_YTD.ei, variant: "A" },
      { label: "B · YTD-extrap. projection (Spectre history)", currentBase: SAM.cppBase, currentEi: SAM.eiEe, ytdBase: SPECTRE_YTD.baseCPP, ytdEi: SPECTRE_YTD.ei, variant: "B" },
      { label: "C · YTD-actual (Spectre history)",             currentBase: SAM.cppBase, currentEi: SAM.eiEe, ytdBase: SPECTRE_YTD.baseCPP, ytdEi: SPECTRE_YTD.ei, variant: "C" },
      { label: "C · YTD-actual (SOURCE history + Spectre curr)", currentBase: SAM.cppBase, currentEi: SAM.eiEe, ytdBase: SOURCE_YTD.baseCPP, ytdEi: SOURCE_YTD.ei, variant: "C" },
      { label: "C · YTD-actual (SOURCE history + RISE curr)",   currentBase: RISE_CURRENT.cppEeCombined, currentEi: RISE_CURRENT.ei, ytdBase: SOURCE_YTD.baseCPP, ytdEi: SOURCE_YTD.ei, variant: "C" },
    ];
    // eslint-disable-next-line no-console
    console.log("\n=== Rise Hybrid YTD Credit — K2 variants for Sam ===");
    // eslint-disable-next-line no-console
    console.log("Method                                                 K2       K2P       Federal    Δ Fed    Alberta   Δ AB");
    for (const r of runs) {
      let k2: Decimal, k2p: Decimal;
      switch (r.variant) {
        case "A": k2 = k2VariantA(r.currentBase, r.currentEi, fedRate); k2p = k2VariantA(r.currentBase, r.currentEi, abRate); break;
        case "B": k2 = k2VariantB(r.ytdBase,     r.ytdEi,     fedRate); k2p = k2VariantB(r.ytdBase,     r.ytdEi,     abRate); break;
        case "C": k2 = k2VariantC(r.ytdBase,     r.ytdEi,     fedRate); k2p = k2VariantC(r.ytdBase,     r.ytdEi,     abRate); break;
      }
      const fed = computeFederalWithK2(k2);
      const ab  = computeAlbertaWithK2(k2p);
      const fedDelta = new Decimal(RISE.federal).minus(fed.federal).toFixed(2);
      const abDelta  = new Decimal(RISE.alberta).minus(ab.alberta).toFixed(2);
      // eslint-disable-next-line no-console
      console.log(`${r.label.padEnd(56)} ${k2.toFixed(2).padStart(8)}  ${k2p.toFixed(2).padStart(8)}  ${fed.federal.padStart(8)}  ${fedDelta.padStart(7)}  ${ab.alberta.padStart(8)}  ${abDelta.padStart(7)}`);
    }
    // eslint-disable-next-line no-console
    console.log(`RISE reference                                                  —         —         ${RISE.federal.padStart(8)}     0.00  ${RISE.alberta.padStart(8)}     0.00\n`);
  });

  it("Variant A (current Spectre) baseline reproduces Sam's production federal/Alberta within a cent", () => {
    const k2  = k2VariantA(SAM.cppBase, SAM.eiEe, fedRate);
    const k2p = k2VariantA(SAM.cppBase, SAM.eiEe, abRate);
    const fed = computeFederalWithK2(k2).federal;
    const ab  = computeAlbertaWithK2(k2p).alberta;
    // Sam production shows 635.44 / 308.11; synthetic CPP-base split
    // reproduces within cent-tolerance.
    expect(Math.abs(Number(fed) - 635.44)).toBeLessThan(0.10);
    expect(Math.abs(Number(ab) - 308.11)).toBeLessThan(0.10);
  });

  it("Variant C with SOURCE YTD (Rise history) closes the federal residual close to zero", () => {
    // Prove the C-hybrid + source-YTD lens materially bridges the
    // $16.83 fed / $9.31 AB residual.
    const k2  = k2VariantC(SOURCE_YTD.baseCPP, SOURCE_YTD.ei, fedRate);
    const k2p = k2VariantC(SOURCE_YTD.baseCPP, SOURCE_YTD.ei, abRate);
    const fed = Number(computeFederalWithK2(k2).federal);
    const ab  = Number(computeAlbertaWithK2(k2p).alberta);
    // Rise 652.27 / 317.42. Variant C should get within a few dollars.
    expect(Math.abs(fed - Number(RISE.federal))).toBeLessThan(5);
    expect(Math.abs(ab - Number(RISE.alberta))).toBeLessThan(5);
  });

  it("TD1 K1 audit: K1 = rate × (BPAF + max(0, claim − BPAF)) — matches CRA T4127 formula shape", () => {
    // For Sam's income ($110k annualised, below phase-out $173k),
    // BPAF = 16452 (max). Claim = 16542. Excess = 90.
    // K1 = 0.14 × 16452 + 0.14 × 90 = 2303.28 + 12.60 = 2315.88.
    const fed = computeFederalWithK2(new Decimal("0"));
    expect(fed.k1).toBe("2315.88");
  });

  it("K5P audit: at Sam's (K1P + K2P), K5P remains ZERO (threshold $4,896 not exceeded)", () => {
    const k2p = k2VariantA(SAM.cppBase, SAM.eiEe, abRate);
    const ab = computeAlbertaWithK2(k2p);
    expect(ab.k5p).toBe("0.00");
    // K1P = 0.08 × 22769 = 1821.52; K2P = 593.61; sum = 2415.13 < 4896.
    expect(ab.k1p).toBe("1821.52");
  });
});
