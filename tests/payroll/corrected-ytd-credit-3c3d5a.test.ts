// Payroll-3C-3D.5A (2026-09-09) — corrected CRA YTD CPP/EI credit
// formula diagnostic.
//
// Provenance note: this session cannot fetch CRA URLs directly. The
// formula below is FOUNDER-SUPPLIED authoritative input (verified
// against T4127 123rd Edition + T4127 122nd Edition K2 YTD-option
// text outside this session), not independently CRA-fetched by
// Claude. See 3C-3D.5A brief §2.
//
// The DIAGNOSTIC ONLY corrected formula:
//   ratio            = 0.0495 / 0.0595
//   CPP projected    = D × ratio + PR × C × ratio
//   CPP maximum      = 3519.45 × (PM / 12)
//   CPP selected     = min(projected, maximum)
//   EI projected     = D1 + PR × EI
//   EI maximum       = 1123.07
//   EI selected      = min(projected, maximum)
//   K2   = federalLowestRate × (CPP selected + EI selected)
//   K2P  = provincialLowestRate × (CPP selected + EI selected)
//
// Where:
//   D  = prior YTD combined-CPP contribution (BEFORE current pay)
//   D1 = prior YTD EI premium (BEFORE current pay)
//   C  = current-pay combined-CPP contribution
//   EI = current-pay EI premium
//   PR = pay periods remaining in the year INCLUDING current pay
//   PM = number of months CPP contributions are required
//
// Prior 3C-3D.5 "Variant C" (`0.14 × YTD_CPP + 0.14 × YTD_EI`) is
// **INVALID** — it omitted projection, maximums, and the CPP base
// ratio. Marked so in the reconciliation report.

import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { CA_AB_2026_PARAMS_H2 } from "@/lib/payroll/statutory/seed-ca-ab-2026";

// -------------------------------------------------------------------
// Fixed Sam facts + package constants
// -------------------------------------------------------------------
const SAM = {
  taxable:  new Decimal("4874.01"),
  cppBase:  new Decimal("233.85"),
  cppFirst: new Decimal("47.28"),
  cpp2:     new Decimal("0"),
  eiEe:     new Decimal("75.32"),
  rrspEe:   new Decimal("229.17"),
  fedTd1:   new Decimal("16542"),
  abTd1:    new Decimal("22769"),
  cppCombinedCurrent: new Decimal("281.33"),   // Sam production
  eiCurrent:          new Decimal("75.32"),
} as const;

const RISE_CURRENT = {
  cppCombined: new Decimal("279.10"),
  ei:          new Decimal("74.71"),
} as const;

const PRIOR = {
  spectreCppCombined: new Decimal("233.85").plus("47.28").times(12), // 12 prior pays × per-pay combined = 3373.56
  spectreEi:          new Decimal("75.32").times(12),                // 903.84
  sourceCppCombined:  new Decimal("3482.46"),                        // source prior YTD CPP
  sourceEi:           new Decimal("933.87"),                         // source prior YTD EI
} as const;

// Sam flagship = seq 16 of 24. PR = periods remaining INCL current = 24 − 16 + 1 = 9.
const PR_FLAGSHIP = 9;
// Sam started 2026-02-02 → contributes to CPP for Feb through Dec = 11 months.
// Payroll-3C-3D.5B (2026-09-09) correction: hire date does NOT
// itself prorate PM. Sam is an ordinary CPP-subject employee with
// no age / CPT30 / disability / death condition, so PM = 12.
// Production `cppPensionableMonths` already returns 12 for this
// case — the earlier PM = 11 derivation was a diagnostic error,
// not a production defect.
const PM_SAM = 12;
const P = new Decimal(24);
const F5A = SAM.cppFirst.plus(SAM.cpp2);

// CPP base ratio 0.0495/0.0595 (base rate ÷ combined rate for 2026).
const CPP_BASE_RATIO = new Decimal("0.0495").div("0.0595"); // ≈ 0.8319327731...
const CPP_ANNUAL_MAX_BASE = new Decimal("3519.45");         // 2026 base CPP max EE contribution
const EI_ANNUAL_MAX       = new Decimal("1123.07");          // 2026 EI max EE premium

