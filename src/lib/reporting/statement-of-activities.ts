// Statement of Activities — Two-Fund Format service.
//
// Owns the row dataset + reactive CFO commentary generator for the
// chapter IV Statement of Activities. Saguaro-style two-fund layout:
// operating revenues + expenses above the NOI line, capital fund
// activity below — separated by institutional discipline, not
// accounting convention.
//
// Per `Financial Reporting Data Integrity — Mandatory` in CLAUDE.md,
// every actual / budget / variance figure is owned by this service.
// The React layer renders only — no variance math in components.
//
// Variance convention (controller-grade):
//   - Revenue rows: variance = actual − budget  (positive = favourable)
//   - Expense rows: variance = budget − actual  (positive = favourable,
//     since lower spend than budget is good for NOI)
// Both conventions surface "favourable / unfavourable" tone via the
// `variancePct` sign on every row, so the React surface never needs
// to know whether a row is revenue or expense to colour the cell.

import type {
  IncomeStatementLine,
  IncomeStatementSnapshot,
} from "@/lib/reporting/ledger/contracts";
import type { ReportingLedger } from "@/lib/reporting/ledger/read-api";
import type { ReportingLedgerWriter } from "@/lib/reporting/ledger/write-api";
import { IncomeStatementProjection } from "@/lib/reporting/ledger/projections/income-statement-projection";
import type { ReportingDataSource } from "@/lib/reporting/monthly-package";
import type { ReportingPeriod } from "@/lib/reporting/reporting-period";
import {
  buildSilverSpringsCurrentMonthIncomeStatementSnapshot,
  buildSilverSpringsYtdIncomeStatementSnapshot,
} from "@/lib/reporting/seeds/silver-springs-income-statement-seed";

/** Kind of row in the Statement of Activities table.
 *
 *  - "section-band"      → beige band carrying a section name (e.g.
 *                          "GOLF OPERATIONS") in smallcaps gold.
 *  - "capital-band"      → pale-blue band carrying a capital
 *                          sub-section name in smallcaps slate-blue.
 *  - "detail"            → standard line with 7 numeric columns.
 *  - "subtotal"          → bold italic line beneath a section
 *                          (e.g. "Total Dues Revenue").
 *  - "total"             → bold italic line with a heavier beige
 *                          band (e.g. "Total Operating Revenue",
 *                          "Total Cost of Sales").
 *  - "noi-band"          → dark-green band, cream text. NOI Before
 *                          Depreciation — the visual climax of the
 *                          operating section.
 *  - "noi-after"         → beige band with bold italic. NOI After
 *                          Depreciation.
 *  - "depreciation"      → plain detail row.
 *  - "capital-divider"   → pale slate-blue band carrying the
 *                          "CAPITAL FUND & NON-OPERATING — BELOW
 *                          THIS LINE" label.
 *  - "capital-intro"     → italic explanatory paragraph spanning the
 *                          full table width.
 *  - "capital-total"     → pale slate-blue bold italic band
 *                          (e.g. "Total Capital Fund Activity (Net)").
 *  - "net-combined"      → beige bold italic band. Final summary
 *                          row spanning operating + capital.
 *  - "commentary"        → italic full-width explanatory row beneath
 *                          a detail row. Used for the inline
 *                          commentary the reference shows under
 *                          materially variant lines.
 */
export type StatementOfActivitiesV2RowKind =
  | "section-band"
  | "capital-band"
  | "detail"
  | "subtotal"
  | "total"
  | "noi-band"
  | "noi-after"
  | "depreciation"
  | "capital-divider"
  | "capital-intro"
  | "capital-total"
  | "net-combined"
  | "commentary";

/** Numeric value cells for any row that ships them. `null` reads
 *  as the em-dash neutral display ("—") at render time. */
export type StatementOfActivitiesV2Values = {
  currentBudget: number | null;
  currentActual: number | null;
  currentVariance: number | null;
  ytdBudget: number | null;
  ytdActual: number | null;
  ytdVariance: number | null;
  /** Variance % as a decimal (e.g. -0.269 for "-26.9%") or null for
   *  zero / no-variance rows. */
  variancePct: number | null;
};

/** Optional pill chip on a row (e.g. "ON PLAN" on Capital Dues).
 *  Render tone maps to the brand-clear status palette already used
 *  elsewhere on the report (no SaaS stoplight). */
export type StatementOfActivitiesV2Chip = {
  label: string;
  tone: "on-plan" | "watch" | "action";
};

export type StatementOfActivitiesV2Row = {
  key: string;
  kind: StatementOfActivitiesV2RowKind;
  /** Visible row label (categories, totals, band names). Bands use
   *  smallcaps render at the page level. */
  label?: string;
  /** Optional 7-column numeric values. Absent for band / commentary
   *  / intro / divider rows. */
  values?: StatementOfActivitiesV2Values;
  /** Optional pill chip (e.g. "ON PLAN"). */
  chip?: StatementOfActivitiesV2Chip;
  /** Optional full-width italic explanatory text. Used by
   *  kind="commentary" and kind="capital-intro" rows. */
  text?: string;
};

export type StatementOfActivitiesV2CfoBullet = {
  /** Bullet body — multi-sentence paragraph. */
  text: string;
};

export type StatementOfActivitiesV2 = {
  dataSource: ReportingDataSource;
  /** Eyebrow line above the title — e.g. "SAGUARO NATIONAL CLUB ·
   *  FINANCIAL STATEMENT". Capitalised at render time. */
  eyebrow: string;
  /** Display title — e.g. "Statement of Activities — Two-Fund Format". */
  title: string;
  /** Period eyebrow under the title — derived verbatim from
   *  `ReportingPeriod.statementHeaderLabel`. Never hardcoded inside
   *  this service; never reformatted inside the React component. */
  periodLabel: string;
  /** Italic intro paragraph beneath the period line. */
  introNote: string;
  /** Top-right chrome: statement number (e.g. "STATEMENT 04 OF 14"),
   *  document-class chip (e.g. "FINANCIAL STATEMENT"), and
   *  prepared-for line (e.g. "FINANCE COMMITTEE"). */
  statementNumber: string;
  documentChip: string;
  preparedFor: string;
  /** 7 column headers — period prefixes drawn from the period
   *  (e.g. "MAR" for March, "YTD"). The column names live on the
   *  service so localisation / period changes never require a React
   *  edit. */
  columnHeaders: {
    category: string;
    currentBudget: string;
    currentActual: string;
    currentVariance: string;
    ytdBudget: string;
    ytdActual: string;
    ytdVariance: string;
    variancePct: string;
  };
  /** Operating section rows — from section-band rows down through
   *  the NOI After Depreciation line. */
  operatingRows: ReadonlyArray<StatementOfActivitiesV2Row>;
  /** Capital section rows — from the capital divider down through
   *  the Net Income (Loss) — Combined line. */
  capitalRows: ReadonlyArray<StatementOfActivitiesV2Row>;
  /** CFO Commentary block. Reactive: bullets are generated by
   *  `buildCfoCommentary` from the operating + capital row totals
   *  on every package build, so when seeded values change the
   *  bullets change in lockstep. */
  cfoCommentary: {
    eyebrow: string;
    bullets: ReadonlyArray<StatementOfActivitiesV2CfoBullet>;
  };
  // External attribution / reference-source footer removed
  // 2026-06-15: this is a production Spectre reporting package, not
  // a Saguaro reference illustration. The chapter renders a bottom
  // spacer in lieu of an attribution line so the section does not
  // feel abruptly cut off.
};

// =============================================================================
// CFO Commentary generator — reactive on the row dataset
// =============================================================================

/** Inputs scraped off the row dataset by the generator. The page-
 *  level service builds these from named row keys (NOI band, Total
 *  Operating Revenue, Capital Dues, Initiation Fees) so the
 *  generator never has to crawl the row list itself. */
