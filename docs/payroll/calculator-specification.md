# Spectre Payroll — Canada / Alberta Gross-to-Net Calculator Specification

**Slice:** Payroll-3B-5B-1 (foundation) — implementation lands in 3B-5B-2.
**Status:** SPECIFICATION ONLY. Zero dollar arithmetic in this slice.
**Jurisdiction:** Canada federal + Alberta MVP. Quebec is out of scope; the resolver refuses non-`AB` provinces loudly at calculation time.

This document is the CRA-grounded contract the 3B-5B calculator will implement. Every value referenced here — YMPE, YAMPE, rates, brackets, K-factors, BPA amounts, MIE — comes from the pinned `PayrollStatutoryPackage.paramsJson` for the pay date. **No numeric CRA parameter is embedded here.** The founder must independently verify every value against the current CRA publications before those packages are seeded.

---

## 1. Calculator contract

```
calculatePayrollBatch(inputs: {
  batch: PreparedBatchView,                       // 3B-4 / 3B-5A frozen snapshot
  statutoryPackage: ResolvedStatutoryPackage,     // pinned via resolveStatutoryPackage(payDate)
  ytdByEmployee: Map<employeeId, EmployeePayrollYtd>,   // 3B-5A + 3B-5B-1 aggregate
  cppElectionsByEmployee?: Map<employeeId, CppElectionView[]>,
  cppDisabilitiesByEmployee?: Map<employeeId, CppDisabilityView[]>,
}): CalculatedPayrollResult
```

Pure function of its inputs. Same inputs → byte-identical outputs. Reproducible replays produce the same PayrollBatchEmployee result columns. The calculator writes result columns (see [prisma/schema.prisma → PayrollBatchEmployee](../../prisma/schema.prisma)) and NEVER mutates the frozen snapshot.

## 2. Earnings / statutory bases

For each `PayrollBatchEmployee`:

**Gross earnings (`grossPay`)** = Σ regular earnings + overtime + allowances + one-time payments, per the batch snapshot. The 3B-5B-2 earnings-decomposition step converts each `sourceFacts.compensations[]` × approved-time / coverage window into typed earning lines *before* summing.

**Taxable earnings (`earningsTaxable`)** = gross + taxable-benefit allowances − CPP2 deduction (per T4127 §Federal formula variable K3) − union dues − RPP contributions. The CPP2 offset applies only in the federal tax formula's `T3` intermediate variable, not to the gross itself.

**Pensionable earnings (`earningsPensionable`)** = gross earnings subject to CPP (excludes non-pensionable classes: severance, retiring allowances, statutory holidays for casuals, etc. — the MVP treats every earning as pensionable unless the earning row carries a `pensionable: false` flag; non-pensionable earnings are out of scope for MVP per §11 and produce a BLOCKER).

**Insurable earnings (`earningsInsurable`)** = gross earnings subject to EI (excludes retiring allowances, most pension income). Same MVP simplification.

## 3. CPP base + first-additional (§21)

Both components MUST be computed and persisted separately for statutory traceability (T4 reporting, YTD annual-maximum tracking, employer matching).

**Pay-period basic exemption (PPBE)** =
`Package.cpp.ybe / periodsPerYear` (unrounded, CRA T4127 §CPP variable `PE`).

**Pensionable-earnings slice for this pay** =
`max(0, min(earningsPensionable, packagePensionableMaxForPeriod) − PPBE)`
where `packagePensionableMaxForPeriod` = `Package.cpp.ympe / periodsPerYear`, rounded per CRA formula.

**CPP base employee contribution (`deductionCppEeBase`)** =
`slice × Package.cpp.baseRateEE`
capped at `max(0, annualBaseMax − ytdCppEE_Base)` where
`annualBaseMax = (Package.cpp.ympe − Package.cpp.ybe) × Package.cpp.baseRateEE × (pensionableMonthCount / 12)`.

The proration factor `pensionableMonthCount / 12` comes from [`cppPensionableMonths(...)`](../../src/lib/payroll/statutory/cpp-pensionable-months.ts) — the resolver that consumes DOB, CPT30 election history, disability intervals, and death date.

**CPP first-additional employee contribution (`deductionCppEeFirstAdd`)** =
`slice × Package.cpp.firstAdditionalRateEE` (a separate parameter added to `CanadianPayrollStatutoryParamsV1` in 3B-5B-1 continuation), capped at the pro-rated annual max in the same shape.

**Employer amounts** (`employerCppBase`, `employerCppFirstAdd`) = mirror of employee amounts using employer rates (per statute typically equal to employee rates).

## 4. CPP2

**Pensionable-earnings slice for CPP2** =
`max(0, min(earningsPensionable, packageYampeForPeriod) − packageYmpeForPeriod)`.

**Employee CPP2 (`deductionCpp2Ee`)** =
`slice × Package.cpp.cpp2RateEE`
capped at `max(0, annualCpp2Max − ytdCpp2EE)` where
`annualCpp2Max = (Package.cpp.yampe − Package.cpp.ympe) × Package.cpp.cpp2RateEE × (pensionableMonthCount / 12)`.

