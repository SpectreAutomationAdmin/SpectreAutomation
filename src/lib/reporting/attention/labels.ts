// Board Attention Engine — pillar-specific label mapping.
//
// The engine produces a universal three-state attention verdict
// (GREEN | YELLOW | RED). Each pillar renders that verdict using its
// own established vocabulary — Operations says "On Plan / Watch / Off
// Plan", Financial Health says "Strong Position / Stable / Concern",
// etc. The labels are part of the executive reporting voice and must
// not be flattened to generic G/Y/R.
//
// Vocabulary per the founder's prior approvals (cover briefing cards
// + Chair's Dashboard) and reaffirmed in the Board Attention Engine
// approval message.
//
// Some pillars carry alternative labels for the YELLOW or RED tier
// (e.g. Financial "Watch" as a softer R alternative to "Concern";
// Capital "Critical" as a stronger R alternative to "Delayed"). The
// engine commits to the primary label per state; future panel-level
// overrides can substitute when severity context warrants it.
//
// Capital cascade is the most-evolved four-tier vocabulary:
//   Executing / Monitor / Delayed / Critical
// The engine maps to three of those tiers (green / yellow / red);
// "Critical" is reserved for a manual statusLabel override when a
// project's slip rises to a Board escalation. The cover briefing
// card honours the data-layer statusLabel verbatim so management
// can name "Critical" without an engine math change.

import type { Attention, PillarKey } from "./types";

const LABELS: Record<PillarKey, Record<Attention, string>> = {
  operations: { green: "On Plan",          yellow: "Watch",  red: "Off Plan"  },
  financial:  { green: "Strong Position",  yellow: "Stable", red: "Concern"   },
  capital:    { green: "Executing",        yellow: "Monitor", red: "Delayed"   },
  membership: { green: "Healthy",          yellow: "Watch",  red: "At Risk"   },
  experience: { green: "Healthy",          yellow: "Watch",  red: "Concern"   },
};

/**
 * Pillar-specific status label for a given attention verdict.
 *
 * Example:
 *   labelFor("operations", "yellow")  → "Watch"
 *   labelFor("capital",    "yellow")  → "Monitor"
 *   labelFor("financial",  "green")   → "Strong Position"
 */
export function labelFor(pillar: PillarKey, attention: Attention): string {
  return LABELS[pillar][attention];
}

/**
 * KpiTone mapping for downstream UI primitives that still consume the
 * 4-value KpiTone union (tone dots, variance text colour, etc.). The
 * universal three-state attention maps 1:1 to KpiTone with
 * yellow → amber (the legacy palette token).
 */
export function kpiToneFor(attention: Attention): "green" | "amber" | "red" {
  return attention === "yellow" ? "amber" : attention;
}
