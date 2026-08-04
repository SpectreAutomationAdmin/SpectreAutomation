// Sprint 3 · Checkpoint 16G Stage A (2026-08-04) — overnight
// preparation summary.
//
// Independent of arrivedToday. Answers: "what did Spectre actually
// process while the operator wasn't looking?"
//
// Window: previous local day 19:00 → current local day 07:00, in the
// club's IANA timezone. DST-safe. If the user reaches Mission
// Control DURING the overnight window itself (before 07:00), the
// window is the prior night's 19:00 → the user's current now.
//
// The count reflects REAL automation events during the window, not
// currently-open items. Never implies overnight activity where none
// occurred.

import { toLocalDateString, zonedTimeToUtc } from "./arrival";

export interface OvernightPreparationSummary {
  windowStart: Date;
  windowEnd: Date;
  itemsAnalysed: number;
  itemsCompletedAutomatically: number;
  itemsReadyForApproval: number;
  itemsNeedingJudgment: number;
  /** Human copy — the sentence to render, computed here so the UI
   *  doesn't reconstruct English from raw counts and risk drift. */
  sentence: string;
}

/**
 * Compute the [windowStart, windowEnd] UTC pair for the overnight
 * preparation summary, given "now" and the club timezone.
 *
 * Rule:
 *   - If now < 07:00 local → window = [previous day 19:00, now].
 *   - Else (now >= 07:00 local) → window = [previous day 19:00,
 *     current day 07:00].
 */
export function overnightWindow(now: Date, clubTimezone: string): { start: Date; end: Date } {
  const tz = clubTimezone ?? "UTC";
  const nowLocalDate = toLocalDateString(now, tz);
  // Determine "current local hour" via wall-clock formatting.
  const hourStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hour: "2-digit", hour12: false,
  }).format(now);
  const currentLocalHour = Number(hourStr);
  const isBeforeMorning = currentLocalHour < 7;

  // Previous day's date.
  const prevLocalDate = prevLocalDateString(nowLocalDate, tz, now);
  const start = zonedTimeToUtc(`${prevLocalDate}T19:00:00`, tz);
  const end = isBeforeMorning ? now : zonedTimeToUtc(`${nowLocalDate}T07:00:00`, tz);
  return { start, end };
}

/**
 * Compose the summary sentence honestly from the raw counts.
 * Rules:
 *   - Zero analysed → "No new work was prepared overnight."
 *   - Non-zero → "Spectre prepared N items overnight — X ready for approval."
 *   - Never invent activity if counts are zero.
 */
export function composeOvernightSentence(input: {
  itemsAnalysed: number;
  itemsCompletedAutomatically: number;
  itemsReadyForApproval: number;
  itemsNeedingJudgment: number;
}): string {
  const { itemsAnalysed, itemsCompletedAutomatically, itemsReadyForApproval, itemsNeedingJudgment } = input;
  if (itemsAnalysed === 0) return "No new work was prepared overnight.";

  const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? "" : "s"}`;
  const clauses: string[] = [];
  if (itemsCompletedAutomatically > 0) clauses.push(`${itemsCompletedAutomatically} handled automatically`);
  if (itemsReadyForApproval > 0) clauses.push(`${plural(itemsReadyForApproval, "ready for approval")}`);
  if (itemsNeedingJudgment > 0) {
    // "1 needs judgment" / "2 need judgment"
    const verb = itemsNeedingJudgment === 1 ? "needs" : "need";
    clauses.push(`${itemsNeedingJudgment} ${verb} judgment`);
  }

  const tail = clauses.length > 0 ? ` — ${clauses.join(", ")}.` : ".";
  return `Spectre prepared ${plural(itemsAnalysed, "item")} overnight${tail}`;
}

/**
 * Return YYYY-MM-DD for the local day immediately before the given
 * local date, in the given timezone. Handles DST-transition days
 * correctly by computing via UTC arithmetic then re-projecting.
 */
function prevLocalDateString(currentLocalDate: string, timezone: string, referenceNow: Date): string {
  // Anchor: noon local on currentLocalDate — safely away from DST
  // transitions (which occur at 02:00 or 03:00 local).
  const anchor = zonedTimeToUtc(`${currentLocalDate}T12:00:00`, timezone);
  const yesterday = new Date(anchor.getTime() - 24 * 60 * 60 * 1000);
  return toLocalDateString(yesterday, timezone);
}
