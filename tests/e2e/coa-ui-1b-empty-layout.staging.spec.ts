// COA-UI-1b (2026-09-29) — authenticated Playwright verification of
// the empty Chart-of-Accounts layout on staging.
//
// Section 9 of the founder's directive: rendered visual verification
// is required, not source/CSS reasoning. The spec:
//   1. Logs in as the staging founder account.
//   2. Navigates to /app/admin/coa (Coulee — Account = 0).
//   3. At 1440×900 and 1920×1080:
//      - Screenshots the viewport.
//      - Measures the distance between the toolbar bottom and the
//        body top.
//      - Asserts the gap is ≤ 4px (visually attached).
//      - Asserts the empty-state h3 is visible within the first
//        ~120px of the body (i.e. rendered near the top, not
//        pushed downward).

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;

const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1920x1080", width: 1920, height: 1080 },
] as const;

for (const vp of VIEWPORTS) {
  runAt(
    `COA-UI-1b · /app/admin/coa (Coulee empty) — body attaches to filter ribbon @ ${vp.name}`,
    async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
      });
      const page = await loginAsFounder(context, { landing: "/app/admin/coa" });

      // Wait for the workspace root to render.
      const root = page.locator(".spectre-dw-root");
      await expect(root).toBeVisible();

      // COA-UI-1b — the root should carry data-mode="empty" for Coulee.
      await expect(root).toHaveAttribute("data-mode", "empty");

      const toolbar = page.locator(".spectre-dw-toolbar");
      const body = page.locator(".spectre-dw-body");
      const emptyH3 = page.locator(".spectre-dw-empty h3").first();
      const inspectorHead = page.locator(".spectre-dw-inspector-eyebrow").first();

      await expect(toolbar).toBeVisible();
      await expect(body).toBeVisible();
      await expect(emptyH3).toBeVisible();

      const toolbarBox = await toolbar.boundingBox();
      const bodyBox = await body.boundingBox();
      const emptyBox = await emptyH3.boundingBox();
      const inspectorBox = await inspectorHead.boundingBox();

      if (!toolbarBox || !bodyBox || !emptyBox || !inspectorBox) {
        throw new Error("Failed to measure toolbar / body / empty-state / inspector bounding boxes.");
      }

      const toolbarBottom = toolbarBox.y + toolbarBox.height;
      const gapBetweenToolbarAndBody = bodyBox.y - toolbarBottom;
      const emptyTopFromBody = emptyBox.y - bodyBox.y;
      const inspectorTopFromBody = inspectorBox.y - bodyBox.y;

      // Screenshot to test-results so failure runs surface visual evidence.
      await page.screenshot({
        path: `test-results/coa-ui-1b-${vp.name}.png`,
        fullPage: false,
      });

      // Report the measurements so a passing run still yields evidence.
      // eslint-disable-next-line no-console
      console.log(`\n== COA-UI-1b · ${vp.name} measurements ==`);
      // eslint-disable-next-line no-console
      console.log(`  toolbar bottom Y:           ${toolbarBottom.toFixed(1)} px`);
      // eslint-disable-next-line no-console
      console.log(`  body top Y:                 ${bodyBox.y.toFixed(1)} px`);
      // eslint-disable-next-line no-console
      console.log(`  gap toolbar→body:           ${gapBetweenToolbarAndBody.toFixed(1)} px  (target ≤ 4 px)`);
      // eslint-disable-next-line no-console
      console.log(`  empty h3 top relative body: ${emptyTopFromBody.toFixed(1)} px  (target ≤ 96 px = 48px pad + ~48px)`);
      // eslint-disable-next-line no-console
      console.log(`  inspector eyebrow relative body: ${inspectorTopFromBody.toFixed(1)} px  (target ≤ 96 px)`);

      // Section 3 — the body's top border must be attached to the
      // ribbon's bottom border with essentially no gap. Allow a
      // 4px tolerance for sub-pixel rendering.
      expect(gapBetweenToolbarAndBody).toBeLessThanOrEqual(4);

      // Section 3 — the empty-state text lives within the body's
      // normal internal padding (~48px). Allow up to 96px to cover
      // the padding + any small margin, but reject anything that
      // suggests the body was pushed hundreds of pixels down.
      expect(emptyTopFromBody).toBeLessThanOrEqual(96);
      expect(inspectorTopFromBody).toBeLessThanOrEqual(96);

      // Section 4 — both columns must begin at the same vertical
      // position within the body.
      expect(Math.abs(emptyBox.y - inspectorBox.y)).toBeLessThanOrEqual(80);

      await context.close();
    },
  );
}
