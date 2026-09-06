// Payroll-3C-3C (2026-09-09) — Canadian Statutory Treatment Library.
//
// Code-defined registry of verified Canadian payroll rules that a
// PayrollComponent may claim as its treatment source. Each rule is
// versioned and effective-dated so historical batches can freeze the
// exact rule they consumed at PREPARE time.
//
// SCOPE: Sam Complex acceptance components — the founder brief's §5-11
// enumerates the CRA guidance the entries below encode. Every rule
// carries its authoritative source metadata so a future WebFetch pass
// or CRA-audit review can independently re-verify against the cited
// document without re-reading Spectre code.
//
// **This library is code-only.** No mutation API exists. Tenant Admin
// users cannot create or edit rules. Adding a rule is a code + PR
// change that a reviewer must approve — this is the "SPECTRE_LIBRARY
// cannot be tenant-authored" guarantee (§14 of the brief).
//
// **A component may only claim SPECTRE_LIBRARY when a matching rule
// resolves.** `assertLibraryRuleResolves()` refuses closed — no
// silent fallback to a guessed rule.

import type { StatutoryEffect, CashEffect } from "./components-catalogue";

/** Rule variants used by rules whose treatment depends on a plan
 *  attribute (e.g. RRSP EI treatment depends on withdrawal rules). */
export type StatutoryRuleVariant =
  | "DEFAULT"
  | "RRSP_WITHDRAWABLE"
  | "RRSP_RESTRICTED_UNTIL_RETIREMENT_OR_TERMINATION";

export interface StatutoryLibraryRule {
  ruleKey: string;
  displayName: string;
  jurisdiction: { country: "CA"; province?: string | null };
  effectiveFrom: string;      // ISO date
  effectiveTo:   string | null;
  variant:       StatutoryRuleVariant;
  /** Resolved directional effects the calculator will apply. */
  taxableEffect:         StatutoryEffect;
  cppPensionableEffect:  StatutoryEffect;
  eiInsurableEffect:     StatutoryEffect;
  /** Whether the underlying benefit changes cash to the employee. */
  cashEffectExpectation: CashEffect;
  /** Authoritative source metadata — non-sensitive; safe to expose in
   *  Admin/Controller diagnostic detail but NOT in employee-facing UI. */
  sourceAuthority: "CRA";
  sourceTitle:     string;
  sourceReference: string;
  sourceLastVerifiedAt: string; // ISO date
  notes: string;
  version: string;
}

