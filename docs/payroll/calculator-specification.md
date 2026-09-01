# Spectre Payroll — Canada / Alberta Gross-to-Net Calculator Specification

**Slice:** Payroll-3B-5B-1b (verification + corrections) — implementation lands in 3B-5B-2.
**Status:** SPECIFICATION ONLY. Zero dollar arithmetic in this slice.
**Jurisdiction:** Canada federal + Alberta MVP. Quebec out of scope; the resolver refuses non-`AB` provinces loudly at calculation time.

Every numeric CRA parameter (rate, maximum, YMPE, YAMPE, YBE, MIE, bracket threshold, K-factor, BPA) comes from the pinned `PayrollStatutoryPackage.paramsJson` for the pay date — never embedded in code. H1 (T4127 122nd Edition) and H2 (T4127 123rd Edition) 2026 packages are seeded via `src/lib/payroll/statutory/seed-ca-ab-2026.ts` with full CRA provenance.

---

## 1. Calculator contract

```
calculatePayrollBatch(inputs: {
  batch: PreparedBatchView,                       // 3B-4 / 3B-5A frozen snapshot
  statutoryPackage: ResolvedStatutoryPackage,     // pinned via resolveStatutoryPackage(payDate)
  ytdByEmployee: Map<employeeId, EmployeePayrollYtd>,   // this-employer YTD only (§9-10)
  cppElectionsByEmployee?: Map<employeeId, CppElectionView[]>,
  cppDisabilitiesByEmployee?: Map<employeeId, CppDisabilityView[]>,
  taxProfilesByEmployee: Map<employeeId, EmployeeTaxProfileWithTd1>,
  periodsPerYearByPayGroup: Map<payGroupId, number>,    // P — see §2
}): CalculatedPayrollResult
```

Pure function. Same inputs → byte-identical outputs. The calculator writes result columns on `PayrollBatchEmployee` and NEVER mutates the frozen snapshot.

## 2. P — actual pay-period count (§5)

`P` is the actual number of pay periods this Pay Group runs in the calendar tax year — NEVER a hard-coded 52 / 26 / 24 / 12.

- Weekly may be 52 OR **53**.
- Biweekly may be 26 OR **27**.
- Semi-monthly is ordinarily 24.
- Monthly is 12.

Source: `resolvePeriodsPerYearFromCalendar({clubId, payGroupId, taxYear})` at `src/lib/payroll/statutory/periods-per-year.ts` counts `PayrollPayPeriod` rows whose `taxYear === year(payDate)`. The 3B-2 calendar generation guarantees deterministic period assignment; the calculator MUST NOT assume a canonical count.

The CPP basic exemption `PPBE = ybe / P` uses this actual count. A biweekly-27 year and a biweekly-26 year produce different PPBEs — this is the intended CRA-correct behaviour.

## 3. PM — pensionable months (§6, §8)

`PM` = the number of calendar months in the tax year for which the employment is CPP-pensionable. Computed by [`cppPensionableMonths(...)`](../../src/lib/payroll/statutory/cpp-pensionable-months.ts), which consumes:

- Employee DOB (age-18 and age-70 boundaries)
- ACTIVE CPT30 election history (stop / revocation)
- ACTIVE CPP disability intervals
- `deceasedOn` (from `Employee.terminationReason === "DECEASED"` + `terminationDate`)

`PM ∈ [0, 12]`. Never a tenure or hire-fraction ratio — always CRA pensionable months.

## 4. Earnings / statutory bases

Per `PayrollBatchEmployee`:

**`grossPay`** = Σ regular earnings + overtime + allowances + one-time payments per the batch snapshot.

**`earningsTaxable`** = gross + taxable-benefit allowances − CPP2 deduction (via `K3` in T4127 §Federal) − union dues − RPP contributions.

**`earningsPensionable`** = gross earnings subject to CPP per each earning row's `pensionable` flag (§18: NOT inferred from `taxable`).

**`earningsInsurable`** = gross earnings subject to EI per each earning row's `insurable` flag (also decoupled).

Per §18: allowance / earning classification uses THREE independent flags (`taxable`, `pensionable`, `insurable`) on `EmployeeAllowance` and the earning-line contract. The calculator MUST honour each independently.

## 5. CPP base + first-additional — Factor C (T4127 Chapter 6)

**CORRECTED** per Payroll-3B-5B-1b §2. The prior spec incorrectly proposed a `min(earningsPensionable, YMPE / P)` per-period ceiling — that is NOT the CRA formula and is not implemented.

**T4127 Factor C** (combined base + first-additional CPP contribution for a pay period):

```
C = min(
      (combinedMaxEE × PM / 12) − D,              // remaining prorated annual max
      combinedRateEE × max(0, PI − ybe/P)          // current-period contribution
    )
```

Where:
- `combinedMaxEE` = `Package.cpp.combinedMaxEE` (2026: 4230.45)
- `combinedRateEE` = `Package.cpp.combinedRateEE` (2026: 0.0595)
- `ybe` = `Package.cpp.ybe` (2026: 3500.00)
- `P` = pay periods per year (§2 — actual calendar count)
- `PM` = pensionable months (§3)
- `PI` = pensionable income for this pay period
- `D` = YTD Factor C contribution (this employer only — §9-10)

