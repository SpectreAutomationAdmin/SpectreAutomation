// Stewardship Red / Amber / Green rule engine.
//
// One module owns every threshold, every status classification, and
// every narrative phrase that consumes a tone. Status chips,
// scorecard rows, KPI tiles, and Dashboard Notes commentary all
// flow from the same `RagRuleResult` objects — preventing the
// "red KPI, green narrative" contradiction the founder flagged.
//
// 8 rules covered (per the audit + the cover-page narrative):
//   • operating-revenue-variance
//   • noi-variance
//   • capital-income
//   • reserve-coverage
//   • dues-to-revenue
//   • debt-service-coverage
//   • net-to-gross-ppe
//   • ar-current-rate
//
// Every rule has the same output shape (`RagRuleResult`) so any
// downstream consumer — a status chip, a scorecard row, a Dashboard
// Notes paragraph — can render from a uniform interface. Adding a
// new metric is a one-function addition; the consumers don't change.
//
// THE CONTRADICTION GUARANTEE: the narrative builder
// (`buildRagDashboardNarrative`) DERIVES its tone from
// `worstStatus(results)` and names every red / amber rule by label.
// There is no code path where it can claim "favorable" while a rule
// is red — the inputs are the rule results themselves, not separate
// strings.

import { formatMoneyShort } from "@/lib/reporting/monthly-accounting-contract";

// ---------------------------------------------------------------------------
// Status taxonomy
// ---------------------------------------------------------------------------

/** Three-state RAG signal. Stewardship-wide canonical taxonomy.
 *  Existing scorecard / KPI types use slightly different value names
 *  (`"on-track" | "monitor" | "action"` and
 *  `"green" | "amber" | "red"` and `KpiTone`). Helpers below convert
 *  between them. */
export type RagStatus = "green" | "amber" | "red";

/** Pick the most conservative status across a set of rules. Used by
 *  the narrative builder to drive the opening verdict and the
 *  scorecard top-level tone. */
export function worstStatus(results: ReadonlyArray<RagRuleResult>): RagStatus {
  if (results.some((r) => r.status === "red")) return "red";
  if (results.some((r) => r.status === "amber")) return "amber";
  return "green";
}

// ---------------------------------------------------------------------------
// Threshold policy — every rule's bands in ONE table
// ---------------------------------------------------------------------------

/**
 * Centralised threshold policy. Every number here is a board-level
 * policy decision; updating the policy updates every consumer
 * (scorecards, KPI tiles, narrative) in lockstep.
 *
 * Numbers are stated as the GREEN / AMBER edges. RED is "outside
 * amber on the worse side". Where signs matter, GREEN is always the
 * "good" side.
 */
export const RAG_THRESHOLDS = {
  /** Operating revenue: % variance vs budget. */
  operatingRevenueVariance: {
    greenMinPct: -0.01, // ≥ −1 % → green
    amberMinPct: -0.05, // −5 % to −1 % → amber; below −5 % → red
  },
  /** NOI vs budget: dollar cushion `max($X, Y % of |budget|)`. */
  noiVariance: {
    minDollarCushion: 50_000,
    pctCushion: 0.05,
  },
  /** Capital income: % variance vs budget. Wider band than
   *  operating revenue (capital is lumpier — initiation fees + lot
   *  sales arrive in bursts). */
  capitalIncome: {
    greenMinPct: -0.05, // ≥ −5 % → green
    amberMinPct: -0.10, // −10 % to −5 % → amber; below −10 % → red
  },
  /** Reserve coverage ratio vs policy floor. */
  reserveCoverage: {
    greenFloorFraction: 1.0,   // ≥ floor → green
    amberFloorFraction: 0.95,  // ≥ 95 % of floor → amber; below → red
  },
  /** Dues-to-Revenue ratio (operating dues ÷ total revenue). The
   *  industry rule of thumb is a private club's dues must be ≥ 60 %
   *  of revenue to be structurally sustainable (otherwise the club
   *  is "selling its way out" of operating costs via F&B / events). */
  duesToRevenue: {
    greenMinPct: 60, // ≥ 60 % → green
    amberMinPct: 55, // 55–60 % → amber; below 55 % → red
  },
  /** Debt Service Coverage Ratio (operating cash flow ÷ annual debt
   *  service). Industry standard: 1.25× is bankable; 1.0× is the
   *  bare minimum. */
  debtServiceCoverage: {
    greenMinRatio: 1.25,
    amberMinRatio: 1.0, // 1.00–1.25 → amber; below 1.00 → red
  },
  /** Net-to-Gross PP&E ratio. Below 50 % indicates an aging asset
   *  base; below 40 % is materially below benchmark. */
  netToGrossPpe: {
    greenMinPct: 50,
    amberMinPct: 40,
  },
  /** AR Current Rate (current bucket / total AR). 80 % is the
   *  collections-policy target; below 70 % is in action territory. */
  arCurrentRate: {
    greenMinPct: 80,
    amberMinPct: 70,
  },
} as const;

