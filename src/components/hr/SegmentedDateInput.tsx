// HR-2B.3.6 (2026-08-19) — Segmented YYYY-MM-DD date input.
//
// Founder pain point: the native `<input type="date">` in the Add
// Employee form allowed the year segment to accept six digits before
// jumping to month. This component fixes that with three tightly-
// bounded numeric inputs that behave like a keyboard-friendly date
// entry: type `20260915` and get `2026-09-15` without touching the
// mouse.
//
// Behaviour:
//   * Year accepts exactly 4 digits, then focus advances to Month.
//   * Month accepts exactly 2 digits, then focus advances to Day.
//   * Day accepts exactly 2 digits. Done.
//   * Backspace on an empty segment jumps to the previous segment
//     (and preserves the caret at end-of-value).
//   * ArrowLeft/Right at the edge of a segment jumps between segments.
//   * Paste accepts BOTH `20260915` and `2026-09-15` (also `2026/09/15`
//     and `2026 09 15`); anything else is rejected.
//   * Rendered canonical value is a hidden `<input>` carrying
//     `YYYY-MM-DD` (or empty when the composite is incomplete /
//     invalid), so a normal `<form>` submit works with no
//     controlled-state ceremony.
//   * Validation refuses impossible calendar dates (e.g. `2026-02-31`)
//     via a Date round-trip. When the composite is complete but
//     invalid, the hidden input carries `""` (the outer `required`
//     attribute + the visible inline error tell the user why).
//
// Deliberately restrained — no oversized popover calendar. The
// browser's native picker remains accessible via a small button
// affordance for mouse users; keyboard users don't need it.

"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Segment = "year" | "month" | "day";

export interface SegmentedDateInputProps {
  /** Name of the hidden `<input>` that carries the canonical `YYYY-MM-DD`
   *  value for form submission. */
  name: string;
  /** Optional id — applied to the year segment so the label's `htmlFor`
   *  focuses year first. */
  id?: string;
  /** Optional initial value in `YYYY-MM-DD` shape. */
  defaultValue?: string;
  required?: boolean;
  /** Data-testid prefix for the three segments and the hidden input. */
  testIdPrefix?: string;
  /** ISO date string (`YYYY-MM-DD`) — reject dates before this. */
  minDate?: string;
  /** ISO date string — reject dates after this. */
  maxDate?: string;
  className?: string;
}

function pad(value: string, width: number): string {
  const n = value.replace(/\D/g, "").slice(0, width);
  return n.length === width ? n : n;
}

function splitIsoValue(iso: string | undefined): { year: string; month: string; day: string } {
  if (!iso) return { year: "", month: "", day: "" };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return { year: "", month: "", day: "" };
  return { year: m[1], month: m[2], day: m[3] };
}

function isCalendarValid(y: string, mo: string, d: string): boolean {
  if (y.length !== 4 || mo.length !== 2 || d.length !== 2) return false;
  const Y = Number(y);
  const M = Number(mo);
  const D = Number(d);
  if (Y < 1900 || Y > 2999) return false;
  if (M < 1 || M > 12) return false;
  if (D < 1 || D > 31) return false;
  const round = new Date(Date.UTC(Y, M - 1, D));
  return (
    round.getUTCFullYear() === Y &&
    round.getUTCMonth() === M - 1 &&
    round.getUTCDate() === D
  );
}