If `C < 0`, set to 0.

## 6. CPP base + first-additional decomposition (§C)

CRA reports Factor C as ONE combined amount but T4 reporting requires separate base + first-additional components. Spectre's decomposition rule preserves the CRA invariant:

**Invariant: `deductionCppEeBase + deductionCppEeFirstAdd == C` to the cent.**

Decomposition algorithm (single unrounded division, then rounded halves that reconcile):

```
1. Compute C via §5 (do not round yet — keep 6-dp Decimal).
2. Compute baseShare        = C × (baseRateEE / combinedRateEE)              // unrounded
3. deductionCppEeBase       = HALF_UP round(baseShare, 2)
4. deductionCppEeFirstAdd   = round(C, 2) − deductionCppEeBase
5. Assert: deductionCppEeBase + deductionCppEeFirstAdd == round(C, 2).       // to the cent
```

This "compute-combined, then split with residual to first-additional" order guarantees zero rounding drift between the CRA-reported combined amount and the T4-reported components.

Employer amounts mirror employee amounts using employer rates (identical to employee rates by statute for 2026).

**YTD caps enforced separately** on `ytdCppEE_Base ≤ prorated baseMaxEE` and `ytdCppEE_FirstAdd ≤ prorated firstAdditionalMaxEE`. The combined-cap check in §5 dominates; the split caps are structural safeguards against future rate divergence.

## 7. CPP2 — Factor C2 (T4127 Chapter 6)

**CORRECTED** per Payroll-3B-5B-1b §4. The prior spec proposed `YMPE / P` as a per-period CPP2 threshold — that is NOT the CRA formula.

**T4127 Factor C2:**

```
W = max(prior YTD pensionable, YMPE × PM / 12)

C2 = min(
       (cpp2MaxEE × PM / 12) − D2,                // remaining prorated CPP2 annual max
       cpp2RateEE × max(0, PI_YTD + PI − W)        // amount above W
     )
```

Where:
- `cpp2MaxEE` = `Package.cpp.cpp2MaxEE` (2026: 416.00)
- `cpp2RateEE` = `Package.cpp.cpp2RateEE` (2026: 0.0400)
- `YMPE` = `Package.cpp.ympe` (2026: 74600.00)
- `YAMPE` = `Package.cpp.yampe` (2026: 85000.00 — implicit YAMPE cap via `cpp2MaxEE` prorated tally)
- `PM` = pensionable months (§3)
- `PI` = pensionable income this pay
- `PI_YTD` = pensionable YTD before this pay (this employer only)
- `D2` = YTD CPP2 contribution (this employer only)

If `C2 < 0`, set to 0.

Employer CPP2 mirrors with `cpp2RateER` (equal to EE for 2026).

## 8. EI — annual max cap (T4127 Chapter 7)

```
EI_EE = min(
          Package.ei.maxAnnualPremiumEE − ytdEiEE,
          Package.ei.rateEE × min(PI_ei, Package.ei.mie − ytdInsurableEarnings)
        )
```

**Never a per-period MIE slice.** The published `maxAnnualPremiumEE` (2026: 1123.07) is authoritative — do NOT recompute it from `mie × rate` (§13 rule).

`EI_ER` uses `Package.ei.rateER` (2026: 0.02282) and `Package.ei.maxAnnualPremiumER` (2026: 1572.30). The employer multiplier (1.4) is documentation metadata only.

## 9. Federal income tax (T4127 §Federal) — CORRECTED per Final CPP Additional-Contribution Correction (2026-08-31)

**Reconciled against T4127's actual K-factor vocabulary and its actual CPP additional-contribution deduction path (F5 / F5A / F5B).** Prior drafts described:

- `K3` as *"federal CPP2 deduction from taxable income"* — WRONG (removed).
- `K2` as bundling *"CPP base + first-additional + CPP2, plus EI"* via `P × (0.0495 / 0.0595) × (C + C2)` — WRONG (removed).

T4127 actually restricts K2 to **BASE CPP + EI only**. First-additional CPP and CPP2 flow through **`F5A` — CPP/QPP additional contributions deducted from periodic income** — and therefore reduce annual taxable income `A`, not through a K-factor tax credit.

### 9a. Formula variables (T4127 §Federal)

