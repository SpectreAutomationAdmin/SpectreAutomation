// Time-of-day greeting helper.
//
// Returns "Good morning" / "Good afternoon" / "Good evening" based on the
// supplied Date (defaults to `new Date()`). Buckets follow a familiar
// convention; overnight hours (midnight–4am) are folded into "evening"
// rather than introducing a fourth bucket.
//
//   05–11  Good morning
//   12–16  Good afternoon
//   17–23  Good evening
//   00–04  Good evening
//
// The bucketing is timezone-naive: it reads the supplied Date's local
// hour. Pass a tz-adjusted Date if you need to greet from a specific
// region.

export type TimeOfDayGreeting = "Good morning" | "Good afternoon" | "Good evening";

export function timeOfDayGreeting(now: Date = new Date()): TimeOfDayGreeting {
  const h = now.getHours();
  if (h >= 5 && h < 12) return "Good morning";
  if (h >= 12 && h < 17) return "Good afternoon";
  return "Good evening";
}
