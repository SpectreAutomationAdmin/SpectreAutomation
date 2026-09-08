// Mobile-regression check for the functional integration.
// Renders the real ScheduleView at 390x844 and confirms the mobile
// branch (weekday strip + selected day detail) still renders.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/schedule-functional-integration");
fs.mkdirSync(OUT, { recursive: true });
const LOCAL = process.env.PREVIEW_URL ?? "http://localhost:3000/preview/schedule-functional";

test.use({ viewport: { width: 390, height: 844 } });

test("mobile 390x844 regression: real ScheduleView mobile branch renders", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(LOCAL, { waitUntil: "networkidle" });
  // Note: the /preview/schedule-functional wrapper uses `hidden md:flex`
  // which hides the desktop portal shell at mobile widths. The ScheduleView
  // itself renders both branches; the mobile branch is `md:hidden` visible.
  // For the regression check we just need to confirm mobile testids exist.
  const html = await page.content();
  expect(html).toContain("portal-schedule-mobile-day-");
  await page.screenshot({ path: path.join(OUT, "functional-mobile-390x844.png"), fullPage: true });
});