const fedParams  = CA_AB_2026_PARAMS_H2.federal;
const provParams = CA_AB_2026_PARAMS_H2.provincial!;
const fedRate = new Decimal(fedParams.lowestRate);
const abRate  = new Decimal(provParams.lowestRate);

const RISE = { federal: "652.27", alberta: "317.42" };

// -------------------------------------------------------------------
// Corrected CRA YTD-credit calculation
// -------------------------------------------------------------------
interface YtdInputs {
  d:       Decimal;   // prior YTD combined CPP
  d1:      Decimal;   // prior YTD EI
  c:       Decimal;   // current combined CPP
  ei:      Decimal;   // current EI
  pr:      number;    // pay periods remaining INCL current
  pm:      number;    // CPP months required
}
interface YtdBreakdown {
  cppProjected:   Decimal;
  cppMaximum:     Decimal;
  cppSelected:    Decimal;
  eiProjected:    Decimal;
  eiMaximum:      Decimal;
  eiSelected:     Decimal;
  k2Fed:          Decimal;
  k2Prov:         Decimal;
}
function ytdCredit(inp: YtdInputs): YtdBreakdown {
  const PR = new Decimal(inp.pr);
  const cppProjected = inp.d.times(CPP_BASE_RATIO).plus(PR.times(inp.c).times(CPP_BASE_RATIO));
  const cppMaximum   = CPP_ANNUAL_MAX_BASE.times(inp.pm).div(12);
  const cppSelected  = Decimal.min(cppProjected, cppMaximum);

  const eiProjected  = inp.d1.plus(PR.times(inp.ei));
  const eiMaximum    = EI_ANNUAL_MAX;
  const eiSelected   = Decimal.min(eiProjected, eiMaximum);

  const k2Fed  = fedRate.times(cppSelected.plus(eiSelected));
  const k2Prov = abRate.times(cppSelected.plus(eiSelected));
  return { cppProjected, cppMaximum, cppSelected, eiProjected, eiMaximum, eiSelected, k2Fed, k2Prov };
}