| Variable | Meaning | Source in T4127 |
|-|-|-|
| `P` | Number of pay periods per year (§2 — actual calendar count) | T4127 §Definitions |
| `I` | Gross remuneration for the pay period (including taxable benefits and allowances) | T4127 §Definitions |
| `F` | Employee RPP contribution this pay period (MVP: BLOCKER — see §19d) | T4127 §Definitions |
| `F1` | Alimony / maintenance deducted this pay period (MVP: BLOCKER) | T4127 §Definitions |
| `F2` | Annualised alimony / maintenance (MVP: BLOCKER) | T4127 §Definitions |
| `U1` | Annualised union dues (MVP: BLOCKER) | T4127 §Definitions |
| `HD` | Annualised deductions from income (union dues, other) (MVP: BLOCKER) | T4127 §Definitions |
| `F5` | Deductions for CPP additional contributions **for the pay period** — the umbrella variable that resolves to F5A for periodic income and F5B for non-periodic income. | T4127 §Definitions |
| `F5A` | **CPP/QPP additional contributions deducted from PERIODIC income.** For the Alberta MVP: `F5A = C_firstAdd + C2` per pay period. See §9f. | T4127 §Definitions |
| `F5B` | CPP/QPP additional contributions deducted from NON-PERIODIC income (bonuses, retro pay). MVP has no non-periodic income → `F5B = 0`. | T4127 §Definitions |
| `A*` | **Annual gross income from office or employment BEFORE any deductions.** Used ONLY for the K4 (Canada Employment Amount) test. Distinct from `A` — see §9c. | T4127 §K4 |
| `A` | **Projected annual taxable income** = `P × (I − F − F1 − F5A) + HD − F2 − U1 − F5B`. Used for the rate/K lookup in §9b and for BPAF phase-out. **Note: F5A is subtracted from `I` before annualising by P** — this is where CPP first-additional + CPP2 exit the taxable-income base. | T4127 §Formula |
| `R` | Federal bracket RATE for `A` | T4127 Table 8.1 |
| `K` | Federal bracket CONSTANT for `A` | T4127 Table 8.1 |
| `T` | Federal basic tax = `R × A − K` (before non-refundable credits) | T4127 §Formula |
| `T3` | Federal income tax on annualised income after non-refundable credits — `T − K1 − K2 − K3 − K4` | T4127 §Formula |
| `T4` | Federal income tax withheld per pay period — `max(0, round(T3 / P) + additionalFederalTaxAmount)` | T4127 §Formula |

### 9b. K-factor glossary (verbatim T4127 §K1-K4)

| Factor | T4127 verbatim meaning | Formula (CRA) | Employee facts required |
|-|-|-|-|
| `K1` | Federal non-refundable personal tax credit for the year (Basic Personal Amount + TD1F Total Claim Amount, income-tiered per Bill C-30). | `federal.lowestRate × BPAF + federal.lowestRate × TCF_over_BPA` where `BPAF` is the income-tiered federal BPA (see §9d) and `TCF_over_BPA` is the portion of the TD1F Total Claim Amount above BPA. | Decrypted TD1F total claim, `A` (for BPAF tier). |
| `K2` | **Federal non-refundable tax credit for BASE CPP contributions and EI premiums.** T4127 §K2 covers ONLY these two. It does NOT credit CPP first-additional and does NOT credit CPP2. | `federal.lowestRate × [ P × C × (0.0495 / 0.0595) + P × EI ]` — subject to the applicable annual base-CPP maximum and PM proration. The `(0.0495 / 0.0595)` ratio extracts the BASE portion of Factor C (base + first-additional at 5.95%); the residual first-additional portion goes to `F5A`. `EI` is the per-period EI premium at full rate. | Payroll-calculated `baseCppForTaxCredit` (base share of Factor C) and `EI`. |
| `K3` | **Other federal tax credits authorised by a tax services office or a Canada Revenue Agency tax centre.** — T4127 §K3 verbatim. NOT the CPP2 deduction. NOT the CPP first-additional deduction. `K3 = 0` for every ordinary MVP calculation. | `0` for MVP. Future slice: read `EmployeeTaxProfile.federalOtherAuthorizedCredits` when a CRA letter is on file. | Authorisation letter reference (not modelled in MVP). |
| `K4` | Canada Employment Amount (CEA) credit. Applies to income from office or employment only. | `federal.lowestRate × min(A*, canadaEmploymentAmountMax)`. **`A*` is the ANNUAL GROSS EMPLOYMENT INCOME (before deductions), not `A`.** For 2026: `canadaEmploymentAmountMax = 1501` (T4127 123rd Edition Table 8.2, officially verified). | Annual gross employment income for the year. |

### 9c. K4 employment-income distinction (T4127 §K4)

T4127 uses TWO distinct income concepts within the federal formula and Spectre's implementation MUST preserve the distinction:

- **`A` = projected annual TAXABLE income** — used for the rate/K bracket lookup and BPAF phase-out. Reduced by `F`, `F1`, `F5A`, `F5B`, `HD`, `F2`, `U1`. This is the value that flows through `T = R × A − K`.
- **`A*` = annual GROSS EMPLOYMENT income** (income from office or employment before any deductions). Used ONLY inside `K4 = federal.lowestRate × min(A*, canadaEmploymentAmountMax)`.

In the MVP where `F/F1/HD/F2/U1 = 0` (all BLOCKERs) but `F5A` is calculated by Payroll for every pensionable employee: `A = P × (I − F5A)` and `A* = P × I`. **These are DIFFERENT the moment any pensionable earnings exist** — CPP first-additional + CPP2 shrink `A` below `A*` even for the base MVP employee. The calculator MUST expose the two as distinct named quantities.

### 9d. BPAF tier (Bill C-30 phase-out)

- `A ≤ Package.federal.bpaPhaseOutStart` → `BPAF = bpaMax` (2026: 16452)
- `A ≥ Package.federal.bpaPhaseOutEnd` → `BPAF = bpaMin` (2026: 14829)
- Between → linear interpolation per T4127 §K1

### 9e. CPP additional contribution treatment — T4127 F5 / F5A / F5B (CORRECTION)