// ---------------------------------------------------------------------------
// Unified rule result shape
// ---------------------------------------------------------------------------

/** Stable rule key. Each rule has exactly one. */
export type RagRuleKey =
  | "operating-revenue-variance"
  | "noi-variance"
  | "capital-income"
  | "reserve-coverage"
  | "dues-to-revenue"
  | "debt-service-coverage"
  | "net-to-gross-ppe"
  | "ar-current-rate";

/** The canonical output every rule returns. Scorecards, status
 *  chips, KPI tiles, and the Dashboard Notes paragraph all consume
 *  this shape. */
export type RagRuleResult = {
  ruleKey: RagRuleKey;
  /** Human-readable metric name. */
  label: string;
  /** Three-state status. */
  status: RagStatus;
  /** Pre-formatted value for display. */
  valueLabel: string;
  /** Pre-formatted benchmark description. */
  benchmarkLabel: string;
  /** One-sentence explanation citing the value + the threshold
   *  reason for the classified status. */
  explanation: string;
  /** Raw numeric value (varies by rule — variance %, ratio, etc.). */
  rawValue: number;
  /** Variance percent when applicable (revenue / NOI / capital
   *  income); `null` when not applicable. */
  variancePct: number | null;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function pctLabel(fraction: number, decimals = 1): string {
  return `${(fraction * 100).toFixed(decimals)}%`;
}

function signedPctLabel(fraction: number, decimals = 1): string {
  const sign = fraction > 0 ? "+" : "";
  return `${sign}${pctLabel(fraction, decimals)}`;
}

function ratioLabel(ratio: number, decimals = 2): string {
  return `${ratio.toFixed(decimals)}x`;
}

// ---------------------------------------------------------------------------
// Rule 1 — Operating Revenue Variance
// ---------------------------------------------------------------------------

export type OperatingRevenueVarianceInput = {
  actual: number;
  budget: number;
};

export function classifyOperatingRevenueVariance(
  input: OperatingRevenueVarianceInput,
): RagRuleResult {
  const t = RAG_THRESHOLDS.operatingRevenueVariance;
  if (input.budget <= 0) {
    return neutralRuleResult({
      ruleKey: "operating-revenue-variance",
      label: "Operating Revenue Variance",
      benchmarkLabel: `Green ≥ ${signedPctLabel(t.greenMinPct)}, amber ${signedPctLabel(t.amberMinPct)}–${signedPctLabel(t.greenMinPct)}, red below`,
      explanation: "Budget comparator unavailable — variance cannot be classified.",
      valueLabel: formatMoneyShort(input.actual),
    });
  }
  const variancePct = (input.actual - input.budget) / Math.abs(input.budget);
  const varianceAmount = input.actual - input.budget;
  let status: RagStatus;
  if (variancePct >= t.greenMinPct) status = "green";
  else if (variancePct >= t.amberMinPct) status = "amber";
  else status = "red";
  return {
    ruleKey: "operating-revenue-variance",
    label: "Operating Revenue Variance",
    status,
    valueLabel: `${formatMoneyShort(input.actual)} (${signedPctLabel(variancePct)})`,
    benchmarkLabel: `vs ${formatMoneyShort(input.budget)} budget; green ≥ ${signedPctLabel(t.greenMinPct)}, amber ${signedPctLabel(t.amberMinPct)}–${signedPctLabel(t.greenMinPct)}`,
    explanation:
      status === "green"
        ? `Revenue is ${signedPctLabel(variancePct)} vs the ${formatMoneyShort(input.budget)} plan (${formatMoneyShort(varianceAmount)}) — at or above the policy floor.`
        : status === "amber"
          ? `Revenue is ${signedPctLabel(variancePct)} vs the ${formatMoneyShort(input.budget)} plan (${formatMoneyShort(varianceAmount)}) — inside the monitor band but below plan.`
          : `Revenue is ${signedPctLabel(variancePct)} vs the ${formatMoneyShort(input.budget)} plan (${formatMoneyShort(varianceAmount)}) — materially below the policy floor.`,
    rawValue: input.actual,
    variancePct,
  };
}

// ---------------------------------------------------------------------------
// Rule 2 — NOI Variance
// ---------------------------------------------------------------------------

export type NoiVarianceInput = {
  actual: number;
  budget: number;
};

export function classifyNoiVariance(input: NoiVarianceInput): RagRuleResult {
  const t = RAG_THRESHOLDS.noiVariance;
  const delta = input.actual - input.budget;
  const cushion = Math.max(t.minDollarCushion, Math.abs(input.budget) * t.pctCushion);
  let status: RagStatus;
  if (delta >= 0) status = "green";
  else if (Math.abs(delta) <= cushion) status = "amber";
  else status = "red";
  return {
    ruleKey: "noi-variance",
    label: "NOI Variance to Budget",
    status,
    valueLabel: `${formatMoneyShort(input.actual)} vs ${formatMoneyShort(input.budget)}`,
    benchmarkLabel: `Green ≥ budget; amber within ${formatMoneyShort(cushion)} cushion; red beyond`,
    explanation:
      status === "green"
        ? `NOI of ${formatMoneyShort(input.actual)} is at or above the ${formatMoneyShort(input.budget)} budget.`
        : status === "amber"
          ? `NOI of ${formatMoneyShort(input.actual)} is ${formatMoneyShort(Math.abs(delta))} below the ${formatMoneyShort(input.budget)} budget — within the ${formatMoneyShort(cushion)} monitor cushion.`
          : `NOI of ${formatMoneyShort(input.actual)} is ${formatMoneyShort(Math.abs(delta))} below the ${formatMoneyShort(input.budget)} budget — beyond the ${formatMoneyShort(cushion)} monitor cushion.`,
    rawValue: input.actual,
    variancePct: input.budget !== 0 ? delta / Math.abs(input.budget) : null,
  };
}

// ---------------------------------------------------------------------------
// Rule 3 — Capital Income
// ---------------------------------------------------------------------------

export type CapitalIncomeInput = {
  actual: number;
  budget: number;
};

export function classifyCapitalIncome(input: CapitalIncomeInput): RagRuleResult {
  const t = RAG_THRESHOLDS.capitalIncome;
  if (input.budget <= 0) {
    return neutralRuleResult({
      ruleKey: "capital-income",
      label: "Capital Income vs Budget",
      benchmarkLabel: `Green ≥ ${signedPctLabel(t.greenMinPct)}, amber ${signedPctLabel(t.amberMinPct)}–${signedPctLabel(t.greenMinPct)}, red below`,
      explanation: "Capital income budget comparator unavailable — variance cannot be classified.",
      valueLabel: formatMoneyShort(input.actual),
    });
  }
  const variancePct = (input.actual - input.budget) / Math.abs(input.budget);
  const varianceAmount = input.actual - input.budget;
  let status: RagStatus;
  if (variancePct >= t.greenMinPct) status = "green";
  else if (variancePct >= t.amberMinPct) status = "amber";
  else status = "red";
  return {
    ruleKey: "capital-income",
    label: "Capital Income vs Budget",
    status,
    valueLabel: `${formatMoneyShort(input.actual)} (${signedPctLabel(variancePct)})`,
    benchmarkLabel: `vs ${formatMoneyShort(input.budget)} budget; green ≥ ${signedPctLabel(t.greenMinPct)}, amber ${signedPctLabel(t.amberMinPct)}–${signedPctLabel(t.greenMinPct)}`,
    explanation:
      status === "green"
        ? `Capital income of ${formatMoneyShort(input.actual)} is ${signedPctLabel(variancePct)} vs the ${formatMoneyShort(input.budget)} plan (${formatMoneyShort(varianceAmount)}) — at or above the policy floor.`
        : status === "amber"
          ? `Capital income of ${formatMoneyShort(input.actual)} is ${signedPctLabel(variancePct)} vs the ${formatMoneyShort(input.budget)} plan (${formatMoneyShort(varianceAmount)}) — inside the monitor band.`
          : `Capital income of ${formatMoneyShort(input.actual)} is ${signedPctLabel(variancePct)} vs the ${formatMoneyShort(input.budget)} plan (${formatMoneyShort(varianceAmount)}) — materially below plan.`,
    rawValue: input.actual,
    variancePct,
  };
}

// ---------------------------------------------------------------------------
// Rule 4 — Reserve Coverage
// ---------------------------------------------------------------------------

export type ReserveCoverageInput = {
  ratio: number;
  policyFloor: number;
};

export function classifyReserveCoverage(input: ReserveCoverageInput): RagRuleResult {
  const t = RAG_THRESHOLDS.reserveCoverage;
  if (input.policyFloor <= 0) {
    return neutralRuleResult({
      ruleKey: "reserve-coverage",
      label: "Capital Reserve Coverage",
      benchmarkLabel: "Policy floor not configured",
      explanation: "Reserve-coverage policy floor not configured in the reporting service.",
      valueLabel: ratioLabel(input.ratio),
    });
  }
  let status: RagStatus;
  if (input.ratio >= input.policyFloor * t.greenFloorFraction) status = "green";
  else if (input.ratio >= input.policyFloor * t.amberFloorFraction) status = "amber";
  else status = "red";
  return {
    ruleKey: "reserve-coverage",
    label: "Capital Reserve Coverage",
    status,
    valueLabel: ratioLabel(input.ratio),
    benchmarkLabel: `Policy floor ${ratioLabel(input.policyFloor)}; amber within 5% of floor`,
    explanation:
      status === "green"
        ? `Reserve coverage of ${ratioLabel(input.ratio)} is at or above the ${ratioLabel(input.policyFloor)} policy floor.`
        : status === "amber"
          ? `Reserve coverage of ${ratioLabel(input.ratio)} sits within 5% of the ${ratioLabel(input.policyFloor)} policy floor — the margin warrants monitoring.`
          : `Reserve coverage of ${ratioLabel(input.ratio)} has fallen below the ${ratioLabel(input.policyFloor)} policy floor.`,
    rawValue: input.ratio,
    variancePct: null,
  };
}

// ---------------------------------------------------------------------------
// Rule 5 — Dues-to-Revenue Ratio
// ---------------------------------------------------------------------------

export type DuesToRevenueInput = {
  duesRevenue: number;
  totalRevenue: number;
};

export function classifyDuesToRevenue(input: DuesToRevenueInput): RagRuleResult {
  const t = RAG_THRESHOLDS.duesToRevenue;
  if (input.totalRevenue <= 0) {
    return neutralRuleResult({
      ruleKey: "dues-to-revenue",
      label: "Dues-to-Revenue Ratio",
      benchmarkLabel: `Green ≥ ${t.greenMinPct}%, amber ${t.amberMinPct}–${t.greenMinPct}%`,
      explanation: "Total revenue is zero — dues-to-revenue ratio cannot be computed.",
      valueLabel: "—",
    });
  }
  const ratioPct = (input.duesRevenue / input.totalRevenue) * 100;
  let status: RagStatus;
  if (ratioPct >= t.greenMinPct) status = "green";
  else if (ratioPct >= t.amberMinPct) status = "amber";
  else status = "red";
  return {
    ruleKey: "dues-to-revenue",
    label: "Dues-to-Revenue Ratio",
    status,
    valueLabel: `${ratioPct.toFixed(1)}%`,
    benchmarkLabel: `Green ≥ ${t.greenMinPct}%, amber ${t.amberMinPct}–${t.greenMinPct}%`,
    explanation:
      status === "green"
        ? `Dues-to-revenue of ${ratioPct.toFixed(1)}% is at or above the ${t.greenMinPct}% structural-sustainability floor.`
        : status === "amber"
          ? `Dues-to-revenue of ${ratioPct.toFixed(1)}% sits below the ${t.greenMinPct}% floor but within the monitor band — the club is leaning on non-dues revenue to cover operating costs.`
          : `Dues-to-revenue of ${ratioPct.toFixed(1)}% is below the ${t.amberMinPct}% action threshold — the club is structurally under-priced.`,
    rawValue: ratioPct,
    variancePct: null,
  };
}

// ---------------------------------------------------------------------------
// Rule 6 — Debt Service Coverage Ratio
// ---------------------------------------------------------------------------

export type DebtServiceCoverageInput = {
  operatingCashFlow: number;
  annualDebtService: number;
};

export function classifyDebtServiceCoverage(
  input: DebtServiceCoverageInput,
): RagRuleResult {
  const t = RAG_THRESHOLDS.debtServiceCoverage;
  if (input.annualDebtService <= 0) {
    // No debt → no debt-service coverage issue. Tag green with an
    // explicit "no debt" explanation (not a contradiction; this is
    // the healthy edge of the spectrum).
    return {
      ruleKey: "debt-service-coverage",
      label: "Debt Service Coverage Ratio",
      status: "green",
      valueLabel: "n/a (no debt service)",
      benchmarkLabel: `Green ≥ ${t.greenMinRatio.toFixed(2)}x, amber ${t.amberMinRatio.toFixed(2)}–${t.greenMinRatio.toFixed(2)}x`,
      explanation: "Club carries no annual debt service — no coverage requirement applies.",
      rawValue: Infinity,
      variancePct: null,
    };
  }
  const ratio = input.operatingCashFlow / input.annualDebtService;
  let status: RagStatus;
  if (ratio >= t.greenMinRatio) status = "green";
  else if (ratio >= t.amberMinRatio) status = "amber";
  else status = "red";
  return {
    ruleKey: "debt-service-coverage",
    label: "Debt Service Coverage Ratio",
    status,
    valueLabel: ratioLabel(ratio),
    benchmarkLabel: `Green ≥ ${t.greenMinRatio.toFixed(2)}x, amber ${t.amberMinRatio.toFixed(2)}–${t.greenMinRatio.toFixed(2)}x`,
    explanation:
      status === "green"
        ? `DSCR of ${ratioLabel(ratio)} (operating cash flow ${formatMoneyShort(input.operatingCashFlow)} ÷ debt service ${formatMoneyShort(input.annualDebtService)}) clears the ${ratioLabel(t.greenMinRatio)} bankable threshold.`
        : status === "amber"
          ? `DSCR of ${ratioLabel(ratio)} sits in the ${ratioLabel(t.amberMinRatio)}–${ratioLabel(t.greenMinRatio)} monitor band — covers debt but below the ${ratioLabel(t.greenMinRatio)} bankable threshold.`
          : `DSCR of ${ratioLabel(ratio)} is below the ${ratioLabel(t.amberMinRatio)} minimum — operating cash flow does not cover annual debt service.`,
    rawValue: ratio,
    variancePct: null,
  };
}

// ---------------------------------------------------------------------------
// Rule 7 — Net-to-Gross PP&E
// ---------------------------------------------------------------------------

export type NetToGrossPpeInput = {
  netPpe: number;
  grossPpe: number;
};

export function classifyNetToGrossPpe(input: NetToGrossPpeInput): RagRuleResult {
  const t = RAG_THRESHOLDS.netToGrossPpe;
  if (input.grossPpe <= 0) {
    return neutralRuleResult({
      ruleKey: "net-to-gross-ppe",
      label: "Net-to-Gross PP&E Ratio",
      benchmarkLabel: `Green ≥ ${t.greenMinPct}%, amber ${t.amberMinPct}–${t.greenMinPct}%`,
      explanation: "Gross PP&E is zero — net-to-gross ratio cannot be computed.",
      valueLabel: "—",
    });
  }
  const ratioPct = (input.netPpe / input.grossPpe) * 100;
  let status: RagStatus;
  if (ratioPct >= t.greenMinPct) status = "green";
  else if (ratioPct >= t.amberMinPct) status = "amber";
  else status = "red";
  return {
    ruleKey: "net-to-gross-ppe",
    label: "Net-to-Gross PP&E Ratio",
    status,
    valueLabel: `${ratioPct.toFixed(1)}%`,
    benchmarkLabel: `Green ≥ ${t.greenMinPct}%, amber ${t.amberMinPct}–${t.greenMinPct}%`,
    explanation:
      status === "green"
        ? `Net-to-gross PP&E of ${ratioPct.toFixed(1)}% indicates an asset base being maintained on pace with depreciation.`
        : status === "amber"
          ? `Net-to-gross PP&E of ${ratioPct.toFixed(1)}% is below the ${t.greenMinPct}% benchmark — the asset base is aging faster than reinvestment.`
          : `Net-to-gross PP&E of ${ratioPct.toFixed(1)}% is materially below the ${t.amberMinPct}% threshold — the club has a deferred capex backlog.`,
    rawValue: ratioPct,
    variancePct: null,
  };
}

// ---------------------------------------------------------------------------
// Rule 8 — AR Current Rate
// ---------------------------------------------------------------------------

export type ArCurrentRateInput = {
  currentBucket: number;
  totalAR: number;
};

export function classifyArCurrentRate(input: ArCurrentRateInput): RagRuleResult {
  const t = RAG_THRESHOLDS.arCurrentRate;
  if (input.totalAR <= 0) {
    // No AR → 100% current by convention. Tag green.
    return {
      ruleKey: "ar-current-rate",
      label: "AR Current Rate",
      status: "green",
      valueLabel: "n/a (no AR)",
      benchmarkLabel: `Green ≥ ${t.greenMinPct}%, amber ${t.amberMinPct}–${t.greenMinPct}%`,
      explanation: "Club carries no outstanding member receivables this period.",
      rawValue: 100,
      variancePct: null,
    };
  }
  const ratioPct = (input.currentBucket / input.totalAR) * 100;
  let status: RagStatus;
  if (ratioPct >= t.greenMinPct) status = "green";
  else if (ratioPct >= t.amberMinPct) status = "amber";
  else status = "red";
  return {
    ruleKey: "ar-current-rate",
    label: "AR Current Rate",
    status,
    valueLabel: `${ratioPct.toFixed(1)}%`,
    benchmarkLabel: `Green ≥ ${t.greenMinPct}%, amber ${t.amberMinPct}–${t.greenMinPct}%`,
    explanation:
      status === "green"
        ? `AR Current rate of ${ratioPct.toFixed(1)}% is at or above the ${t.greenMinPct}% collections-policy target.`
        : status === "amber"
          ? `AR Current rate of ${ratioPct.toFixed(1)}% is below the ${t.greenMinPct}% target — collections discipline is slipping but not yet critical.`
          : `AR Current rate of ${ratioPct.toFixed(1)}% is below the ${t.amberMinPct}% action threshold — material aging across the membership.`,
    rawValue: ratioPct,
    variancePct: null,
  };
}

// ---------------------------------------------------------------------------
// Shared "indeterminate" result helper
// ---------------------------------------------------------------------------

/** Build a neutral / pending result when inputs are insufficient
 *  (zero denominator, null comparator, etc.). Classified as `amber`
 *  so it shows up in the monitor bucket rather than silently passing
 *  through as `green`. */
function neutralRuleResult(args: {
  ruleKey: RagRuleKey;
  label: string;
  benchmarkLabel: string;
  explanation: string;
  valueLabel: string;
}): RagRuleResult {
  return {
    ruleKey: args.ruleKey,
    label: args.label,
    status: "amber",
    valueLabel: args.valueLabel,
    benchmarkLabel: args.benchmarkLabel,
    explanation: args.explanation,
    rawValue: 0,
    variancePct: null,
  };
}

// ---------------------------------------------------------------------------
// Dashboard Notes narrative — guaranteed not to contradict the rules
// ---------------------------------------------------------------------------

/**
 * Build a Dashboard Notes paragraph from a set of rule results.
 *
 * The narrative is DERIVED from the rule results — there is no path
 * by which it can claim "favorable" while a rule is red, or "no
 * action" while a rule is amber. The opening verdict, the named
 * call-outs, and the closing action statement all read off
 * `worstStatus(results)` and the per-status partitions.
 *
 * Output sentence shape:
 *   • All green → "All [N] monitored metrics are within policy
 *     thresholds. No Board action is required this period."
 *   • Amber only → "[Names]" sits in the monitor band — listed +
 *     reason summary + "Committee monitoring is recommended."
 *   • Red present → "[Names] [is/are] outside policy and require[s]
 *     Board attention." + amber call-out + reason summaries.
 */
export function buildRagDashboardNarrative(
  results: ReadonlyArray<RagRuleResult>,
): string {
  if (results.length === 0) {
    return "No stewardship metrics have been evaluated for this period.";
  }
  const reds = results.filter((r) => r.status === "red");
  const ambers = results.filter((r) => r.status === "amber");

  // Verdict opener — the worstStatus selector guarantees the
  // language matches the most conservative rule outcome.
  let opener: string;
  if (reds.length > 0) {
    const names = joinLabels(reds);
    opener =
      reds.length === 1
        ? `${names} is outside policy thresholds and requires Board attention.`
        : `${names} are outside policy thresholds and require Board attention.`;
  } else if (ambers.length > 0) {
    const names = joinLabels(ambers);
    opener =
      ambers.length === 1
        ? `${names} sits in the monitor band; the remaining metrics are within policy.`
        : `${names} sit in the monitor band; the remaining metrics are within policy.`;
  } else {
    opener = `All ${results.length} monitored metrics are within policy thresholds.`;
  }

  // Reason summary — one explanation per non-green rule. Order:
  // reds first, then ambers, in their original presentation order.
  const reasonClauses: string[] = [];
  for (const r of reds) reasonClauses.push(r.explanation);
  for (const a of ambers) reasonClauses.push(a.explanation);

  // Closing action statement — derived from worstStatus.
  const worst = worstStatus(results);
  const action =
    worst === "red"
      ? "Board attention is required this period."
      : worst === "amber"
        ? "No Board action is required; Committee monitoring is recommended."
        : "No Board action is required this period.";

  return [opener, ...reasonClauses, action].join(" ");
}

/** Format a list of rule labels as "A and B" / "A, B, and C". */
function joinLabels(results: ReadonlyArray<RagRuleResult>): string {
  const names = results.map((r) => r.label);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Adapter — feed rule results into existing dashboard-notes generator
// ---------------------------------------------------------------------------

/**
 * Convert a set of rule results into the `{key, name, tone}` shape
 * `buildStewardshipDashboardNotes()` consumes. Lets callers feed
 * the existing operating + capital narrative generators from the
 * rule engine without modifying their internals.
 *
 * `tone` mapping: `green → "green"`, `amber → "amber"`,
 * `red → "red"` (matches the legacy `KpiTone` shape).
 */
export function ruleResultsToKpiTones(
  results: ReadonlyArray<RagRuleResult>,
): ReadonlyArray<{ key: string; name: string; tone: "green" | "amber" | "red" }> {
  return results.map((r) => ({
    key: r.ruleKey,
    name: r.label,
    tone: r.status,
  }));
}