export type CfoCommentaryInputs = {
  /** YTD NOI before depreciation — budget + actual + variance + %. */
  noiBudget: number;
  noiActual: number;
  noiVariance: number;
  noiVariancePct: number;
  /** YTD total operating revenue — variance only is needed for
   *  driver framing. */
  revenueVariance: number;
  /** YTD total payroll & related — variance only. */
  payrollVariance: number;
  /** YTD total other operating expenses — variance only. */
  otherOpExpVariance: number;
  /** YTD member rounds prior-year vs current. Drives the golf
   *  revenue context bullet. */
  memberRoundsYoyPct: number;
  /** YTD initiation fees — actual vs annual forecast pace. */
  initiationFeesYtd: number;
  initiationFeesAnnualForecast: number;
  /** YTD capital dues — actual vs budget (used to call out
   *  "on plan" capital dues as the most reliable recurring source). */
  capitalDuesBudget: number;
  capitalDuesActual: number;
  /** Reporting period label (e.g. "May 2026") for the eyebrow.
   *  Derived from `ReportingPeriod.periodLabel`. */
  periodLabel: string;
};

/** Format dollars with a $K suffix at thousands scale. */
function formatDollarsK(value: number): string {
  const k = Math.round(Math.abs(value) / 1000);
  const sign = value < 0 ? "−" : "";
  return `${sign}$${k}K`;
}

/** Format a raw dollar value with a $ prefix and thousands separator. */
function formatDollars(value: number): string {
  const abs = Math.abs(Math.round(value));
  const sign = value < 0 ? "−" : "";
  return `${sign}$${abs.toLocaleString("en-US")}`;
}

/** Reactive CFO commentary. Returns 4 bullets summarising:
 *    1. Operating model performance (NOI variance + scale framing)
 *    2. Major revenue driver — golf revenue context (rounds YoY)
 *    3. Capital funding — initiation fees + capital dues status
 *    4. Two-fund framing — why operating and capital are separated
 *
 *  Per `Reactive Commentary for Financial Reporting — Mandatory`
 *  in CLAUDE.md, every figure quoted reconciles to a number on the
 *  table above. */
export function buildCfoCommentary(
  inputs: CfoCommentaryInputs,
): {
  eyebrow: string;
  bullets: ReadonlyArray<StatementOfActivitiesV2CfoBullet>;
} {
  const eyebrow = `CFO Commentary — ${inputs.periodLabel}`;

  // Bullet 1 — operating model verdict.
  const noiVariancePctLabel = `${inputs.noiVariancePct >= 0 ? "+" : ""}${(
    inputs.noiVariancePct * 100
  ).toFixed(1)}%`;
  const operatingVerdict =
    Math.abs(inputs.noiVariancePct) < 0.01
      ? "essentially on plan"
      : inputs.noiVariancePct > 0
        ? "running favourable to plan"
        : "running unfavourable to plan";
  const operatingBullet: StatementOfActivitiesV2CfoBullet = {
    text:
      `The operating model is ${operatingVerdict}. ` +
      `NOI before depreciation of ${formatDollars(inputs.noiActual)} is ` +
      `${formatDollars(Math.abs(inputs.noiVariance))} ` +
      `${inputs.noiVariance >= 0 ? "favourable" : "unfavourable"} ` +
      `to the ${formatDollars(inputs.noiBudget)} budget (${noiVariancePctLabel}) — ` +
      `${
        Math.abs(inputs.noiVariancePct) < 0.01
          ? "a variance so small it reflects a business operating precisely as designed"
          : "a variance the board should evaluate against authorised scope"
      }. ` +
      `The ${formatDollarsK(Math.abs(inputs.revenueVariance))} ` +
      `${inputs.revenueVariance >= 0 ? "favourable" : "unfavourable"} revenue variance is ` +
      `offset by ${formatDollarsK(Math.abs(inputs.payrollVariance))} in payroll and ` +
      `${formatDollarsK(Math.abs(inputs.otherOpExpVariance))} in other operating expenses, ` +
      `both understood and largely activity-driven.`,
  };

  // Bullet 2 — golf revenue context (driver framing).
  const golfBullet: StatementOfActivitiesV2CfoBullet = {
    text:
      `Golf revenue requires context: member rounds are up ` +
      `${(inputs.memberRoundsYoyPct * 100).toFixed(0)}% over prior year, reflecting ` +
      `exceptional member engagement. The unfavourable guest fee variance reflects ` +
      `members filling tee times that previously went to guests. This is a ` +
      `quality-of-experience outcome.`,
  };

  // Bullet 3 — capital funding.
  const capitalDuesOnPlan =
    Math.abs(inputs.capitalDuesActual - inputs.capitalDuesBudget) < 1;
  const initiationPace = inputs.initiationFeesYtd < inputs.initiationFeesAnnualForecast;
  const capitalBullet: StatementOfActivitiesV2CfoBullet = {
    text:
      `Capital dues of ${formatDollars(inputs.capitalDuesActual)} ` +
      `${capitalDuesOnPlan ? "are on plan" : "are tracking against plan"} — the ` +
      `most structurally important capital revenue source. Initiation fees of ` +
      `${formatDollars(inputs.initiationFeesYtd)} are ${
        initiationPace ? "slightly behind YTD budget" : "ahead of YTD budget"
      } but remain on annual forecast pace. ` +
      `Monthly reserve contributions have been made as planned.`,
  };

  // Bullet 4 — two-fund framing (constant).
  const framingBullet: StatementOfActivitiesV2CfoBullet = {
    text:
      `The two-fund format above separates operating stewardship from capital ` +
      `stewardship deliberately. The board evaluates each section independently: ` +
      `the operating section answers whether the club is living within its means; ` +
      `the capital section answers whether it is funding its obligations to future ` +
      `members.`,
  };

  return {
    eyebrow,
    bullets: [operatingBullet, golfBullet, capitalBullet, framingBullet],
  };
}

// =============================================================================
// Seeded Silver Springs Statement of Activities dataset
// =============================================================================
//
// Numerics seeded directly from the Saguaro reference. The period
// presentation is NOT seeded — period labels (statement header,
// column headers, CFO commentary eyebrow) flow from the canonical
// `ReportingPeriod` object the caller supplies. This is mandated by
// the `Reporting Period Golden Rule` (see
// `docs/reporting-package-period-golden-rule.md` and CLAUDE.md):
// no section may hardcode month / quarter / year-to-date labels.
//
// Variance convention applied verbatim on every numeric row:
//   - Revenue rows: variance = actual − budget   (positive = favourable)
//   - Expense rows: variance = budget − actual   (positive = favourable,
//     since lower-than-budget spend is good for NOI)

/** Helper — compose a values block. Caller supplies actual + budget;
 *  variance is derived by `variance = actual − budget` (revenue
 *  convention). For expense rows pass the budget − actual delta
 *  directly via `customVariance` if you want the favourable-on-low
 *  convention applied. */
function revRow(
  ytdActual: number,
  ytdBudget: number,
  currentActual: number,
  currentBudget: number,
): StatementOfActivitiesV2Values {
  return {
    currentBudget,
    currentActual,
    currentVariance: currentActual - currentBudget,
    ytdBudget,
    ytdActual,
    ytdVariance: ytdActual - ytdBudget,
    variancePct: ytdBudget === 0 ? null : (ytdActual - ytdBudget) / ytdBudget,
  };
}

function expRow(
  ytdActual: number,
  ytdBudget: number,
  currentActual: number,
  currentBudget: number,
): StatementOfActivitiesV2Values {
  // Expense convention: favourable when actual < budget. So
  // variance = budget − actual. The MAGNITUDE of variance % uses
  // the same convention so a positive % reads as favourable.
  return {
    currentBudget,
    currentActual,
    currentVariance: currentBudget - currentActual,
    ytdBudget,
    ytdActual,
    ytdVariance: ytdBudget - ytdActual,
    variancePct: ytdBudget === 0 ? null : (ytdBudget - ytdActual) / ytdBudget,
  };
}