**T4127 places CPP first-additional and CPP2 in a deduction-from-income path (F5 family), NOT in any tax-credit K-factor.**

The three T4127-defined variables:

| Variable | Definition (T4127) |
|-|-|
| `F5` | Deductions for CPP additional contributions **for the pay period.** Sum of periodic + non-periodic portions. |
| `F5A` | CPP/QPP additional contributions deducted from **periodic income** for the pay period. |
| `F5B` | CPP/QPP additional contributions deducted from **non-periodic income** for the pay period. |

**Spectre Alberta MVP mapping — periodic remuneration only, no non-periodic income:**

```
C_firstAdd_thisPay = round(C, 2) − round(C × (0.0495 / 0.0595), 2)   // Spectre decomposition §6 (unchanged)
F5A_thisPay        = C_firstAdd_thisPay + C2_thisPay                  // CPP first-additional + CPP2
F5B_thisPay        = 0                                                // MVP has no non-periodic income
F5_thisPay         = F5A_thisPay + F5B_thisPay = F5A_thisPay
```

`F5A` reduces the per-period `I` before annualising by `P`, so it enters `A` through the `P × (I − F − F1 − F5A)` term in §9a.

**What this eliminates:**

- CPP first-additional MUST NOT appear in `K2` (or `K2P`) as a tax credit — it is a deduction from `A`.
- CPP2 MUST NOT appear in `K2` / `K2P` / `K3` / `K3P` — it is a deduction from `A` via `F5A`.
- The prior `federal.cpp2DeductionRate` package field survives as a **deprecated Spectre-internal helper** for schema compatibility (checksum stability) but the calculator MUST NOT consume it. The rate baked into `F5A`'s effect on `A` is not a separate multiplier — it emerges naturally from the bracket lookup on the reduced `A`.

**Concrete implication for the 3B-5B-2 calculator:**

1. Compute `C` (Factor C — combined base + first-additional at 5.95%) and `C2` (Factor C2 — second-additional at 4.00%) per §5, §7.
2. Compute `baseCppForTaxCredit = C × (0.0495 / 0.0595)` (unrounded until final line) → feeds K2/K2P.
3. Compute `C_firstAdd = round(C, 2) − round(baseCppForTaxCredit, 2)` → feeds F5A.
4. Compute `F5A_thisPay = C_firstAdd + C2` → subtract from `I` in the `A` formula.
5. Apply K2 / K2P using ONLY `baseCppForTaxCredit + EI` — never `+ CPP first-additional`, never `+ C2`.

Any 3B-5B-2 calculator output that:
- adds CPP first-additional or CPP2 to K2 or K2P,
- puts CPP first-additional or CPP2 in K3 or K3P,
- fails to reduce `A` by `F5A`,

is a defect against this specification.

### 9f. Factor C / C2 → F5A → K2 mapping (single source of truth)

The precise mapping the calculator must enforce:

| Quantity | Formula | Consumed by |
|-|-|-|
| `C` (Factor C, per pay period) | `min((combinedMaxEE × PM/12 − D), combinedRateEE × max(0, PI − ybe/P))` (§5) | Decomposition below |
| `C_base` (unrounded base share) | `C × (0.0495 / 0.0595)` — the "baseCppForTaxCredit" | K2, K2P (tax credits) |
| `deductionCppEeBase` (rounded, persisted) | `HALF_UP round(C_base, 2)` | T4 base-CPP box; net-pay deduction |
| `deductionCppEeFirstAdd` (residual, persisted) | `round(C, 2) − deductionCppEeBase` | T4 first-additional-CPP box; net-pay deduction; **F5A input** |
| `C2` (Factor C2, per pay period) | Per §7 formula | Net-pay deduction; T4 CPP2 box; **F5A input** |
| `F5A_thisPay` | `deductionCppEeFirstAdd + C2` | Subtractor in `A = P × (I − F − F1 − F5A) + HD − F2 − U1 − F5B` |
| `K2` | `federal.lowestRate × (P × C_base + P × EI)` | `T3 = T − K1 − K2 − K3 − K4` |
| `K2P` | `provincial.lowestRate × (P × C_base + P × EI)` | `T3P = TP − K1P − K2P − K3P − K5P` |

**Invariant** (unchanged from 3B-5B-1 §6): `deductionCppEeBase + deductionCppEeFirstAdd == round(C, 2)` to the cent.

## 10. Alberta provincial tax — CORRECTED per Final CPP Additional-Contribution Correction (2026-08-31)

Same shape as federal, applied to `Package.provincial.brackets[]` (2026: 6 brackets, `V` = rate, `KP` = bracket constant) + `Package.provincial.bpa` (2026: 22,769). Same `F5A` treatment as §9e — CPP first-additional and CPP2 reduce the Alberta `A` via `F5A`; they do NOT flow to K2P or K3P.

### 10a. Alberta K-factor glossary (verbatim T4127 §Alberta)

