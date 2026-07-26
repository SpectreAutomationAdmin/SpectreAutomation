// Shared "At a glance" block — the 2x2 KPI grid that lives on the
// Monthly Reporting Package cover (Executive Opening) AND on the
// Board dashboard widget.
//
// Reused by both surfaces so the Board widget is a visual exact
// copy of the cover block — same typography, spacing, casing,
// proportions, and ivory/cream report-card feel. The founder's
// spec calls this out explicitly:
//
//   "The widget should be an exact visual copy of the 'At a
//    Glance' section from the Executive Opening page of the
//    Monthly Reporting Package."
//
// The block accepts a list of KPI tuples (label / value / variance)
// in source order. Callers either:
//   • Pluck the canonical four cover keys (ytd-revenue, noi,
//     capital-income, reserve-coverage) from a live or snapshot
//     payload, OR
//   • Pass already-shaped tuples (e.g. board widget reads
//     atAGlanceKpis from the immutable snapshot).
//
// Visual rules — DO NOT redesign. Match the cover exactly.
//   • Section eyebrow:   "At a glance" in 11px gold smallcaps with
//                        0.22em tracking
//   • Top hairline:      border-club-sand/70
//   • 2x2 grid:          grid-cols-2, gap-x-6 gap-y-3
//   • KPI label:         11px green-900 uppercase 0.22em tracking
//   • KPI value:         serif tabular-nums, 2xl on narrow viewports
//                        / 3xl when min-height:880px allows it
//   • Variance:          12px green-800/70 uppercase 0.18em tracking
//
// The cover's full `[@media(min-height:880px)]:` responsive
// upgrades are preserved here — at tall viewports both surfaces
// breathe identically.

export type AtAGlanceMetric = {
  /** Stable key — used for the testid + the React list key. */
  key: string;
  /** Smallcaps label (e.g. "YTD Revenue", "NOI Before Depreciation"). */
  label: string;
  /** Pre-formatted hero number ("$14.62M", "1.42x"). */
  value: string;
  /** Comparator copy under the hero ("+3.7% Above Plan",
   *  "0.17x Above Floor"). Optional — omit for KPIs without one. */
  variance?: string | null;
};

type Props = {
  metrics: ReadonlyArray<AtAGlanceMetric>;
  /** Test-id prefix so two instances of this block on the same
   *  page (cover + widget, if that ever happens) don't collide.
   *  Defaults to "monthly-cover-at-a-glance" — matches the cover's
   *  existing testid namespace so the existing screenshot + e2e
   *  fixtures keep working when the cover is migrated to this
   *  component. */
  testIdPrefix?: string;
  /** Optional aria-label override — defaults to "At a glance". */
  ariaLabel?: string;
};

export function AtAGlanceBlock({
  metrics,
  testIdPrefix = "monthly-cover-at-a-glance",
  ariaLabel = "At a glance",
}: Props) {
  return (
    <div
      data-testid={testIdPrefix}
      className="mt-2 border-t border-club-sand/70 pt-2 [@media(min-height:880px)]:mt-6 [@media(min-height:880px)]:pt-4 xl:mr-4 2xl:mr-32"
      aria-label={ariaLabel}
    >
      <h3
        data-testid={`${testIdPrefix}-eyebrow`}
        className="text-[11px] font-medium uppercase tracking-[0.22em] text-club-gold"
      >
        At a glance
      </h3>
      <dl
        data-testid={`${testIdPrefix}-grid`}
        className="mt-2 grid grid-cols-2 gap-x-6 gap-y-2 [@media(min-height:880px)]:mt-3 [@media(min-height:880px)]:gap-y-3"
      >
        {metrics.map((m) => (
          <div key={m.key} data-testid={`${testIdPrefix}-${m.key}`}>
            <dt
              data-testid={`${testIdPrefix}-${m.key}-label`}
              className="text-[11px] uppercase tracking-[0.22em] font-medium text-club-green-900"
            >
              {m.label}
            </dt>
            <dd
              data-testid={`${testIdPrefix}-${m.key}-value`}
              className="mt-0.5 font-serif text-2xl leading-none tracking-tight tabular-nums text-club-green-900 [@media(min-height:880px)]:mt-1 [@media(min-height:880px)]:text-3xl"
            >
              {m.value}
            </dd>
            {/* Variance row is always rendered when the field is
                supplied (even as an empty string) so vertical
                rhythm matches the original cover block byte-for-
                byte. Pass `variance: null` to skip explicitly. */}
            {m.variance !== null && m.variance !== undefined && (
              <dd
                data-testid={`${testIdPrefix}-${m.key}-variance`}
                className="mt-0.5 text-[12px] uppercase tracking-[0.18em] text-club-green-800/70 [@media(min-height:880px)]:mt-1.5"
              >
                {m.variance}
              </dd>
            )}
          </div>
        ))}
      </dl>
    </div>
  );
}