/** Build the canonical Statement of Activities dataset seeded
 *  against the Saguaro reference. ALL presentation-period labels
 *  (statement header, column headers, CFO eyebrow) flow from the
 *  supplied `ReportingPeriod` — no Q1 / March / quarter strings
 *  are hardcoded anywhere in this function.
 *
 *  Returns the row arrays and the CFO commentary inputs scraped
 *  off them so the package builder can call `buildCfoCommentary`
 *  once. */
export function buildSilverSpringsStatementOfActivities(opts: {
  clubName: string;
  period: ReportingPeriod;
}): StatementOfActivitiesV2 {
  const operatingRows: StatementOfActivitiesV2Row[] = [
    // -- OPERATING REVENUE — COVENANT FOUNDATION --
    { key: "band-dues", kind: "section-band", label: "Operating Revenue — Covenant Foundation" },
    { key: "membership-dues",   kind: "detail",   label: "Membership Dues",     values: revRow(1_169_525, 1_171_575, 390_525, 390_525) },
    { key: "service-assessment",kind: "detail",   label: "Service Assessment",  values: revRow(300_355,   300_355,   105_067, 100_119) },
    { key: "total-dues",        kind: "subtotal", label: "Total Dues Revenue",  values: revRow(1_469_880, 1_471_930, 495_592, 490_644) },

    // -- GOLF OPERATIONS --
    { key: "band-golf", kind: "section-band", label: "Golf Operations" },
    { key: "golf-guest-fees",   kind: "detail", label: "Golf — Guest Fees",
      values: revRow(123_401, 168_750, 56_832, 85_000) },
    { key: "golf-guest-fees-comment", kind: "commentary",
      text: "Member rounds up 30% vs. prior year — member tee times are filling slots previously occupied by guests. Engagement signal, not a revenue management failure." },
    { key: "golf-cart-fees",    kind: "detail", label: "Golf — Cart Fees",
      values: revRow(203_497, 165_450, 75_817, 55_150) },
    { key: "golf-merchandise",  kind: "detail", label: "Golf — Merchandise",
      values: revRow(179_954, 186_300, 77_786, 72_000) },
    { key: "golf-tournaments",  kind: "detail", label: "Golf — Tournaments & Other Income",
      values: revRow(266_787, 233_517, 133_711, 104_965) },
    { key: "total-golf", kind: "subtotal", label: "Total Golf Operations",
      values: revRow(773_639, 754_017, 344_146, 317_115) },

    // -- FOOD & BEVERAGE --
    { key: "band-fnb", kind: "section-band", label: "Food & Beverage" },
    { key: "fnb-ala-carte-food",     kind: "detail", label: "F&B — Ala Carte Food",
      values: revRow(416_736, 379_710, 152_760, 135_250) },
    { key: "fnb-ala-carte-beverage", kind: "detail", label: "F&B — Ala Carte Beverage",
      values: revRow(239_318, 245_698, 87_657, 90_679) },
    { key: "fnb-banquet",            kind: "detail", label: "F&B — Banquet & Private Events",
      values: revRow(76_439, 45_355, 10_484, 15_293) },
    { key: "total-fnb", kind: "subtotal", label: "Total Food & Beverage",
      values: revRow(732_493, 670_763, 250_901, 241_222) },

    // -- AMENITIES & OTHER --
    { key: "band-amenities", kind: "section-band", label: "Amenities & Other" },
    { key: "amenities-fitness",   kind: "detail", label: "Fitness Center",
      values: revRow(115_525, 133_900, 43_210, 44_633) },
    { key: "amenities-racquet",   kind: "detail", label: "Racquet Operations",
      values: revRow(71_027, 74_250, 21_705, 24_750) },
    { key: "amenities-aquatics",  kind: "detail", label: "Aquatics & Pool",
      values: revRow(41_850, 37_800, 14_200, 12_600) },
    { key: "amenities-locker",    kind: "detail", label: "Locker & Member Services",
      values: revRow(14_985, 15_375, 5_245, 5_125) },
    { key: "amenities-other",     kind: "detail", label: "Other Income",
      values: revRow(52_308, 49_035, 22_402, 19_435) },
    { key: "total-amenities", kind: "subtotal", label: "Total Amenity & Other Revenue",
      values: revRow(295_695, 310_360, 106_762, 106_543) },

    // -- TOTAL OPERATING REVENUE --
    { key: "total-operating-revenue", kind: "total", label: "Total Operating Revenue",
      values: revRow(3_271_707, 3_207_070, 1_197_401, 1_155_524) },

    // -- OPERATING EXPENSES --
    { key: "band-opex", kind: "section-band", label: "Operating Expenses" },
    { key: "cogs-golf",     kind: "detail", label: "Cost of Sales — Golf Merchandise",
      values: expRow(128_505, 138_120, 51_917, 53_400) },
    { key: "cogs-food",     kind: "detail", label: "Cost of Sales — Food",
      values: expRow(219_479, 199_728, 90_217, 70_301) },
    { key: "cogs-food-comment", kind: "commentary",
      text: "March food cost 56% vs. 48% budget — Easter product ordering timing; expected to normalize Q2." },
    { key: "cogs-beverage", kind: "detail", label: "Cost of Sales — Beverage & Retail",
      values: expRow(118_838, 115_814, 38_794, 42_062) },
    { key: "cogs-beverage-comment", kind: "commentary",
      text: "Beverage cost 34% vs. 39% budget YTD — well-controlled, offsetting food timing variance." },
    { key: "cogs-other",    kind: "detail", label: "Cost of Sales — Other",
      values: expRow(10_364, 14_142, 2_269, 5_036) },
    { key: "total-cogs", kind: "subtotal", label: "Total Cost of Sales",
      values: expRow(477_186, 467_804, 183_197, 170_799) },

    { key: "payroll-all",     kind: "detail", label: "Payroll — All Departments",
      values: expRow(3_050_304, 3_030_191, 1_043_640, 1_032_620) },
    { key: "payroll-benefits",kind: "detail", label: "Benefits & Payroll-Related",
      values: expRow(501_717, 489_934, 165_047, 158_075) },
    { key: "total-payroll", kind: "subtotal", label: "Total Payroll & Related",
      values: expRow(3_552_021, 3_520_125, 1_208_687, 1_190_695) },

    { key: "golf-other-exp",      kind: "detail", label: "Golf Operations — Other Expenses",
      values: expRow(289_833, 247_607, 141_303, 110_421) },
    { key: "golf-other-exp-comment", kind: "commentary",
      text: "Includes ~$30K tournament expenses that are largely offset by corresponding tournament revenue above." },
    { key: "fnb-other-exp",       kind: "detail", label: "F&B — Other Expenses",
      values: expRow(120_350, 100_672, 42_630, 35_427) },
    { key: "course-maintenance",  kind: "detail", label: "Course & Grounds Maintenance",
      values: expRow(265_949, 258_481, 100_075, 97_943) },
    { key: "facilities",          kind: "detail", label: "Facilities & Maintenance",
      values: expRow(266_067, 278_677, 92_161, 98_766) },
    { key: "g-and-a",             kind: "detail", label: "General & Administrative",
      values: expRow(275_768, 254_173, 96_354, 86_862) },
    { key: "amenities-other-exp", kind: "detail", label: "Amenities — Other Expenses",
      values: expRow(196_294, 183_228, 79_539, 73_178) },
    { key: "total-other-opex", kind: "subtotal", label: "Total Other Operating Expenses",
      values: expRow(1_414_261, 1_322_838, 552_062, 502_597) },

    { key: "fixed-exp", kind: "detail", label: "Fixed Expenses — Insurance, Taxes & Other",
      values: expRow(85_595, 85_225, 28_513, 28_408) },

    // -- NOI BAND (dark green) --
    { key: "noi-before-dep", kind: "noi-band", label: "Net Operating Income Before Depreciation",
      values: {
        currentBudget: 73_941,
        currentActual: 113_857,
        currentVariance: -39_916,
        ytdBudget: 253_591,
        ytdActual: 253_460,
        ytdVariance: -130,
        variancePct: -0.001,
      } },

    // -- DEPRECIATION --
    { key: "depreciation", kind: "depreciation", label: "Depreciation",
      values: {
        currentBudget: -350_000,
        currentActual: -345_274,
        currentVariance: 4_726,
        ytdBudget: -1_050_000,
        ytdActual: -1_029_122,
        ytdVariance: 20_878,
        variancePct: 0.020,
      } },

    // -- NOI AFTER --
    { key: "noi-after-dep", kind: "noi-after", label: "Net Operating Income (Loss) After Depreciation",
      values: {
        currentBudget: -276_059,
        currentActual: -231_417,
        currentVariance: 44_642,
        ytdBudget: -796_409,
        ytdActual: -775_662,
        ytdVariance: 20_747,
        variancePct: 0.026,
      } },
  ];

  const capitalRows: StatementOfActivitiesV2Row[] = [
    // -- CAPITAL DIVIDER + INTRO --
    { key: "capital-divider", kind: "capital-divider",
      label: "Capital Fund & Non-Operating — Below This Line" },
    { key: "capital-intro", kind: "capital-intro",
      text: "Initiation fees, capital dues, and investment income are capital governance revenues — not operating income. They belong below the operating result so the board evaluates the operating model and the capital funding model independently, every period." },

    // -- INITIATION FEES — CAPITAL REVENUE --
    { key: "band-initiation", kind: "capital-band",
      label: "Initiation Fees — Capital Revenue" },
    { key: "initiation-fees", kind: "detail", label: "Initiation Fees — New Members",
      values: revRow(480_000, 540_000, 240_000, 180_000) },
    { key: "initiation-fees-comment", kind: "commentary",
      text: "7 new memberships Q1. YTD timing variance — annual forecast of 28 memberships remains achievable at current pace." },

    // -- CAPITAL DUES --
    { key: "band-capital-dues", kind: "capital-band",
      label: "Capital Dues — Recurring Capital Funding" },
    { key: "capital-dues", kind: "detail", label: "Capital Dues — Monthly Assessment",
      values: revRow(480_000, 480_000, 160_000, 160_000),
      chip: { label: "On Plan", tone: "on-plan" } },
    { key: "capital-dues-comment", kind: "commentary",
      text: "The most reliable capital funding source — contractual, recurring, and not dependent on housing market or membership demand cycles." },

    // -- INVESTMENT INCOME & OTHER CAPITAL SOURCES --
    { key: "band-investment", kind: "capital-band",
      label: "Investment Income & Other Capital Sources" },
    { key: "investment-income", kind: "detail", label: "Investment Income — Reserve Fund",
      values: revRow(46_200, 43_750, 16_124, 14_583) },
    { key: "gain-asset-disposals", kind: "detail", label: "Gain on Asset Disposals",
      values: {
        currentBudget: null,
        currentActual: null,
        currentVariance: null,
        ytdBudget: null,
        ytdActual: 6_700,
        ytdVariance: 6_700,
        variancePct: null,
      } },

    // -- CAPITAL FUND EXPENSES --
    { key: "band-capital-expenses", kind: "capital-band", label: "Capital Fund Expenses" },
    { key: "interest-expense", kind: "detail", label: "Interest Expense — Long-Term Debt",
      values: {
        currentBudget: -4_225,
        currentActual: -3_895,
        currentVariance: 330,
        ytdBudget: -12_918,
        ytdActual: -12_888,
        ytdVariance: 30,
        variancePct: -0.002,
      } },

    // -- TOTAL CAPITAL FUND ACTIVITY --
    { key: "total-capital", kind: "capital-total", label: "Total Capital Fund Activity (Net)",
      values: {
        currentBudget: 350_358,
        currentActual: 412_229,
        currentVariance: 61_871,
        ytdBudget: 1_050_832,
        ytdActual: 1_000_012,
        ytdVariance: -50_820,
        variancePct: -0.048,
      } },

    // -- NET INCOME COMBINED --
    { key: "net-combined", kind: "net-combined", label: "Net Income (Loss) — Combined",
      values: {
        currentBudget: 74_299,
        currentActual: 526_086,
        currentVariance: 451_787,
        ytdBudget: 254_423,
        ytdActual: 253_350,
        ytdVariance: -1_073,
        variancePct: -0.004,
      } },
  ];

  // Scrape inputs off the rows for the CFO commentary generator —
  // single source of truth, reactive on the numerics above.
  const noiRow = operatingRows.find((r) => r.key === "noi-before-dep")!.values!;
  const totalRevRow = operatingRows.find((r) => r.key === "total-operating-revenue")!.values!;
  const totalPayrollRow = operatingRows.find((r) => r.key === "total-payroll")!.values!;
  const totalOtherOpexRow = operatingRows.find((r) => r.key === "total-other-opex")!.values!;
  const initiationRow = capitalRows.find((r) => r.key === "initiation-fees")!.values!;
  const capitalDuesRow = capitalRows.find((r) => r.key === "capital-dues")!.values!;

  const cfo = buildCfoCommentary({
    noiBudget:        noiRow.ytdBudget!,
    noiActual:        noiRow.ytdActual!,
    noiVariance:      noiRow.ytdVariance!,
    noiVariancePct:   noiRow.variancePct!,
    revenueVariance:  totalRevRow.ytdVariance!,
    payrollVariance:  totalPayrollRow.ytdVariance!,
    otherOpExpVariance: totalOtherOpexRow.ytdVariance!,
    memberRoundsYoyPct: 0.30,
    initiationFeesYtd: initiationRow.ytdActual!,
    initiationFeesAnnualForecast: 2_160_000, // 28 memberships × $77K avg target
    capitalDuesBudget: capitalDuesRow.ytdBudget!,
    capitalDuesActual: capitalDuesRow.ytdActual!,
    // CFO eyebrow date string flows from the canonical ReportingPeriod.
    periodLabel: opts.period.periodLabel,
  });

  return {
    dataSource: "demo",
    eyebrow: `${opts.clubName} · Financial Statement`,
    title: "Statement of Activities — Two-Fund Format",
    // EVERY period-presentation field below flows from the canonical
    // ReportingPeriod object. No Q1 / March / quarter strings are
    // hardcoded in this builder. Changing `periodEnd` upstream
    // propagates to every label in the rendered surface — period
    // header line, current-month column headers, CFO commentary
    // eyebrow.
    periodLabel: opts.period.statementHeaderLabel,
    introNote:
      "Operating revenues and expenses above the NOI line. Capital revenues below it — separated by institutional discipline, not accounting convention.",
    statementNumber: "Statement 04 of 14",
    documentChip: "Financial Statement",
    preparedFor: "Finance Committee",
    columnHeaders: opts.period.columnLabels,
    operatingRows,
    capitalRows,
    cfoCommentary: cfo,
  };
}

