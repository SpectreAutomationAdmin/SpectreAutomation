// Reactive commentary generator for the Stewardship KPI Dashboard
// (Chapter III) "Dashboard Notes" block.
//
// Per `Reactive Commentary for Financial Reporting — Mandatory` in
// CLAUDE.md, every figure in the rendered notes must reconcile to
// the SAME reporting dataset that produces the Operating + Capital
// KPI rows above. The generator branches on:
//   • The Operating KPI roster — counts of green / amber / red rows
//     decide the panel verdict and surface specific metric names in
//     monitor / action call-outs.
//   • The Capital KPI roster — same scanning pattern, plus the
//     dedicated reserve-coverage and PP&E-reinvestment status flags
//     that ride directly off policy thresholds (FAC 60% / 50% PP&E).
//
// 2026-06-14 paragraph-bullet pass:
//   The generator now returns EXACTLY TWO entries — a complete
//   executive paragraph per panel (operating, capital) — rather
//   than fragmenting each sentence into its own bullet. The React
//   surface renders these as two stacked bullet items so the chair
//   reads two coherent narratives instead of a sentence-by-sentence
//   pile. Reactivity is preserved: the paragraph composition reads
//   the KPI tones every render, so when a metric flips, the prose
//   flips with it.

import type { KpiTone } from "@/lib/reporting/monthly-package";

/** Minimum-viable KPI shape used to evaluate a stewardship roster.
 *  Mirrors the relevant fields on `StewardshipKpi` (`key`, `name`,
 *  `tone`). The generator accepts a structural shape rather than the
 *  full type to avoid pulling in unrelated card fields. */
export type StewardshipDashboardNoteKpi = {
  key: string;
  name: string;
  tone?: KpiTone;
};

export type StewardshipDashboardNoteInputs = {
  /** Operating panel KPI roster (as rendered in the chapter III
   *  Operating Stewardship column). The generator scans this list
   *  for `tone` to decide the panel verdict and surface specific
   *  metric names in monitor / action call-outs. */
  operatingKpis: ReadonlyArray<StewardshipDashboardNoteKpi>;
  /** Capital panel KPI roster (chapter III Capital Stewardship
   *  column). Same scanning logic as operating; metrics named in
   *  the dedicated reserve-coverage / PP&E branches are excluded
   *  from the generic call-out so we never repeat ourselves. */
  capitalKpis: ReadonlyArray<StewardshipDashboardNoteKpi>;
  /** Whether the Capital panel's reserve coverage clears the FAC
   *  policy floor. Drives the reserve-coverage sentence branch. */
  reserveCoverageMeetsFloor: boolean;
  /** Reserve coverage % as a pre-formatted string ("61%"). Re-quoted
   *  in the below-floor branch so the prose names the same number
   *  the summary card displays. */
  reserveCoveragePct: string;
  /** FAC benchmark threshold as a pre-formatted string ("60%").
   *  Configuration-driven; not derived from accounting records. */
  facBenchmarkPct: string;
  /** Whether the Net-to-Gross PP&E ratio sits BELOW the policy
   *  benchmark. Drives the aging-assets vs refreshed branch. */
  ppeBelowBenchmark: boolean;
};

export type StewardshipDashboardNoteBullet = {
  /** Visual / semantic group the bullet belongs to. The chapter III
   *  notes ship EXACTLY ONE bullet per tone (operating + capital);
   *  the React surface stacks both as full-paragraph bullets. */
  tone: "operating" | "capital";
  /** The complete executive paragraph for this panel. Multiple
   *  sentences allowed; finance-chair tone; board-report register. */
  text: string;
};

export type StewardshipDashboardNotes = ReadonlyArray<StewardshipDashboardNoteBullet>;

