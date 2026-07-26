// One-or-two-sentence explanations attached to each hospitality KPI
// card via the HelpTip affordance. Kept here so wording stays
// consistent across the headline dashboard and the per-station
// drilldown, and so a future tune of copy is a single-file change.
//
// Tone: plain English, manager-facing. State what's measured and why
// it matters, not how it's computed.

export const KPI_HELP = {
  avgKitchen:
    "The average time a chit spends at the kitchen line — from the moment it lands on the screen to when it's marked ready. Lower is better. Anything over 12 minutes drags service.",
  avgBar:
    "The average time the bar takes to prepare a drink chit. Drinks should clear quickly — over 5 minutes is a sign the bar is backed up.",
  medianKitchen:
    "The midpoint of kitchen prep times — half the chits were faster, half slower. Sitting next to the average, it tells you whether a few slow chits are skewing the picture.",
  medianBar:
    "The midpoint of bar prep times. Best read alongside the average and p90 to see whether the bar is consistent.",
  p90:
    "Nine out of ten chits were ready within this time. Watch this number to understand how bad the slow end of the distribution looks on a tough night.",
  kitchenChits:
    "Total chits sent to the kitchen in this window, excluding cancelled tickets. Use as volume context for the prep-time numbers above.",
  barChits:
    "Total drink chits the bar received in this window, excluding cancelled tickets.",
  lateKitchen:
    "Chits where kitchen prep exceeded 18 minutes — the red threshold. Late food drives guest complaints and comps.",
  lateBar:
    "Chits where bar prep exceeded 8 minutes. Drinks should be the fastest thing leaving the line; this should be zero on most days.",
  cancelled:
    "Chits cancelled before the line completed them — usually walk-outs, server errors, or items pulled from the order. A small number is normal; a spike is worth investigating.",
  busiestPeriod:
    "The service period with the most chit volume in this window. Knowing which slot drives the load helps focus staffing decisions.",

  // Station drilldown variants
  totalChits:
    "Chits this station handled in the window, cancelled excluded. The completed count tells you how many actually reached the ready state.",
  lateAndCancelled:
    "Late chits exceeded the red threshold; cancelled chits never reached ready. Both deserve a look during the post-shift review.",
  drilldownAverage:
    "Average prep time at this station in the selected window. Compared automatically against the prior period of the same length.",
  drilldownMedian:
    "Midpoint prep time. Less sensitive to one slow chit than the average.",
  drilldownP90:
    "Slowest 10% boundary. If this is much higher than the average, the station has a long tail worth investigating.",
} as const;
