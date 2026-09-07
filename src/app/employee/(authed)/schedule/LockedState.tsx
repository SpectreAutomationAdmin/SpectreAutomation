// Scheduling Foundation · Phase D (2026-09-07) — training-locked
// Schedule state. Rendered by page.tsx when the employee is not
// scheduling-eligible (required training incomplete).
//
// Founder amendment §2: this is a POLISHED state, not an amber
// warning above an otherwise-usable schedule. No shift functionality
// is exposed while ineligible.

import Link from "next/link";

export default function LockedState({
  completedCount,
  totalCount,
  outstanding,
}: {
  completedCount: number;
  totalCount: number;
  outstanding: { title: string; category: string }[];
}) {
  return (
    <div className="space-y-8" data-testid="portal-schedule-locked">
      <header>
        <h1 className="font-serif text-3xl text-club-ink">My Schedule</h1>
        <p className="mt-2 text-sm text-stone-500">
          Your upcoming shifts and work schedule will appear here.
        </p>
      </header>

      <section className="rounded-lg border border-stone-200 bg-white px-6 py-8 md:px-10 md:py-12">
        <p className="text-[11px] uppercase tracking-[0.25em] text-club-gold-700">
          Not quite ready
        </p>
        <h2 className="mt-3 font-serif text-2xl md:text-3xl text-club-ink">
          You're almost ready.
        </h2>
        <p className="mt-3 text-sm text-stone-600 max-w-xl leading-relaxed">
          Complete your required training before you can be scheduled for
          shifts. Once your training is finished, your Club can add you to
          the schedule.
        </p>

        {totalCount > 0 && (
          <div className="mt-6 rounded-md border border-stone-200 bg-club-cream px-4 py-3">
            <p className="text-[11px] uppercase tracking-[0.2em] text-stone-500">
              Training progress
            </p>
            <p className="mt-1 font-serif text-lg text-club-ink" data-testid="portal-schedule-training-progress">
              {completedCount} of {totalCount} complete
            </p>
            {outstanding.length > 0 && (
              <ul className="mt-3 space-y-1 text-sm text-stone-600">
                {outstanding.slice(0, 4).map((c) => (
                  <li key={c.title}>· {c.title}</li>
                ))}
                {outstanding.length > 4 && (
                  <li className="text-xs text-stone-500">
                    + {outstanding.length - 4} more
                  </li>
                )}
              </ul>
            )}
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Link
            href="/employee/safety-training"
            data-testid="portal-schedule-locked-view-training"
            className="inline-flex items-center rounded-md bg-club-green-800 px-5 py-2.5 text-sm font-medium text-white hover:bg-club-green-900"
          >
            View Training
          </Link>
          <Link
            href="/employee/availability"
            data-testid="portal-schedule-locked-view-availability"
            className="inline-flex items-center rounded-md border border-stone-300 bg-white px-5 py-2.5 text-sm text-stone-700 hover:border-stone-500"
          >
            View Availability
          </Link>
        </div>
      </section>
    </div>
  );
}
