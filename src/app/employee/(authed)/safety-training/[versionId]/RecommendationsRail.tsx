// EP-TRAIN-2 §4 (2026-10-29) -- Recommended Training rail.  Server-
// rendered.  Receives a prepared recommendation list from the page
// and renders cards with title + category + required chip +
// duration (when known) + progress badge.  Entire card is clickable.
// No fabrication: titles, durations, status come from the DB-backed
// recommendation list only.
//
// Not a client component: no interactivity beyond the <Link> wrap.
// Avoid widgets that would re-render the parent on scroll / hover.

import Link from "next/link";
import { isLikelyStagingFixtureText } from "@/lib/hr/training/employee-recommendations";
import type { TrainingRecommendation } from "@/lib/hr/training/employee-recommendations";

function formatDuration(sec: number | null): string | null {
  if (!sec || sec <= 0) return null;
  const m = Math.round(sec / 60);
  if (m < 1) return "<1 min";
  if (m === 1) return "1 min";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m - h * 60;
  return rem === 0 ? `${h} hr` : `${h} hr ${rem} min`;
}

export default function RecommendationsRail({
  recommendations,
}: {
  recommendations: TrainingRecommendation[];
}) {
  const hasAny = recommendations.length > 0;
  return (
    <aside
      className="w-full lg:sticky lg:top-6 self-start"
      data-testid="portal-training-recommendations"
      aria-labelledby="portal-training-recs-heading"
    >
      <h2
        id="portal-training-recs-heading"
        className="font-serif text-lg md:text-xl text-club-ink mb-4"
      >
        Recommended Training
      </h2>
      {hasAny ? (
        <ul className="space-y-3" data-testid="portal-training-recommendations-list">
          {recommendations.map((r) => {
            const safeTitle = isLikelyStagingFixtureText(r.title) ? r.category : r.title;
            const duration = formatDuration(r.videoDurationSec);
            const inProgress = r.progressPercent > 0 && !r.completed;
            return (
              <li key={r.versionId}>
                <Link
                  href={r.href}
                  prefetch={false}
                  className="group block rounded-lg border border-stone-200 bg-white px-4 py-3 hover:border-club-green-700 hover:shadow-sm transition-colors"
                  data-testid={`portal-training-rec-${r.versionId}`}
                >
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="inline-flex items-center rounded-full border border-stone-300 bg-stone-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-stone-700">
                      {r.category}
                    </span>
                    {r.required && (
                      <span className="inline-flex items-center rounded-full bg-club-green-800 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-white">
                        Required
                      </span>
                    )}
                    {r.completed && (
                      <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-emerald-800">
                        Complete
                      </span>
                    )}
                    {inProgress && (
                      <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-amber-800">
                        In progress
                      </span>
                    )}
                  </div>
                  <div className="font-serif text-[15px] leading-snug text-club-ink group-hover:text-club-green-800">
                    {safeTitle}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[11.5px] text-stone-500">
                    {duration && <span>{duration}</span>}
                    {duration && inProgress && <span aria-hidden="true">·</span>}
                    {inProgress && <span className="tabular-nums">{r.progressPercent}% watched</span>}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <div
          className="rounded-lg border border-stone-200 bg-white px-4 py-5 text-sm text-stone-500"
          data-testid="portal-training-recommendations-empty"
        >
          You&apos;re all caught up — nothing else is recommended right now.
        </div>
      )}
    </aside>
  );
}