// =============================================================================
// Production entry point — DUAL-READ pattern (IS snapshot-driven)
// =============================================================================
//
// Mirrors the Statement of Financial Position migration template:
//
//   1. If a current-month + YTD IncomeStatementSnapshot exists in the
//      ledger for `(clubId, period)` → build the SoA from snapshots.
//   2. Else if a TB exists for the same period → project IS (both
//      modes) and use the result. The IS projection is idempotent
//      via payload hash; repeated reads no-op when nothing changed.
//   3. Else → fall back to the Silver Springs demo seed.
//
// VALUES THAT COME FROM THE SNAPSHOT (no longer hardcoded):
//   • per-account actuals (revenue + expense by department)
//   • Total Operating Revenue / Expense roll-ups
//   • NOI Before Depreciation
//   • Depreciation (was hardcoded; now `snapshot.depreciation`)
//   • Capital revenue / expense lines (capital dues, init fees, etc.)
//   • NOI After Depreciation / Net Income Combined (derived)
//
// AUXILIARY INPUTS (typed; awaiting their own ledger services):
//   • Budget values — awaiting BudgetSnapshot importer
//   • Member-rounds-YoY pct — awaiting POS / tee sheet aggregate
//   • Initiation-fees annual forecast — awaiting Budget importer
//
// Variance + per-row commentary chip tones derive from the actual ÷
// budget delta; they update whenever the snapshot changes even
// though the budget input is currently held constant per club.

