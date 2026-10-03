// TB-HIST-12B §6-7 (2026-10-03) — chart partial-availability helpers.
//
// CONTRACT
//   AVAILABLE SERIES RENDER. MISSING SERIES DO NOT BECOME ZERO.
//
//   The shared chart primitives (`EditorialLineChart`,
//   `EditorialBarChart`, `EditorialDonut`) natively support this via
//   their input types:
//     - EditorialLineChart.LineSpec.values is `(number | null)[]`
//       → a `null` SKIPS that x-slot (no marker, no line segment).
//     - EditorialBarChart series pass arrays as-is; an omitted series
//       is simply not plotted.
//     - EditorialDonut's category list is the list to plot; an
//       omitted category is not plotted.
//
// This module adds helpers so callers can STATE their availability
// shape declaratively, and tests can assert the contract (missing
// series never coerced to zero, never silently plotted).

import type { ChartSeriesPoint } from "./monthly-package";

// -------------------------------------------------------------------
// LineSpec helpers
// -------------------------------------------------------------------

/** Build an actual-only series: the caller passes real values for the
 *  slots that have data, and the helper leaves every other slot
 *  explicitly `null`. Returns a `values` array of length `period`
 *  suitable for passing straight to `EditorialLineChart.LineSpec`. */
export function buildActualOnlySeries(opts: {
  values: number[];
  period: number;
}): (number | null)[] {
  const out: (number | null)[] = new Array(opts.period).fill(null);
  const n = Math.min(opts.values.length, opts.period);
  for (let i = 0; i < n; i++) out[i] = opts.values[i];
  return out;
}

/** Build an "unavailable" series — every slot explicitly null. Used
 *  by callers that want to pre-build a comparison series shape when
 *  the source is not yet connected. Explicit nulls make it IMPOSSIBLE
 *  to accidentally plot `0` as a data point. */
export function buildUnavailableSeries(period: number): (number | null)[] {
  return new Array(period).fill(null);
}

// -------------------------------------------------------------------
// Multi-series guards
// -------------------------------------------------------------------

/** Returns true iff the series has at least one non-null numeric
 *  slot — i.e. there is something to plot. Callers use this to
 *  decide whether to add the series to the chart at all. */
export function seriesIsRenderable(values: (number | null)[]): boolean {
  return values.some((v) => typeof v === "number" && Number.isFinite(v));
}

/** Audit guard — asserts the values array never contains `0` in
 *  place of unavailable data. Expected usage: when a caller wants
 *  to prove that a missing comparison series was NOT substituted
 *  with zero, pass the pair (sourceAvailable, values); when the
 *  source is unavailable, every slot must be `null`, never `0`.
 *
 *  Returns a diagnostic struct (does not throw) so tests can
 *  surface the actual offending slot. */
export function auditNoZeroFillForUnavailable(opts: {
  sourceAvailable: boolean;
  values: (number | null)[];
}): { ok: boolean; firstViolationIndex: number | null } {
  if (opts.sourceAvailable) return { ok: true, firstViolationIndex: null };
  for (let i = 0; i < opts.values.length; i++) {
    const v = opts.values[i];
    if (v !== null && v === 0) {
      return { ok: false, firstViolationIndex: i };
    }
  }
  return { ok: true, firstViolationIndex: null };
}

// -------------------------------------------------------------------
// Donut category helpers
// -------------------------------------------------------------------

/** Donut category input — one slice. */
export type DonutCategoryInput = {
  key: string;
  label: string;
  value: number;
};

/** Filter donut categories to the available-and-nonzero set. Missing
 *  categories (undefined / null) are omitted entirely rather than
 *  rendered as 0% slices. A category with a legitimate 0 value is
 *  preserved — the caller stated it had data of zero magnitude. */
export function filterDonutCategories(
  categories: Array<DonutCategoryInput | null | undefined>,
): DonutCategoryInput[] {
  return categories.filter(
    (c): c is DonutCategoryInput => c != null && Number.isFinite(c.value),
  );
}

// -------------------------------------------------------------------
// ChartSeriesPoint helpers (12-month trend containers)
// -------------------------------------------------------------------

/** When a 12-month trend series has data for only the first N months
 *  of the fiscal year, build a `ChartSeriesPoint[]` where the trailing
 *  (12 − N) months carry `value: null` (not 0). Useful for building
 *  package-payload series without putting the null-logic into every
 *  caller. */
export function buildPartialTrend(opts: {
  labels: string[];
  values: Array<number | null>;
}): ChartSeriesPoint[] {
  if (opts.labels.length !== opts.values.length) {
    throw new Error(
      `buildPartialTrend: labels length ${opts.labels.length} ≠ values length ${opts.values.length}`,
    );
  }
  return opts.labels.map((label, i) => ({
    label,
    // ChartSeriesPoint.value is `number`; downstream renderers treat
    // Number.NaN as "no data". The LineChart adapter must map NaN →
    // null in its LineSpec translation. Callers who have a real
    // nullable at the source should prefer buildActualOnlySeries +
    // the LineSpec path directly; buildPartialTrend exists for the
    // package type (ChartSeriesPoint) which doesn't carry nullability.
    value: opts.values[i] == null ? Number.NaN : (opts.values[i] as number),
  }));
}
