// Payroll-3B-5B-2c (2026-09-02) — pure federal income-tax calculator.
//
// PURE function. No Prisma. No side effects.
//
// Implements the reconciled T4127 §Federal contract:
//
//   A*  = P × I                                                                (annual gross employment income; K4 only)
//   A   = P × (I − F − F1 − F5A) + HD − F2 − U1 − F5B                          (annual taxable income; brackets + BPAF)
//   R,K = bracket lookup on A
//   T   = R × A − K
//   K1  = federalLowestRate × BPAF + federalLowestRate × TCF_over_BPA          (BPAF phased by A; TCF from frozen tax facts)
//   K2  = federalLowestRate × (P × baseCPP + P × EI)                           (BASE CPP + EI only)
//   K3  = 0 in MVP (other CRA-office-authorised credits)
//   K4  = federalLowestRate × min(A*, canadaEmploymentAmountMax)
//   T3  = max(0, T − K1 − K2 − K3 − K4)
//   T4  = max(0, roundCents(T3 / P))
//
// Additional withholding is NOT added here — the orchestrator adds
// it separately after this function returns, so the persisted
// deductionFederalTax column remains the pure statutory result.
//
// Every diagnostic is exposed on the result for audit / snapshot.

import { Decimal, nonNegative, roundCentsHalfUp, toDecimal } from "./decimal-money";

export interface FederalTaxBracket {
  from:      string;
  to:        string | null;
  rate:      string;
  constantK: string;
}

export interface FederalTaxInput {
  /** Current pay-period gross earnings (I). */
  grossPay:                Decimal | string | number;
  /** Sum of employee CPP first-additional + CPP2 for this pay period (F5A). */
  f5aThisPay:              Decimal | string | number;
  /** Per-period base CPP amount for K2 (already cent-rounded by 2b). */
  baseCppThisPay:          Decimal | string | number;
  /** Per-period EI amount for K2 (already cent-rounded by 2b). */
  eiThisPay:               Decimal | string | number;
  /** Actual pay-period count in the tax year (P). */
  periodsPerYear:          number;
  /** Frozen TD1 federal total claim (see freeze pipeline). */
  federalClaim:            Decimal | string | number;
  /** TD1 "more than one employer / payer" flag — federal side. */
  claimZeroFederal:        boolean;
  /** TD1 "no tax withheld" attestation — total income < total claim. */
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

export interface FederalTaxResult {
  a:            Decimal;    // annual taxable income
  aStar:        Decimal;    // annual gross employment income (K4 only)
  f5aAnnual:    Decimal;    // P × F5A
  bpaf:         Decimal;    // income-tiered federal BPA
  bracketRate:  Decimal;    // R
  bracketK:     Decimal;    // K
  t:            Decimal;    // R × A − K
  k1:           Decimal;
  k2:           Decimal;
  k3:           Decimal;
  k4:           Decimal;
  t3Annual:     Decimal;    // annual tax after credits
  /** Per-period federal tax withheld (base statutory — additional withholding added by orchestrator). */
  t4PerPeriod:  Decimal;
}

function lookupBracket(brackets: FederalTaxBracket[], a: Decimal): { R: Decimal; K: Decimal } {
  for (const b of brackets) {
    const from = toDecimal(b.from);
    const to   = b.to == null ? null : toDecimal(b.to);
    // Half-open ranges match T4127: (from, to] where a > from implicitly.
    if (to == null || a.lte(to)) {
      if (a.gt(from) || (from.isZero() && a.gte(0))) {
        return { R: toDecimal(b.rate), K: toDecimal(b.constantK) };
      }
    }
  }
  // If no bracket matched (shouldn't happen — a >= 0 always hits row 1), fall back to the last.
  const last = brackets[brackets.length - 1];
  return { R: toDecimal(last.rate), K: toDecimal(last.constantK) };
}

function computeBpaf(input: FederalTaxInput, a: Decimal): Decimal {
  if (input.claimZeroFederal) return new Decimal(0);
  const bpaMax = toDecimal(input.federal.bpaMax);
  const bpaMin = toDecimal(input.federal.bpaMin);
  const start  = toDecimal(input.federal.bpaPhaseOutStart);
  const end    = toDecimal(input.federal.bpaPhaseOutEnd);
  if (a.lte(start)) return bpaMax;
  if (a.gte(end))   return bpaMin;
  // Linear phase-out per T4127 §K1.
  const span     = end.minus(start);
  const offset   = a.minus(start);
  const shrink   = bpaMax.minus(bpaMin).times(offset).div(span);
  return bpaMax.minus(shrink);
}

export function calculateFederalTax(input: FederalTaxInput): FederalTaxResult {
  const P    = new Decimal(input.periodsPerYear);
  if (P.lte(0)) throw new Error("periodsPerYear must be > 0");
  const I    = toDecimal(input.grossPay);
  const F5A  = toDecimal(input.f5aThisPay);
  const base = toDecimal(input.baseCppThisPay);
  const ei   = toDecimal(input.eiThisPay);
  const rate = toDecimal(input.federal.lowestRate);
  const cea  = toDecimal(input.federal.canadaEmploymentAmountMax);

  // §11: A* is annual GROSS employment income (K4 only). A is
  // annual TAXABLE income (rate lookup + BPAF phase-out).
  const aStar = I.times(P);
  const f5aAnnual = F5A.times(P);
  // MVP unsupported inputs (F, F1, HD, F2, U1, F5B) — all zero;
  // readiness would BLOCK if any applied.
  const a = I.minus(F5A).times(P);

  // TD1 "no tax withheld" attestation short-circuit: T3 = 0.
  if (input.totalIncomeLessThanClaim) {
    return {
      a, aStar, f5aAnnual,
      bpaf: new Decimal(0), bracketRate: new Decimal(0), bracketK: new Decimal(0),
      t: new Decimal(0), k1: new Decimal(0), k2: new Decimal(0), k3: new Decimal(0), k4: new Decimal(0),
      t3Annual: new Decimal(0), t4PerPeriod: new Decimal(0),
    };
  }

  const { R, K } = lookupBracket(input.federal.brackets, a);
  const t = R.times(a).minus(K);

  // K1 — BPAF + TCF over BPA. `federalClaim` = total TD1 claim.
  const bpaf = computeBpaf(input, a);
  const claim = input.claimZeroFederal ? new Decimal(0) : toDecimal(input.federalClaim);
  const tcfOverBpa = nonNegative(claim.minus(bpaf));
  const k1 = rate.times(bpaf).plus(rate.times(tcfOverBpa));

  // K2 — BASE CPP + EI credits, annualised via P.
  const k2 = rate.times(base.times(P).plus(ei.times(P)));

  // K3 — MVP zero.
  const k3 = new Decimal(0);

  // K4 — Canada Employment Amount capped by CEA. Uses A* (gross).
  const k4 = rate.times(Decimal.min(aStar, cea));

  // T3 annual tax after credits, floored at zero.
  const t3Annual = nonNegative(t.minus(k1).minus(k2).minus(k3).minus(k4));

  // Per-period T4 = round(T3 / P), floored at zero. Additional
  // withholding is NOT added here — the orchestrator adds it as
  // a separate persisted column.
  const t4PerPeriod = roundCentsHalfUp(nonNegative(t3Annual.div(P)));

  return { a, aStar, f5aAnnual, bpaf, bracketRate: R, bracketK: K, t, k1, k2, k3, k4, t3Annual, t4PerPeriod };
}