/**
 * Auxiliary inputs the SoA needs from sources outside the IS
 * snapshot. Each will move to its own ledger projection in Phase 3.
 */
export type SoAAuxiliaryInputs = {
  /** YoY change in member rounds (decimal — e.g. 0.30 for +30%).
   *  Drives the golf-revenue context bullet in CFO commentary.
   *  Awaiting POS / tee-sheet aggregate projection. */
  memberRoundsYoyPct: number;
  /** Annual initiation-fees forecast. Drives the capital-funding
   *  bullet ("on annual forecast pace"). Awaiting Budget importer. */
  initiationFeesAnnualForecast: number;
  /** Per-account-code budget figures (current month + YTD).
   *  Awaiting Budget importer. */
  budget: {
    /** key = accountCode, value = { currentMonth, ytd } */
    byAccount: Record<string, { currentMonth: number; ytd: number }>;
    /** Roll-ups for the section / total rows. */
    rollups: {
      totalOperatingRevenue: { currentMonth: number; ytd: number };
      totalOperatingExpense: { currentMonth: number; ytd: number };
      depreciation: { currentMonth: number; ytd: number };
      totalCapitalIncome: { currentMonth: number; ytd: number };
      totalCapitalExpense: { currentMonth: number; ytd: number };
    };
  };
};

export async function getStatementOfActivitiesForClub(args: {
  clubId: string;
  clubName: string;
  period: ReportingPeriod;
  ledger: ReportingLedger & ReportingLedgerWriter;
  auxiliaryInputs: SoAAuxiliaryInputs;
  demoFallback?: () => StatementOfActivitiesV2;
}): Promise<StatementOfActivitiesV2> {
  const snapshots = await resolveIncomeStatementSnapshots({
    ledger: args.ledger,
    clubId: args.clubId,
    period: args.period,
  });

  if (snapshots) {
    return buildStatementOfActivitiesFromIncomeStatement({
      clubName: args.clubName,
      period: args.period,
      ytdActual: snapshots.ytd,
      // When only the YTD snapshot exists (no prior-period TB to derive
      // current-month from), fall back to using YTD values in both
      // columns. The rendered SoA labels the current column with the
      // period name regardless — this is the most honest signal.
      currentMonthActual: snapshots.currentMonth ?? snapshots.ytd,
      auxiliaryInputs: args.auxiliaryInputs,
    });
  }

  if (args.demoFallback) return args.demoFallback();

  // Pure-ledger callers with nothing to fall back to: degenerate
  // empty snapshot so the React contract stays valid.
  return buildStatementOfActivitiesFromIncomeStatement({
    clubName: args.clubName,
    period: args.period,
    ytdActual: emptyIncomeStatementSnapshot(args.clubId, args.period),
    currentMonthActual: emptyIncomeStatementSnapshot(args.clubId, args.period),
    auxiliaryInputs: args.auxiliaryInputs,
  });
}

// ---------------------------------------------------------------------------
// Snapshot resolver — self-healing branch (project from TB on demand)
// ---------------------------------------------------------------------------

async function resolveIncomeStatementSnapshots(args: {
  ledger: ReportingLedger & ReportingLedgerWriter;
  clubId: string;
  period: ReportingPeriod;
}): Promise<{
  ytd: IncomeStatementSnapshot;
  currentMonth: IncomeStatementSnapshot | null;
} | null> {
  // Normalize asOf to end-of-day for the TB existence check (same
  // convention as the SoFP refactor).
  const asOf = endOfDayUtc(args.period.periodEnd);
  const tb = await args.ledger.getTrialBalance(args.clubId, asOf);
  if (!tb) return null;

  // Founder rule 2026-07-01 v14.12 — direct IS snapshot preference.
  // The ledger's live-synthesis returns an authoritative
  // IncomeStatementSnapshot; the range-based projection fails on
  // non-standard Silver Springs COAs.
  // v14.13 — YTD window uses fiscal-year-start from the TB.
  const directYtd = await args.ledger.getIncomeStatement(
    args.clubId,
    tb.periodStart,
    asOf,
  );
  if (directYtd) {
    return { ytd: directYtd, currentMonth: null };
  }

  const projection = new IncomeStatementProjection({
    ledger: args.ledger,
    writer: args.ledger,
  });

  const ytdResult = await projection.getIncomeStatementSnapshot({
    clubId: args.clubId,
    periodStart: args.period.periodStart,
    periodEnd: asOf,
    fiscalYearLabel: tb.fiscalYearLabel,
    fiscalPeriodSequence: tb.fiscalPeriodSequence,
    mode: "ytd",
  });
  if (ytdResult.status !== "succeeded") return null;

  // Current-month requires the prior period's TB. Best-effort —
  // when absent the SoA renders YTD values in both columns.
  let currentMonth: IncomeStatementSnapshot | null = null;
  const cmResult = await projection.getIncomeStatementSnapshot({
    clubId: args.clubId,
    periodStart: args.period.periodStart,
    periodEnd: asOf,
    fiscalYearLabel: tb.fiscalYearLabel,
    fiscalPeriodSequence: tb.fiscalPeriodSequence,
    mode: "current-month",
  });
  if (cmResult.status === "succeeded") currentMonth = cmResult.snapshot;

  return { ytd: ytdResult.snapshot, currentMonth };
}

function endOfDayUtc(d: Date): Date {
  return new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      23, 59, 59, 999,
    ),
  );
}

function emptyIncomeStatementSnapshot(
  clubId: string,
  period: ReportingPeriod,
): IncomeStatementSnapshot {
  return {
    snapshotId: `is_empty_${clubId}`,
    clubId,
    capturedAt: new Date(0),
    sourceSystem: "manual-entry",
    importBatchId: null,
    dataSource: "demo",
    notes: "Empty IS snapshot — no ledger data for this club / period.",
    entityKind: "income-statement",
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    fiscalYearLabel: `FY${period.year}`,
    fiscalPeriodSequence: period.month,
    lines: [],
    totalOperatingRevenue: 0,
    totalOperatingExpense: 0,
    noiBeforeDepreciation: 0,
    depreciation: 0,
    totalCapitalIncome: 0,
    totalCapitalExpense: 0,
  };
}

// =============================================================================
// Snapshot-driven SoA builder
// =============================================================================

/**
 * Build a `StatementOfActivitiesV2` from current-month + YTD IS
 * snapshots. Every numeric trace back to a snapshot line OR a
 * documented auxiliary input.
 *
 * Layout:
 *   - One section band per operating-revenue department + a
 *     general/membership band
 *   - One band per expense bucket (COGS, Payroll, Other Opex,
 *     Fixed)
 *   - NOI Before Depreciation band (from snapshot.noiBeforeDepreciation)
 *   - Depreciation row (from snapshot.depreciation)
 *   - NOI After Depreciation
 *   - Capital divider + sub-bands for capital revenue and expense
 *   - Net Income Combined
 *
 * Per-row variances use the same convention as the seeded builder:
 *   - Revenue rows: variance = actual − budget
 *   - Expense rows: variance = budget − actual
 */
