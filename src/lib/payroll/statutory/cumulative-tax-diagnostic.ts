// Payroll-3C-3D.4 (2026-09-09) — DIAGNOSTIC ONLY.
//
// CRA T4127 Option 2 (cumulative-averaging) federal + Alberta tax
// calculator. Test-only helper used by the RRSP cumulative-averaging
// diagnostic; **NOT wired into production**.
//
// **Live-verification limitation of this session.** This session
// cannot fetch CRA URLs directly (WebFetch is not loaded). The
// formula below is implemented from the standard T4127 §Chapter 5
// cumulative-averaging shape as documented in Spectre's existing
// package/formula code + the founder's brief. Before adopting this
// harness for production, a follow-up slice MUST live-verify the
// exact CRA §5 wording against the 2026 123rd Edition.
//
// The harness is intentionally narrowly-scoped:
//   Annualisation: A_annual = (YTD_I − YTD_F − YTD_F5A) × (P / N)
//   Bracket:        R, K from Option 1 tables (edition unchanged §Ch4/§Ch5)
//   T_annual =      R × A_annual − K
//   K1_annual =     Option 1 K1 (BPAF + excess claim)
//   K2_annual =     rate × (YTD_baseCPP × P/N + YTD_EI × P/N)
//   K4_annual =     rate × min(A*_annual, CEA)     A*_annual = YTD_I × P/N
//   T3_annual =     max(0, T_annual − K1 − K2 − K3 − K4)
//   YTD_T3_owed =   T3_annual × (N / P)
//   currentPeriodT= max(0, YTD_T3_owed − priorYTD_T_withheld)

import { Decimal, nonNegative, roundCentsHalfUp, toDecimal } from "./decimal-money";
import type { FederalTaxBracket } from "./federal-tax-calculator";

export interface CumulativeFederalInput {
  /** YTD taxable remuneration through THIS pay period (inclusive). */
  ytdTaxableThroughCurrent: string;
  /** YTD F through THIS pay (inclusive) — sum of RRSP-at-source amounts. */
  ytdFThroughCurrent:       string;
  /** YTD F5A through THIS pay (inclusive) — CPP first-add + CPP2 EE. */
  ytdF5AThroughCurrent:     string;
  /** YTD base CPP EE through THIS pay (inclusive). */
  ytdBaseCppThroughCurrent: string;
  /** YTD EI EE through THIS pay (inclusive). */
  ytdEiThroughCurrent:      string;
  /** Number of pay periods completed THROUGH this pay (inclusive). */
  nPayPeriodsThroughCurrent: number;
  /** P — periods per year (24 for semi-monthly). */
  periodsPerYear:           number;
  /** Cumulative federal tax withheld BEFORE this pay period. */
  priorYtdFederalWithheld:  string;
  /** Frozen TD1 federal total claim. */
  federalClaim:             string;
  claimZeroFederal:         boolean;
  totalIncomeLessThanClaim: boolean;
  federal: {
    brackets:                 FederalTaxBracket[];
    lowestRate:               string;
    bpaMax:                   string;
    bpaMin:                   string;
    bpaPhaseOutStart:         string;
    bpaPhaseOutEnd:           string;
    canadaEmploymentAmountMax: string;
  };
}

export interface CumulativeFederalResult {
  aAnnual:        Decimal;
  aStarAnnual:    Decimal;
  bpaf:           Decimal;
  bracketRate:    Decimal;
  bracketK:       Decimal;
  tAnnual:        Decimal;
  k1:             Decimal;
  k2:             Decimal;
  k4:             Decimal;
  t3Annual:       Decimal;
  ytdT3Owed:      Decimal;
  currentPeriodT: Decimal;
}

function lookupBracket(brackets: FederalTaxBracket[], a: Decimal): { R: Decimal; K: Decimal } {
  for (const b of brackets) {
    const from = toDecimal(b.from);
    const to   = b.to == null ? null : toDecimal(b.to);
    if (to == null || a.lte(to)) {
      if (a.gt(from) || (from.isZero() && a.gte(0))) {
        return { R: toDecimal(b.rate), K: toDecimal(b.constantK) };
      }
    }
  }
  const last = brackets[brackets.length - 1];
  return { R: toDecimal(last.rate), K: toDecimal(last.constantK) };
}

function computeBpaf(input: CumulativeFederalInput, a: Decimal): Decimal {
  if (input.claimZeroFederal) return new Decimal(0);
  const bpaMax = toDecimal(input.federal.bpaMax);
  const bpaMin = toDecimal(input.federal.bpaMin);
  const start  = toDecimal(input.federal.bpaPhaseOutStart);
  const end    = toDecimal(input.federal.bpaPhaseOutEnd);
  if (a.lte(start)) return bpaMax;
  if (a.gte(end))   return bpaMin;
  const span   = end.minus(start);
  const offset = a.minus(start);
  const shrink = bpaMax.minus(bpaMin).times(offset).div(span);
  return bpaMax.minus(shrink);
}

