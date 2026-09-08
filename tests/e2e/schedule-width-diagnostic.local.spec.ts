// WIDTH DIAGNOSTIC — walks the full ancestor chain of the Schedule
// content and reports width, max-width, computed styles at both
// 1440x900 and 1920x1080. Purpose: find the exact element causing
// the schedule workspace to stop growing.

import { test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/schedule-responsive");
fs.mkdirSync(OUT, { recursive: true });
const LOCAL = process.env.PREVIEW_URL ?? "http://localhost:3000/preview/schedule-desktop";

async function walkChain(page: import("@playwright/test").Page, viewport: string) {
  return await page.evaluate((vp) => {
    function pluck(el: Element) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        testid: (el as HTMLElement).dataset?.testid ?? null,
        classes: (el.className && typeof el.className === "string"
          ? el.className : (el as HTMLElement).getAttribute("class") ?? "").slice(0, 200),
        x: Math.round(r.left),
        right: Math.round(r.right),
        width: Math.round(r.width),
        maxWidth: cs.maxWidth,
        display: cs.display,
        flexGrow: cs.flexGrow,
        flexShrink: cs.flexShrink,
        gridTemplateColumns: cs.gridTemplateColumns,
        marginLeft: cs.marginLeft,
        marginRight: cs.marginRight,
        paddingLeft: cs.paddingLeft,
        paddingRight: cs.paddingRight,
      };
    }
    const results: any = { viewport: vp, viewportWidth: window.innerWidth, chain: [] };
    // Anchor at week grid, walk up to <html>.
    const weekGrid = document.querySelector('[data-testid="portal-schedule-week-grid"]');
    if (!weekGrid) { results.error = "week grid not found"; return results; }
    let el: Element | null = weekGrid;
    while (el && el.tagName.toLowerCase() !== "html") {
      results.chain.push(pluck(el));
      el = el.parentElement;
    }
    return results;
  }, viewport);
}

test.use({ viewport: { width: 1440, height: 900 } });

test("diagnose width chain at 1440 and 1920", async ({ browser }) => {
  test.setTimeout(120_000);
  const captures: Record<string, unknown> = {};

  for (const vp of [{ w: 1440, h: 900 }, { w: 1920, h: 1080 }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
    const page = await ctx.newPage();
    await page.goto(LOCAL, { waitUntil: "networkidle" });
    await page.getByTestId("portal-schedule-week-grid").first().waitFor({ state: "visible" });
    await page.waitForTimeout(300);
    const chain = await walkChain(page, `${vp.w}x${vp.h}`);
    captures[`${vp.w}x${vp.h}`] = chain;
    await page.screenshot({
      path: path.join(OUT, `schedule-local-${vp.w}x${vp.h}.png`),
      fullPage: false,
    });
    await ctx.close();
  }

  const outFile = path.join(OUT, "width-diagnostic.json");
  fs.writeFileSync(outFile, JSON.stringify(captures, null, 2));
  console.log(JSON.stringify(captures, null, 2));
});
