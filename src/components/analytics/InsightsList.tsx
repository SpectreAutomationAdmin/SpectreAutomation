// Rule-based manager insights. Severity drives the left border colour;
// the message text comes straight from the analytics service.

import type { Insight } from "@/lib/analytics/hospitality";

export function InsightsList({ insights }: { insights: Insight[] }) {
  if (insights.length === 0) {
    return (
      <div className="card card-body">
        <div className="font-medium text-club-ink">Manager insights</div>
        <div className="mt-2 text-sm text-stone-500">
          Nothing notable in this range — prep times are within target.
        </div>
      </div>
    );
  }
  return (
    <div className="card card-body">
      <div className="font-medium text-club-ink">Manager insights</div>
      <ul className="mt-3 space-y-2">
        {insights.map((i) => {
          const borderCls =
            i.severity === "ALERT"
              ? "border-red-500"
              : i.severity === "WATCH"
              ? "border-amber-500"
              : "border-stone-300";
          const sevCls =
            i.severity === "ALERT"
              ? "bg-red-50 text-red-700 border-red-200"
              : i.severity === "WATCH"
              ? "bg-amber-50 text-amber-800 border-amber-200"
              : "bg-stone-50 text-stone-600 border-stone-200";
          return (
            <li key={i.id} className={`rounded-md border-l-4 ${borderCls} bg-white px-3 py-2`}>
              <div className="flex items-start gap-2">
                <span
                  className={`mt-0.5 inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${sevCls}`}
                >
                  {i.severity}
                </span>
                <span className="text-sm text-stone-700">{i.message}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