// -------------------------------------------------------------------
// Registered rules
// -------------------------------------------------------------------
export const RULES: readonly StatutoryLibraryRule[] = [
  // ---------------------------------------------------------------
  // Employer-paid group AD&D — §5 of the 3C-3C brief.
  //
  // "CRA guidance identifies employer-paid premiums/contributions to
  // group sickness or accident insurance plans as taxable benefits
  // except for qualifying wage-loss replacement benefits paid
  // periodically. CRA explicitly cites accidental death and
  // dismemberment as an example where employer-paid premiums are
  // taxable." (founder-supplied CRA citation, brief §5)
  //
  // Non-cash taxable benefit → CPP pensionable, NOT EI insurable.
  // ---------------------------------------------------------------
  {
    ruleKey: "CA-ER-AD-AND-D-PREMIUM-V1",
    displayName: "Employer-paid AD&D premium (non-cash taxable benefit)",
    jurisdiction: { country: "CA" },
    effectiveFrom: "2000-01-01", effectiveTo: null,
    variant: "DEFAULT",
    taxableEffect: "ADD",
    cppPensionableEffect: "ADD",
    eiInsurableEffect: "NONE",
    cashEffectExpectation: "NO_NET_PAY_EFFECT",
    sourceAuthority: "CRA",
    sourceTitle: "Employers' Guide – Taxable Benefits and Allowances (T4130)",
    sourceReference: "T4130 — Premiums under provincial hospitalization, medical care insurance and certain federal government plans; group sickness or accident insurance plans",
    sourceLastVerifiedAt: "2026-09-09",
    notes:
      "AD&D premium is a non-cash taxable benefit unless it qualifies as a wage-loss replacement plan paid " +
      "periodically. EI is not insurable for non-cash benefits.",
    version: "1.0.0",
  },

  // ---------------------------------------------------------------
  // Employer-paid group Life Insurance — §7.
  //
  // Group term life insurance paid by the employer is a taxable
  // non-cash benefit. Treatment: income tax YES, CPP YES, EI NO.
  //
  // NOTE (brief §7): the taxable-benefit VALUE may differ from raw
  // premium in some plans. This library rule maps the directional
  // effects; the calling fixture is responsible for supplying the
  // benefit AMOUNT. When a plan requires a separate imputation
  // (e.g. IRC-style split calculations), a follow-up rule variant
  // will encode that; for the Sam fixture the raw premium is used.
  // ---------------------------------------------------------------
  {
    ruleKey: "CA-ER-GROUP-LIFE-INSURANCE-PREMIUM-V1",
    displayName: "Employer-paid group life insurance premium (non-cash taxable benefit)",
    jurisdiction: { country: "CA" },
    effectiveFrom: "2000-01-01", effectiveTo: null,
    variant: "DEFAULT",
    taxableEffect: "ADD",
    cppPensionableEffect: "ADD",
    eiInsurableEffect: "NONE",
    cashEffectExpectation: "NO_NET_PAY_EFFECT",
    sourceAuthority: "CRA",
    sourceTitle: "Employers' Guide – Taxable Benefits and Allowances (T4130)",
    sourceReference: "T4130 — Group term life insurance policies",
    sourceLastVerifiedAt: "2026-09-09",
    notes:
      "Employer-paid group term life insurance is a taxable non-cash benefit. Income tax withheld on the " +
      "benefit value; CPP pensionable; not EI insurable (non-cash benefit). Where a plan requires a " +
      "computed benefit value distinct from the employer premium, the fixture is responsible for providing " +
      "the correct benefit amount — this rule encodes the directional effects only.",
    version: "1.0.0",
  },

  // ---------------------------------------------------------------
  // Employer RRSP contribution — WITHDRAWABLE variant. §8 + §9.
  //
  // CRA rule (brief §8):
  //   "Employer RRSP contributions are generally taxable benefits.
  //    Verify taxableEffect = ADD, cppPensionableEffect = ADD.
  //    Then determine EI via plan restrictions."
  //
  // If employee CAN withdraw employer contributions before
  // retirement/termination → EI ADD.
  // ---------------------------------------------------------------
  {
    ruleKey: "CA-ER-GROUP-RRSP-CONTRIBUTION-WITHDRAWABLE-V1",
    displayName: "Employer RRSP contribution — withdrawable plan",
    jurisdiction: { country: "CA" },
    effectiveFrom: "2000-01-01", effectiveTo: null,
    variant: "RRSP_WITHDRAWABLE",
    taxableEffect: "ADD",
    cppPensionableEffect: "ADD",
    eiInsurableEffect: "ADD",
    cashEffectExpectation: "NO_NET_PAY_EFFECT",
    sourceAuthority: "CRA",
    sourceTitle: "Employers' Guide – Taxable Benefits and Allowances (T4130) — RRSP contributions",
    sourceReference:
      "T4130 — Employer contributions to a group RRSP where the employee can withdraw amounts before " +
      "retirement or termination are insurable earnings.",
    sourceLastVerifiedAt: "2026-09-09",
    notes:
      "Applies when the group RRSP plan permits the employee to withdraw employer contributions before " +
      "retirement or termination (i.e. a withdrawable plan). Under this variant CPP AND EI both apply.",
    version: "1.0.0",
  },

  // ---------------------------------------------------------------
  // Employer RRSP contribution — RESTRICTED variant. §8 + §9.
  //
  // CRA rule: "If employee cannot withdraw amounts before
  // retirement/termination except allowed HBP/LLP cases → EI NONE."
  // ---------------------------------------------------------------
  {
    ruleKey: "CA-ER-GROUP-RRSP-CONTRIBUTION-RESTRICTED-V1",
    displayName: "Employer RRSP contribution — withdrawal-restricted plan",
    jurisdiction: { country: "CA" },
    effectiveFrom: "2000-01-01", effectiveTo: null,
    variant: "RRSP_RESTRICTED_UNTIL_RETIREMENT_OR_TERMINATION",
    taxableEffect: "ADD",
    cppPensionableEffect: "ADD",
    eiInsurableEffect: "NONE",
    cashEffectExpectation: "NO_NET_PAY_EFFECT",
    sourceAuthority: "CRA",
    sourceTitle: "Employers' Guide – Taxable Benefits and Allowances (T4130) — RRSP contributions",
    sourceReference:
      "T4130 — Employer contributions to a group RRSP where the employee cannot withdraw amounts before " +
      "retirement or termination (except permitted HBP/LLP withdrawals) are NOT insurable earnings.",
    sourceLastVerifiedAt: "2026-09-09",
    notes:
      "Applies when the group RRSP plan restricts employee withdrawals to retirement or termination, " +
      "except for permitted Home Buyers' Plan / Lifelong Learning Plan withdrawals. Under this variant " +
      "the taxable benefit remains, CPP applies, but EI does not.",
    version: "1.0.0",
  },
  // ---------------------------------------------------------------
  // Employer-paid group DEPENDENT LIFE — §7 of the 3C-3D brief.
  //
  // Founder-clarified (§7 3C-3D): employer-paid dependent-life
  // coverage is a taxable non-cash group-life-adjacent benefit. CRA
  // T4130 group life / group insurance guidance treats employer-paid
  // dependent-life premiums as a taxable benefit — income tax + CPP
  // pensionable, NOT EI insurable (non-cash benefit).
  //
  // Where a plan requires a computed benefit value distinct from raw
  // premium, the fixture is responsible for supplying the correct
  // amount; this rule encodes the directional effects only.
  // ---------------------------------------------------------------
  {
    ruleKey: "CA-ER-GROUP-DEPENDENT-LIFE-PREMIUM-V1",
    displayName: "Employer-paid group dependent-life premium (non-cash taxable benefit)",
    jurisdiction: { country: "CA" },
    effectiveFrom: "2000-01-01", effectiveTo: null,
    variant: "DEFAULT",
    taxableEffect: "ADD",
    cppPensionableEffect: "ADD",
    eiInsurableEffect: "NONE",
    cashEffectExpectation: "NO_NET_PAY_EFFECT",
    sourceAuthority: "CRA",
    sourceTitle: "Employers' Guide – Taxable Benefits and Allowances (T4130)",
    sourceReference: "T4130 — Group term life insurance policies (employer-paid coverage on the life of an employee's spouse or dependant is a taxable benefit).",
    sourceLastVerifiedAt: "2026-09-09",
    notes:
      "Employer-paid dependent-life premium follows the same non-cash taxable-benefit treatment as employer-paid " +
      "group life insurance: income tax and CPP pensionable, not EI insurable. Plan-specific value calculation " +
      "may differ from raw premium; the fixture supplies the benefit amount.",
    version: "1.0.0",
  },

  // ---------------------------------------------------------------
  // Flat taxable CASH allowance — §5-6 of the 3C-3D brief.
  //
  // Founder-clarified (§5): the $37.50 Cell Phone item is a FLAT
  // CASH ALLOWANCE, not a reimbursement. CRA T4130 treats a flat
  // taxable cash allowance as taxable AND CPP-pensionable AND EI-
  // insurable — the same three-base ADD pattern as regular cash
  // earnings.
  //
  // This is a GENERAL rule usable for any club-configured flat
  // taxable cash allowance (§30: no tenant-specific rule names).
  // ---------------------------------------------------------------
  {
    ruleKey: "CA-TAXABLE-CASH-ALLOWANCE-V1",
    displayName: "Flat taxable cash allowance (INCREASES_NET_PAY)",
    jurisdiction: { country: "CA" },
    effectiveFrom: "2000-01-01", effectiveTo: null,
    variant: "DEFAULT",
    taxableEffect: "ADD",
    cppPensionableEffect: "ADD",
    eiInsurableEffect: "ADD",
    cashEffectExpectation: "INCREASES_NET_PAY",
    sourceAuthority: "CRA",
    sourceTitle: "Employers' Guide – Taxable Benefits and Allowances (T4130)",
    sourceReference: "T4130 — Allowances (taxable cash allowances are included in employment income, CPP pensionable, and EI insurable).",
    sourceLastVerifiedAt: "2026-09-09",
    notes:
      "Applies to any flat taxable cash allowance paid to the employee (e.g. cell phone, tool, travel not " +
      "reconciled to receipts). Where the allowance is a reimbursement of accountable business expenses, use " +
      "the REIMBURSEMENT category and a non-taxable classification instead.",
    version: "1.0.0",
  },
] as const;

