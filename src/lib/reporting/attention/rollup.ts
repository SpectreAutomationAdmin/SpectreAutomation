// Board Attention Engine — rollup helpers.
//
// Worst-of aggregation: RED beats YELLOW beats GREEN. Used to roll
// per-tile attention up to chapter-level (ribbon at the top of each
// pillar panel) and to dashboard-level (ribbon at the top of the
// Chair's Dashboard and the cover Executive Briefing column).

import type { Attention } from "./types";

const RANK: Record<Attention, number> = { green: 0, yellow: 1, red: 2 };

/**
 * Worst-of aggregation across a list of attention values. Empty input
 * defaults to GREEN — an empty panel has nothing to flag.
 */
export function worstOf(attentions: ReadonlyArray<Attention>): Attention {
  if (attentions.length === 0) return "green";
  let worst: Attention = "green";
  for (const a of attentions) {
    if (RANK[a] > RANK[worst]) worst = a;
  }
  return worst;
}

/**
 * Chapter-level rollup — the panel's own verdict, equal to the
 * worst-of its tiles' verdicts. Identical mechanics to worstOf();
 * named distinctly so consumer code reads as intent ("rollupChapter"
 * is what the chapter ribbon needs).
 */
export function rollupChapter(tileAttentions: ReadonlyArray<Attention>): Attention {
  return worstOf(tileAttentions);
}

/**
 * Dashboard-level rollup — the cross-pillar verdict, equal to the
 * worst-of each pillar's chapter rollup. Drives the Chair's Dashboard
 * top ribbon and the cover Executive Briefing attention strip.
 */
export function rollupDashboard(chapterAttentions: ReadonlyArray<Attention>): Attention {
  return worstOf(chapterAttentions);
}

/**
 * Count the number of YELLOW + RED chapters in a list. Used by the
 * Chair's Dashboard rollup to render "1 of 5 pillars flagged" without
 * the chair having to count colour dots.
 */
export function countFlagged(chapterAttentions: ReadonlyArray<Attention>): number {
  return chapterAttentions.filter((a) => a !== "green").length;
}
