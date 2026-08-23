// HR-2C B4 (2026-08-23) — Availability shared constants + view types.
//
// Split from `availability.ts` so the client `AvailabilityWeekForm`
// can import WEEKDAYS + AvailabilityWeekView WITHOUT dragging the
// service (which pulls in prisma + audit + next/headers) into the
// client bundle. Everything in this file is data-only: no imports,
// no side effects.

export const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export type Weekday = (typeof WEEKDAYS)[number];

export interface AvailabilityWeekView {
  id: string;
  weekStart: Date;
  monday: boolean;
  tuesday: boolean;
  wednesday: boolean;
  thursday: boolean;
  friday: boolean;
  saturday: boolean;
  sunday: boolean;
  notes: string | null;
  updatedAt: Date;
}
