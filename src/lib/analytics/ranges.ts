// Resolve a preset name to a (current, prior) date-range pair so the
// analytics dashboard can do period-over-period comparisons without
// the caller doing date math.
//
// All windows are half-open: `from <= x < to`. `now` is injectable so
// tests can pin the clock.

import type { RangePreset } from "@/components/analytics/RangeSelector";

export type Range = { from: Date; to: Date };

export function resolveRange(preset: RangePreset, now: Date = new Date()): { current: Range; prior: Range; label: string } {
  switch (preset) {
    case "TODAY": {
      const startOfToday = startOfDay(now);
      const endOfToday = addDays(startOfToday, 1);
      return {
        current: { from: startOfToday, to: endOfToday },
        prior: { from: addDays(startOfToday, -1), to: startOfToday },
        label: "Today vs yesterday",
      };
    }
    case "YESTERDAY": {
      const startOfToday = startOfDay(now);
      return {
        current: { from: addDays(startOfToday, -1), to: startOfToday },
        prior: { from: addDays(startOfToday, -2), to: addDays(startOfToday, -1) },
        label: "Yesterday vs the day before",
      };
    }
    case "THIS_WEEK": {
      const wkStart = startOfWeek(now);
      return {
        current: { from: wkStart, to: addDays(wkStart, 7) },
        prior: { from: addDays(wkStart, -7), to: wkStart },
        label: "This week vs last week",
      };
    }
    case "LAST_WEEK": {
      const wkStart = startOfWeek(now);
      return {
        current: { from: addDays(wkStart, -7), to: wkStart },
        prior: { from: addDays(wkStart, -14), to: addDays(wkStart, -7) },
        label: "Last week vs the week before",
      };
    }
    case "THIS_MONTH": {
      const monthStart = startOfMonth(now);
      return {
        current: { from: monthStart, to: nextMonth(monthStart) },
        prior: { from: prevMonth(monthStart), to: monthStart },
        label: "This month vs last month",
      };
    }
    case "LAST_MONTH": {
      const monthStart = startOfMonth(now);
      return {
        current: { from: prevMonth(monthStart), to: monthStart },
        prior: { from: prevMonth(prevMonth(monthStart)), to: prevMonth(monthStart) },
        label: "Last month vs the month before",
      };
    }
    case "THIS_YEAR": {
      const yearStart = new Date(now.getFullYear(), 0, 1);
      return {
        current: { from: yearStart, to: new Date(now.getFullYear() + 1, 0, 1) },
        prior: { from: new Date(now.getFullYear() - 1, 0, 1), to: yearStart },
        label: "This year vs last year",
      };
    }
    case "LAST_YEAR": {
      const yearStart = new Date(now.getFullYear() - 1, 0, 1);
      return {
        current: { from: yearStart, to: new Date(now.getFullYear(), 0, 1) },
        prior: { from: new Date(now.getFullYear() - 2, 0, 1), to: yearStart },
        label: "Last year vs the year before",
      };
    }
    case "LAST_60_DAYS": {
      const startOfToday = startOfDay(now);
      const sixtyAgo = addDays(startOfToday, -60);
      return {
        current: { from: sixtyAgo, to: startOfToday },
        prior: { from: addDays(sixtyAgo, -60), to: sixtyAgo },
        label: "Last 60 days vs the prior 60",
      };
    }
  }
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function startOfWeek(d: Date): Date {
  // Monday-start week.
  const s = startOfDay(d);
  const day = s.getDay(); // 0=Sun..6=Sat
  const back = (day + 6) % 7;
  return addDays(s, -back);
}
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function prevMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() - 1, 1);
}
function nextMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 1);
}