**Employer CPP2 (`employerCpp2`)** = mirror using `Package.cpp.cpp2RateER`.

## 5. EI

**Insurable earnings slice** = `min(earningsInsurable, Package.ei.mie − ytdInsurableEarnings)`.

The CRA formula does NOT use a per-period MIE slice — the annual MIE is the sole cap, applied cumulatively. Callers MUST NOT invent a per-period MIE proration.

**Employee EI (`deductionEiEe`)** =
`insurableSlice × Package.ei.rateEE`
capped at `max(0, Package.ei.maxAnnualPremiumEE − ytdEiEE)`.
The published `maxAnnualPremiumEE` value from CRA is authoritative — the calculator MUST NOT recompute it from `mie × rate` and substitute (§17 rule).

**Employer EI (`employerEi`)** = `deductionEiEe × Package.ei.employerMultiplier` (typically 1.4).

Quebec (`QPIP`) is out of MVP.

## 6. Federal income tax (T4127 §Federal formula)

The full CRA formula chain — not a bracket multiplication.

| Variable | Meaning |
|-|-|
| `P` | Periods-per-year for the pay-frequency |
| `I` | Gross remuneration for this pay period |
| `F` | Employee's contribution to a RPP for this pay |
| `F1` | Alimony / maintenance for this pay |
| `A` | Annualised net taxable income = `P × (I − F − F1) + HD − F2 − U1` |
| `HD` | Annual deductions from income (as declared) |
| `F2` | Alimony / maintenance annualised |
| `U1` | Union dues annualised |
| `R` | Federal tax rate for the bracket A falls into |
| `K` | Bracket constant K (the CRA T4127 "constant") |
| `K1` | Federal non-refundable tax credit = `Package.federal.lowestRate × (TC + TD1F-BPA-tier)` |
| `K2` | Federal CPP tax credit = `Package.federal.lowestRate × (annualised CPP employee contribution + first-additional)` |
| `K2A` | Federal EI tax credit = `Package.federal.lowestRate × (annualised EI premiums)` |
| `K3` | Federal CPP2 deduction = `Package.federal.cpp2DeductionRate × (annualised CPP2 contribution)` |
| `K4` | Canada employment credit = `Package.federal.lowestRate × min(annualised employment income, CEA_MAX)` |
| `T3` | Annual federal tax = `(R × A − K) − K1 − K2 − K2A − K3 − K4` |
| `T4` | Federal tax withheld this pay = `max(0, round(T3 / P) + additionalTaxRequested)` |

**BPA (Basic Personal Amount) tier** — Bill C-30 phases the federal BPA between `Package.federal.bpaLow` and `Package.federal.bpaHigh` based on annualised income (`Package.federal.bpaPhaseOutStart` → `Package.federal.bpaPhaseOutEnd`). Linear phase-out formula per CRA T4127 §BPA.

**No TD1F on file (§L, §19):** the calculator uses the federal BPA only (no additional claim credits). CRA's stated employer default when TD1 is missing.

## 7. Alberta provincial income tax

Same shape as federal, applied to `Package.provincial.brackets[]` + `Package.provincial.bpa`. `T4Prov = max(0, round(T3Prov / P) + additionalProvincialTaxRequested)`.

## 8. Net pay

```
netPay = grossPay
       − deductionCppEeBase
       − deductionCppEeFirstAdd
       − deductionCpp2Ee
       − deductionEiEe
       − deductionFederalTax
       − deductionProvincialTax
       − Σ other post-tax deductions (union dues, garnishments, etc. — MVP: zero)
```

Rounded per `Package.rounding.netPayMode`.

## 9. YTD maximums (annual max cap enforcement)

