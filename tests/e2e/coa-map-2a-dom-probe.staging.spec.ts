// COA-MAP-2A (2026-10-06) — DOM probe to find the real scroll owner.
//
// Purpose: diagnose the founder's reported auto-scroll failure. We
// visit the Mapping Studio on staging and ask the browser directly:
//   - which element owns vertical scrolling?
//   - how far can we scroll?
//   - which ancestor of the hierarchy has overflow:auto|scroll?
//   - does calling window.scrollBy actually move anything?

import { test, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

runAt("COA-MAP-2A · DOM probe · find real scroll owner", async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page: Page = await loginAsFounder(ctx);

  // Entry 1: /app/admin/coa — founder's actual starting point.
  await page.goto(`${BASE}/app/admin/coa`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);

  const coaProbe = await page.evaluate(() => {
    const scrolling = document.scrollingElement as HTMLElement | null;
    const main = document.querySelector("main") as HTMLElement | null;
    const body = document.body as HTMLElement;
    const html = document.documentElement as HTMLElement;

    const describe = (el: HTMLElement | null) => el ? ({
      tag: el.tagName,
      cls: el.className?.toString()?.slice(0, 160) ?? "",
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      canScroll: el.scrollHeight > el.clientHeight,
      overflow: getComputedStyle(el).overflow,
      overflowY: getComputedStyle(el).overflowY,
    }) : null;

    // Walk every descendant and find elements with overflow:auto|scroll
    // that have actual scrollable content.
    const scrollables: Array<{ tag: string; cls: string; scrollHeight: number; clientHeight: number }> = [];
    document.querySelectorAll("*").forEach((el) => {
      const he = el as HTMLElement;
      const oy = getComputedStyle(he).overflowY;
      if ((oy === "auto" || oy === "scroll") && he.scrollHeight > he.clientHeight + 10) {
        scrollables.push({
          tag: he.tagName,
          cls: he.className?.toString()?.slice(0, 160) ?? "",
          scrollHeight: he.scrollHeight,
          clientHeight: he.clientHeight,
        });
      }
    });

    return {
      innerHeight: window.innerHeight,
      scrollY: window.scrollY,
      scrollingElement: describe(scrolling),
      html: describe(html),
      body: describe(body),
      main: describe(main),
      scrollables: scrollables.slice(0, 8),
    };
  });
  console.log("COA_PROBE " + JSON.stringify(coaProbe, null, 2));

  // Try scrolling + measure.
  const coaScrollTest = await page.evaluate(() => {
    const before = window.scrollY;
    const seBefore = (document.scrollingElement as HTMLElement | null)?.scrollTop ?? -1;
    window.scrollBy({ top: 300, left: 0, behavior: "auto" });
    const after = window.scrollY;
    const seAfter = (document.scrollingElement as HTMLElement | null)?.scrollTop ?? -1;
    return { before, after, seBefore, seAfter, moved: after - before, seMoved: seAfter - seBefore };
  });
  console.log("COA_SCROLL_TEST " + JSON.stringify(coaScrollTest));

  // Entry 2: /app/admin/coa-mapping — my implementation.
  await page.goto(`${BASE}/app/admin/coa-mapping`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="coa-mapping-header"]').waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForTimeout(1000);

  const mapProbe = await page.evaluate(() => {
    const scrolling = document.scrollingElement as HTMLElement | null;
    const main = document.querySelector("main") as HTMLElement | null;
    const hierarchy = document.querySelector('[data-testid^="coa-mapping-section-"]') as HTMLElement | null;

    const describe = (el: HTMLElement | null) => el ? ({
      tag: el.tagName,
      cls: el.className?.toString()?.slice(0, 160) ?? "",
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      canScroll: el.scrollHeight > el.clientHeight,
      overflowY: getComputedStyle(el).overflowY,
    }) : null;

    // Walk ancestors of the hierarchy and find the first one that
    // actually scrolls.
    const scrollableAncestors: Array<{ tag: string; cls: string; overflowY: string; scrollHeight: number; clientHeight: number }> = [];
    let node: HTMLElement | null = hierarchy;
    while (node) {
      const oy = getComputedStyle(node).overflowY;
      if ((oy === "auto" || oy === "scroll") && node.scrollHeight > node.clientHeight + 10) {
        scrollableAncestors.push({
          tag: node.tagName,
          cls: node.className?.toString()?.slice(0, 160) ?? "",
          overflowY: oy,
          scrollHeight: node.scrollHeight,
          clientHeight: node.clientHeight,
        });
      }
      node = node.parentElement;
    }

    const scrollables: Array<{ tag: string; cls: string; scrollHeight: number; clientHeight: number }> = [];
    document.querySelectorAll("*").forEach((el) => {
      const he = el as HTMLElement;
      const oy = getComputedStyle(he).overflowY;
      if ((oy === "auto" || oy === "scroll") && he.scrollHeight > he.clientHeight + 10) {
        scrollables.push({
          tag: he.tagName,
          cls: he.className?.toString()?.slice(0, 160) ?? "",
          scrollHeight: he.scrollHeight,
          clientHeight: he.clientHeight,
        });
      }
    });

    return {
      innerHeight: window.innerHeight,
      scrollY: window.scrollY,
      scrollingElement: describe(scrolling),
      main: describe(main),
      hierarchy: describe(hierarchy),
      scrollableAncestors,
      scrollables: scrollables.slice(0, 8),
    };
  });
  console.log("MAP_PROBE " + JSON.stringify(mapProbe, null, 2));

  const mapScrollTest = await page.evaluate(() => {
    const before = window.scrollY;
    const seBefore = (document.scrollingElement as HTMLElement | null)?.scrollTop ?? -1;
    window.scrollBy({ top: 300, left: 0, behavior: "auto" });
    const after = window.scrollY;
    const seAfter = (document.scrollingElement as HTMLElement | null)?.scrollTop ?? -1;
    return { before, after, seBefore, seAfter, moved: after - before, seMoved: seAfter - seBefore };
  });
  console.log("MAP_SCROLL_TEST " + JSON.stringify(mapScrollTest));

  await ctx.close();
});