// -------------------------------------------------------------------
// Lookup + validation
// -------------------------------------------------------------------

export interface RuleLookupInput {
  ruleKey: string;
  variant?: StatutoryRuleVariant;
  jurisdiction: { country: "CA"; province?: string | null };
  /** Pay date the rule must be effective for. */
  asOf: Date;
}

export function findLibraryRule(input: RuleLookupInput): StatutoryLibraryRule | null {
  const asOfIso = input.asOf.toISOString().slice(0, 10);
  return RULES.find((r) =>
    r.ruleKey === input.ruleKey &&
    (input.variant ? r.variant === input.variant : true) &&
    r.jurisdiction.country === input.jurisdiction.country &&
    r.effectiveFrom <= asOfIso &&
    (r.effectiveTo == null || asOfIso <= r.effectiveTo),
  ) ?? null;
}

/**
 * Fail-closed validator (§15 of the brief). A component may only
 * claim SPECTRE_LIBRARY when a matching, currently-effective rule
 * exists. No silent fallback to CUSTOM.
 */
export function assertLibraryRuleResolves(input: RuleLookupInput): StatutoryLibraryRule {
  const r = findLibraryRule(input);
  if (!r) {
    throw new Error(
      `SPECTRE_LIBRARY rule not found: key=${input.ruleKey} ` +
      `variant=${input.variant ?? "DEFAULT"} country=${input.jurisdiction.country} ` +
      `asOf=${input.asOf.toISOString().slice(0, 10)}. ` +
      `Adding a rule requires a code migration; components cannot claim SPECTRE_LIBRARY without a rule.`,
    );
  }
  return r;
}
