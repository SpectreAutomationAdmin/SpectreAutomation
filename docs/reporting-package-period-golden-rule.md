# Reporting Package Period Golden Rule

This document codifies a permanent architecture rule for the Monthly
Reporting Package (`/app/admin/reporting/monthly`) and every future
reporting surface in Spectre.

It exists because the same regression class has now appeared more
than once: a new reporting section is added with period labels
(month names, quarter strings, "year to date", current-month column
headers, chart x-axis captions) hardcoded directly inside the
section's seed data or React component — and the next time the
package's selected reporting period changes, the section silently
displays the wrong date.

## Golden Rule

> **Every section in the Monthly Reporting Package must be active
> and responsive to the single selected reporting period.**
>
> No section may hardcode `Q1`, `March`, `March 31`, `quarter-to-date`,
> `year-to-date`, `January 1 — March 31`, `Mar Budget`, or any other
> calendar / period descriptor unless that string is derived from
> the canonical `ReportingPeriod` object.

This rule applies to:

- Section headers + eyebrows
- Italic-serif subtitles and period meta lines
- Table column labels (current-month, current-quarter, YTD)
- Chart titles, x-axis labels, legends, trend windows
- Inline commentary numerals that quote a date range
- Footnotes + footer statement-number lines
- Reactive commentary block eyebrows (e.g. "CFO Commentary — May 2026")
- Export / PDF / print metadata
- Any string visible to the chair, finance committee, or board

It does **not** apply to:

- Real accounting / GL row labels that name a department or KPI
  (e.g. "Course & Grounds Maintenance" — that's a stable category
  name, not a period descriptor)
- Type or interface field names (e.g. `currentBudget` on the row
  shape — that field name is internal, the rendered label is not)
- Seeded demo / fixture **values** (e.g. "$253,460" YTD NOI actual)
  — values are honest numerics; labels are the concern

## Canonical Period Source

There is **one** canonical period source in the package:
`src/lib/reporting/reporting-period.ts`.

```ts
export type ReportingPeriod = {
  periodStart: Date;
  periodEnd: Date;
  year: number;
  month: number;             // 1-12
  monthShort: string;        // "May"
  monthLong: string;         // "May"
  periodLabel: string;       // "May 2026"
  periodEndedLabel: string;  // "For the period ended May 31, 2026"
  periodEndISO: string;      // "2026-05-31"
  statementHeaderLabel: string;
  // "May 2026 · For the period ended May 31, 2026 · Year to Date"
  columnLabels: {
    category: string;        // "Category"
    currentBudget: string;   // "May Budget"
    currentActual: string;   // "May Actual"
    currentVariance: string; // "May Var"
    ytdBudget: string;       // "YTD Budget"
    ytdActual: string;       // "YTD Actual"
    ytdVariance: string;     // "YTD Var"
    variancePct: string;     // "% Var"
  };
};

export function buildReportingPeriod(periodEnd: Date, opts?: {
  periodStart?: Date;
}): ReportingPeriod;
```

The Monthly Reporting Package builder (`getMonthlyReportingPackage`
in `src/lib/reporting/monthly-package.ts`) constructs **one** of
these per package build, immediately after `periodEnd` is resolved,
and threads it into every section's data builder.

```ts
const periodEnd = opts?.period?.end ?? new Date(Date.UTC(2026, 4, 31));
const reportingPeriod = buildReportingPeriod(periodEnd, { periodStart });

// ... downstream:
statementOfActivitiesV2: buildSilverSpringsStatementOfActivities({
  clubName: club.name,
  period: reportingPeriod, // <-- canonical, single-source
}),
```

## What This Rule Looks Like in Practice

### Section data builder (service layer)

✅ **Right** — accept the `ReportingPeriod` and read pre-formatted
fields:

```ts
export function buildSilverSpringsStatementOfActivities(opts: {
  clubName: string;
  period: ReportingPeriod;
}): StatementOfActivitiesV2 {
  // ...
  return {
    periodLabel: opts.period.statementHeaderLabel,
    columnHeaders: opts.period.columnLabels,
    cfoCommentary: buildCfoCommentary({
      // ...
      periodLabel: opts.period.periodLabel,
    }),
    // ...
  };
}
```

