"use client";

// HR-2C B4 (2026-08-23) — Availability week form.
//
// A single week's Mon–Sun checkboxes + free-text notes + Save. The
// form action is server-side (`saveAvailabilityAction`) which is
// gated by `assertSchedulingEligibility` — a stale page (form was
// eligible at load, a new required course was published mid-edit)
// still fails the write, and the returned message flips this form
// into the same "training required" banner the parent page shows on
// initial render. No client-only bypass exists.

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { WEEKDAYS, type Weekday, type AvailabilityWeekView } from "@/lib/hr/availability-types";

interface Props {
  weekStart: string;
  initial: AvailabilityWeekView | null;
  editable: boolean;
  action: (formData: FormData) => Promise<
    | { ok: true; savedWeek: string }
    | { ok: false; error: string; ineligible?: boolean; outstandingCount?: number }
  >;
}

const DAY_LABEL: Record<Weekday, string> = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
};

export default function AvailabilityWeekForm({ weekStart, initial, editable, action }: Props) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [refusedByTraining, setRefusedByTraining] = useState<boolean>(false);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startTransition(async () => {
      setError(null);
      setSavedAt(null);
      const result = await action(fd);
      if (result.ok) {
        setSavedAt(new Date().toLocaleTimeString());
        router.refresh();
      } else {
        setError(result.error);
        if (result.ineligible) setRefusedByTraining(true);
      }
    });
  }

  const initialFor = (day: Weekday) => (initial ? initial[day] : false);

  return (
    <form
      onSubmit={onSubmit}
      className="mt-3 space-y-3"
      data-testid={`portal-availability-form-${weekStart.slice(0, 10)}`}
    >
      <input type="hidden" name="weekStart" value={weekStart} />
      <div className="flex flex-wrap gap-2" data-testid="portal-availability-days">
        {WEEKDAYS.map((day) => (
          <label
            key={day}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md border text-sm ${
              editable
                ? "border-stone-200 bg-white hover:bg-stone-50 cursor-pointer"
                : "border-stone-200 bg-stone-50 text-stone-600 cursor-not-allowed"
            }`}
            data-testid={`portal-availability-day-${day}`}
          >
            <input
              type="checkbox"
              name={day}
              defaultChecked={initialFor(day)}
              disabled={!editable}
              className="accent-club-green-700"
            />
            {DAY_LABEL[day]}
          </label>
        ))}
      </div>
      <div>
        <label className="block text-[11px] uppercase tracking-[0.16em] text-stone-500">
          Notes (optional)
        </label>
        <textarea
          name="notes"
          rows={2}
          maxLength={500}
          defaultValue={initial?.notes ?? ""}
          disabled={!editable}
          placeholder="e.g. afternoons only Wednesday; unavailable long weekend."
          className="mt-1 input w-full"
          data-testid="portal-availability-notes"
        />
      </div>
      {editable && (
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs text-stone-500">
            {pending && "Saving…"}
            {!pending && savedAt && `Saved ${savedAt}`}
            {!pending && !savedAt && initial?.updatedAt && (
              <>Last saved {new Date(initial.updatedAt).toLocaleString()}</>
            )}
          </div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={pending}
            data-testid={`portal-availability-save-${weekStart.slice(0, 10)}`}
          >
            {pending ? "Saving…" : initial ? "Update availability" : "Submit availability"}
          </button>
        </div>
      )}
      {error && (
        <div
          role="alert"
          className={`rounded-md border px-3 py-2 text-sm ${
            refusedByTraining
              ? "border-amber-200 bg-amber-50 text-amber-900"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
          data-testid="portal-availability-error"
        >
          <p>{error}</p>
          {refusedByTraining && (
            <p className="mt-2">
              <Link
                href="/employee/safety-training"
                className="underline underline-offset-4"
                data-testid="portal-availability-error-cta"
              >
                Complete required training
              </Link>
            </p>
          )}
        </div>
      )}
    </form>
  );
}
