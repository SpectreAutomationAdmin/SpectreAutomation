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

## 9. Federal income tax (T4127 §Federal)

Full formula chain:

| Variable | Meaning |
|-|-|
| `P` | Pay periods per year (§2) |
| `I` | Gross remuneration this period |
| `F` | Employee RPP contribution this period |
| `F1` | Alimony / maintenance this period |
| `A` | `P × (I − F − F1) + HD − F2 − U1` |
| `HD` | Annualised deductions from income (as declared) |
| `F2` | Annualised alimony / maintenance |
| `U1` | Annualised union dues |
| `R` | Federal bracket rate for `A` |
| `K` | Bracket constant K |
| `K1` | `Package.federal.lowestRate × BPAF` |
| `BPAF` | Federal BPA (income-tiered per §K1 rule below) |
| `K2` | `Package.federal.lowestRate × annualised (CPP base + first-additional employee contributions)` |
| `K2A` | `Package.federal.lowestRate × annualised EI premiums` |
| `K3` | `Package.federal.cpp2DeductionRate × annualised CPP2` |
| `K4` | `Package.federal.lowestRate × min(annualised employment income, CEA_MAX)` |
| `T3` | `(R × A − K) − K1 − K2 − K2A − K3 − K4` |
| `T4` | `max(0, round(T3 / P) + additionalFederalTaxAmount)` |

**BPAF tier (Bill C-30 phase-out):**
- `A ≤ Package.federal.bpaPhaseOutStart` → `BPAF = bpaMax` (2026: 16452)
- `A ≥ Package.federal.bpaPhaseOutEnd` → `BPAF = bpaMin` (2026: 14829)
- Between → linear interpolation per T4127 §K1

## 10. Alberta provincial tax

Same shape as federal, applied to `Package.provincial.brackets[]` (2026: 6 brackets, `V` = rate, `KP` = bracket constant) + `Package.provincial.bpa` (2026: 22,769).

Alberta credit factors, all consumed from `Package.provincial` / TD1:

| Factor | Meaning | Source |
|-|-|-|
| `K1P` | Alberta non-refundable tax credit = `Package.provincial.lowestRate × (TCP + Alberta BPA-tier)` | TD1AB |
| `K2P` | Alberta CPP tax credit = `Package.provincial.lowestRate × annualised (CPP base + first-additional)` | derived from CPP result |
| `K2AP` | Alberta EI tax credit = `Package.provincial.lowestRate × annualised EI` | derived from EI result |
| `K3P` | Alberta CPP2 deduction / credit (T4127 §Alberta) | derived from CPP2 result |
| `K4P` | Alberta employment credit (if applicable) | annualised employment income |
| `K5P` | **Alberta supplemental credit factor** — see §10a below | `Package.provincial.k5p` |

**Alberta withholding chain:**
```
T3Prov  = (V × A) − KP − K1P − K2P − K2AP − K3P − K4P − K5P
T4Prov  = max(0, round(T3Prov / P) + additionalProvincialTaxAmount)
```

### 10a. Alberta K5P specification (§H)

`Package.provincial.k5p` is a required field on the pinned Alberta package — never absent. Structure:

| Field | Meaning |
|-|-|
| `enabled: Boolean` | `true` → the calculator applies K5P per the formula below. `false` → K5P is explicitly documented as not applying this year (never a silent default). |
| `triggerBase: Decimal` | Annualised Alberta tax base above which K5P applies. 2026 draft: `4800`. |
| `rate: Decimal` | Differential rate applied to the excess above `triggerBase`. 2026 draft: `0.02` (the "2%-over-8%" structure — 2 percentage points over Alberta's first-bracket rate of 8%). |
| `sourceCitation: String` | Verbatim CRA citation for auditor visibility. |

**Formula (when `enabled === true`):**
```
K5P = k5p.rate × max(0, T_prov_base − k5p.triggerBase)
```
where `T_prov_base` is the annualised Alberta tax before K5P.

If `enabled === false`, `K5P = 0` — but that zero is a deliberate, documented package decision, never a missing-field inference.

**Pending final line-verification against T4127 122nd/123rd Editions before dollar calculation ships.** The founder-supplied structure ($4,800 trigger, 2%-over-8% differential) is encoded; the exact CRA algebraic form must be confirmed line-by-line.

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

## 17. CPP base/first-additional decomposition — verified against T4127 K2 (§10 verification)

T4127's federal K2 tax-credit formula (T4127 §K2) expresses the CPP EMPLOYEE credit as:

```
K2 = P × (0.0495 / 0.0595) × [C1 + C2]      (federal lowestRate then applied elsewhere)
```

Where `C1 + C2` are the CPP + CPP2 contributions per pay period, and the `0.0495 / 0.0595` ratio isolates the BASE component from the combined Factor C total. CRA thus uses **exactly the same base-share ratio (`baseRateEE / combinedRateEE`)** Spectre applies to decompose the calculated Factor C into base + first-additional.

**Spectre decomposition (from §6 above) mirrors CRA:**
```
baseShare       = C × (baseRateEE / combinedRateEE)         // 0.0495/0.0595
deductionBase   = HALF_UP round(baseShare, 2)
deductionFirst  = round(C, 2) − deductionBase               // residual
```

**Reconciliation invariants (tested):**
1. `deductionBase + deductionFirst == round(C, 2)` to the cent.
2. `K2 (federal)  = federalLowestRate × (baseShare + K2 from CPP2 portion)` uses the same base-share value the decomposition produced — no re-derivation required.
3. `K2P (Alberta) = albertaLowestRate × (baseShare + K2 from CPP2 portion)` likewise.

For T4 reporting, `deductionBase` populates the base-CPP T4 box and `deductionFirst` populates the first-additional-CPP box.

## 17. Statutory package pinning

```
PREPARED
 → calculation begins
 → resolveStatutoryPackage({country, province, payDate}) → ResolvedStatutoryPackage
 → PayrollBatch.statutoryPackageId ← package.id
 → calculation writes result columns on PayrollBatchEmployee
 → transition PREPARED → CALCULATED
```

Once pinned, recalculating the same frozen batch reuses the exact package. Void-and-recalculate is the only path to change a POSTED batch's statutory package.

## 18. Work Intake (§25)

`PAYROLL_REVIEW` stays OPEN. No `PAYROLL_FINAL_APPROVAL` in 3B-5B-1x. The 3B-5B-2 calculator transitions REVIEW → RESOLVED on successful calculation and materialises FINAL_APPROVAL for the Controller.

---

## Verification gate before 3B-5B-2 implementation

1. H1 + H2 packages installed via `seedCanadaAlbertaPackages2026`. Federal-tax `brackets[]` MUST be replaced with the CRA-T4127 122nd/123rd Edition federal-tax bracket table.
2. Every scenario in `tests/payroll/fixtures/2026/ca-ab/scenarios.json` must carry an `expected` value derived independently from CRA T4127 worked examples OR CRA PDOC — never from Spectre's own calculator.
3. `resolvePeriodsPerYearFromCalendar` must be called by the calculator; never a hard-coded literal.
4. TD1 behaviour re-verified against the current CRA guidance for missing / zero / additional-tax combinations.
5. Allowance statutory-classification decouple applied through the earning-line + snapshot chain.