| Factor | T4127 verbatim meaning | Formula (CRA) | MVP status |
|-|-|-|-|
| `K1P` | Alberta non-refundable personal tax credit for the year. | `provincial.lowestRate × (Alberta BPA + TCP_over_BPA)` where `TCP_over_BPA` is TD1AB Total Claim above BPA. | ✅ supported |
| `K2P` | **Alberta non-refundable tax credit for BASE CPP contributions and EI premiums.** T4127 §K2P covers ONLY these two — same base-only rule as federal K2. It does NOT credit CPP first-additional and does NOT credit CPP2. | `provincial.lowestRate × [ P × C × (0.0495 / 0.0595) + P × EI ]` — subject to base-CPP annual maximum + PM proration. `EI` at full rate. | ✅ supported |
| `K3P` | **Other Alberta tax credits authorised by a tax services office or a Canada Revenue Agency tax centre.** NOT the Alberta CPP2 deduction. NOT the Alberta CPP first-additional deduction. `K3P = 0` for every ordinary MVP calculation. | `0` for MVP. | ✅ supported (structural zero) |
| `K4P` | *(No K4P factor exists in T4127 §Alberta.)* | *n/a* | ⛔ **STATUTORY NON-APPLICABILITY** — the Canada Employment Amount is a federal-only credit; Alberta's withholding formula does not carry a K4P analogue. This is NOT an MVP exclusion. |
| `K5P` | Alberta supplemental credit — see §10c. | `max(0, ((K1P + K2P) − threshold) × (supplementalRate / baseRate))` — CRA: `max(0, ((K1P + K2P) − 4896.00) × 0.25)` | ✅ supported |

### 10b. Alberta withholding chain

```
A_prov = P × (I − F − F1 − F5A) + HD − F2 − U1 − F5B    // same F5A-reduced A as federal
TP     = V × A_prov − KP                                 // Alberta basic tax before credits
T3P    = TP − K1P − K2P − K3P − K5P                      // K4P statutorily n/a; K3P = 0 in MVP
T4P    = max(0, round(T3P / P) + additionalProvincialTaxAmount)
```

The provincial `A` is the SAME reduced-by-F5A annual taxable income used federally — F5A subtracts from `I` before annualising, so CPP first-additional and CPP2 shrink `A_prov` before the Alberta bracket lookup.

Prior drafts subtracting `K2AP` or `K4P` in T3P are superseded — neither is a T4127 subtractor.

### 10c. Alberta K5P specification

**VERIFIED CRA FORMULA (T4127 122nd Edition §Alberta; inherited by 123rd):**
```
K5P = max(0, ((K1P + K2P) − 4896.00) × 0.25)
```

`Package.provincial.k5p` is a required field on the pinned Alberta package — never absent. Structure:

| Field | 2026 Value | Meaning |
|-|-|-|
| `enabled: Boolean` | `true` | `true` → apply K5P per the formula. `false` → deliberate non-application (documented, never silent). |
| `threshold: Decimal` | `"4896"` | CRA-published dollar threshold applied to (K1P + K2P). |
| `supplementalRate: Decimal` | `"0.02"` | Numerator of the "2%-over-8%" differential. |
| `baseRate: Decimal` | `"0.08"` | Alberta first-bracket rate — denominator of the differential. `0.02 / 0.08 = 0.25` mathematically equivalent to CRA's published `× 0.25`. |
| `sourceCitation: String` | *see seeder* | Verbatim CRA citation. T4127 122nd Edition §Alberta; H2 (123rd) reproduces only sections changed effective July 1 — Alberta K5P was NOT identified as changed. |

If `enabled === false`, `K5P = 0` as a deliberate, documented package decision.

### 10d. CPP additional contribution treatment in Alberta — F5A path, not K2P/K3P

Same rule as §9e federally: T4127 routes CPP first-additional and CPP2 through `F5A` (a deduction reducing periodic `I` and hence `A_prov`), NOT through `K2P` (BASE CPP + EI only) and NOT through `K3P` (letter-authority only). Any calculation that:

- adds CPP first-additional or CPP2 to `K2P`,
- puts CPP first-additional or CPP2 in `K3P`,
- fails to reduce `A_prov` by `F5A`,

is a defect against this specification.

## 11. TD1 source facts — verified contract (§16-17)

TD1 fields on `EmployeeTaxProfile`:

| Field | Behaviour |
|-|-|
| `federalClaimSecretRef` | KMS-wrapped TD1F claim amount. When decrypted total = 0 or `claimZeroFederal = true` → BPA only NOT applied. |
| `provincialClaimSecretRef` | Alberta TD1 total. Same behaviour. |
| `additionalFederalTaxAmount` | ADDED to `T4` AFTER formula. Never modifies `T3`. |
| `additionalProvincialTaxAmount` | ADDED to `T4Prov`. |
| `claimZeroFederal` | TD1 "more than one employer/payer" flag. When true → federal claim = 0 (no BPA). |
| `claimZeroProvincial` | Alberta TD1 equivalent. |
| `totalIncomeLessThanClaim` | TD1 "total income less than total claim amount — no tax withheld" flag. When true → `T4 = additionalFederalTaxAmount` (i.e. WITHHOLD NOTHING from the formula, plus any voluntary additional tax). Same for provincial. |

**No federal / Alberta TD1 on file** → federal BPA + Alberta BPA respectively, no additional claim credits (per CRA guidance to employers when TD1 is not received).

## 12. Net pay