❌ **Wrong** — hardcode the period inside the builder:

```ts
return {
  periodLabel: "Q1 2026 · January 1 — March 31, 2026 · Year to Date",
  columnHeaders: {
    currentBudget: "Mar Budget",
    currentActual: "Mar Actual",
    currentVariance: "Mar Var",
    // ...
  },
};
```

### React component (page surface)

✅ **Right** — render the pre-formatted strings off the package
field:

```tsx
<p data-testid="soa-period">{soa.periodLabel}</p>
<span>{soa.columnHeaders.currentBudget}</span>
```

❌ **Wrong** — call `Date` APIs or format a string in JSX:

```tsx
<p>{`Q1 ${new Date().getFullYear()} · January 1 — March 31`}</p>
<span>Mar Budget</span>
```

### Charts

✅ **Right** — the chart's x-axis labels come from a service-
computed series whose labels were derived from
`reportingPeriod.month` / `reportingPeriod.year`:

```ts
xLabels: priorYearMonths.map((m) => m.shortLabel), // "Jan" … "May"
```

❌ **Wrong** — hardcode chart x-axis labels:

```tsx
xLabels={["Jan", "Feb", "Mar", "Apr", "May", "Jun", ...]}
```

## Enforcement

Two mechanisms keep this rule from regressing:

### 1. Forbidden-string lint guard

`tests/reporting-period-golden-rule.test.ts` scans every file under:

- `src/lib/reporting`
- `src/app/app/admin/reporting`
- `src/components/reporting`

for a forbidden-string list:

- `Q1 2026`, `Q2 2026`, `Q3 2026`, `Q4 2026`
- `Mar Budget`, `Mar Actual`, `Mar Var`
- `January 1 — March 31`
- `March 31, 2026`

If any match is found outside the explicit allowlist (the canonical
period source, the guard test itself, the period-regression unit
test, and the docs), the test fails with a pointer to this rule.

When a new period regression class is found in the wild (e.g. a
"Sep YTD" string appears somewhere it shouldn't), add it to the
`FORBIDDEN` list in the guard test.

### 2. Period-regression unit tests

Every section data builder MUST be unit-tested for period
sensitivity:

```ts
it("REGRESSION: section updates dynamically when the reporting period changes", () => {
  const MAR_2026 = buildReportingPeriod(new Date(Date.UTC(2026, 2, 31)));
  const soa = buildSilverSpringsStatementOfActivities({ clubName: "Demo", period: MAR_2026 });
  expect(soa.periodLabel).toBe("March 2026 · For the period ended March 31, 2026 · Year to Date");
  expect(soa.columnHeaders.currentBudget).toBe("Mar Budget");
  // ...
});
```

Adding a new section without a period-regression test is a CLAUDE.md
operating-rules violation.

## Adding a New Section to the Reporting Package

When you add a new reporting section, you MUST:

1. **Receive `period: ReportingPeriod` as an argument** on the
   section's data builder. Threading it through the package builder
   is not optional.
2. **Render only pre-formatted strings** off the period object. No
   `toLocaleString`, no template literals over `Date`, no embedded
   month names in JSX.
3. **Add a period-regression test** that flips `periodEnd` to a
   different month and asserts every period-derived label flips
   with it.
4. **Add any new forbidden strings** to the guard test's
   `FORBIDDEN` list if your section introduces a new format that
   shouldn't appear hardcoded elsewhere.

## Related Docs

- [docs/equity-value-over-time-card-spec.md](equity-value-over-time-card-spec.md) — the LOCKED Equity card. Its
  x-axis was already period-derived from `getEquityHistory`'s
  `asOf` argument; this rule simply names the pattern explicitly.
- CLAUDE.md → "Reporting Period Golden Rule — Mandatory" — the
  same rule restated as an operating-rules section so it triggers
  during routine reporting work.

## Change Log

- 2026-06-14 — Created after the Statement of Activities chapter IV
  shipped with `Q1 2026 · January 1 — March 31, 2026 · Year to Date`
  hardcoded into the seed builder. Canonical period source
  (`src/lib/reporting/reporting-period.ts`) introduced; Statement
  of Activities refactored to consume it; forbidden-string lint
  guard added to prevent the same class of regression.