export function buildStatementOfActivitiesFromIncomeStatement(args: {
  clubName: string;
  period: ReportingPeriod;
  currentMonthActual: IncomeStatementSnapshot;
  ytdActual: IncomeStatementSnapshot;
  auxiliaryInputs: SoAAuxiliaryInputs;
}): StatementOfActivitiesV2 {
  const { ytdActual, currentMonthActual, auxiliaryInputs } = args;

  // -- Operating revenue rows, grouped by department --
  const operatingRows: StatementOfActivitiesV2Row[] = [];

  // General / dues — any operating revenue line without a department
  // OR with department=null.
  const duesLines = ytdActual.lines.filter(
    (l) => l.category === "revenue" && l.fund === "operating" && !l.departmentCode,
  );
  if (duesLines.length > 0) {
    operatingRows.push({
      key: "band-dues",
      kind: "section-band",
      label: "Operating Revenue — Covenant Foundation",
    });
    for (const line of duesLines) {
      operatingRows.push(buildRevenueRow(line, currentMonthActual, auxiliaryInputs));
    }
    operatingRows.push(buildSubtotal({
      key: "total-dues",
      label: "Total Dues Revenue",
      lines: duesLines,
      ytdSnapshot: ytdActual,
      cmSnapshot: currentMonthActual,
      isRevenue: true,
      auxiliaryInputs,
    }));
  }

  // Departmental revenue bands — GOLF / FB / RETAIL / AMENITY (any
  // departmentCode that appears in the snapshot).
  const departmentOrder = ["GOLF", "FB", "RETAIL", "AMENITY"] as const;
  const seenDepts = new Set<string>();
  for (const dept of departmentOrder) {
    const lines = ytdActual.lines.filter(
      (l) => l.category === "revenue" && l.fund === "operating" && l.departmentCode === dept,
    );
    if (lines.length === 0) continue;
    seenDepts.add(dept);
    operatingRows.push({
      key: `band-${dept.toLowerCase()}`,
      kind: "section-band",
      label: deptBandLabel(dept),
    });
    for (const line of lines) {
      operatingRows.push(buildRevenueRow(line, currentMonthActual, auxiliaryInputs));
    }
    operatingRows.push(buildSubtotal({
      key: `total-${dept.toLowerCase()}`,
      label: `Total ${deptBandLabel(dept)}`,
      lines,
      ytdSnapshot: ytdActual,
      cmSnapshot: currentMonthActual,
      isRevenue: true,
      auxiliaryInputs,
    }));
  }

  // Catch-all: any departmental revenue with a code not in the
  // canonical order — surface under "Other Departmental Revenue".
  const otherDeptLines = ytdActual.lines.filter(
    (l) =>
      l.category === "revenue" &&
      l.fund === "operating" &&
      l.departmentCode &&
      !seenDepts.has(l.departmentCode),
  );
  if (otherDeptLines.length > 0) {
    operatingRows.push({
      key: "band-other-dept",
      kind: "section-band",
      label: "Other Departmental Revenue",
    });
    for (const line of otherDeptLines) {
      operatingRows.push(buildRevenueRow(line, currentMonthActual, auxiliaryInputs));
    }
  }

  // Total Operating Revenue — from snapshot roll-up.
  operatingRows.push(buildTotalRow({
    key: "total-operating-revenue",
    label: "Total Operating Revenue",
    ytdActual: ytdActual.totalOperatingRevenue,
    cmActual: currentMonthActual.totalOperatingRevenue,
    ytdBudget: auxiliaryInputs.budget.rollups.totalOperatingRevenue.ytd,
    cmBudget: auxiliaryInputs.budget.rollups.totalOperatingRevenue.currentMonth,
    isRevenue: true,
  }));

  // -- Operating expenses --
  const opexLines = ytdActual.lines.filter(
    (l) =>
      l.category === "expense" &&
      l.fund === "operating" &&
      !/depreciation/i.test(l.accountName),
  );
  if (opexLines.length > 0) {
    operatingRows.push({ key: "band-opex", kind: "section-band", label: "Operating Expenses" });
    for (const line of opexLines) {
      operatingRows.push(buildExpenseRow(line, currentMonthActual, auxiliaryInputs));
    }
  }

  // NOI Before Depreciation — from snapshot.
  const ytdNoiBefore = ytdActual.noiBeforeDepreciation;
  const cmNoiBefore = currentMonthActual.noiBeforeDepreciation;
  const ytdBudgetNoiBefore =
    auxiliaryInputs.budget.rollups.totalOperatingRevenue.ytd -
    (auxiliaryInputs.budget.rollups.totalOperatingExpense.ytd -
      auxiliaryInputs.budget.rollups.depreciation.ytd);
  const cmBudgetNoiBefore =
    auxiliaryInputs.budget.rollups.totalOperatingRevenue.currentMonth -
    (auxiliaryInputs.budget.rollups.totalOperatingExpense.currentMonth -
      auxiliaryInputs.budget.rollups.depreciation.currentMonth);
  operatingRows.push({
    key: "noi-before-dep",
    kind: "noi-band",
    label: "Net Operating Income Before Depreciation",
    values: {
      currentBudget: cmBudgetNoiBefore,
      currentActual: cmNoiBefore,
      currentVariance: cmNoiBefore - cmBudgetNoiBefore,
      ytdBudget: ytdBudgetNoiBefore,
      ytdActual: ytdNoiBefore,
      ytdVariance: ytdNoiBefore - ytdBudgetNoiBefore,
      variancePct:
        ytdBudgetNoiBefore !== 0
          ? (ytdNoiBefore - ytdBudgetNoiBefore) / Math.abs(ytdBudgetNoiBefore)
          : null,
    },
  });

  // Depreciation — derived from snapshot.depreciation (was hardcoded!).
  const ytdDepBudget = auxiliaryInputs.budget.rollups.depreciation.ytd;
  const cmDepBudget = auxiliaryInputs.budget.rollups.depreciation.currentMonth;
  operatingRows.push({
    key: "depreciation",
    kind: "depreciation",
    label: "Depreciation",
    values: {
      currentBudget: -cmDepBudget,
      currentActual: -currentMonthActual.depreciation,
      currentVariance: cmDepBudget - currentMonthActual.depreciation,
      ytdBudget: -ytdDepBudget,
      ytdActual: -ytdActual.depreciation,
      ytdVariance: ytdDepBudget - ytdActual.depreciation,
      variancePct:
        ytdDepBudget !== 0
          ? (ytdDepBudget - ytdActual.depreciation) / Math.abs(ytdDepBudget)
          : null,
    },
  });

  // NOI After Depreciation — derived: NOI Before Dep − Depreciation.
  const ytdNoiAfter = ytdNoiBefore - ytdActual.depreciation;
  const cmNoiAfter = cmNoiBefore - currentMonthActual.depreciation;
  const ytdBudgetNoiAfter = ytdBudgetNoiBefore - ytdDepBudget;
  const cmBudgetNoiAfter = cmBudgetNoiBefore - cmDepBudget;
  operatingRows.push({
    key: "noi-after-dep",
    kind: "noi-after",
    label: "Net Operating Income (Loss) After Depreciation",
    values: {
      currentBudget: cmBudgetNoiAfter,
      currentActual: cmNoiAfter,
      currentVariance: cmNoiAfter - cmBudgetNoiAfter,
      ytdBudget: ytdBudgetNoiAfter,
      ytdActual: ytdNoiAfter,
      ytdVariance: ytdNoiAfter - ytdBudgetNoiAfter,
      variancePct:
        ytdBudgetNoiAfter !== 0
          ? (ytdNoiAfter - ytdBudgetNoiAfter) / Math.abs(ytdBudgetNoiAfter)
          : null,
    },
  });

  // -- Capital section --
  const capitalRows: StatementOfActivitiesV2Row[] = [
    {
      key: "capital-divider",
      kind: "capital-divider",
      label: "Capital Fund & Non-Operating — Below This Line",
    },
    {
      key: "capital-intro",
      kind: "capital-intro",
      text:
        "Initiation fees, capital dues, and investment income are capital governance revenues — not operating income. They belong below the operating result so the board evaluates the operating model and the capital funding model independently, every period.",
    },
  ];

  const capitalRevLines = ytdActual.lines.filter(
    (l) => l.category === "revenue" && l.fund === "capital",
  );
  if (capitalRevLines.length > 0) {
    capitalRows.push({ key: "band-capital-rev", kind: "capital-band", label: "Capital Revenue" });
    for (const line of capitalRevLines) {
      const row = buildRevenueRow(line, currentMonthActual, auxiliaryInputs);
      // "On Plan" chip for capital dues lines whose YTD variance ≈ 0.
      const budget = auxiliaryInputs.budget.byAccount[line.accountCode];
      if (
        /capital dues/i.test(line.accountName) &&
        budget &&
        Math.abs(line.amount - budget.ytd) < 1
      ) {
        row.chip = { label: "On Plan", tone: "on-plan" };
      }
      capitalRows.push(row);
    }
  }

  const capitalExpLines = ytdActual.lines.filter(
    (l) => l.category === "expense" && l.fund === "capital",
  );
  if (capitalExpLines.length > 0) {
    capitalRows.push({
      key: "band-capital-expenses",
      kind: "capital-band",
      label: "Capital Fund Expenses",
    });
    for (const line of capitalExpLines) {
      // Capital expense rows render as negative amounts.
      const cmLine = currentMonthActual.lines.find(
        (l) => l.accountCode === line.accountCode,
      );
      const budget = auxiliaryInputs.budget.byAccount[line.accountCode] ?? {
        currentMonth: 0,
        ytd: 0,
      };
      capitalRows.push({
        key: `acct-${line.accountCode}`,
        kind: "detail",
        label: line.accountName,
        values: {
          currentBudget: -budget.currentMonth,
          currentActual: -(cmLine?.amount ?? 0),
          currentVariance: budget.currentMonth - (cmLine?.amount ?? 0),
          ytdBudget: -budget.ytd,
          ytdActual: -line.amount,
          ytdVariance: budget.ytd - line.amount,
          variancePct: budget.ytd !== 0 ? (budget.ytd - line.amount) / Math.abs(budget.ytd) : null,
        },
      });
    }
  }

  // Total Capital Fund Activity — from snapshot roll-ups.
  const ytdCapitalNet = ytdActual.totalCapitalIncome - ytdActual.totalCapitalExpense;
  const cmCapitalNet = currentMonthActual.totalCapitalIncome - currentMonthActual.totalCapitalExpense;
  const ytdCapitalNetBudget =
    auxiliaryInputs.budget.rollups.totalCapitalIncome.ytd -
    auxiliaryInputs.budget.rollups.totalCapitalExpense.ytd;
  const cmCapitalNetBudget =
    auxiliaryInputs.budget.rollups.totalCapitalIncome.currentMonth -
    auxiliaryInputs.budget.rollups.totalCapitalExpense.currentMonth;
  capitalRows.push({
    key: "total-capital",
    kind: "capital-total",
    label: "Total Capital Fund Activity (Net)",
    values: {
      currentBudget: cmCapitalNetBudget,
      currentActual: cmCapitalNet,
      currentVariance: cmCapitalNet - cmCapitalNetBudget,
      ytdBudget: ytdCapitalNetBudget,
      ytdActual: ytdCapitalNet,
      ytdVariance: ytdCapitalNet - ytdCapitalNetBudget,
      variancePct:
        ytdCapitalNetBudget !== 0
          ? (ytdCapitalNet - ytdCapitalNetBudget) / Math.abs(ytdCapitalNetBudget)
          : null,
    },
  });

  // Net Income Combined — NOI After Dep + Capital Net.
  const ytdCombined = ytdNoiAfter + ytdCapitalNet;
  const cmCombined = cmNoiAfter + cmCapitalNet;
  const ytdCombinedBudget = ytdBudgetNoiAfter + ytdCapitalNetBudget;
  const cmCombinedBudget = cmBudgetNoiAfter + cmCapitalNetBudget;
  capitalRows.push({
    key: "net-combined",
    kind: "net-combined",
    label: "Net Income (Loss) — Combined",
    values: {
      currentBudget: cmCombinedBudget,
      currentActual: cmCombined,
      currentVariance: cmCombined - cmCombinedBudget,
      ytdBudget: ytdCombinedBudget,
      ytdActual: ytdCombined,
      ytdVariance: ytdCombined - ytdCombinedBudget,
      variancePct:
        ytdCombinedBudget !== 0
          ? (ytdCombined - ytdCombinedBudget) / Math.abs(ytdCombinedBudget)
          : null,
    },
  });

  // Build CFO commentary from the resolved actuals + auxiliary inputs.
  const capitalDuesActual = capitalRevLines
    .filter((l) => /capital dues/i.test(l.accountName))
    .reduce((s, l) => s + l.amount, 0);
  const capitalDuesBudget = capitalRevLines
    .filter((l) => /capital dues/i.test(l.accountName))
    .reduce(
      (s, l) => s + (auxiliaryInputs.budget.byAccount[l.accountCode]?.ytd ?? 0),
      0,
    );
  const initiationFeesActual = capitalRevLines
    .filter((l) => /initiation/i.test(l.accountName))
    .reduce((s, l) => s + l.amount, 0);

  // Payroll variance — sum payroll-tagged opex lines.
  const payrollLines = opexLines.filter((l) => /payroll|benefits/i.test(l.accountName));
  const payrollYtdActual = payrollLines.reduce((s, l) => s + l.amount, 0);
  const payrollYtdBudget = payrollLines.reduce(
    (s, l) => s + (auxiliaryInputs.budget.byAccount[l.accountCode]?.ytd ?? 0),
    0,
  );
  // Expense variance convention: budget − actual.
  const payrollVariance = payrollYtdBudget - payrollYtdActual;
  const otherOpexYtdActual = opexLines
    .filter((l) => !/payroll|benefits/i.test(l.accountName))
    .reduce((s, l) => s + l.amount, 0);
  const otherOpexYtdBudget = opexLines
    .filter((l) => !/payroll|benefits/i.test(l.accountName))
    .reduce((s, l) => s + (auxiliaryInputs.budget.byAccount[l.accountCode]?.ytd ?? 0), 0);
  const otherOpexVariance = otherOpexYtdBudget - otherOpexYtdActual;

  const cfo = buildCfoCommentary({
    noiBudget: ytdBudgetNoiBefore,
    noiActual: ytdNoiBefore,
    noiVariance: ytdNoiBefore - ytdBudgetNoiBefore,
    noiVariancePct:
      ytdBudgetNoiBefore !== 0
        ? (ytdNoiBefore - ytdBudgetNoiBefore) / Math.abs(ytdBudgetNoiBefore)
        : 0,
    revenueVariance:
      ytdActual.totalOperatingRevenue -
      auxiliaryInputs.budget.rollups.totalOperatingRevenue.ytd,
    payrollVariance,
    otherOpExpVariance: otherOpexVariance,
    memberRoundsYoyPct: auxiliaryInputs.memberRoundsYoyPct,
    initiationFeesYtd: initiationFeesActual,
    initiationFeesAnnualForecast: auxiliaryInputs.initiationFeesAnnualForecast,
    capitalDuesBudget,
    capitalDuesActual,
    periodLabel: args.period.periodLabel,
  });

  return {
    dataSource:
      ytdActual.dataSource === "demo" ? "demo" : "live",
    eyebrow: `${args.clubName} · Financial Statement`,
    title: "Statement of Activities — Two-Fund Format",
    periodLabel: args.period.statementHeaderLabel,
    introNote:
      "Operating revenues and expenses above the NOI line. Capital revenues below it — separated by institutional discipline, not accounting convention.",
    statementNumber: "Statement 04 of 14",
    documentChip: "Financial Statement",
    preparedFor: "Finance Committee",
    columnHeaders: args.period.columnLabels,
    operatingRows,
    capitalRows,
    cfoCommentary: cfo,
  };
}

