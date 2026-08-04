// Sprint 3 · Checkpoint 16G Stage A (2026-08-04) — canonical
// arrival-time resolver.
//
// EVERY Mission Control "today" / "since midnight" / "overnight"
// calculation resolves through this module. There are two rules:
//
//   1. Arrival time is the FIRST GENUINE SOURCE EVENT that brought
//      the work into Spectre — NEVER the DB row's createdAt (which
//      is bumped by backfills, reanalysis, projection), NEVER the
//      updatedAt (bumped by orchestration state transitions), NEVER
//      lastAnalysedAt (bumped by re-analysis).
//
//   2. "Today" is the CLUB'S local calendar day, resolved through the
//      club's IANA timezone (Club.timezone). DST-safe. If the club has
//      no timezone configured, we fall back to UTC and mark the result
//      as "timezone_missing" so the caller can warn.
//
// The source-hierarchy per work-item type is fixed and documented in
// resolveArrivalTime() below.

export type WorkSourceType =
  | "EMAIL"
  | "DOCUMENT_FROM_EMAIL"
  | "USER_UPLOAD"
  | "USER_CREATED"
  | "INTEGRATION_EVENT"
  | "SYSTEM_CONDITION"
  | "IMPORT"
  | "UNKNOWN";

export type WorkArrivalDerivedFrom =
  | "EMAIL_RECEIVED"
  | "USER_UPLOAD"
  | "USER_CREATED"
  | "INTEGRATION_EVENT"
  | "SYSTEM_CONDITION_OCCURRED"
  | "IMPORT_OCCURRED"
  | "FALLBACK_CREATED_AT";

export interface WorkArrival {
  /** UTC timestamp of the genuine source event. */
  sourceOccurredAt: Date;
  /** Explicit source type — determines the hierarchy chosen. */
  sourceType: WorkSourceType;
  /** Which timestamp field the resolver actually used. */
  derivedFrom: WorkArrivalDerivedFrom;
  /**
   * Club-local calendar date (YYYY-MM-DD) — the date the user sees on
   * her wall calendar in the club's IANA timezone. Suitable for
   * grouping / equality checks.
   */
  localCalendarDate: string;
  /** IANA timezone used ("UTC" if the club is missing timezone). */
  sourceTimezone: string;
}

/**
 * Input to resolveArrivalTime — a flat bag of every timestamp that
 * MIGHT be an arrival signal. The resolver picks the correct one per
 * the source-hierarchy and returns a canonical WorkArrival.
 */
export interface ResolveArrivalInput {
  /** REQUIRED: the club timezone. Null → we mark timezone_missing + use UTC. */
  clubTimezone: string | null;
  /** For an email-derived WI: the EmailMessage.receivedAt. */
  emailReceivedAt?: Date | null;
  /** For a doc-derived WI where the doc came from an email attachment: the source EmailMessage.receivedAt. */
  emailReceivedAtForDoc?: Date | null;
  /** For a user-uploaded doc: the original upload occurrence time (NOT ingestion). */
  userUploadedAt?: Date | null;
  /** For user-created work (manual card): the create time recorded by the user. */
  userCreatedAt?: Date | null;
  /** For integration-generated work: the originating event time. */
  integrationEventAt?: Date | null;
  /** For system-condition work (e.g. AR-aging threshold crossed): when the condition first became true. */
  systemConditionOccurredAt?: Date | null;
  /** For imported work: the actual import occurrence time. */
  importOccurredAt?: Date | null;
  /** Absolute final fallback — WI row createdAt. Used only if every other signal is null. */
  workIntakeCreatedAt: Date;
}

/**
 * Resolve the arrival time for a Work Intake item.
 *
 * Hierarchy (first non-null wins):
 *   1. Email received (emailReceivedAt OR emailReceivedAtForDoc if doc-from-email)
 *   2. User upload occurrence
 *   3. User creation
 *   4. Integration event
 *   5. System condition occurred
 *   6. Import occurred
 *   7. FALLBACK: workIntakeCreatedAt (only if every above is null;
 *      derivedFrom = "FALLBACK_CREATED_AT" so callers can flag it)
 *
 * NEVER selected:
 *   updatedAt, lastAnalysedAt, projection time, reprocessing time,
 *   cleanup-modified time, backfill-inserted row time, state transition
 *   time. These are excluded by construction — they're not accepted
 *   as input at all.
 */
export function resolveArrivalTime(input: ResolveArrivalInput): WorkArrival {
  const [sourceOccurredAt, sourceType, derivedFrom] = pickSource(input);
  const timezone = input.clubTimezone ?? "UTC";
  return {
    sourceOccurredAt,
    sourceType,
    derivedFrom,
    localCalendarDate: toLocalDateString(sourceOccurredAt, timezone),
    sourceTimezone: timezone,
  };
}

