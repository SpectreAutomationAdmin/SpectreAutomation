// Board Attention Engine — types.
//
// The engine produces a three-state verdict (GREEN | YELLOW | RED) for
// any KPI on the five Chair's Dashboard pillar panels. The verdict
// drives:
//   - per-tile tone (replacing hardcoded `tone: "amber"` etc.)
//   - per-chapter rollup ribbon at the top of each pillar panel
//   - per-dashboard rollup ribbon at the top of the Chair's Dashboard
//   - the compact attention ribbon on the cover Executive Briefing
//
// The engine sits between raw service data and panel rendering. It is
// a pure-function module — no React, no DOM, no network. The threshold
// config is a TypeScript const today; the engine signature already
// accepts a Thresholds override so a future PR can swap to a per-club
// DB-backed config without touching panel code.

/**
 * Universal three-state attention verdict. Maps to the user-defined
 * pillar-specific labels via `labelFor()` in ./labels.ts.
 */
export type Attention = "green" | "yellow" | "red";

/**
 * One of four threshold-rule shapes. Each panel's metric uses one of
 * these; the rule kind determines how the actual value is compared
 * against the configured bands.
 */
export type ThresholdRule =
  /**
   * Higher reading is favorable. Example: Working Capital, Active
   * Members, Reserve Coverage.
   *   value ≥ greenAt   → GREEN
   *   value ≤ redAt     → RED
   *   otherwise         → YELLOW
   */
  | { kind: "higher-better"; greenAt: number; redAt: number }
  /**
   * Lower reading is favorable. Example: Attrition rate, F&B Subsidy
   * % of dues, Projects Delayed count.
   *   value ≤ greenAt   → GREEN
   *   value ≥ redAt     → RED
   *   otherwise         → YELLOW
   */
  | { kind: "lower-better"; greenAt: number; redAt: number }
  /**
   * Reading is favorable when it sits inside a policy band. Example:
   * Dues-to-Revenue inside 38–44% policy band.
   *   min ≤ value ≤ max              → GREEN
   *   within tolerance of either edge → YELLOW
   *   otherwise                       → RED
   */
  | { kind: "band-bounded"; min: number; max: number; tolerance: number }
  /**
   * Variance vs benchmark expressed as a percentage (signed). Example:
   * Revenue +3.7% above plan → 3.7. The thresholds are signed
   * percentage points.
   *   variancePct ≥ greenAtPct → GREEN
   *   variancePct ≤ redAtPct   → RED
   *   otherwise                → YELLOW
   */
  | { kind: "vs-benchmark"; greenAtPct: number; redAtPct: number };

/**
 * Per-metric threshold registry. Keys follow the convention
 * "<pillar>.<metric>" — e.g. "operations.revenue",
 * "financial.ar-current", "capital.projects-delayed". A missing key
 * resolves to GREEN with a console warning in dev (defensive default
 * — silent failure on a missing threshold would let a real concern
 * read as favorable, which is worse than a noisy warning).
 */
export type Thresholds = Record<string, ThresholdRule>;

/**
 * The five Chair's Dashboard pillars the engine targets in this pass.
 * Downstream long-form chapters (Financial Statements, Operations &
 * Analytics, etc.) are intentionally out of scope; see
 * docs/board-attention-engine.md §"Scope" for the rationale.
 */
export type PillarKey =
  | "operations"
  | "financial"
  | "capital"
  | "membership"
  | "experience";