export function calculateCumulativeFederalTax(input: CumulativeFederalInput): CumulativeFederalResult {
  const N = new Decimal(input.nPayPeriodsThroughCurrent);
  const P = new Decimal(input.periodsPerYear);
  if (N.lte(0)) throw new Error("nPayPeriodsThroughCurrent must be > 0");
  if (P.lte(0)) throw new Error("periodsPerYear must be > 0");

  const factor = P.div(N);
  const ytdI     = toDecimal(input.ytdTaxableThroughCurrent);
  const ytdF     = toDecimal(input.ytdFThroughCurrent);
  const ytdF5A   = toDecimal(input.ytdF5AThroughCurrent);
  const ytdCpp   = toDecimal(input.ytdBaseCppThroughCurrent);
  const ytdEi    = toDecimal(input.ytdEiThroughCurrent);

  const aAnnual     = ytdI.minus(ytdF).minus(ytdF5A).times(factor);
  const aStarAnnual = ytdI.times(factor);
  const rate = toDecimal(input.federal.lowestRate);
  const cea  = toDecimal(input.federal.canadaEmploymentAmountMax);

  if (input.totalIncomeLessThanClaim) {
    return {
      aAnnual, aStarAnnual, bpaf: new Decimal(0),
      bracketRate: new Decimal(0), bracketK: new Decimal(0),
      tAnnual: new Decimal(0), k1: new Decimal(0), k2: new Decimal(0), k4: new Decimal(0),
      t3Annual: new Decimal(0), ytdT3Owed: new Decimal(0),
      currentPeriodT: new Decimal(0),
    };
  }

  const { R, K } = lookupBracket(input.federal.brackets, aAnnual);
  const tAnnual = R.times(aAnnual).minus(K);

  const bpaf = computeBpaf(input, aAnnual);
  const claim = input.claimZeroFederal ? new Decimal(0) : toDecimal(input.federalClaim);
  const excess = nonNegative(claim.minus(bpaf));
  const k1 = rate.times(bpaf).plus(rate.times(excess));

  const k2 = rate.times(ytdCpp.times(factor).plus(ytdEi.times(factor)));

  const k4 = rate.times(Decimal.min(aStarAnnual, cea));

  const t3Annual   = nonNegative(tAnnual.minus(k1).minus(k2).minus(k4));
  const ytdT3Owed  = t3Annual.times(N).div(P);
  const priorYtdT  = toDecimal(input.priorYtdFederalWithheld);
  const currentPeriodT = roundCentsHalfUp(nonNegative(ytdT3Owed.minus(priorYtdT)));

  return {
    aAnnual, aStarAnnual, bpaf,
    bracketRate: R, bracketK: K,
    tAnnual, k1, k2, k4,
    t3Annual, ytdT3Owed, currentPeriodT,
  };
}

// Alberta variant — identical shape with provincial bracket + K5P.
export interface CumulativeAlbertaInput
  extends Omit<CumulativeFederalInput, "federal" | "federalClaim" | "claimZeroFederal" | "priorYtdFederalWithheld"> {
  provincialClaim: string;
  claimZeroProvincial: boolean;
  priorYtdProvincialWithheld: string;
  provincial: {
    brackets:      FederalTaxBracket[];   // structurally identical
    lowestRate:    string;
    bpa:           string;
    k5p: {
      enabled:          boolean;
      threshold:        string;
      supplementalRate: string;
      baseRate:         string;
    };
  };
}

export function calculateCumulativeAlbertaTax(input: CumulativeAlbertaInput) {
  const N = new Decimal(input.nPayPeriodsThroughCurrent);
  const P = new Decimal(input.periodsPerYear);
  const factor = P.div(N);
  const ytdI   = toDecimal(input.ytdTaxableThroughCurrent);
  const ytdF   = toDecimal(input.ytdFThroughCurrent);
  const ytdF5A = toDecimal(input.ytdF5AThroughCurrent);
  const ytdCpp = toDecimal(input.ytdBaseCppThroughCurrent);
  const ytdEi  = toDecimal(input.ytdEiThroughCurrent);
  const aAnnual = ytdI.minus(ytdF).minus(ytdF5A).times(factor);

  const rate = toDecimal(input.provincial.lowestRate);
  const bpa  = toDecimal(input.provincial.bpa);
  const claim = input.claimZeroProvincial ? new Decimal(0) : toDecimal(input.provincialClaim);

  if (input.totalIncomeLessThanClaim) {
    return {
      aAnnual,
      tpAnnual: new Decimal(0), k1p: new Decimal(0), k2p: new Decimal(0), k5p: new Decimal(0),
      t3pAnnual: new Decimal(0), ytdT3pOwed: new Decimal(0),
      currentPeriodTp: new Decimal(0),
    };
  }
  const { R: V, K: KP } = lookupBracket(input.provincial.brackets, aAnnual);
  const tpAnnual = V.times(aAnnual).minus(KP);

  const k1p = rate.times(bpa).plus(rate.times(nonNegative(claim.minus(bpa))));
  const k2p = rate.times(ytdCpp.times(factor).plus(ytdEi.times(factor)));

  const k = input.provincial.k5p;
  let k5p = new Decimal(0);
  if (k.enabled) {
    const above = nonNegative(k1p.plus(k2p).minus(toDecimal(k.threshold)));
    k5p = above.times(toDecimal(k.supplementalRate)).div(toDecimal(k.baseRate));
  }
  const t3pAnnual   = nonNegative(tpAnnual.minus(k1p).minus(k2p).minus(k5p));
  const ytdT3pOwed  = t3pAnnual.times(N).div(P);
  const priorYtdT   = toDecimal(input.priorYtdProvincialWithheld);
  const currentPeriodTp = roundCentsHalfUp(nonNegative(ytdT3pOwed.minus(priorYtdT)));

  return { aAnnual, tpAnnual, k1p, k2p, k5p, t3pAnnual, ytdT3pOwed, currentPeriodTp };
}
