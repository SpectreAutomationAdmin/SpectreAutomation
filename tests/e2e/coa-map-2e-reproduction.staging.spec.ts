// COA-MAP-2E (2026-10-07) — reproduction probe for the ACTUAL
// founder-reported defect.
//
// COA-MAP-2D measured the default (expanded) state and declared
// gap=0.  The founder's screenshot shows the regression when ALL
// top-level sections are COLLAPSED.  Reproduce that state here
// and dump the full parent-chain layout so we can find the real
// cause before writing any CSS.

import { test, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

runAt("COA-MAP-2E · reproduce COLLAPSED-state layout defect", async ({ browser }) => {
  test.setTimeout(180_000);
  // Match the founder's apparent viewport class (screenshot ~1650x930).
  const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
  const page: Page = await loginAsFounder(ctx);

  await page.goto(`${BASE}/app/admin/coa`, { waitUntil: "domcontentloaded" });
  await page.locator(".spectre-dw-table-wrap").waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForTimeout(1200);

  // Snapshot the DOM structure around every type-header to find the
  // collapse toggle.
  const typeHeaders = await page.evaluate(() => {
    const out: Array<{ testid: string; outerHtml: string }> = [];
    document.querySelectorAll('[data-testid^="coa-type-"]').forEach((el) => {
      const he = el as HTMLElement;
      out.push({
        testid: he.getAttribute("data-testid") ?? "",
        outerHtml: he.outerHTML.slice(0, 500),
      });
    });
    return out;
  });
  console.log("TYPE_HEADER_SAMPLE " + JSON.stringify(typeHeaders.slice(0, 1), null, 2));

  // Capture the expanded state first.
  await page.screenshot({ path: "test-results/coa-map-2e-01-expanded-before-collapse.png" }).catch(() => undefined);
  const expandedProbe = await layoutProbe(page);
  console.log("COA_MAP_2E_LAYOUT_EXPANDED " + JSON.stringify(expandedProbe));

  // Collapse ALL top-level type sections.  The type header is a
  // <tr> inside a <tbody data-group="TYPE"> with the group label and
  // chevron.  Click each type header's collapse control (the whole
  // `.spectre-dw-group-header` row is clickable).
  const types = ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"];
  for (const t of types) {
    const row = page.locator(`[data-testid="coa-type-${t}"] .spectre-dw-group-header`).first();
    const exists = (await row.count()) > 0;
    if (exists) {
      await row.scrollIntoViewIfNeeded();
      await row.click({ timeout: 5_000 }).catch((e) => console.log("CLICK_FAILED " + t + " " + String(e).slice(0, 120)));
      await page.waitForTimeout(150);
    } else {
      console.log("NO_TYPE_ROW " + t);
    }
  }
  await page.waitForTimeout(800);
  await page.screenshot({ path: "test-results/coa-map-2e-02-collapsed-after-click.png" }).catch(() => undefined);

  const collapsedProbe = await layoutProbe(page);
  console.log("COA_MAP_2E_LAYOUT_COLLAPSED " + JSON.stringify(collapsedProbe));

  // Deep ancestor-chain inspection of the table-wrap -> table -> thead
  // so we can tell exactly which parent is bottom-aligning the content.
  const ancestorChain = await page.evaluate(() => {
    const describe = (el: Element | null) => {
      if (!el) return null;
      const he = el as HTMLElement;
      const r = he.getBoundingClientRect();
      const cs = getComputedStyle(he);
      return {
        tag: he.tagName,
        cls: he.className?.toString()?.slice(0, 160) ?? "",
        y: Math.round(r.top),
        bottom: Math.round(r.bottom),
        height: Math.round(r.height),
        display: cs.display,
        flex: cs.flex,
        flexDirection: cs.flexDirection,
        justifyContent: cs.justifyContent,
        alignContent: cs.alignContent,
        alignItems: cs.alignItems,
        placeContent: cs.placeContent,
        gridTemplateRows: cs.gridTemplateRows,
        gridAutoRows: cs.gridAutoRows,
        marginTop: cs.marginTop,
        minHeight: cs.minHeight,
        overflow: cs.overflow,
      };
    };
    const chain: ReturnType<typeof describe>[] = [];
    let node: Element | null = document.querySelector(".spectre-dw-table");
    while (node) {
      chain.push(describe(node));
      node = node.parentElement;
    }
    return chain;
  });
  console.log("ANCESTOR_CHAIN " + JSON.stringify(ancestorChain, null, 2));

  await ctx.close();
});

async function layoutProbe(page: Page) {
  return page.evaluate(() => {
    const yOf = (sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
    };
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      toolbar: yOf(".spectre-dw-toolbar"),
      thead: yOf(".spectre-dw-table thead tr"),
      firstGroupHeader: yOf(".spectre-dw-table .spectre-dw-group-header"),
      tableWrap: yOf(".spectre-dw-table-wrap"),
      table: yOf(".spectre-dw-table"),
      tableWrapScroll: ((): { scrollTop: number; scrollHeight: number; clientHeight: number } | null => {
        const w = document.querySelector(".spectre-dw-table-wrap") as HTMLElement | null;
        if (!w) return null;
        return { scrollTop: w.scrollTop, scrollHeight: w.scrollHeight, clientHeight: w.clientHeight };
      })(),
    };
  });
}