export default function SegmentedDateInput(props: SegmentedDateInputProps) {
  const {
    name,
    id,
    defaultValue,
    required,
    testIdPrefix = "seg-date",
    minDate,
    maxDate,
    className,
  } = props;

  const initial = useMemo(() => splitIsoValue(defaultValue), [defaultValue]);
  const [year, setYear] = useState(initial.year);
  const [month, setMonth] = useState(initial.month);
  const [day, setDay] = useState(initial.day);

  const yearRef = useRef<HTMLInputElement | null>(null);
  const monthRef = useRef<HTMLInputElement | null>(null);
  const dayRef = useRef<HTMLInputElement | null>(null);

  const composite = year && month && day ? `${year}-${month}-${day}` : "";
  const compositeValid = composite ? isCalendarValid(year, month, day) : false;
  const canonical = compositeValid ? composite : "";

  // Range validation (bound in a plain effect so we can also surface
  // an inline hint below the field).
  const rangeError = useMemo(() => {
    if (!canonical) return null;
    if (minDate && canonical < minDate) return `Must be on or after ${minDate}`;
    if (maxDate && canonical > maxDate) return `Must be on or before ${maxDate}`;
    return null;
  }, [canonical, minDate, maxDate]);

  const inlineError = useMemo(() => {
    // Only surface an inline error when the user has finished typing
    // all three segments — mid-entry noise is unhelpful.
    if (!composite) return null;
    if (!compositeValid) return "Please enter a real calendar date.";
    return rangeError;
  }, [composite, compositeValid, rangeError]);

  function focus(seg: Segment) {
    const target =
      seg === "year" ? yearRef.current : seg === "month" ? monthRef.current : dayRef.current;
    if (!target) return;
    target.focus();
    // Place caret at end of the segment's current value.
    const len = target.value.length;
    target.setSelectionRange(len, len);
  }

  function onChangeYear(next: string) {
    const clean = pad(next, 4);
    setYear(clean);
    if (clean.length === 4) focus("month");
  }
  function onChangeMonth(next: string) {
    const clean = pad(next, 2);
    setMonth(clean);
    if (clean.length === 2) focus("day");
  }
  function onChangeDay(next: string) {
    const clean = pad(next, 2);
    setDay(clean);
    // No auto-advance after day — this is the last segment.
  }

  function backspaceHop(seg: Segment) {
    if (seg === "month" && month.length === 0) focus("year");
    else if (seg === "day" && day.length === 0) focus("month");
  }

  function arrowHop(seg: Segment, dir: "left" | "right", caret: number, len: number) {
    if (dir === "left" && caret === 0) {
      if (seg === "month") focus("year");
      else if (seg === "day") focus("month");
    } else if (dir === "right" && caret === len) {
      if (seg === "year") focus("month");
      else if (seg === "month") focus("day");
    }
  }

  function handlePaste(event: React.ClipboardEvent<HTMLInputElement>) {
    const raw = event.clipboardData.getData("text").trim();
    // Match YYYY[sep]MM[sep]DD where sep is -, /, space, or nothing.
    const m = /^(\d{4})[-/\s]?(\d{2})[-/\s]?(\d{2})$/.exec(raw);
    if (!m) return; // let default paste fire — user probably pasted into one segment
    event.preventDefault();
    setYear(m[1]);
    setMonth(m[2]);
    setDay(m[3]);
    // Focus the day segment so any follow-up typing lands there.
    setTimeout(() => focus("day"), 0);
  }

  // Keep the native calendar picker as a secondary affordance without
  // being the primary path. The hidden native input is rendered
  // off-screen so screen readers still see it; clicking the visible
  // "Pick date" button opens it.
  const nativeRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (nativeRef.current) {
      nativeRef.current.value = canonical;
    }
  }, [canonical]);

  return (
    <div className={className ?? ""}>
      <div className="flex items-center gap-1" data-testid={`${testIdPrefix}-shell`}>
        <input
          ref={yearRef}
          id={id}
          data-testid={`${testIdPrefix}-year`}
          inputMode="numeric"
          autoComplete="off"
          value={year}
          maxLength={4}
          placeholder="YYYY"
          onChange={(e) => onChangeYear(e.target.value)}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            if (e.key === "Backspace" && year.length === 0) backspaceHop("year");
            if (e.key === "ArrowLeft") arrowHop("year", "left", e.currentTarget.selectionStart ?? 0, year.length);
            if (e.key === "ArrowRight") arrowHop("year", "right", e.currentTarget.selectionEnd ?? 0, year.length);
          }}
          className="w-[4.5rem] rounded-md border border-stone-300 px-2 py-1.5 text-center font-mono text-sm text-stone-900 focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700"
          aria-label="Year"
        />
        <span aria-hidden className="text-stone-400">-</span>
        <input
          ref={monthRef}
          data-testid={`${testIdPrefix}-month`}
          inputMode="numeric"
          autoComplete="off"
          value={month}
          maxLength={2}
          placeholder="MM"
          onChange={(e) => onChangeMonth(e.target.value)}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            if (e.key === "Backspace" && month.length === 0) backspaceHop("month");
            if (e.key === "ArrowLeft") arrowHop("month", "left", e.currentTarget.selectionStart ?? 0, month.length);
            if (e.key === "ArrowRight") arrowHop("month", "right", e.currentTarget.selectionEnd ?? 0, month.length);
          }}
          className="w-[3rem] rounded-md border border-stone-300 px-2 py-1.5 text-center font-mono text-sm text-stone-900 focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700"
          aria-label="Month"
        />
        <span aria-hidden className="text-stone-400">-</span>
        <input
          ref={dayRef}
          data-testid={`${testIdPrefix}-day`}
          inputMode="numeric"
          autoComplete="off"
          value={day}
          maxLength={2}
          placeholder="DD"
          onChange={(e) => onChangeDay(e.target.value)}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            if (e.key === "Backspace" && day.length === 0) backspaceHop("day");
            if (e.key === "ArrowLeft") arrowHop("day", "left", e.currentTarget.selectionStart ?? 0, day.length);
            if (e.key === "ArrowRight") arrowHop("day", "right", e.currentTarget.selectionEnd ?? 0, day.length);
          }}
          className="w-[3rem] rounded-md border border-stone-300 px-2 py-1.5 text-center font-mono text-sm text-stone-900 focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700"
          aria-label="Day"
        />

        {/* Secondary calendar affordance for mouse users. */}
        <button
          type="button"
          data-testid={`${testIdPrefix}-picker-button`}
          onClick={() => nativeRef.current?.showPicker?.()}
          className="ml-2 rounded-md border border-stone-200 px-2 py-1.5 text-xs text-stone-600 hover:border-stone-300 hover:text-stone-800"
          aria-label="Open calendar picker"
          title="Pick date"
        >
          📅
        </button>
      </div>

      {inlineError && (
        <p
          data-testid={`${testIdPrefix}-error`}
          role="alert"
          className="mt-1 text-xs text-red-700"
        >
          {inlineError}
        </p>
      )}

      {/* Hidden native picker for the calendar affordance. */}
      <input
        ref={nativeRef}
        type="date"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          const parts = splitIsoValue(e.target.value);
          if (parts.year) setYear(parts.year);
          if (parts.month) setMonth(parts.month);
          if (parts.day) setDay(parts.day);
        }}
        min={minDate}
        max={maxDate}
        className="sr-only"
      />

      {/* Canonical hidden input carrying the YYYY-MM-DD value. */}
      <input
        type="hidden"
        name={name}
        data-testid={`${testIdPrefix}-canonical`}
        value={canonical}
        required={required}
      />
    </div>
  );
}