```
netPay = grossPay
       − deductionCppEeBase − deductionCppEeFirstAdd
       − deductionCpp2Ee
       − deductionEiEe
       − deductionFederalTax
       − deductionProvincialTax
       − Σ other post-tax deductions (MVP: zero)
```

## 13. YTD (§9-10)

YTD includes ONLY:

- ACTIVE `PayrollOpeningBalance` where `priorPayrollKind ∈ {PRIOR_SYSTEM_SAME_EMPLOYER, PRIOR_ADJUSTMENT}`.
- POSTED `PayrollBatch` for this employer (payDate < asOf, taxYear match).

`PRIOR_EMPLOYER` opening balances contribute **ZERO** to every YTD category — gross, taxable, pensionable, insurable, CPP, CPP2, EI, federal tax, provincial tax, all employer contributions. Different employers/BNs calculate CPP + EI + tax independently per CRA; the employee may recover overcontributions on their personal return.

`getEmployeePayrollYtd` enforces this. The row remains recorded (for HR reference) but its values are hidden from THIS employer's YTD aggregate.

## 14. Salary proration — Spectre business policy (§19)

Spectre calendar-day proration:

```
periodBaseSalary = annualSalary / P
prorated         = periodBaseSalary × (coverageDays / periodDays)
```

**This is Spectre compensation policy, NOT a CPP statutory formula.** Statutory deductions operate on the resulting remuneration; they do NOT prorate based on coverageDays themselves. `PM` (pensionable months) handles CPP proration separately.

## 15. Allowance conversion (§18)

`EmployeeAllowance.frequency` → per-period amount:

| Frequency | Formula |
|-|-|
| `PER_PAY_PERIOD` | 1 × amount |
| `MONTHLY` | `amount × 12 / P` |
| `BIWEEKLY` | `amount × 26 / P` (**note:** normalised by ACTUAL P) |
| `WEEKLY` | `amount × 52 / P` |
| `ANNUAL` | `amount / P` |
| `ONE_TIME` | Applied once at effective date |
| Other | BLOCKER `UNSUPPORTED_ALLOWANCE_FREQUENCY` |

Contribution to statutory bases uses independent `taxable / pensionable / insurable` flags (§18 rule — never inferred from any single Boolean).

## 16. Rounding (§9 verification correction)

**Two distinct concepts, never conflated:**

### 16a. Statutory instruction (what CRA REQUIRES)

Recorded verbatim on the pinned package at `Package.rounding.statutoryInstruction`. 2026 CRA-published wording (T4127):

> *"T4127 §6: CPP and CPP2 contributions rounded to the nearest cent. T4127 §5: federal + provincial income tax withheld per pay period rounded to the nearest cent (CRA also permits nearest $0.05 for legacy manual computations)."*

CRA specifies **the target precision** ("nearest cent") but does NOT prescribe a specific tie-breaking algorithm. HALF_UP, HALF_EVEN, and half-away-from-zero all satisfy "nearest cent" for the vast majority of values; they differ only when the fractional portion is exactly `.5` at the rounding boundary. In production payroll this is a fractional-cent edge case per pay line.

### 16b. Spectre implementation convention (what Spectre USES)

Recorded on the pinned package at `Package.rounding.mode` / `Package.rounding.netPayMode`. Spectre's MVP convention:

- `mode = HALF_UP` for CPP base / first-additional / CPP2 / EI / federal `T4` / Alberta `T4Prov`.
- `netPayMode = HALF_UP` for net pay.
- Every intermediate uses `Decimal` at ≥6 fractional digits precision — never JS floating point.
- MVP always rounds to **nearest $0.01**. Nickel-rounding (nearest $0.05) is out of MVP scope. **Not tenant-configurable** — CRA does not permit tenants to select tie-breaking behaviour.
- **Annual-max comparison:** compare `unroundedSlice × unroundedRate` against unrounded max, then ROUND the final line only.

The Spectre-side HALF_UP convention is a deterministic choice for tie-breaks when CRA is silent. If a future CRA-verified audit calls for HALF_EVEN on any specific line item, the package parameter permits the change without code churn.

## 17. CPP base/first-additional decomposition — reconciled against corrected T4127 K2

**CORRECTED per Final CPP Additional-Contribution Correction (2026-08-31).** Prior spec text described K2 as `P × (0.0495 / 0.0595) × [C1 + C2]` — that bundled CPP2 into K2's credit path, which is wrong. See §9b and §9e for the corrected treatment.

Spectre's decomposition of Factor C into base + first-additional serves TWO downstream consumers:

```
baseShare       = C × (baseRateEE / combinedRateEE)         // 0.0495/0.0595 — unrounded
deductionBase   = HALF_UP round(baseShare, 2)               // persists on PayrollBatchEmployee
deductionFirst  = round(C, 2) − deductionBase               // residual, persists
```

| Consumer | Uses |
|-|-|
| K2 / K2P (tax credit) | `baseShare` (unrounded until final line) — see §9b, §10a. **Only the BASE portion feeds K2/K2P — never `deductionFirst`, never `C2`.** |
| F5A (deduction from A) | `deductionFirst + C2` — see §9e, §9f. **Both the first-additional portion AND C2 flow through F5A, reducing `A` / `A_prov`.** |
| T4 reporting | `deductionBase` populates the base-CPP box; `deductionFirst` populates the first-additional-CPP box; `deductionCpp2Ee` populates the CPP2 box. Three separate boxes, cent-reconciled. |
| Net pay | `deductionBase + deductionFirst + deductionCpp2Ee` all subtract from gross pay (unchanged from §12). |

