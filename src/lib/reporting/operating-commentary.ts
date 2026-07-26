// ---------------------------------------------------------------------------
// Operating Results — 12-Month Rolling Trend commentary generator.
//
// Parallel to src/lib/reporting/equity-commentary.ts. Produces the
// one- or two-sentence executive commentary that sits beneath the
// Operating Results chart. The string is derived from the same numbers
// the KPI ribbon displays (YTD NOI, % of revenue, budget goal, prior
// year, break-even corridor), so it stays in lockstep with whatever
// the accounting service returns.
//
// Tone: finance-chair voice, executive, analytical, board-report
// appropriate. Conclusion first, then the recovery / margin / policy
// implication. NO pillar references, NO SaaS language. Explains what
// the chart MEANS — not just a restatement of the KPI values.
//
// Five classification branches, evaluated in order:
//
//   1. above-corridor               — NOI % > corridor upper bound
//                                     (margin discipline ahead of policy)
//   2. below-corridor               — NOI % < corridor lower bound
//                                     (reserves being consumed)
//   3. inside-recovered             — NOI % ∈ corridor, current NOI > 0,
//                                     prior year was a deficit
//                                     → "deficit has been recovered"
//   4. inside-prior-positive        — NOI % ∈ corridor, prior year was
//                                     also non-negative → steady state
//   5. inside-still-recovering      — NOI % ∈ corridor (slightly negative
//                                     side typically), prior was a deeper
//                                     deficit but the current year has
//                                     not yet returned to positive NOI
// ---------------------------------------------------------------------------

export type OperatingCommentaryCase =
  | "above-corridor"
  | "below-corridor"
  | "inside-recovered"
  | "inside-prior-positive"
  | "inside-still-recovering";

export type OperatingCommentaryInput = {
  /** Sum of NOI across the trailing 12 months (dollars). */
  ytdNoiDollars: number;
  /** Sum of revenue across the trailing 12 months (dollars). The
   *  generator computes NOI % = ytdNoiDollars / ytdRevenueDollars. */
  ytdRevenueDollars: number;
  /** Sum of budget NOI across the trailing 12 months (dollars). */
  ytdBudgetNoiDollars: number;
  /** Sum of NOI across the matching prior-year 12 months (dollars). */
  priorYearNoiDollars: number;
  /** Break-even tolerance corridor as %-of-revenue bounds. E.g.
   *  ClubBenchmarking's "−2.8 % to +3.3 %" zone → `{ lower: -2.8,
   *  upper: 3.3 }`. */
  corridorPct: { lower: number; upper: number };
  /** Display-ready period label, e.g. "Year-end" / "Year to date". */
  periodLabel: string;
};

/** Classifier — pure function, no I/O. Exposed for tests. */
export function classifyOperatingCommentary(
  input: OperatingCommentaryInput,
): OperatingCommentaryCase {
  const { ytdNoiDollars, ytdRevenueDollars, priorYearNoiDollars, corridorPct } = input;
  const pct = ytdRevenueDollars > 0 ? (ytdNoiDollars / ytdRevenueDollars) * 100 : 0;

  // 1 & 2 — current sits outside the policy zone.
  if (pct > corridorPct.upper) return "above-corridor";
  if (pct < corridorPct.lower) return "below-corridor";

  // 3, 4, 5 — current sits inside the policy zone. Distinguish by
  // (a) whether the prior year was a deficit and (b) whether the
  // current year has returned to positive NOI.
  const priorWasDeficit = priorYearNoiDollars < 0;

  if (!priorWasDeficit) {
    // Case 4 — both years inside (or above) the corridor; nothing
    // dramatic to narrate.
    return "inside-prior-positive";
  }

  // Prior year was a deficit. Has the current year recovered to
  // positive NOI?
  if (ytdNoiDollars > 0) {
    // Case 3 — operational deficit has been turned around.
    return "inside-recovered";
  }

  // Case 5 — current year is inside the corridor but still net
  // negative (or zero); the deficit has not yet been fully recovered.
  return "inside-still-recovering";
}

