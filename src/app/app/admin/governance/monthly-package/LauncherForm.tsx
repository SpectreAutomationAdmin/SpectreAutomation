"use client";

// Monthly Package launcher form.
//
// Two side-by-side dropdowns (Month + Year) drive the period
// selection. Primary "Generate Monthly Package" button routes to the
// board document with `?period=YYYY-MM`. Secondary "View Archive"
// link points at the Board Packages archive at
// /app/admin/governance/packages — the natural home for saved /
// distributed monthly packages.

import Link from "next/link";
import { useState, useTransition } from "react";

import { generateDraftMonthlyPackageAction } from "@/app/app/admin/reporting/monthly/_lifecycle-actions";

const MONTHS = [
  { value: 1, label: "January" },
  { value: 2, label: "February" },
  { value: 3, label: "March" },
  { value: 4, label: "April" },
  { value: 5, label: "May" },
  { value: 6, label: "June" },
  { value: 7, label: "July" },
  { value: 8, label: "August" },
  { value: 9, label: "September" },
  { value: 10, label: "October" },
  { value: 11, label: "November" },
  { value: 12, label: "December" },
] as const;

type LauncherFormProps = {
  /** Year range surfaced in the Year dropdown. */
  years: ReadonlyArray<number>;
  /** Initial Month value (1..12). */
  defaultMonth: number;
  /** Initial Year value. */
  defaultYear: number;
  /** URL of the archive surface for the secondary action. */
  archiveHref: string;
};

export function LauncherForm({
  years,
  defaultMonth,
  defaultYear,
  archiveHref,
}: LauncherFormProps) {
  const [month, setMonth] = useState<number>(defaultMonth);
  const [year, setYear] = useState<number>(defaultYear);
  const [isPending, startTransition] = useTransition();

  function handleGenerate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // Server action: find-or-create the DRAFT MonthlyPackage row
    // for (clubId, year, month), then redirect to the report page
    // for review. Idempotent — re-opening the same period reuses
    // the existing row instead of creating duplicates.
    const fd = new FormData();
    fd.set("year", String(year));
    fd.set("month", String(month));
    startTransition(async () => {
      await generateDraftMonthlyPackageAction(fd);
    });
  }

  const monthLabel = MONTHS.find((m) => m.value === month)?.label ?? "May";

  return (
    <form
      onSubmit={handleGenerate}
      className="mt-6 space-y-6"
      data-testid="launcher-form"
    >
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <div>
          <label
            htmlFor="launcher-month"
            className="block text-xs uppercase tracking-wide text-stone-500"
          >
            Month
          </label>
          <select
            id="launcher-month"
            name="month"
            value={month}
            onChange={(e) => setMonth(Number(e.target.value))}
            className="input mt-1.5 w-full text-sm"
            data-testid="launcher-month-select"
          >
            {MONTHS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label
            htmlFor="launcher-year"
            className="block text-xs uppercase tracking-wide text-stone-500"
          >
            Year
          </label>
          <select
            id="launcher-year"
            name="year"
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="input mt-1.5 w-full text-sm"
            data-testid="launcher-year-select"
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div
        className="rounded-md border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-stone-700"
        data-testid="launcher-period-preview"
      >
        Generating the package for{" "}
        <span className="font-medium text-club-ink">
          {monthLabel} {year}
        </span>{" "}
        will open the reporting document for the period ending the last day of
        that month.
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={isPending}
          data-testid="launcher-generate"
        >
          {isPending ? "Opening…" : "Generate Monthly Package"}
        </button>
        <Link
          href={archiveHref}
          className="btn btn-secondary"
          data-testid="launcher-view-archive"
        >
          View Archive
        </Link>
      </div>
    </form>
  );
}