**Reconciliation invariants (tested):**
1. `deductionBase + deductionFirst == round(C, 2)` to the cent (Spectre decomposition invariant, unchanged).
2. K2 (federal) uses `baseShare` (or `deductionBase` as the persisted rounded form) — **not `round(C, 2)`, not `+ C2`**.
3. K2P (Alberta) uses the same `baseShare` — **not `round(C, 2)`, not `+ C2`**.
4. F5A per pay period = `deductionFirst + C2`. `F5B = 0` for MVP.
5. `A` and `A_prov` both subtract `P × F5A` (via subtracting F5A from I before annualising by P).

## 18a. Statutory package pinning

```
PREPARED
 → calculation begins
 → resolveStatutoryPackage({country, province, payDate}) → ResolvedStatutoryPackage
 → PayrollBatch.statutoryPackageId ← package.id
 → calculation writes result columns on PayrollBatchEmployee
 → transition PREPARED → CALCULATED
```

Once pinned, recalculating the same frozen batch reuses the exact package. Void-and-recalculate is the only path to change a POSTED batch's statutory package.

## 18b. Work Intake (§25)

`PAYROLL_REVIEW` stays OPEN. No `PAYROLL_FINAL_APPROVAL` in 3B-5B-1x. The 3B-5B-2 calculator transitions REVIEW → RESOLVED on successful calculation and materialises FINAL_APPROVAL for the Controller.

---

## 19. Final credit-factor matrix (Final CPP Additional-Contribution Correction — 2026-08-31)

Definitive contract for every K/KP factor and F5 subvariable the calculator must handle, **rebuilt from CRA T4127 vocabulary**. Only actual T4127 factors appear as tax-credit or income-deduction rows. Spectre-internal helpers (`K2A`, `K2AP`, `cpp2DeductionRate`) are identified in §19c and MUST NOT be represented as CRA factors.

### 19a. Federal factors (T4127 §Federal K1–K4 + F5 family)

| Factor | T4127 vocabulary | Formula (CRA verbatim) | Statutory-package parameters | MVP status |
|-|-|-|-|-|
| `K1` | Federal non-refundable personal tax credit (BPA + TD1F Total Claim, income-tiered per Bill C-30). | `federal.lowestRate × BPAF + federal.lowestRate × TCF_over_BPA` | `federal.bpaMax / bpaMin / phaseOutStart / phaseOutEnd / lowestRate` | ✅ supported |
| `K2` | **Federal non-refundable tax credit for BASE CPP contributions and EI premiums.** ONLY these two. Does NOT credit CPP first-additional. Does NOT credit CPP2. | `federal.lowestRate × [ P × C × (0.0495 / 0.0595) + P × EI ]` — subject to base-CPP annual max + PM proration. | `federal.lowestRate`, `cpp.baseRateEE`, `cpp.combinedRateEE` | ✅ supported |
| `K3` | Other federal tax credits authorised by a tax services office or a CRA tax centre. **NOT any CPP deduction.** | `0` for MVP (no letter authority modelled). | *none* | ✅ supported (structural zero) |
| `K4` | Canada Employment Amount credit. Applies to income from office or employment. | `federal.lowestRate × min(A*, canadaEmploymentAmountMax)` where **`A*` = annual GROSS employment income** (not `A`). | `federal.lowestRate`, `federal.canadaEmploymentAmountMax` (2026: `"1501"` — T4127 123rd Edition Table 8.2, officially verified). | ✅ supported |
| `F5` | Deductions for CPP additional contributions **for the pay period.** Umbrella = F5A + F5B. | *see F5A / F5B* | *none* | ✅ supported |
| `F5A` | **CPP/QPP additional contributions deducted from PERIODIC income.** Reduces `I` before annualising by `P`, therefore reduces `A`. For Alberta MVP: `F5A = deductionCppEeFirstAdd + deductionCpp2Ee`. | Subtracted in `A = P × (I − F − F1 − F5A) + HD − F2 − U1 − F5B` | *none* — computed by Payroll | ✅ supported |
| `F5B` | CPP/QPP additional contributions deducted from NON-PERIODIC income (bonuses, retro pay). | `0` for MVP (no non-periodic income modelled). | *none* | ✅ supported (structural zero) |

### 19b. Alberta factors (T4127 §Alberta K1P–K5P + F5 family — shared)