/** Format a list of KPI names into a "A, B, and C" English run. */
function joinNames(kpis: ReadonlyArray<StewardshipDashboardNoteKpi>): string {
  const names = kpis.map((k) => k.name);
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** Operating-side paragraph composer. Returns ONE complete paragraph
 *  composed of three sentences:
 *    1. Verdict — all-green / monitor-with-name / action-with-name.
 *    2. Framing of variances — favourable vs structural-cost language.
 *    3. Closing operating-signals sentence ("clean AR + strong WC"). */
function buildOperatingParagraph(inputs: StewardshipDashboardNoteInputs): string {
  const reds   = inputs.operatingKpis.filter((k) => k.tone === "red");
  const ambers = inputs.operatingKpis.filter((k) => k.tone === "amber");

  const sentences: string[] = [];

  if (reds.length > 0) {
    // Action branch — the verdict names every red metric.
    sentences.push(
      reds.length === 1
        ? `The operating panel shows ${joinNames(reds)} outside policy and requires board attention.`
        : `The operating panel shows ${joinNames(reds)} outside policy and requires board attention.`,
    );
    if (ambers.length > 0) {
      sentences.push(
        ambers.length === 1
          ? `${joinNames(ambers)} also sits in monitor range and should be tracked next period.`
          : `${joinNames(ambers)} also sit in monitor range and should be tracked next period.`,
      );
    }
    sentences.push(
      `Variances should be reviewed against authorized scope and known timing factors — sustained drift at this magnitude becomes structural cost growth.`,
    );
  } else if (ambers.length > 0) {
    // Monitor branch — broadly on plan, named monitor items.
    sentences.push(
      ambers.length === 1
        ? `The operating panel is broadly on plan, with ${joinNames(ambers)} requiring monitoring next period.`
        : `The operating panel is broadly on plan, with ${joinNames(ambers)} requiring monitoring next period.`,
    );
    sentences.push(
      `Variances that exist are understood, authorized, or attributable to known timing factors — not structural cost growth.`,
    );
  } else {
    // All-green branch — original founder-approved wording.
    sentences.push(`The operating panel confirms the club is running close to plan.`);
    sentences.push(
      `Variances that exist are understood, authorized, or attributable to known timing factors — not structural cost growth.`,
    );
  }

  // Closing operating-signals sentence — same line in every branch.
  sentences.push(
    `The most important operating signals are clean AR and strong working capital.`,
  );

  return sentences.join(" ");
}

/** Capital-side paragraph composer. Returns ONE complete paragraph
 *  composed of:
 *    1. Reserve coverage sentence (at-FAC vs below-FAC).
 *    2. PP&E reinvestment sentence (refreshed vs aging).
 *    3. Optional aging-assets call-to-action when PP&E is below
 *       benchmark — preserves the original founder-approved sentence.
 *    4. Optional additional capital call-out when an amber/red
 *       capital metric OTHER than reserve-coverage/ppe-reinvestment
 *       is present (so we never repeat ourselves). */
function buildCapitalParagraph(inputs: StewardshipDashboardNoteInputs): string {
  const sentences: string[] = [];

  // Sentence 1 — reserve coverage.
  if (inputs.reserveCoverageMeetsFloor) {
    sentences.push(
      `The capital panel shows the club at the FAC ${inputs.facBenchmarkPct}+ reserve coverage benchmark.`,
    );
  } else {
    sentences.push(
      `Capital reserve coverage of ${inputs.reserveCoveragePct} sits below the FAC ${inputs.facBenchmarkPct} benchmark; the board should consider accelerating reserve contributions.`,
    );
  }

  // Sentence 2 — PP&E reinvestment. The aging-asset branch also
  // emits the original founder-approved "argument strengthens"
  // sentence so the long-form executive prose is preserved.
  if (inputs.ppeBelowBenchmark) {
    sentences.push(
      `The Net-to-Gross PP&E ratio is below the 50% benchmark, indicating aging assets.`,
    );
    sentences.push(
      `The board should be aware that as this ratio declines over time, the argument for accelerating reserve contributions strengthens — the club is managing assets that are depreciating faster than they are being rebuilt.`,
    );
  } else {
    sentences.push(
      `The Net-to-Gross PP&E ratio sits above the 50% benchmark — the asset base is being refreshed on pace with depreciation.`,
    );
  }

  // Optional additional capital callout — any amber / red rows
  // OTHER than reserve-coverage and ppe-reinvestment.
  const otherCapital = inputs.capitalKpis.filter(
    (k) => k.key !== "reserve-coverage" && k.key !== "ppe-reinvestment",
  );
  const otherReds   = otherCapital.filter((k) => k.tone === "red");
  const otherAmbers = otherCapital.filter((k) => k.tone === "amber");

  if (otherReds.length > 0) {
    sentences.push(
      otherReds.length === 1
        ? `${joinNames(otherReds)} is also outside capital policy and requires board attention.`
        : `${joinNames(otherReds)} are also outside capital policy and require board attention.`,
    );
  } else if (otherAmbers.length > 0) {
    sentences.push(
      otherAmbers.length === 1
        ? `${joinNames(otherAmbers)} also sits in monitor range and should be tracked next period.`
        : `${joinNames(otherAmbers)} also sit in monitor range and should be tracked next period.`,
    );
  }

  return sentences.join(" ");
}

export function buildStewardshipDashboardNotes(
  inputs: StewardshipDashboardNoteInputs,
): StewardshipDashboardNotes {
  return [
    { tone: "operating", text: buildOperatingParagraph(inputs) },
    { tone: "capital",   text: buildCapitalParagraph(inputs)   },
  ];
}