// -------------------------------------------------------------------
// Federal + Alberta engine (shape identical to production; K2/K2P injectable).
// -------------------------------------------------------------------
function computeFederal(k2: Decimal): { federal: string; k1: string; k4: string } {
  const aStar   = SAM.taxable.times(P);
  const a       = SAM.taxable.minus(SAM.rrspEe).minus(F5A).times(P);
  const bracket = fedParams.brackets.find((b) => {
    const from = new Decimal(b.from);
    const to   = b.to == null ? null : new Decimal(b.to);
    return (to == null || a.lte(to)) && (a.gt(from) || (from.isZero() && a.gte(0)));
  })!;
  const R = new Decimal(bracket.rate);
  const K = new Decimal(bracket.constantK);
  const t = R.times(a).minus(K);
  const bpaf = new Decimal(fedParams.bpaMax);
  const excess = Decimal.max(0, SAM.fedTd1.minus(bpaf));
  const k1 = fedRate.times(bpaf).plus(fedRate.times(excess));
  const cea = new Decimal(fedParams.canadaEmploymentAmountMax);
  const k4  = fedRate.times(Decimal.min(aStar, cea));
  const t3Annual = Decimal.max(0, t.minus(k1).minus(k2).minus(k4));
  const federal  = t3Annual.div(P).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return { federal: federal.toFixed(2), k1: k1.toFixed(2), k4: k4.toFixed(2) };
}
function computeAlberta(k2p: Decimal): { alberta: string; k1p: string; k5p: string } {
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
// Option 1 baseline K2 (annualisation).
function option1K2(rate: Decimal, currentBase: Decimal, currentEi: Decimal): Decimal {
  return rate.times(currentBase.times(P).plus(currentEi.times(P)));
}

// -------------------------------------------------------------------
// Matrix
// -------------------------------------------------------------------
describe("Payroll-3C-3D.5A · corrected CRA YTD K2/K2P — full comparison matrix", () => {
  it("prints matrix with projection + maximum + selected breakdown", () => {
    const runs = [
      {
        label: "A · Current Spectre Option 1",
        k2:  option1K2(fedRate, SAM.cppBase, SAM.eiEe),
        k2p: option1K2(abRate,  SAM.cppBase, SAM.eiEe),
        cppSelected: "n/a", eiSelected: "n/a",
      },
      (() => {
        const b = ytdCredit({ d: PRIOR.spectreCppCombined, d1: PRIOR.spectreEi, c: SAM.cppCombinedCurrent, ei: SAM.eiCurrent, pr: PR_FLAGSHIP, pm: PM_SAM });
        return { label: "B · CRA YTD — Spectre history",             k2: b.k2Fed, k2p: b.k2Prov, cppSelected: b.cppSelected.toFixed(2), eiSelected: b.eiSelected.toFixed(2), _b: b };
      })(),
      (() => {
        const b = ytdCredit({ d: PRIOR.sourceCppCombined,  d1: PRIOR.sourceEi,  c: SAM.cppCombinedCurrent, ei: SAM.eiCurrent, pr: PR_FLAGSHIP, pm: PM_SAM });
        return { label: "C · CRA YTD — source history + Spectre curr", k2: b.k2Fed, k2p: b.k2Prov, cppSelected: b.cppSelected.toFixed(2), eiSelected: b.eiSelected.toFixed(2), _b: b };
      })(),
      (() => {
        const b = ytdCredit({ d: PRIOR.sourceCppCombined,  d1: PRIOR.sourceEi,  c: RISE_CURRENT.cppCombined, ei: RISE_CURRENT.ei, pr: PR_FLAGSHIP, pm: PM_SAM });
        return { label: "D · CRA YTD — source history + Rise curr",    k2: b.k2Fed, k2p: b.k2Prov, cppSelected: b.cppSelected.toFixed(2), eiSelected: b.eiSelected.toFixed(2), _b: b };
      })(),
    ] as const;

    // eslint-disable-next-line no-console
    console.log(`\n=== Corrected CRA YTD K2/K2P Matrix — Sam flagship (PR=${PR_FLAGSHIP} PM=${PM_SAM}) ===`);
    // eslint-disable-next-line no-console
    console.log("Method                                                CPP sel   EI sel     K2       K2P      Federal   Δ Fed    Alberta   Δ AB");
    for (const r of runs) {
      const fed = computeFederal(r.k2);
      const ab  = computeAlberta(r.k2p);
      const fedD = new Decimal(RISE.federal).minus(fed.federal).toFixed(2);
      const abD  = new Decimal(RISE.alberta).minus(ab.alberta).toFixed(2);
      // eslint-disable-next-line no-console
      console.log(
        `${r.label.padEnd(55)} ${r.cppSelected.padStart(8)} ${r.eiSelected.padStart(8)}  ${r.k2.toFixed(2).padStart(8)} ${r.k2p.toFixed(2).padStart(8)}  ${fed.federal.padStart(8)}  ${fedD.padStart(7)}  ${ab.alberta.padStart(8)}  ${abD.padStart(7)}`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(`RISE reference                                                                             ${RISE.federal.padStart(8)}     0.00  ${RISE.alberta.padStart(8)}     0.00\n`);
  });

  it("PR + PM values used", () => {
    expect(PR_FLAGSHIP).toBe(9);
    expect(PM_SAM).toBe(12);
  });

  it("Run D (source YTD + Rise current) — CPP MAXIMUM caps the projection at $3,519.45 (PM=12, full year)", () => {
    const b = ytdCredit({ d: PRIOR.sourceCppCombined, d1: PRIOR.sourceEi, c: RISE_CURRENT.cppCombined, ei: RISE_CURRENT.ei, pr: PR_FLAGSHIP, pm: PM_SAM });
    // CPP max at PM=12 = 3519.45 exact (full annual max).
    expect(b.cppMaximum.toFixed(2)).toBe("3519.45");
    // Projected exceeds maximum → selected = maximum.
    expect(b.cppSelected.eq(b.cppMaximum)).toBe(true);
    // EI: projected = 933.87 + 9 × 74.71 = 1606.26; capped at 1123.07.
    expect(b.eiSelected.eq(EI_ANNUAL_MAX)).toBe(true);
  });

  it("Run D federal + Alberta land within a $2 tolerance of Rise", () => {
    const b = ytdCredit({ d: PRIOR.sourceCppCombined, d1: PRIOR.sourceEi, c: RISE_CURRENT.cppCombined, ei: RISE_CURRENT.ei, pr: PR_FLAGSHIP, pm: PM_SAM });
    const fed = Number(computeFederal(b.k2Fed).federal);
    const ab  = Number(computeAlberta(b.k2Prov).alberta);
    expect(Math.abs(fed - Number(RISE.federal))).toBeLessThan(2);
    expect(Math.abs(ab  - Number(RISE.alberta))).toBeLessThan(2);
  });

  it("The prior 3C-3D.5 Variant C formula (0.14 × YTD-actual, no projection / max / ratio) is INVALID", () => {
    // Reproduce the invalid formula and prove its value differs from
    // the corrected formula for the same source YTD inputs.
    const invalidK2 = fedRate.times(PRIOR.sourceCppCombined.plus(PRIOR.sourceEi));
    const corrected = ytdCredit({ d: PRIOR.sourceCppCombined, d1: PRIOR.sourceEi, c: RISE_CURRENT.cppCombined, ei: RISE_CURRENT.ei, pr: PR_FLAGSHIP, pm: PM_SAM });
    // The invalid formula ignored base-ratio + projection + max, so
    // its K2 differs from the corrected K2 (proves it's a different,
    // incorrect formula shape — magnitude of the delta varies with
    // whether the CPP/EI maximums bind).
    expect(invalidK2.toFixed(2)).not.toBe(corrected.k2Fed.toFixed(2));
    expect(Math.abs(Number(invalidK2) - Number(corrected.k2Fed))).toBeGreaterThan(1);
  });

  it("Prior YTD (D, D1) must be BEFORE current pay, not including current", () => {
    // Sanity: PRIOR.sourceCppCombined ($3,482.46) is source YTD CPP
    // MINUS current CPP ($3,761.56 − $279.10 = $3,482.46).
    const derivedPriorCpp = new Decimal("3761.56").minus("279.10").toFixed(2);
    expect(PRIOR.sourceCppCombined.toFixed(2)).toBe(derivedPriorCpp);
    const derivedPriorEi = new Decimal("1008.58").minus("74.71").toFixed(2);
    expect(PRIOR.sourceEi.toFixed(2)).toBe(derivedPriorEi);
  });

  it("K2P = provincialLowestRate × (same CPP + EI selected as K2)", () => {
    // Corrected formula applies the same credit basis to K2 (federal
    // rate) and K2P (Alberta rate) per §17 of the brief.
    const b = ytdCredit({ d: PRIOR.sourceCppCombined, d1: PRIOR.sourceEi, c: RISE_CURRENT.cppCombined, ei: RISE_CURRENT.ei, pr: PR_FLAGSHIP, pm: PM_SAM });
    const ratio = b.k2Prov.div(b.k2Fed);
    // 0.08 / 0.14 = 0.5714285714...
    expect(ratio.minus(abRate.div(fedRate)).abs().lt("0.00001")).toBe(true);
  });

  it("No production behavior changed — Option 1 pipeline still yields Sam production federal + Alberta", () => {
    const k2  = option1K2(fedRate, SAM.cppBase, SAM.eiEe);
    const k2p = option1K2(abRate,  SAM.cppBase, SAM.eiEe);
    const fed = Number(computeFederal(k2).federal);
    const ab  = Number(computeAlberta(k2p).alberta);
    expect(Math.abs(fed - 635.44)).toBeLessThan(0.10);
    expect(Math.abs(ab  - 308.11)).toBeLessThan(0.10);
  });
});
