// ---------------------------------------------------------------------------
// Equity Value Over Time — commentary generator.
//
// Produces the one- or two-sentence executive commentary that appears
// beneath the Equity Value Over Time chart in the Monthly Board
// Reporting Package. The string is derived from the same CAGR values
// the KPI ribbon already displays, plus the first plotted calendar
// year — so it stays in lockstep with whatever the accounting service
// returns. Nothing about this commentary is hardcoded in the React
// tree.
//
// Tone: finance-chair voice, executive, analytical, board-report
// appropriate. NO pillar references, NO SaaS language, NO promotional
// adjectives. One-to-two sentence sentences explaining what the chart
// means, not restating the KPI values.
//
// Four branches, in evaluation order:
//   1. above-best-in-class   — actual ≥ best-in-class
//   2. near-minimum          — |actual − min| ≤ 25 bps (tolerance)
//   3. below-minimum         — actual < min and not near
//   4. between-min-and-best  — otherwise
//
// The 25 bps tolerance for "near minimum" keeps the narrative honest:
// a club tracking within a quarter percentage point of the floor is
// preserving real value, but only just — that's a different message
// than "comfortably ahead."
// ---------------------------------------------------------------------------

/** Maximum gap (in basis points) between the actual CAGR and the
 *  minimum-required CAGR that still classifies as "near minimum". */
export const NEAR_MIN_TOLERANCE_BPS = 25;

export type EquityCommentaryCase =
  | "above-best-in-class"
  | "between-min-and-best"
  | "near-minimum"
  | "below-minimum";

export type EquityCommentaryInput = {
  /** Compounded annual growth rate of actual equity, in basis points. */
  actualCagrBps: number;
  /** Configured best-in-class peer benchmark CAGR, in basis points. */
  bestInClassCagrBps: number;
  /** Configured minimum-required (inflation-parity) CAGR, in basis points. */
  minimumRequiredCagrBps: number;
  /** Calendar year of the first plotted point — e.g. "2018".
   *  MUST NOT include the "FY" prefix; the commentary surface
   *  uses calendar years, not fiscal-year labels. */
  firstYear: string;
};

/** Classifies the actual CAGR against the two benchmark thresholds.
 *  Pure function — no I/O, no formatting. Exposed for tests and any
 *  caller that needs the verdict without the prose. */
export function classifyEquityCommentary(
  input: EquityCommentaryInput,
): EquityCommentaryCase {
  const { actualCagrBps, bestInClassCagrBps, minimumRequiredCagrBps } = input;

  // 1. Out-performance — actual reaches or exceeds the peer benchmark.
  if (actualCagrBps >= bestInClassCagrBps) return "above-best-in-class";

  // 2. Near-minimum — actual is within tolerance of the floor in
  //    either direction. Evaluated BEFORE "below-minimum" so the
  //    softer language fires when the gap is genuinely small (and
  //    BEFORE "between" so a fragile-margin club isn't framed as
  //    "comfortably above").
  if (Math.abs(actualCagrBps - minimumRequiredCagrBps) <= NEAR_MIN_TOLERANCE_BPS) {
    return "near-minimum";
  }

  // 3. Below the floor by more than tolerance.
  if (actualCagrBps < minimumRequiredCagrBps) return "below-minimum";

  // 4. Otherwise: above the floor by more than tolerance, but still
  //    short of the peer benchmark.
  return "between-min-and-best";
}

function pct(bps: number): string {
  return `${(bps / 100).toFixed(1)}%`;
}

/** Returns the one- or two-sentence Finance-Committee commentary
 *  for the Equity Value Over Time chart. Numerals are wrapped in
 *  Markdown-style `**bold**` markers — the React renderer
 *  (`renderInterpretation` in the monthly page) parses them out and
 *  emits bold spans. Plain prose is honest, restrained, and matches
 *  the Saguaro reference's editorial register. */
export function buildEquityCommentary(input: EquityCommentaryInput): string {
  const actual = pct(input.actualCagrBps);
  const best = pct(input.bestInClassCagrBps);
  const min = pct(input.minimumRequiredCagrBps);
  const year = input.firstYear;

  switch (classifyEquityCommentary(input)) {
    case "above-best-in-class":
      return (
        `Compounded annual equity growth of **${actual}** since ${year} exceeds both ` +
        `the **${best}** best-in-class benchmark and the **${min}** minimum required ` +
        `to outpace asset inflation. Clubs growing equity at less than **${min}** ` +
        `annually are falling behind replacement cost increases.`
      );
    case "between-min-and-best":
      return (
        `Compounded annual equity growth of **${actual}** since ${year} remains above ` +
        `the **${min}** minimum required to outpace asset inflation but trails the ` +
        `**${best}** best-in-class benchmark. Equity growth remains sustainable, ` +
        `though not yet at peer-leading levels.`
      );
    case "near-minimum":
      return (
        `Compounded annual equity growth of **${actual}** since ${year} is tracking ` +
        `near the **${min}** minimum required to outpace asset inflation. The Club ` +
        `is preserving equity value, but the margin of safety remains narrow.`
      );
    case "below-minimum":
      return (
        `Compounded annual equity growth of **${actual}** since ${year} is below the ` +
        `**${min}** minimum required to outpace asset inflation. At this pace, ` +
        `equity growth is not keeping up with replacement cost increases and warrants ` +
        `Board attention.`
      );
  }
}
