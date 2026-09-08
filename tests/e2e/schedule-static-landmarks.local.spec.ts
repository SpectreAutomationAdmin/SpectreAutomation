// Landmark diagnostic for the isolated static prototype.

import { test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/schedule-static-shell");
fs.mkdirSync(OUT, { recursive: true });
const LOCAL = process.env.PREVIEW_URL ?? "http://localhost:3000/preview/schedule-desktop-static";

test.use({ viewport: { width: 1440, height: 900 } });

test("measure static landmarks at 1440x900", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(LOCAL, { waitUntil: "networkidle" });
  await page.getByTestId("static-schedule-shell").waitFor({ state: "visible" });
  await page.waitForTimeout(300);
  const marks = await page.evaluate(() => {
    function box(sel: string) {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        left: Math.round(r.left), right: Math.round(r.right),
        top: Math.round(r.top), bottom: Math.round(r.bottom),
        width: Math.round(r.width), height: Math.round(r.height),
      };
    }
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      shell: box('[data-testid="static-schedule-shell"]'),
      sidebar: box('[data-testid="static-schedule-shell"] aside'),
      topbar: box('[data-testid="static-schedule-shell"] header'),
      main: box('[data-testid="static-schedule-shell"] main'),
      breadcrumb: box('[data-testid="static-schedule-shell"] main > div > p:first-child'),
      title: box('[data-testid="static-schedule-shell"] main h1'),
      toolbar: box('[data-testid="static-schedule-shell"] main > div > div:nth-of-type(1)'),
      calendar: box('[data-testid="static-schedule-shell"] main > div > section:nth-of-type(1)'),
      kpiRow: box('[data-testid="static-schedule-shell"] main > div > section:nth-of-type(2)'),
      recent: box('[data-testid="static-schedule-shell"] main > div > section:nth-of-type(3)'),
    };
  });
  fs.writeFileSync(path.join(OUT, "landmarks.json"), JSON.stringify(marks, null, 2));
  console.log(JSON.stringify(marks, null, 2));
});