function pct(bpsLike: number): string {
  return `${bpsLike.toFixed(1)}%`;
}

function fmtDollarsK(d: number): string {
  // $K with parentheses for negatives — board-style accounting
  // formatting that matches the KPI tile values.
  const abs = Math.abs(Math.round(d / 1000));
  return d < 0 ? `($${abs}K)` : `$${abs}K`;
}

/** Renders a corridor band like `−2.8% to +3.3%` using the proper
 *  U+2212 minus sign and an explicit `+` on positives. Board-report
 *  typography — straight ASCII `-` is reserved for hyphens in copy. */
function fmtCorridor(lower: number, upper: number): string {
  const fmtSigned = (v: number): string => {
    if (v < 0) return `−${Math.abs(v).toFixed(1)}%`;
    if (v > 0) return `+${v.toFixed(1)}%`;
    return "0.0%";
  };
  return `${fmtSigned(lower)} to ${fmtSigned(upper)}`;
}

/** Returns the one- or two-sentence Finance-Committee commentary for
 *  the Operating Results card. Numerals are wrapped in Markdown-style
 *  `**bold**` markers so `renderInterpretation` in the monthly page
 *  can emit bold spans. Prose is honest, restrained, and matches the
 *  Saguaro reference's editorial register. */
export function buildOperatingCommentary(input: OperatingCommentaryInput): string {
  const { ytdNoiDollars, ytdRevenueDollars, priorYearNoiDollars, corridorPct, periodLabel } = input;
  const noiLabel = fmtDollarsK(ytdNoiDollars);
  const noiPctValue = ytdRevenueDollars > 0 ? (ytdNoiDollars / ytdRevenueDollars) * 100 : 0;
  const noiPctLabel = pct(noiPctValue);
  const priorLabel = fmtDollarsK(priorYearNoiDollars);
  const corridorLabel = fmtCorridor(corridorPct.lower, corridorPct.upper);

  switch (classifyOperatingCommentary(input)) {
    case "above-corridor":
      return (
        `${periodLabel} NOI of **${noiLabel} (${noiPctLabel})** sits above the ClubBenchmarking ` +
        `break-even zone of ${corridorLabel}. Margin discipline is comfortably ahead of policy; ` +
        `excess NOI should be directed to capital reserves before it accrues as a structural ` +
        `dues surplus.`
      );

    case "below-corridor":
      return (
        `${periodLabel} NOI of **${noiLabel} (${noiPctLabel})** sits below the ClubBenchmarking ` +
        `break-even zone of ${corridorLabel}. The Club is consuming reserves at the operating ` +
        `level; the Finance Committee should review dues sizing, expense controls, or both ` +
        `before the next budget cycle.`
      );

    case "inside-recovered":
      return (
        `${periodLabel} NOI of **${noiLabel} (${noiPctLabel})** sits squarely in the ` +
        `ClubBenchmarking break-even zone of ${corridorLabel}. Prior year's **${priorLabel}** ` +
        `deficit has been recovered. Consistent performance in this zone confirms dues are ` +
        `properly sized against the operating footprint.`
      );

    case "inside-prior-positive":
      return (
        `${periodLabel} NOI of **${noiLabel} (${noiPctLabel})** sits inside the ` +
        `ClubBenchmarking break-even zone of ${corridorLabel}. Operating margin is on policy ` +
        `for a second consecutive year; the trend supports current dues sizing without ` +
        `surplus accumulation.`
      );

    case "inside-still-recovering":
      return (
        `${periodLabel} NOI of **${noiLabel} (${noiPctLabel})** sits inside the ` +
        `ClubBenchmarking break-even zone of ${corridorLabel}, but prior year's ` +
        `**${priorLabel}** deficit has not been fully recovered. The Finance Committee should ` +
        `monitor whether dues sizing matches the operating footprint over the next cycle.`
      );
  }
}
