// COA-MAP-2D (2026-10-06) — DOM probe to diagnose the regressed
// Account List layout the founder reported after COA-MAP-2C.
//
// Reported symptom: on /app/admin/coa the table/column header
// appears pushed to the bottom of the viewport with a large blank
// region between the toolbar and the header.  Measure the exact
// Y positions of every element in the vertical layout chain so we
// know what to fix.

import { test, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

runAt("COA-MAP-2D · probe · Account List vertical layout chain", async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page: Page = await loginAsFounder(ctx);

  await page.goto(`${BASE}/app/admin/coa`, { waitUntil: "domcontentloaded" });
  await page.locator(".spectre-dw-table-wrap").waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForTimeout(1200);

  const probe = await page.evaluate(() => {
    const describe = (el: Element | null) => {
      if (!el) return null;
      const he = el as HTMLElement;
      const r = he.getBoundingClientRect();
      const cs = getComputedStyle(he);
      return {
        selector: he.tagName + (he.className ? "." + String(he.className).split(/\s+/).slice(0, 3).join(".") : ""),
        y: Math.round(r.top),
        bottom: Math.round(r.bottom),
        height: Math.round(r.height),
        display: cs.display,
        flex: cs.flex,
        flexDirection: cs.flexDirection,
        justifyContent: cs.justifyContent,
        alignItems: cs.alignItems,
        alignContent: cs.alignContent,
        overflow: cs.overflow,
        overflowY: cs.overflowY,
        position: cs.position,
        padding: cs.padding,
        marginTop: cs.marginTop,
        marginBottom: cs.marginBottom,
      };
    };

    // Target elements in the vertical chain.
    const root = document.querySelector(".spectre-dw-root");
    const body = document.querySelector(".spectre-dw-body");
    const main = document.querySelector(".spectre-dw-main");
    const header = document.querySelector(".spectre-dw-header");
    const toolbar = document.querySelector(".spectre-dw-toolbar");
    const tableWrap = document.querySelector(".spectre-dw-table-wrap");
    const table = document.querySelector(".spectre-dw-table");
    const thead = document.querySelector(".spectre-dw-table thead");
    const firstTheadTr = document.querySelector(".spectre-dw-table thead tr");
    const firstTbodyGroupHeader = document.querySelector(".spectre-dw-table .spectre-dw-group-header");
    const firstTbody = document.querySelector(".spectre-dw-table tbody");

    // Also probe table-wrap children.
    const tableWrapChildren: ReturnType<typeof describe>[] = [];
    if (tableWrap) {
      for (const child of Array.from(tableWrap.children)) {
        tableWrapChildren.push(describe(child));
      }
    }

    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      root: describe(root),
      body: describe(body),
      main: describe(main),
      header: describe(header),
      toolbar: describe(toolbar),
      tableWrap: describe(tableWrap),
      tableWrapChildren,
      table: describe(table),
      thead: describe(thead),
      firstTheadTr: describe(firstTheadTr),
      firstTbodyGroupHeader: describe(firstTbodyGroupHeader),
      firstTbody: describe(firstTbody),
    };
  });

  console.log("PROBE " + JSON.stringify(probe, null, 2));

  // Key regression gates — print the gap values plainly.
  const toolbarBottom = probe.toolbar?.bottom ?? -1;
  const theadTop = probe.firstTheadTr?.y ?? -1;
  const groupHeaderTop = probe.firstTbodyGroupHeader?.y ?? -1;
  console.log("REGRESSION_GATE toolbar.bottom=" + toolbarBottom + " thead.top=" + theadTop + " groupHeader.top=" + groupHeaderTop);
  if (toolbarBottom > 0 && theadTop > 0) {
    console.log("GAP_toolbar_to_thead=" + (theadTop - toolbarBottom));
  }
  if (theadTop > 0 && groupHeaderTop > 0) {
    console.log("GAP_thead_to_firstGroup=" + (groupHeaderTop - (probe.firstTheadTr?.bottom ?? theadTop)));
  }

  await page.screenshot({ path: "test-results/coa-map-2d-before.png" }).catch(() => undefined);
  await ctx.close();
});
