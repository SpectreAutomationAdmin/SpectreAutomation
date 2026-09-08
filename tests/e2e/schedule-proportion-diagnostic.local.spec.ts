// PROPORTION DIAGNOSTIC — at both 1440x900 and 1920x1080, measures
// vertical landmarks (topbar bottom, breadcrumb, title, toolbar,
// calendar, KPI row, Recent Shifts, bottom gutter) and computes
// each section's height as a percentage of the usable main-area
// height. Used to verify the responsive design actually SCALES
// rather than preserving fixed 1440 heights.

import { test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/schedule-responsive");
fs.mkdirSync(OUT, { recursive: true });
const LOCAL = process.env.PREVIEW_URL ?? "http://localhost:3000/preview/schedule-desktop";

async function measure(page: import("@playwright/test").Page, viewportH: number) {
  return await page.evaluate((vh) => {
    function box(sel: string) {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
    }
    const topbar = box('[data-testid="portal-header"]');
    const breadcrumb = box('[data-testid="portal-schedule-populated"] header p');
    const title = box('[data-testid="portal-schedule-populated"] header h1');
    const toolbar = box('[data-testid="portal-schedule-populated"] .flex.flex-col.md\\:flex-row');
    const cal = box('[data-testid="portal-schedule-week-grid"]');
    const kpi = box('[data-testid="portal-schedule-populated"] .grid.grid-cols-1.md\\:grid-cols-3');
    const recent = box('[data-testid="portal-schedule-recent"]');
    const usableTop = topbar ? topbar.bottom : 0;
    const usableHeight = vh - usableTop;
    const contentBottom = recent ? recent.bottom : (kpi ? kpi.bottom : 0);
    const bottomGutter = vh - contentBottom;
    function pct(h: number | undefined) {
      if (!h || !usableHeight) return "-";
      return ((h / usableHeight) * 100).toFixed(1) + "%";
    }
    return {
      viewportHeight: vh,
      topbarBottom: usableTop,
      usableHeight,
      breadcrumb, title, toolbar, calendar: cal, kpiRow: kpi, recentShifts: recent,
      contentBottom, bottomGutter,
      percentOfUsable: {
        calendar: pct(cal?.height),
        kpiRow: pct(kpi?.height),
        recentShifts: pct(recent?.height),
        bottomGutter: pct(bottomGutter),
      },
    };
  }, viewportH);
}

test("proportion diagnostic at 1440 and 1920", async ({ browser }) => {
  test.setTimeout(120_000);
  const captures: Record<string, unknown> = {};

  for (const vp of [{ w: 1440, h: 900 }, { w: 1920, h: 1080 }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
    const page = await ctx.newPage();
    await page.goto(LOCAL, { waitUntil: "networkidle" });
    await page.getByTestId("portal-schedule-week-grid").first().waitFor({ state: "visible" });
    await page.waitForTimeout(300);
    const m = await measure(page, vp.h);
    captures[`${vp.w}x${vp.h}`] = m;
    await page.screenshot({
      path: path.join(OUT, `schedule-local-${vp.w}x${vp.h}.png`),
      fullPage: false,
    });
    await ctx.close();
  }

  fs.writeFileSync(path.join(OUT, "proportion-diagnostic.json"), JSON.stringify(captures, null, 2));
  console.log(JSON.stringify(captures, null, 2));
});