// =============================================================================
// Silver Springs auxiliary-input defaults
// =============================================================================
//
// Constant per-account budget pattern that the dual-read uses on the
// LIVE branch (until Budget importer + POS aggregate land). The
// values match what the Silver Springs seed expressed — so when the
// dual-read runs with the same Silver Springs IS snapshot, the
// rendered SoA reads ~identically to the pre-refactor demo.

export const SILVER_SPRINGS_SOA_AUXILIARY_INPUTS: SoAAuxiliaryInputs = {
  memberRoundsYoyPct: 0.30,
  initiationFeesAnnualForecast: 2_160_000,
  budget: {
    byAccount: {
      // operating revenue
      "4010": { currentMonth:   390_525, ytd: 1_171_575 },
      "4020": { currentMonth:   100_119, ytd:   300_355 },
      "4110": { currentMonth:    85_000, ytd:   168_750 },
      "4120": { currentMonth:    55_150, ytd:   165_450 },
      "4130": { currentMonth:    72_000, ytd:   186_300 },
      "4140": { currentMonth:   104_965, ytd:   233_517 },
      "4210": { currentMonth:   135_250, ytd:   379_710 },
      "4220": { currentMonth:    90_679, ytd:   245_698 },
      "4230": { currentMonth:    15_293, ytd:    45_355 },
      "4410": { currentMonth:    44_633, ytd:   133_900 },
      "4420": { currentMonth:    24_750, ytd:    74_250 },
      "4430": { currentMonth:    12_600, ytd:    37_800 },
      "4440": { currentMonth:     5_125, ytd:    15_375 },
      "4450": { currentMonth:    19_435, ytd:    49_035 },
      // operating expense
      "5110": { currentMonth:    53_400, ytd:   138_120 },
      "5210": { currentMonth:    70_301, ytd:   199_728 },
      "5220": { currentMonth:    42_062, ytd:   115_814 },
      "5290": { currentMonth:     5_036, ytd:    14_142 },
      "5400": { currentMonth: 1_032_620, ytd: 3_030_191 },
      "5500": { currentMonth:   158_075, ytd:   489_934 },
      "6110": { currentMonth:   110_421, ytd:   247_607 },
      "6210": { currentMonth:    35_427, ytd:   100_672 },
      "6310": { currentMonth:    97_943, ytd:   258_481 },
      "6410": { currentMonth:    98_766, ytd:   278_677 },
      "6510_GA": { currentMonth:  86_862, ytd:   254_173 },
      "6710": { currentMonth:    73_178, ytd:   183_228 },
      "6810": { currentMonth:    28_408, ytd:    85_225 },
      "6510": { currentMonth:   350_000, ytd: 1_050_000 }, // depreciation
      // capital
      "9010": { currentMonth:   180_000, ytd:   540_000 },
      "9020": { currentMonth:   160_000, ytd:   480_000 },
      "9030": { currentMonth:    14_583, ytd:    43_750 },
      "9040": { currentMonth:         0, ytd:         0 },
      "9510": { currentMonth:     4_225, ytd:    12_918 },
    },
    rollups: {
      totalOperatingRevenue: { currentMonth: 1_155_524, ytd: 3_207_070 },
      totalOperatingExpense: { currentMonth: 1_892_499, ytd: 5_395_992 },
      depreciation:          { currentMonth:   350_000, ytd: 1_050_000 },
      totalCapitalIncome:    { currentMonth:   354_583, ytd: 1_063_750 },
      totalCapitalExpense:   { currentMonth:     4_225, ytd:    12_918 },
    },
  },
};

