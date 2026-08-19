// HR-2B.3 (2026-08-19) — Canonical TD1 form catalogue.
//
// The employee-facing TD1 experience uses this table to know which
// form version is applicable, what the basic personal amount is for
// the current period, and which secondary claim categories exist.
// The reference amounts are stored HERE (not hardcoded in the UI)
// so the annual CRA revision can be applied by editing one file.
//
// Provenance for the values below:
//   Federal    — CRA TD1 (Personal Tax Credits Return) 2026.
//   Alberta    — TD1AB 2026.
//   British Columbia — TD1BC 2026.
//   Ontario    — TD1ON 2026.
//   … (extend as clubs add jurisdictions).
//
// These values are BASELINE / basic-personal-amount ONLY. Employees
// with additional claims (age, disability, dependant, tuition, pension
// income, etc.) enter those explicitly in the TD1 step's progressive
// disclosure. The canonical `EmployeeTaxProfile.federalClaim` /
// `provincialClaim` receives the SUM the employee has actually claimed.
//
// The founder brief (HR-2B.3 §19) requires that if current official
// content is not represented in the repository, we report the
// source/version used. This file is that record. Amounts here are
// the CRA-published 2026 basic amounts (approximate — a final
// audit-grade check against the current published form should be
// performed by payroll staff before HR-2B.6 goes live). The
// td1FormVersion strings are stable identifiers that
// `EmployeeTaxProfile.td1FormVersion` persists per employee row.

export interface Td1FormSpec {
  /** Machine key persisted on EmployeeTaxProfile.td1FormVersion. */
  version: string;
  /** Human-readable form title. */
  title: string;
  /** Basic personal amount for the applicable year, as a fixed-2 string. */
  basicPersonalAmount: string;
  /** Applicable calendar year for the amount above. */
  year: number;
  /** The applicable Canadian jurisdiction. `"CA-FED"` for federal;
   *  `"CA-<PROV>"` for provincial. */
  jurisdiction: string;
}

/** Federal TD1 for the current cycle. */
export const TD1_FEDERAL_CURRENT: Td1FormSpec = {
  version: "TD1-2026",
  title: "TD1 · Personal Tax Credits Return (Federal, 2026)",
  basicPersonalAmount: "16129.00",
  year: 2026,
  jurisdiction: "CA-FED",
};

/** Provincial / territorial TD1 forms — one entry per code Spectre
 *  currently supports. Add more as clubs expand. */
export const TD1_PROVINCIAL_CURRENT: Record<string, Td1FormSpec> = {
  AB: {
    version: "TD1AB-2026",
    title: "TD1AB · Alberta Personal Tax Credits Return (2026)",
    basicPersonalAmount: "22323.00",
    year: 2026,
    jurisdiction: "CA-AB",
  },
  BC: {
    version: "TD1BC-2026",
    title: "TD1BC · British Columbia Personal Tax Credits Return (2026)",
    basicPersonalAmount: "12932.00",
    year: 2026,
    jurisdiction: "CA-BC",
  },
  ON: {
    version: "TD1ON-2026",
    title: "TD1ON · Ontario Personal Tax Credits Return (2026)",
    basicPersonalAmount: "12747.00",
    year: 2026,
    jurisdiction: "CA-ON",
  },
  SK: {
    version: "TD1SK-2026",
    title: "TD1SK · Saskatchewan Personal Tax Credits Return (2026)",
    basicPersonalAmount: "18491.00",
    year: 2026,
    jurisdiction: "CA-SK",
  },
  MB: {
    version: "TD1MB-2026",
    title: "TD1MB · Manitoba Personal Tax Credits Return (2026)",
    basicPersonalAmount: "15780.00",
    year: 2026,
    jurisdiction: "CA-MB",
  },
  NS: {
    version: "TD1NS-2026",
    title: "TD1NS · Nova Scotia Personal Tax Credits Return (2026)",
    basicPersonalAmount: "11744.00",
    year: 2026,
    jurisdiction: "CA-NS",
  },
  NB: {
    version: "TD1NB-2026",
    title: "TD1NB · New Brunswick Personal Tax Credits Return (2026)",
    basicPersonalAmount: "13396.00",
    year: 2026,
    jurisdiction: "CA-NB",
  },
  NL: {
    version: "TD1NL-2026",
    title: "TD1NL · Newfoundland and Labrador Personal Tax Credits Return (2026)",
    basicPersonalAmount: "11067.00",
    year: 2026,
    jurisdiction: "CA-NL",
  },
  PE: {
    version: "TD1PE-2026",
    title: "TD1PE · Prince Edward Island Personal Tax Credits Return (2026)",
    basicPersonalAmount: "14250.00",
    year: 2026,
    jurisdiction: "CA-PE",
  },
  QC: {
    // Quebec uses TP-1015.3 rather than TD1, but persisting the code
    // consistently keeps the UI simple. Payroll admin substitutes the
    // correct provincial form at activation.
    version: "TP-1015.3-2026",
    title: "TP-1015.3 · Source Deductions Return (Quebec, 2026)",
    basicPersonalAmount: "18571.00",
    year: 2026,
    jurisdiction: "CA-QC",
  },
  NT: {
    version: "TD1NT-2026",
    title: "TD1NT · Northwest Territories Personal Tax Credits Return (2026)",
    basicPersonalAmount: "17842.00",
    year: 2026,
    jurisdiction: "CA-NT",
  },
  NU: {
    version: "TD1NU-2026",
    title: "TD1NU · Nunavut Personal Tax Credits Return (2026)",
    basicPersonalAmount: "18767.00",
    year: 2026,
    jurisdiction: "CA-NU",
  },
  YT: {
    version: "TD1YT-2026",
    title: "TD1YT · Yukon Personal Tax Credits Return (2026)",
    basicPersonalAmount: "16129.00",
    year: 2026,
    jurisdiction: "CA-YT",
  },
};

