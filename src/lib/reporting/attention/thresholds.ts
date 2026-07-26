// Board Attention Engine — threshold config.
//
// Central registry of green/yellow/red bands per metric across the
// five Chair's Dashboard pillars. This is the "configurable" part of
// the engine — the founder edits this file to retune attention bands
// without touching panel code.
//
// Future migration path: a per-club override lives in Prisma as
// `Club.attentionThresholds: Json?`. When wired, the service merges
// the per-club overrides on top of DEFAULT_THRESHOLDS and passes the
// merged set to evaluateMetric(). The engine's signature already
// accepts a Thresholds override; no panel-side change required.
//
// Threshold authoring conventions:
//   - Money values are in millions ($M) where the displayed unit is
//     "$X.XXM"; otherwise in the unit displayed (e.g. percentage).
//   - vs-benchmark thresholds are signed percentage points: +3.7 means
//     "3.7% above benchmark"; -5 means "5% below benchmark".
//   - band-bounded tolerance is in the same unit as min/max; a
//     reading within `tolerance` of either edge of [min, max] is
//     YELLOW.

import type { Thresholds } from "./types";

export const DEFAULT_THRESHOLDS: Thresholds = {
  // -----------------------------------------------------------------
  // Pillar 1 — Operations (chapter III)
  // -----------------------------------------------------------------
  // Revenue YTD vs Budget. +3.7% in demo → GREEN.
  "operations.revenue":         { kind: "vs-benchmark", greenAtPct: 0,    redAtPct: -5  },
  // NOI before depreciation vs Budget. +12.0% in demo → GREEN.
  "operations.noi":             { kind: "vs-benchmark", greenAtPct: 0,    redAtPct: -10 },
  // Payroll Ratio (lower is better). Policy band 50%. Demo 49.2% → GREEN.
  "operations.payroll-ratio":   { kind: "lower-better", greenAt:    50,   redAt:     55 },
  // Dues-to-Revenue policy band 38–44%. Demo 41.8% → GREEN.
  "operations.dues-to-revenue": { kind: "band-bounded", min: 38,   max:   44, tolerance: 2 },

  // -----------------------------------------------------------------
  // Pillar 3 — Financial Health (chapter IV)
  // -----------------------------------------------------------------
  // Working Capital ($M). Policy floor $3.50M. Demo $4.71M → GREEN.
  "financial.working-capital":  { kind: "higher-better", greenAt: 3.50,   redAt: 3.00 },
  // Current Ratio. Healthy ≥ 1.50. Demo 2.18 → GREEN.
  "financial.current-ratio":    { kind: "higher-better", greenAt: 1.50,   redAt: 1.20 },
  // Reserve Coverage policy floor 1.25x. Demo 1.42x → GREEN.
  "financial.reserve-coverage": { kind: "higher-better", greenAt: 1.25,   redAt: 1.00 },
  // AR Current % target ≥ 80%. Demo 78.4% → YELLOW (below target by 1.6 pts).
  "financial.ar-current":       { kind: "higher-better", greenAt: 80,     redAt: 75   },

  // -----------------------------------------------------------------
  // Pillar 2 — Capital (chapter V)
  // -----------------------------------------------------------------
  // Capital Spend YTD as a % of plan (90–110% inside band → GREEN).
  // Demo $1.62M / $1.94M plan = ~83.5% → YELLOW (below the 90% floor
  // due to the irrigation deferral).
  "capital.capital-spend-pct":    { kind: "band-bounded", min: 90,  max: 110, tolerance: 10 },
  // Projects Active count (LRP target 7+). Demo 7 → GREEN.
  "capital.projects-active":      { kind: "higher-better", greenAt: 5,    redAt: 3   },
  // Projects Delayed count (lower is better). Demo 1 deferred → YELLOW.
  "capital.projects-delayed":     { kind: "lower-better",  greenAt: 0,    redAt: 3   },
  // Reserve Contributions favorable swing %. Demo +$242K vs -$168K plan
  // → favorable swing → GREEN.
  "capital.reserve-contributions-pct": { kind: "vs-benchmark", greenAtPct: 0, redAtPct: -50 },

  // -----------------------------------------------------------------
  // Pillar 4 — Membership (chapter VI)
  // -----------------------------------------------------------------
  // Member Count (LRP target +30 net YTD; demo +25 → just inside band).
  // Vs-benchmark: net YTD as % of target. 25/30 ≈ -16.7% → YELLOW.
  // We tighten the GREEN floor to 0% so demo's +25 vs +30 falls YELLOW
  // (worse than plan), matching the cover Membership briefing card's
  // "monitor" posture and the user's "waitlist below buffer" framing.
  "membership.member-count-vs-target-pct": { kind: "vs-benchmark", greenAtPct: 0, redAtPct: -25 },
  // Waitlist depth (LRP target 60-deep; demo 47 → YELLOW).
  "membership.waitlist":      { kind: "higher-better", greenAt: 60,     redAt: 30      },
  // New Members YTD vs LRP target +30. Demo 36 → +20% above → GREEN.
  "membership.new-members-vs-target-pct": { kind: "vs-benchmark", greenAtPct: 0, redAtPct: -25 },
  // Attrition TTM (lower is better). CMAA peer median 6.0%. Demo 5.7% → GREEN.
  "membership.attrition-ttm": { kind: "lower-better",  greenAt: 6.0,   redAt: 8.0     },

  // -----------------------------------------------------------------
  // Pillar 5 — Experience (chapter VII)
  // -----------------------------------------------------------------
  // Rounds YTD vs plan. Demo +6.0% → GREEN.
  "experience.rounds":        { kind: "vs-benchmark", greenAtPct: 0,    redAtPct: -10 },
  // Covers YTD vs plan. Demo -1.4% → YELLOW (slip but contained).
  "experience.covers":        { kind: "vs-benchmark", greenAtPct: 0,    redAtPct: -10 },
  // Average Check YoY. Demo +4.1% → GREEN.
  "experience.average-check": { kind: "vs-benchmark", greenAtPct: 0,    redAtPct: -5  },
  // F&B Subsidy % of dues (lower is better; sustained target ≤ 6%).
  // Demo 5.1% → GREEN.
  "experience.fb-subsidy":    { kind: "lower-better",  greenAt: 6.0,   redAt: 9.0     },
};
