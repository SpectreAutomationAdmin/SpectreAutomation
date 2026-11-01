// EP-UX-2 (2026-11-01) — small circular-progress badge for the
// Safety & Training summary cards.  Pure SVG; no deps.  Server-
// renderable (no "use client").
//
// Visual contract (matches the founder reference):
//   - 64 px outer diameter
//   - 8 px stroke width (ring + track)
//   - Track color: stone-200 (muted)
//   - Ring color: club-green-800 (chrome green) at any completion
//   - Centred label: percent as integer, e.g. "100%"
//   - Label color: club-ink
//   - Label font: Spectre Inter stack via inherited chrome styling

interface Props {
  /** 0 – 100 integer. Values outside the range are clamped. */
  value: number;
  /** Visual diameter in pixels.  Defaults to 64. */
  size?: number;
  /** Stroke width in pixels.  Defaults to 7. */
  stroke?: number;
  /** Optional ARIA label.  Defaults to "N% complete". */
  ariaLabel?: string;
  /** Optional test id. */
  testId?: string;
}

export default function CircularProgress({ value, size = 64, stroke = 7, ariaLabel, testId }: Props) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - pct / 100);
  return (
    <div
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
      data-testid={testId}
      role="img"
      aria-label={ariaLabel ?? `${pct}% complete`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="rgb(231 229 228)" /* stone-200 */
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="#213a22" /* club-green-800 */
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span
        className="absolute text-[13px] font-semibold text-club-ink tabular-nums"
        aria-hidden="true"
      >
        {pct}%
      </span>
    </div>
  );
}
