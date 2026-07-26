// Prep-time distribution histogram. Buckets prep durations into 2-min
// bins and renders a horizontal bar chart. Coloured by threshold: bars
// in the GREEN range are club-green, AMBER are amber, RED are red.
//
// Useful for spotting tail behaviour — a manager can see at a glance
// whether the slow times are a few outliers or a fat tail.

import { thresholdStatus, type Station } from "@/lib/analytics/hospitality";

type Props = {
  title: string;
  station: Station;
  // Durations in seconds.
  durations: number[];
};

const BIN_WIDTH_SEC = 120;     // 2-minute bins
const MAX_BIN_MINUTES = 30;    // anything beyond rolls into the last bucket

export function Distribution({ title, station, durations }: Props) {
  if (durations.length === 0) {
    return (
      <div className="card card-body">
        <div className="font-medium text-club-ink">{title}</div>
        <div className="mt-6 text-sm text-stone-500 text-center py-10">No completed chits in this range yet.</div>
      </div>
    );
  }
  const binCount = Math.ceil((MAX_BIN_MINUTES * 60) / BIN_WIDTH_SEC); // 15 bins
  const bins = new Array(binCount).fill(0) as number[];
  for (const d of durations) {
    const idx = Math.min(binCount - 1, Math.floor(d / BIN_WIDTH_SEC));
    bins[idx]++;
  }
  const max = Math.max(...bins);
  return (
    <div className="card card-body">
      <div className="font-medium text-club-ink">{title}</div>
      <div className="mt-3 space-y-1">
        {bins.map((count, i) => {
          const lowSec = i * BIN_WIDTH_SEC;
          const highSec = (i + 1) * BIN_WIDTH_SEC;
          const label =
            i === binCount - 1
              ? `${Math.floor(lowSec / 60)}m+`
              : `${Math.floor(lowSec / 60)}–${Math.floor(highSec / 60)}m`;
          // Bin is coloured by its midpoint threshold class so the
          // histogram reads as a heat-up-the-tail picture.
          const midSec = (lowSec + highSec) / 2;
          const status = thresholdStatus(midSec, station);
          const barCls =
            status === "RED"
              ? "bg-red-400"
              : status === "AMBER"
              ? "bg-amber-400"
              : "bg-club-green-400";
          const widthPct = max === 0 ? 0 : Math.round((count / max) * 100);
          return (
            <div key={i} className="flex items-center gap-2 text-[11px]">
              <div className="w-14 shrink-0 text-stone-500 tabular-nums text-right">{label}</div>
              <div className="flex-1 h-3 bg-stone-100 rounded-sm overflow-hidden">
                <div className={`${barCls} h-full`} style={{ width: `${widthPct}%` }} />
              </div>
              <div className="w-8 shrink-0 text-stone-600 tabular-nums">{count}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