| Factor | T4127 vocabulary | Formula (CRA verbatim) | Statutory-package parameters | MVP status |
|-|-|-|-|-|
| `K1P` | Alberta non-refundable personal tax credit (BPA + TD1AB Total Claim). | `provincial.lowestRate × (provincial.bpa + TCP_over_BPA)` | `provincial.bpa`, `provincial.lowestRate` | ✅ supported |
| `K2P` | **Alberta non-refundable tax credit for BASE CPP contributions and EI premiums.** ONLY these two. Does NOT credit CPP first-additional. Does NOT credit CPP2. | `provincial.lowestRate × [ P × C × (0.0495 / 0.0595) + P × EI ]` | `provincial.lowestRate`, CPP rates | ✅ supported |
| `K3P` | Other Alberta tax credits authorised by a tax services office or a CRA tax centre. **NOT any CPP deduction.** | `0` for MVP. | *none* | ✅ supported (structural zero) |
| `K4P` | *(No K4P factor exists in T4127 §Alberta.)* | *n/a* | *n/a* | ⛔ **STATUTORY NON-APPLICABILITY** — the Canada Employment Amount is a federal-only credit; Alberta's withholding formula does NOT carry a K4P analogue. This is NOT an MVP exclusion — a future Alberta K4P would require a CRA T4127 change, at which point add `provincial.canadaEmploymentAmountMax` and re-run this matrix. |
| `K5P` | Alberta supplemental credit factor. | `max(0, ((K1P + K2P) − 4896.00) × 0.25)` — package encoding: `max(0, ((K1P + K2P) − threshold) × (supplementalRate / baseRate))` with `threshold=4896, supplementalRate=0.02, baseRate=0.08`. Mathematically equivalent to CRA's `× 0.25`. | `provincial.k5p.threshold / supplementalRate / baseRate` | ✅ supported |

### 19c. Spectre-internal helpers (NOT T4127 factors) — explicit disclosure

The following names appeared in earlier drafts and could be mistaken for CRA vocabulary. They are **Spectre-internal decompositions**, not T4127 factors, and MUST NOT be surfaced as if they were CRA-defined:

| Spectre helper name | Actual T4127 role | Correct handling |
|-|-|-|
| `K2A` | Spectre's internal breakout of the EI portion of K2. **T4127 defines no `K2A`.** | Rename any internal accessor to `spectreEiPortionOfK2` (or similar). Never emit as a separate line item on T4 reports, board packages, or the withholding chain. CRA sees ONE `K2`. |
| `K2AP` | Spectre's internal breakout of the EI portion of K2P. **T4127 defines no `K2AP`.** | Rename to `spectreEiPortionOfK2P`. Same rule — CRA sees ONE `K2P`. |
| `federal.cpp2DeductionRate` | Historical field on the statutory package that assumed CPP2 had its own K3-style deduction. **T4127 actually routes CPP2 through the F5/F5A income-deduction path (§9e/§9f), NOT through K2 and NOT through K3.** | Package field is unused by the corrected calculator; retained for schema-compatibility only (preserves paramsJson checksum stability) and slated for removal in a future schema migration. The corrected calculator computes F5A = `deductionCppEeFirstAdd + deductionCpp2Ee` and subtracts it from `I` before annualising by `P` — no separate "K3 CPP2" or "K2 CPP2" multiplier. |

### 19d. Unsupported tax inputs → explicit blockers

The following T4127 source facts EXIST in the full CRA formula but are NOT modelled in the MVP. Any Employee for whom these apply causes the calculator to raise a `PayrollBatchException` BLOCKER — the calculator NEVER silently substitutes zero.

| Input | Formula impact | MVP handling |
|-|-|-|
| `F` — RPP contributions per pay period | Reduces annualised net taxable income `A` | Not represented on EmployeeCompensation or a canonical deduction row. Calculator BLOCKER `UNSUPPORTED_RPP_DEDUCTION` if any earning has an RPP flag or if `PayrollProfile.rppContribution` is set. |
| `F1` — Alimony / maintenance per pay period | Same | Not represented. Calculator BLOCKER `UNSUPPORTED_ALIMONY_DEDUCTION`. |
| `HD` — Annual deductions from income | Reduces `A` | Not represented. Calculator BLOCKER `UNSUPPORTED_ANNUAL_DEDUCTION`. |
| `F2` — Annualised alimony / maintenance | Same | Not represented. Same blocker as F1. |
| `U1` — Annualised union dues | Reduces `A` | Not represented on any canonical Payroll model. Calculator BLOCKER `UNSUPPORTED_UNION_DUES` if the founder's Club has unionised staff. |
| Prescribed-zone deductions | Federal deduction on TD1F line 10 | Not represented. Calculator BLOCKER `UNSUPPORTED_PRESCRIBED_ZONE`. |

Adding any of these is a deliberate future slice — never a silent zero in the calculator. The BLOCKER surfaces on batch preparation so the Payroll Admin sees exactly which employee is not calculable and why.

## Verification gate before 3B-5B-2 implementation

1. H1 + H2 packages installed via `seedCanadaAlbertaPackages2026`. Federal-tax `brackets[]` MUST be replaced with the CRA-T4127 122nd/123rd Edition federal-tax bracket table.
2. Every scenario in `tests/payroll/fixtures/2026/ca-ab/scenarios.json` must carry an `expected` value derived independently from CRA T4127 worked examples OR CRA PDOC — never from Spectre's own calculator.
3. `resolvePeriodsPerYearFromCalendar` must be called by the calculator; never a hard-coded literal.
4. TD1 behaviour re-verified against the current CRA guidance for missing / zero / additional-tax combinations.
5. Allowance statutory-classification decouple applied through the earning-line + snapshot chain.
