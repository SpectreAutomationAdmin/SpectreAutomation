// Lightweight SVG line chart for prep-time trends. No chart library;
// matches the hand-rolled bar charts already in the admin dashboards.
//
// Renders two stacked overlays:
//   • a soft area + line for the metric series (e.g. average prep seconds)
//   • a faint baseline at the green/amber threshold so managers can
//     instantly see which buckets crossed target.
//
// Empty state, axis labels, accessible role.

import { formatDuration } from "@/lib/analytics/hospitality";

type Point = {
  label: string;
  bucketStart: Date;
  valueSec: number | null;
  totalChits: number;
};

type Props = {
  title: string;
  unit: "duration" | "count";
  thresholdSec?: number;
  points: Point[];
  height?: number;
};

export function TrendChart({ title, unit, thresholdSec, points, height = 180 }: Props) {
  const valid = points.filter((p) => p.valueSec !== null) as Array<Point & { valueSec: number }>;
  if (valid.length === 0) {
    return (
      <div className="card card-body">
        <div className="font-medium text-club-ink">{title}</div>
        <div className="mt-6 text-sm text-stone-500 text-center py-10">No data in this range yet.</div>
      </div>
    );
  }
  const maxSec = Math.max(thresholdSec ?? 0, ...valid.map((p) => p.valueSec));
  const ceilingSec = Math.ceil(maxSec / 60) * 60; // round up to next minute
  const minSec = 0;
  const w = Math.max(320, points.length * 32);
  const h = height;
  const padX = 32;
  const padY = 24;
  const innerW = w - padX * 2;
  const innerH = h - padY * 2;

  function xFor(i: number) {
    if (points.length <= 1) return padX + innerW / 2;
    return padX + (i / (points.length - 1)) * innerW;
  }
  function yFor(secs: number) {
    if (ceilingSec === minSec) return padY + innerH / 2;
    return padY + innerH - ((secs - minSec) / (ceilingSec - minSec)) * innerH;
  }

  // Build line path (skip null gaps).
  const segments: string[] = [];
  let currentSeg: string[] = [];
  points.forEach((p, i) => {
    if (p.valueSec === null) {
      if (currentSeg.length > 0) {
        segments.push(currentSeg.join(" "));
        currentSeg = [];
      }
    } else {
      const cmd = currentSeg.length === 0 ? "M" : "L";
      currentSeg.push(`${cmd}${xFor(i)},${yFor(p.valueSec)}`);
    }
  });
  if (currentSeg.length > 0) segments.push(currentSeg.join(" "));

  // Axis ticks — 4 ticks on Y.
  const tickCount = 4;
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => {
    const v = (ceilingSec / tickCount) * i;
    return { y: yFor(v), label: unit === "duration" ? formatDuration(v) : `${Math.round(v)}` };
  });

  return (
    <div className="card card-body">
      <div className="flex items-baseline justify-between gap-3">
        <div className="font-medium text-club-ink">{title}</div>
        <div className="text-[10px] uppercase tracking-wide text-stone-400">
          {unit === "duration" ? "Minutes" : "Count"}
        </div>
      </div>
      <div className="mt-3 overflow-x-auto">
        <svg
          role="img"
          aria-label={title}
          viewBox={`0 0 ${w} ${h}`}
          width={w}
          height={h}
          className="block"
        >
          {/* Gridlines + Y-axis tick labels */}
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={padX} x2={w - padX} y1={t.y} y2={t.y} stroke="#e7e5e4" strokeWidth={1} />
              <text x={padX - 6} y={t.y + 3} textAnchor="end" className="fill-stone-400" fontSize={10}>
                {t.label}
              </text>
            </g>
          ))}
          {/* Threshold line */}
          {thresholdSec !== undefined && thresholdSec > 0 && thresholdSec <= ceilingSec && (
            <line
              x1={padX}
              x2={w - padX}
              y1={yFor(thresholdSec)}
              y2={yFor(thresholdSec)}
              stroke="#f59e0b"
              strokeWidth={1.2}
              strokeDasharray="3 3"
            />
          )}
          {/* Line segments */}
          {segments.map((d, i) => (
            <path key={i} d={d} fill="none" stroke="#2f5832" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          ))}
          {/* Dots */}
          {valid.map((p, i) => {
            const idx = points.indexOf(p);
            return (
              <circle
                key={p.label}
                cx={xFor(idx)}
                cy={yFor(p.valueSec)}
                r={3}
                fill="#2f5832"
              >
                <title>{`${p.label} · ${formatDuration(p.valueSec)} · ${p.totalChits} chits`}</title>
              </circle>
            );
          })}
          {/* X-axis tick labels — show every other one if the series is dense */}
          {points.map((p, i) => {
            const step = points.length > 14 ? Math.ceil(points.length / 7) : 1;
            if (i % step !== 0 && i !== points.length - 1) return null;
            return (
              <text
                key={`${p.label}-x`}
                x={xFor(i)}
                y={h - padY + 14}
                textAnchor="middle"
                className="fill-stone-500"
                fontSize={10}
              >
                {shortLabel(p.label)}
              </text>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

function shortLabel(label: string): string {
  // For "2026-05-19" → "May 19"; for "2026-W21" → "W21"; for "2026-05" → "May".
  if (/^\d{4}-W\d{2}$/.test(label)) return label.slice(5);
  if (/^\d{4}-\d{2}-\d{2}$/.test(label)) {
    const d = new Date(label + "T00:00:00");
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  if (/^\d{4}-\d{2}$/.test(label)) {
    const d = new Date(label + "-01T00:00:00");
    return d.toLocaleDateString(undefined, { month: "short" });
  }
  return label;
}