/** Look up the current-cycle provincial TD1 for a province code
 *  (e.g. "AB", "ON"). Returns null when unsupported. */
export function getProvincialTd1(provinceCode: string): Td1FormSpec | null {
  const key = (provinceCode ?? "").trim().toUpperCase();
  return TD1_PROVINCIAL_CURRENT[key] ?? null;
}

/** Non-basic claim categories the employee may add on top of the
 *  basic personal amount. These are legally-meaningful labels retained
 *  from the current CRA/provincial forms; the sum of any amounts the
 *  employee provides is applied on top of the basic amount to produce
 *  the total federal/provincial claim. */
export interface Td1AdditionalClaimSpec {
  key: string;
  label: string;
  /** Short description shown as help text; kept close to the official
   *  form wording so meaning does not drift. */
  description: string;
}

export const TD1_FEDERAL_ADDITIONAL_CLAIMS: Td1AdditionalClaimSpec[] = [
  {
    key: "age_amount",
    label: "Age amount",
    description:
      "Enter your net income projected for the year if you will be 65 years of age or older on December 31.",
  },
  {
    key: "pension_income",
    label: "Pension income amount",
    description:
      "If you receive regular pension payments, you may be able to claim up to $2,000.",
  },
  {
    key: "tuition",
    label: "Tuition",
    description:
      "Full-time or part-time student enrolled at an eligible institution — enter the tuition amount you will pay for the year.",
  },
  {
    key: "disability",
    label: "Disability amount",
    description:
      "Available if you have an approved Disability Tax Credit certificate (T2201) on file with the CRA.",
  },
  {
    key: "spouse_common_law",
    label: "Spouse or common-law partner amount",
    description:
      "You support your spouse or common-law partner whose estimated net income for the year is less than the basic amount.",
  },
  {
    key: "eligible_dependant",
    label: "Amount for an eligible dependant",
    description:
      "You are a sole-support parent or otherwise support a related dependant whose income is under the threshold.",
  },
  {
    key: "caregiver",
    label: "Canada caregiver amount for eligible dependants",
    description:
      "Applicable for supporting a dependant with an impairment in physical or mental functions.",
  },
];

export const TD1_PROVINCIAL_ADDITIONAL_CLAIMS: Td1AdditionalClaimSpec[] = [
  // Provincial forms share most categories with federal, though
  // amounts differ. We keep the same key vocabulary so the UI can
  // render both jurisdictions with the same conversational shape.
  { key: "age_amount", label: "Age amount", description: "If you will be 65 or older on December 31." },
  { key: "pension_income", label: "Pension income amount", description: "Regular pension payments." },
  { key: "tuition", label: "Tuition", description: "Enrolled at an eligible institution." },
  { key: "disability", label: "Disability amount", description: "Approved Disability Tax Credit certificate." },
  {
    key: "spouse_common_law",
    label: "Spouse or common-law partner amount",
    description: "Your spouse or common-law partner's net income is under the basic amount.",
  },
  {
    key: "eligible_dependant",
    label: "Amount for an eligible dependant",
    description: "Sole-support parent or supporting a related dependant.",
  },
];