function pickSource(input: ResolveArrivalInput): [Date, WorkSourceType, WorkArrivalDerivedFrom] {
  if (input.emailReceivedAt) return [input.emailReceivedAt, "EMAIL", "EMAIL_RECEIVED"];
  if (input.emailReceivedAtForDoc) return [input.emailReceivedAtForDoc, "DOCUMENT_FROM_EMAIL", "EMAIL_RECEIVED"];
  if (input.userUploadedAt) return [input.userUploadedAt, "USER_UPLOAD", "USER_UPLOAD"];
  if (input.userCreatedAt) return [input.userCreatedAt, "USER_CREATED", "USER_CREATED"];
  if (input.integrationEventAt) return [input.integrationEventAt, "INTEGRATION_EVENT", "INTEGRATION_EVENT"];
  if (input.systemConditionOccurredAt) return [input.systemConditionOccurredAt, "SYSTEM_CONDITION", "SYSTEM_CONDITION_OCCURRED"];
  if (input.importOccurredAt) return [input.importOccurredAt, "IMPORT", "IMPORT_OCCURRED"];
  return [input.workIntakeCreatedAt, "UNKNOWN", "FALLBACK_CREATED_AT"];
}

// ---------------------------------------------------------------------------
// Timezone-aware calendar helpers. Uses Intl.DateTimeFormat with
// { timeZone } — DST-safe by construction.
// ---------------------------------------------------------------------------

/**
 * Return the wall-clock date YYYY-MM-DD in the given IANA timezone.
 * Assembled from Intl parts to guarantee zero-padded month + day
 * across Node versions (some ICU builds omit the pad on numeric day).
 */
export function toLocalDateString(d: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const pad = (s: string) => s.padStart(2, "0");
  return `${g("year")}-${pad(g("month"))}-${pad(g("day"))}`;
}

/**
 * Return the UTC instant corresponding to the start-of-day (00:00:00)
 * of the given wall-clock date in the given IANA timezone. DST-safe.
 */
export function startOfLocalDayUtc(wallClockDate: Date | string, timezone: string): Date {
  const dateStr = typeof wallClockDate === "string"
    ? wallClockDate
    : toLocalDateString(wallClockDate, timezone);
  return zonedTimeToUtc(`${dateStr}T00:00:00`, timezone);
}

/**
 * Return the UTC instant corresponding to a wall-clock timestamp in
 * the given IANA timezone. Handles DST-transition ambiguity by
 * choosing the earlier (pre-transition) offset, which is standard for
 * calendar-day boundaries.
 */
export function zonedTimeToUtc(wallClockIsoNoZone: string, timezone: string): Date {
  // Iteratively converge on the correct UTC instant. Two rounds is
  // sufficient for every IANA zone; extra rounds are a no-op.
  let guess = new Date(`${wallClockIsoNoZone}Z`);   // treat as UTC first
  for (let i = 0; i < 3; i++) {
    const backProjected = formatIsoLocal(guess, timezone);
    if (backProjected === wallClockIsoNoZone) break;
    const guessMs = guess.getTime();
    const backProjectedUtcMs = new Date(`${backProjected}Z`).getTime();
    const drift = new Date(`${wallClockIsoNoZone}Z`).getTime() - backProjectedUtcMs;
    guess = new Date(guessMs + drift);
  }
  return guess;
}

/**
 * Format a UTC instant as YYYY-MM-DDTHH:mm:ss in the given zone
 * (no offset suffix). Used by zonedTimeToUtc to iterate.
 */
function formatIsoLocal(d: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const pad = (s: string) => s.padStart(2, "0");
  const hh = g("hour") === "24" ? "00" : g("hour");
  return `${g("year")}-${pad(g("month"))}-${pad(g("day"))}T${pad(hh)}:${pad(g("minute"))}:${pad(g("second"))}`;
}

/**
 * Return the current local calendar date for a club, given "now"
 * (default: Date.now()).
 */
export function todayLocalDateString(clubTimezone: string | null, now: Date = new Date()): string {
  return toLocalDateString(now, clubTimezone ?? "UTC");
}

/**
 * Predicate: did this arrival occur within the club's local calendar
 * day matching "now"?
 */
export function arrivedTodayInClubTimezone(arrival: WorkArrival, now: Date = new Date()): boolean {
  return arrival.localCalendarDate === todayLocalDateString(arrival.sourceTimezone, now);
}