Every contribution field is capped at the annual maximum from the pinned package **for this employer** (per §23 — a `PRIOR_EMPLOYER` opening balance is NOT deducted from this employer's max):

- `deductionCppEeBase ≤ annualCppBaseMax × (pensionableMonthCount/12) − ytdCppEE_Base`
- `deductionCppEeFirstAdd ≤ annualCppFirstAddMax × (pensionableMonthCount/12) − ytdCppEE_FirstAdd`
- `deductionCpp2Ee ≤ annualCpp2Max × (pensionableMonthCount/12) − ytdCpp2EE`
- `deductionEiEe ≤ Package.ei.maxAnnualPremiumEE − ytdEiEE`

The calculator never fabricates a cap from `ympe × baseRate`; it uses the pinned package's authoritative published value where CRA supplies one.

## 10. Multiple assignments

Earnings are computed per assignment (from `sourceFacts.compensations[].assignmentId`) then summed for statutory deductions. YTD accumulates at the Employee level (`PayrollBatchEmployee`) — the split across assignments is only for earnings-line traceability.

## 11. Mid-period Pay Group transfer

Each batch's `sourceFacts.coverage.coverageDays / periodDays` ratio is applied to salaried earnings BEFORE any statutory calculation. This prevents duplicate full-period salary across the two batches for a transferred employee (Payroll-3B-5A §32 invariant).

## 12. Salary proration policy (§28)

Spectre MVP policy: **calendar-day proration**.

For a salaried employee whose `coverage.coverageDays < coverage.periodDays`:

```
periodBaseSalary = annualSalary / periodsPerYear
prorated         = periodBaseSalary × (coverageDays / periodDays)
```

Applies to:
- ordinary full period → `coverageDays == periodDays` → factor is 1.
- hire mid-period → factor < 1.
- termination mid-period → factor < 1.
- Pay Group transfer → each batch carries its own factor.

**Not tenant-configurable in MVP.** A future slice may add `PayrollClubConfig.salaryProrationPolicy` (`CALENDAR_DAYS | BUSINESS_DAYS | WORKING_DAYS`) if a Club needs it.

**Proof of no-double-pay:** for any transfer where employee moves Group A → Group B on day `T`:
`coverageA.coverageDays + coverageB.coverageDays = periodDays` (asserted by [`membership-coverage.test.ts`](../../tests/payroll/membership-coverage.test.ts)), and the calculator computes `periodBaseSalary × coverageA/periodDays + periodBaseSalary × coverageB/periodDays = periodBaseSalary × 1.0`. Sum equals a full period salary — never more.

## 13. Allowance conversion policy (§29)

`EmployeeAllowance.frequency` values today:

| Frequency | Conversion to per-period amount |
|-|-|
| `PER_PAY_PERIOD` | 1 × amount |
| `MONTHLY` | `amount × 12 / periodsPerYear` |
| `BIWEEKLY` | `amount × 26 / periodsPerYear` |
| `WEEKLY` | `amount × 52 / periodsPerYear` |
| `ANNUAL` | `amount / periodsPerYear` |
| `ONE_TIME` | Applied once in the coverage window matching the effective date |

Any other frequency → BLOCKER `UNSUPPORTED_ALLOWANCE_FREQUENCY`.

Taxable allowances contribute to `earningsGross` + `earningsTaxable` + `earningsPensionable` + `earningsInsurable` per the allowance's `taxable` flag and CRA guidance. Non-cash / non-taxable allowances contribute to `earningsGross` only when statute requires.

## 14. Rounding (§30)

**Arithmetic:** all intermediate calculations use `Decimal` (Prisma `Decimal` / `decimal.js`) at minimum 6 fractional digits precision. **No JS floating point.**

**Per-line rounding:**
| Value | Mode | Precision |
|-|-|-|
| Pay-period basic exemption (PPBE) | HALF_EVEN | 2 dp |
| CPP base contribution | `Package.rounding.mode` (default HALF_UP) | 2 dp |
| CPP first-additional | `Package.rounding.mode` | 2 dp |
| CPP2 contribution | `Package.rounding.mode` | 2 dp |
| EI premium | `Package.rounding.mode` | 2 dp |
| Federal tax `T4` | `Package.rounding.mode` | 2 dp |
| Provincial tax `T4Prov` | `Package.rounding.mode` | 2 dp |
| Net pay | `Package.rounding.netPayMode` | 2 dp |

**Annual maximum comparison:** compare unrounded slice against unrounded (unrounded rate × unrounded pensionable slice) before rounding the final contribution, so a taxable slice that would trigger a $0.005 cap breach doesn't sneak through rounding.

## 15. Statutory package pinning (§31)

```
PREPARED
 → calculation begins
 → resolveStatutoryPackage({country, province, payDate}) → ResolvedStatutoryPackage
 → PayrollBatch.statutoryPackageId ← package.id
 → calculation writes result columns on PayrollBatchEmployee
 → transition PREPARED → CALCULATED
```

Once pinned, recalculating the same frozen batch reuses the exact same package. A later package publish never silently alters a historical batch. Void-and-recalculate is the only path to change a POSTED batch's statutory package, and it produces a NEW batch sequence.

## 16. Work Intake state (§32)

No `PAYROLL_FINAL_APPROVAL` card is created in 3B-5B-1. The existing `PAYROLL_REVIEW` card stays OPEN. 3B-5B-2 transitions REVIEW → RESOLVED on successful calculation and materialises FINAL_APPROVAL for the Controller.

---

## Verification gate before 3B-5B-2 implementation

1. Every parameter in §3–§9 must reference a Zod-validated field on `CanadianPayrollStatutoryParamsV1`. Missing fields (e.g. `firstAdditionalRateEE`, `maxAnnualPremiumEE`) must be added to the schema in 3B-5B-2's first step.
2. H1 (`[2026-01-01, 2026-07-01)`) and H2 (`[2026-07-01, ...)`) statutory packages must be installed with values extracted from official CRA publications (T4127 122nd + 123rd editions, T4032-AB, EI Premium Rate/Maximum announcements).
3. Every scenario in [tests/payroll/fixtures/2026/ca-ab/](../../tests/payroll/fixtures/2026/ca-ab/) must carry an expected result derived independently from CRA PDOC or official CRA worked examples — never from the Spectre calculator itself (§24 no-circular-testing rule).
4. `tests/payroll/statutory-package.test.ts` must confirm every required numeric field is present and validated on install.
5. TD1 behaviour (§19) must be re-verified against current CRA guidance before withholding formulas ship.
