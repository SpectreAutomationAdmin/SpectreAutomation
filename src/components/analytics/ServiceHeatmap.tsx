// Service-period × day-of-week heatmap. Each cell shows chit count and
// average prep time, coloured by threshold. Helps a manager spot
// "Friday dinner is consistently slow" patterns at a glance.

import {
  formatDuration,
  thresholdToneClass,
  type ServicePeriod,
  type ServicePeriodCell,
} from "@/lib/analytics/hospitality";

const PERIODS: ServicePeriod[] = ["BREAKFAST", "LUNCH", "AFTERNOON", "DINNER"];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// dayOfWeek in JS is 0=Sun. We display Mon-first.
const DAY_INDEX_MAP = [1, 2, 3, 4, 5, 6, 0];

type Props = {
  cells: ServicePeriodCell[];
};

export function ServiceHeatmap({ cells }: Props) {
  if (cells.length === 0) {
    return (
      <div className="card card-body">
        <div className="font-medium text-club-ink">Service-period performance</div>
        <div className="mt-6 text-sm text-stone-500 text-center py-10">No chits in this range yet.</div>
      </div>
    );
  }
  const map = new Map<string, ServicePeriodCell>();
  for (const c of cells) map.set(`${c.period}::${c.dayOfWeek}`, c);

  return (
    <div className="card card-body">
      <div className="font-medium text-club-ink">Service-period performance</div>
      <div className="mt-1 text-xs text-stone-500">
        Average prep time and chit volume by service period and day of week. Tap a cell to filter the drilldown.
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full border-collapse">
          <thead>
            <tr>
              <th className="px-2 py-1 text-left text-[10px] uppercase tracking-wide text-stone-400">Period</th>
              {DAYS.map((d) => (
                <th key={d} className="px-2 py-1 text-center text-[10px] uppercase tracking-wide text-stone-400">
                  {d}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PERIODS.map((period) => (
              <tr key={period}>
                <th className="px-2 py-1 text-left text-xs text-stone-700 whitespace-nowrap">
                  {periodLabel(period)}
                </th>
                {DAY_INDEX_MAP.map((dow) => {
                  const cell = map.get(`${period}::${dow}`);
                  return (
                    <td key={dow} className="p-1">
                      <Cell cell={cell ?? null} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Cell({ cell }: { cell: ServicePeriodCell | null }) {
  if (!cell || cell.count === 0) {
    return <div className="rounded border border-stone-100 bg-stone-50 px-2 py-1.5 text-[11px] text-stone-400 text-center min-h-[2.5rem]">—</div>;
  }
  const tone = thresholdToneClass(cell.status);
  return (
    <div className={`rounded border px-2 py-1.5 text-center min-h-[2.5rem] ${tone}`}>
      <div className="text-[11px] tabular-nums font-medium">{formatDuration(cell.avgSec ?? 0)}</div>
      <div className="text-[10px] opacity-75 tabular-nums">{cell.count} chits</div>
    </div>
  );
}

function periodLabel(p: ServicePeriod): string {
  if (p === "BREAKFAST") return "Breakfast (–11)";
  if (p === "LUNCH") return "Lunch (11–3)";
  if (p === "AFTERNOON") return "Afternoon (3–5)";
  return "Dinner (5+)";
}
