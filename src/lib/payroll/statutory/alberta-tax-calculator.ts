// Payroll-3B-5B-2c (2026-09-02) — pure Alberta provincial income-tax calculator.
//
// PURE function. No Prisma. No side effects.
//
// Implements the reconciled T4127 §Alberta contract:
//
//   A     = P × (I − F − F1 − F5A) + HD − F2 − U1 − F5B   (same A as federal)
//   V,KP  = Alberta bracket lookup on A
//   TP    = V × A − KP
//   K1P   = provincialLowestRate × (Alberta BPA + TCP_over_BPA)
//   K2P   = provincialLowestRate × (P × baseCPP + P × EI)     (BASE CPP + EI only)
//   K3P   = 0 in MVP
//   K4P   = 0                                                  (statutory non-applicability)
//   K5P   = max(0, ((K1P + K2P) − threshold) × (supplementalRate / baseRate))
//   T3P   = max(0, TP − K1P − K2P − K3P − K5P)
//   T4P   = max(0, roundCents(T3P / P))
//
// The `additionalProvincialTaxAmount` is NOT added here — the
// orchestrator persists it separately.

import { Decimal, nonNegative, roundCentsHalfUp, toDecimal } from "./decimal-money";

export interface AlbertaTaxBracket {
  from:      string;
  to:        string | null;
  rate:      string;
  constantK: string;
}

export interface AlbertaTaxInput {
  /** Payroll-3C-3D.3 (2026-09-09) — see federal-tax-calculator
   *  for full docstring. Periodic taxable remuneration (including
   *  employer taxable benefits), NOT cash gross. */
  periodicTaxableRemuneration: Decimal | string | number;
  /** T4127 §Alberta F — same shape as the federal input; RRSP
   *  deducted at source flows through here. Payroll-3C-3D. */
  fThisPay?:               Decimal | string | number;
  f5aThisPay:              Decimal | string | number;
  baseCppThisPay:          Decimal | string | number;
  eiThisPay:               Decimal | string | number;
  periodsPerYear:          number;
  /** Frozen TD1AB total claim. */
  provincialClaim:         Decimal | string | number;
  /** TD1AB more-than-one-employer flag (Alberta side). */
  claimZeroProvincial:     boolean;
  /** TD1 "no tax withheld" attestation (federal + provincial share the flag per T4127). */
  totalIncomeLessThanClaim: boolean;
  /** Payroll-3C-3D.6 — same YTD credit basis as federal K2 (§13). */
  ytdCreditBasis?: {
    combinedSelectedBasis: Decimal | string | number;
  };
  provincial: {
    brackets:      AlbertaTaxBracket[];
    lowestRate:    string;
    bpa:           string;
    /** k5p block from the pinned package. */
    k5p: {
      enabled:          boolean;
      threshold:        string;
      supplementalRate: string;
      baseRate:         string;
    };
  };
}

export interface AlbertaTaxResult {
  a:            Decimal;
  f5aAnnual:    Decimal;
  bracketRate:  Decimal;    // V
  bracketK:     Decimal;    // KP
  tp:           Decimal;    // V × A − KP
  k1p:          Decimal;
  k2p:          Decimal;
  k3p:          Decimal;
  k4p:          Decimal;    // 0 for Alberta MVP
  k5p:          Decimal;
  t3pAnnual:    Decimal;
  t4pPerPeriod: Decimal;
}

function lookupAlbertaBracket(brackets: AlbertaTaxBracket[], a: Decimal): { V: Decimal; KP: Decimal } {
  for (const b of brackets) {
    const from = toDecimal(b.from);
    const to   = b.to == null ? null : toDecimal(b.to);
    if (to == null || a.lte(to)) {
      if (a.gt(from) || (from.isZero() && a.gte(0))) {
        return { V: toDecimal(b.rate), KP: toDecimal(b.constantK) };
      }
    }
  }
  const last = brackets[brackets.length - 1];
  return { V: toDecimal(last.rate), KP: toDecimal(last.constantK) };
}

export function calculateAlbertaTax(input: AlbertaTaxInput): AlbertaTaxResult {
  const P    = new Decimal(input.periodsPerYear);
  if (P.lte(0)) throw new Error("periodsPerYear must be > 0");
  const I    = toDecimal(input.periodicTaxableRemuneration);
  const F    = toDecimal(input.fThisPay ?? 0);
  const F5A  = toDecimal(input.f5aThisPay);
  const base = toDecimal(input.baseCppThisPay);
  const ei   = toDecimal(input.eiThisPay);
  const rate = toDecimal(input.provincial.lowestRate);
  const bpa  = toDecimal(input.provincial.bpa);
  const f5aAnnual = F5A.times(P);
  // Payroll-3C-3D — same F as federal: RRSP deducted at source
  // reduces A pre-annualisation on the provincial side too.
  const a = I.minus(F).minus(F5A).times(P);

  if (input.totalIncomeLessThanClaim) {
    return {
      a, f5aAnnual, bracketRate: new Decimal(0), bracketK: new Decimal(0),
      tp: new Decimal(0), k1p: new Decimal(0), k2p: new Decimal(0), k3p: new Decimal(0),
      k4p: new Decimal(0), k5p: new Decimal(0),
      t3pAnnual: new Decimal(0), t4pPerPeriod: new Decimal(0),
    };
  }

  const { V, KP } = lookupAlbertaBracket(input.provincial.brackets, a);
  const tp = V.times(a).minus(KP);

  const claim = input.claimZeroProvincial ? new Decimal(0) : toDecimal(input.provincialClaim);
  // K1P = provincialLowestRate × (BPA + TCP_over_BPA). If claim
  // is >= BPA the whole claim contributes at the lowest rate.
  const tcpOverBpa = nonNegative(claim.minus(bpa));
  const k1p = input.claimZeroProvincial
    ? new Decimal(0)
    : rate.times(bpa).plus(rate.times(tcpOverBpa));

  // K2P — Payroll-3C-3D.6: use the CRA YTD basis when supplied
  // (§13 — federal + Alberta share the same credit basis).
  const k2p = input.ytdCreditBasis
    ? rate.times(toDecimal(input.ytdCreditBasis.combinedSelectedBasis))
    : rate.times(base.times(P).plus(ei.times(P)));
  const k3p = new Decimal(0);
  const k4p = new Decimal(0);   // §22 statutory non-applicability

  // K5P: enabled per package. Uses K1P + K2P.
  let k5p = new Decimal(0);
  if (input.provincial.k5p.enabled) {
    const threshold        = toDecimal(input.provincial.k5p.threshold);
    const supplementalRate = toDecimal(input.provincial.k5p.supplementalRate);
    const baseRatePkg      = toDecimal(input.provincial.k5p.baseRate);
    const above            = nonNegative(k1p.plus(k2p).minus(threshold));
    k5p = above.times(supplementalRate.div(baseRatePkg));
  }

  const t3pAnnual = nonNegative(tp.minus(k1p).minus(k2p).minus(k3p).minus(k5p));
  const t4pPerPeriod = roundCentsHalfUp(nonNegative(t3pAnnual.div(P)));

  return { a, f5aAnnual, bracketRate: V, bracketK: KP, tp, k1p, k2p, k3p, k4p, k5p, t3pAnnual, t4pPerPeriod };
}
