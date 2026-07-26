import { describe, it, expect } from "vitest";
import { timeOfDayGreeting } from "@/lib/greeting";

// Build a Date whose LOCAL hour is exactly `h`. Avoids cross-timezone
// surprises in CI: the helper reads `Date.getHours()`, which is local time.
function localHour(h: number, minute = 0): Date {
  const d = new Date();
  d.setHours(h, minute, 0, 0);
  return d;
}

describe("timeOfDayGreeting", () => {
  it("returns 'Good morning' between 5am and 11:59am", () => {
    expect(timeOfDayGreeting(localHour(5))).toBe("Good morning");
    expect(timeOfDayGreeting(localHour(8, 30))).toBe("Good morning");
    expect(timeOfDayGreeting(localHour(11, 59))).toBe("Good morning");
  });

  it("returns 'Good afternoon' between noon and 4:59pm", () => {
    expect(timeOfDayGreeting(localHour(12))).toBe("Good afternoon");
    expect(timeOfDayGreeting(localHour(15))).toBe("Good afternoon");
    expect(timeOfDayGreeting(localHour(16, 59))).toBe("Good afternoon");
  });

  it("returns 'Good evening' from 5pm onward", () => {
    expect(timeOfDayGreeting(localHour(17))).toBe("Good evening");
    expect(timeOfDayGreeting(localHour(20))).toBe("Good evening");
    expect(timeOfDayGreeting(localHour(23, 59))).toBe("Good evening");
  });

  it("folds overnight hours (midnight–4:59am) into 'Good evening'", () => {
    expect(timeOfDayGreeting(localHour(0))).toBe("Good evening");
    expect(timeOfDayGreeting(localHour(3, 15))).toBe("Good evening");
    expect(timeOfDayGreeting(localHour(4, 59))).toBe("Good evening");
  });

  it("default argument uses the current time without throwing", () => {
    // We don't assert a specific bucket — just that it returns one of the
    // three valid strings.
    const g = timeOfDayGreeting();
    expect(["Good morning", "Good afternoon", "Good evening"]).toContain(g);
  });
});
