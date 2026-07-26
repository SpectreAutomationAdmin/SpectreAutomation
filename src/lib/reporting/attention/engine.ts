// Board Attention Engine — pure-function evaluator.
//
// `evaluateMetric(metricKey, actualValue, overrides?)` is the engine's
// only public function. Given a metric key (e.g. "operations.revenue"),
// a numeric actual value, and an optional Thresholds override, it
// returns the universal three-state Attention verdict
// (GREEN | YELLOW | RED).
//
// Pure function — no React, no DOM, no network, no time. Testable in
// isolation.

import type { Attention, ThresholdRule, Thresholds } from "./types";
import { DEFAULT_THRESHOLDS } from "./thresholds";

/**
 * Compute attention verdict for a single metric.
 *
 * @param metricKey   "<pillar>.<metric>" — e.g. "operations.revenue"
 * @param actualValue numeric reading; meaning depends on the rule kind
 *                    (variance % for vs-benchmark, absolute for others)
 * @param overrides   optional Thresholds map; defaults to
 *                    DEFAULT_THRESHOLDS. Future per-club configuration
 *                    flows through this parameter.
 * @returns Attention — "green" / "yellow" / "red"
 *
 * A missing metricKey resolves to GREEN with a console warning in dev
 * builds — the defensive default. Silent failure on missing thresholds
 * would let a real concern read as favorable, which is worse than a
 * noisy log line.
 */
export function evaluateMetric(
  metricKey: string,
  actualValue: number,
  overrides?: Thresholds,
): Attention {
  const rule: ThresholdRule | undefined =
    (overrides ?? DEFAULT_THRESHOLDS)[metricKey];

  if (!rule) {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn(
        `[attention-engine] missing threshold for metric "${metricKey}" — defaulting to GREEN`,
      );
    }
    return "green";
  }

  return evaluateRule(rule, actualValue);
}

/**
 * Internal — dispatch on rule kind. Exported for unit tests.
 */
export function evaluateRule(rule: ThresholdRule, value: number): Attention {
  switch (rule.kind) {
    case "higher-better":
      if (value >= rule.greenAt) return "green";
      if (value <= rule.redAt)   return "red";
      return "yellow";

    case "lower-better":
      if (value <= rule.greenAt) return "green";
      if (value >= rule.redAt)   return "red";
      return "yellow";

    case "band-bounded": {
      const inBand = value >= rule.min && value <= rule.max;
      if (inBand) return "green";
      const nearLow  = value >= rule.min - rule.tolerance && value < rule.min;
      const nearHigh = value > rule.max  && value <= rule.max + rule.tolerance;
      if (nearLow || nearHigh) return "yellow";
      return "red";
    }

    case "vs-benchmark":
      if (value >= rule.greenAtPct) return "green";
      if (value <= rule.redAtPct)   return "red";
      return "yellow";
  }
}