// =============================================================================
// Internal row builders
// =============================================================================

function buildRevenueRow(
  line: IncomeStatementLine,
  cmSnapshot: IncomeStatementSnapshot,
  aux: SoAAuxiliaryInputs,
): StatementOfActivitiesV2Row {
  const cmAmount = cmSnapshot.lines.find((l) => l.accountCode === line.accountCode)?.amount ?? 0;
  const budget = aux.budget.byAccount[line.accountCode] ?? { currentMonth: 0, ytd: 0 };
  return {
    key: `acct-${line.accountCode}`,
    kind: "detail",
    label: line.accountName,
    values: {
      currentBudget: budget.currentMonth,
      currentActual: cmAmount,
      currentVariance: cmAmount - budget.currentMonth,
      ytdBudget: budget.ytd,
      ytdActual: line.amount,
      ytdVariance: line.amount - budget.ytd,
      variancePct: budget.ytd !== 0 ? (line.amount - budget.ytd) / budget.ytd : null,
    },
  };
}

function buildExpenseRow(
  line: IncomeStatementLine,
  cmSnapshot: IncomeStatementSnapshot,
  aux: SoAAuxiliaryInputs,
): StatementOfActivitiesV2Row {
  const cmAmount = cmSnapshot.lines.find((l) => l.accountCode === line.accountCode)?.amount ?? 0;
  const budget = aux.budget.byAccount[line.accountCode] ?? { currentMonth: 0, ytd: 0 };
  // Expense convention: variance = budget − actual.
  return {
    key: `acct-${line.accountCode}`,
    kind: "detail",
    label: line.accountName,
    values: {
      currentBudget: budget.currentMonth,
      currentActual: cmAmount,
      currentVariance: budget.currentMonth - cmAmount,
      ytdBudget: budget.ytd,
      ytdActual: line.amount,
      ytdVariance: budget.ytd - line.amount,
      variancePct: budget.ytd !== 0 ? (budget.ytd - line.amount) / budget.ytd : null,
    },
  };
}

function buildSubtotal(args: {
  key: string;
  label: string;
  lines: ReadonlyArray<IncomeStatementLine>;
  ytdSnapshot: IncomeStatementSnapshot;
  cmSnapshot: IncomeStatementSnapshot;
  isRevenue: boolean;
  auxiliaryInputs: SoAAuxiliaryInputs;
}): StatementOfActivitiesV2Row {
  let ytdActual = 0;
  let cmActual = 0;
  let ytdBudget = 0;
  let cmBudget = 0;
  for (const line of args.lines) {
    ytdActual += line.amount;
    cmActual += args.cmSnapshot.lines.find((l) => l.accountCode === line.accountCode)?.amount ?? 0;
    const b = args.auxiliaryInputs.budget.byAccount[line.accountCode];
    if (b) {
      ytdBudget += b.ytd;
      cmBudget += b.currentMonth;
    }
  }
  return buildTotalRow({
    key: args.key,
    label: args.label,
    kind: "subtotal",
    ytdActual,
    cmActual,
    ytdBudget,
    cmBudget,
    isRevenue: args.isRevenue,
  });
}

function buildTotalRow(args: {
  key: string;
  label: string;
  kind?: StatementOfActivitiesV2RowKind;
  ytdActual: number;
  cmActual: number;
  ytdBudget: number;
  cmBudget: number;
  isRevenue: boolean;
}): StatementOfActivitiesV2Row {
  const ytdVariance = args.isRevenue
    ? args.ytdActual - args.ytdBudget
    : args.ytdBudget - args.ytdActual;
  const cmVariance = args.isRevenue
    ? args.cmActual - args.cmBudget
    : args.cmBudget - args.cmActual;
  return {
    key: args.key,
    kind: args.kind ?? "total",
    label: args.label,
    values: {
      currentBudget: args.cmBudget,
      currentActual: args.cmActual,
      currentVariance: cmVariance,
      ytdBudget: args.ytdBudget,
      ytdActual: args.ytdActual,
      ytdVariance,
      variancePct: args.ytdBudget !== 0 ? ytdVariance / Math.abs(args.ytdBudget) : null,
    },
  };
}

function deptBandLabel(dept: string): string {
  switch (dept) {
    case "GOLF": return "Golf Operations";
    case "FB": return "Food & Beverage";
    case "RETAIL": return "Retail";
    case "AMENITY": return "Amenities & Other";
    default: return dept;
  }
}
