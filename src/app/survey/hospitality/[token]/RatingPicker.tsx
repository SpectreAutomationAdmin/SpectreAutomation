"use client";

// Star-rating picker for the public hospitality survey.
//
// Why a client component when the rest of the survey page is a server
// component: the prior implementation used a server-rendered radio
// grid that relied on a CSS sibling-selector variant for the visual
// highlight. Users reported the page felt broken — clicks produced no
// visible feedback, and the submit button stayed clickable even with
// nothing selected.
//
// Switching to a controlled client component eliminates the dependency
// on that CSS variant and gates the submit button explicitly. The form
// action is still a server action on the parent page; we just carry
// the rating + comment through a plain `<form>` submission via named
// inputs (rating goes through a hidden input).

import { useState } from "react";

export function RatingPicker({
  initialRating,
}: {
  // ?rating=N preselects the rating clicked in the email. If the
  // query param is missing, invalid, or out-of-range, the picker
  // starts empty and the submit button is disabled until the user
  // picks something.
  initialRating: number | null;
}) {
  const [rating, setRating] = useState<number | null>(initialRating);

  return (
    <>
      <fieldset>
        <legend className="text-sm font-medium text-stone-700">Your rating</legend>
        <p className="mt-1 text-xs text-stone-500">5 = excellent · 1 = needs our attention</p>
        <div
          className="mt-3 grid grid-cols-5 gap-2"
          role="radiogroup"
          aria-label="How would you rate today's visit?"
        >
          {[1, 2, 3, 4, 5].map((n) => {
            const selected = rating === n;
            return (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={`${n} of 5 stars`}
                onClick={() => setRating(n)}
                className={
                  selected
                    ? "cursor-pointer rounded-md border border-stone-900 bg-stone-900 px-3 py-3 text-center text-lg text-white shadow-sm transition"
                    : "cursor-pointer rounded-md border border-stone-300 bg-white px-3 py-3 text-center text-lg text-stone-900 hover:border-stone-500 transition"
                }
              >
                <span className="block">{"⭐".repeat(n)}</span>
                <span className="block text-[10px] mt-1 opacity-70">{n}</span>
              </button>
            );
          })}
        </div>
        {/* The form action reads rating from this hidden input. The
            visible buttons above never submit anything themselves
            (type="button"); they only update local state. */}
        <input type="hidden" name="rating" value={rating ?? ""} />
      </fieldset>

      <div>
        <label htmlFor="comment" className="text-sm font-medium text-stone-700">
          Tell us what we could have done better
          <span className="ml-1 text-xs font-normal text-stone-500">(optional)</span>
        </label>
        <textarea
          id="comment"
          name="comment"
          rows={4}
          maxLength={2000}
          placeholder="A note on service, food, atmosphere, anything we should know."
          className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm focus:border-stone-900 focus:outline-none"
        />
      </div>

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={rating === null}
          aria-disabled={rating === null}
          className="rounded-md bg-stone-900 px-5 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:bg-stone-300 disabled:cursor-not-allowed"
        >
          Send feedback
        </button>
      </div>
    </>
  );
}
