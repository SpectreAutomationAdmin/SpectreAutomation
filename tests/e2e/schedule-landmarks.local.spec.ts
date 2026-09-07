// Landmark diagnostic — measures the Y position of every major
// vertical landmark in both the reference PNG (detected via row-
// scan of prominent color transitions) and the live render.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/schedule-desktop-exact");
fs.mkdirSync(OUT, { recursive: true });
const LOCAL = process.env.PREVIEW_URL ?? "http://localhost:3000/preview/schedule-desktop";

test.use({ viewport: { width: 1440, height: 900 } });

test("landmark Y positions of rendered page", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(LOCAL, { waitUntil: "networkidle" });
  await page.getByTestId("portal-schedule-week-grid").first().waitFor({ state: "visible" });
  await page.waitForTimeout(400);
  const marks = await page.evaluate(() => {
    function y(sel: string): { top: number; bottom: number; height: number } | null {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
    }
    return {
      breadcrumb: y('[data-testid="portal-schedule-populated"] header p'),
      title: y('[data-testid="portal-schedule-populated"] header h1'),
      toolbar: y('[data-testid="portal-schedule-populated"] > div:nth-child(3)'),
      weekGrid: y('[data-testid="portal-schedule-week-grid"]'),
      kpiRow: y('[data-testid="portal-schedule-populated"] .grid.grid-cols-1.md\\:grid-cols-3'),
      recent: y('[data-testid="portal-schedule-recent"]'),
    };
  });
  const outFile = path.join(OUT, "landmarks-render.json");
  fs.writeFileSync(outFile, JSON.stringify(marks, null, 2));
  console.log(JSON.stringify(marks, null, 2));
  expect(marks.weekGrid).not.toBeNull();
});
