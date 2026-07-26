import { test } from "@playwright/test";

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

test("club-title descender/cap collision diagnostic at 1920x1080", async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);

  const data = await page.getByTestId("monthly-cover-club-name").evaluate((el) => {
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();

    // Use Canvas TextMetrics to get exact font metrics.
    const c = document.createElement("canvas");
    const ctx = c.getContext("2d")!;
    ctx.font = `${cs.fontSize} ${cs.fontFamily}`;
    // Measure metrics for "g" and "C" separately.
    const gMetrics = ctx.measureText("g");
    const cMetrics = ctx.measureText("C");

    return {
      computedFontSize: cs.fontSize,
      computedLineHeight: cs.lineHeight,
      computedFontFamily: cs.fontFamily,
      computedLetterSpacing: cs.letterSpacing,
      rectHeight: rect.height,
      gDescent: (gMetrics as any).actualBoundingBoxDescent,
      gAscent: (gMetrics as any).actualBoundingBoxAscent,
      cAscent: (cMetrics as any).actualBoundingBoxAscent,
      cDescent: (cMetrics as any).actualBoundingBoxDescent,
    };
  });

  // eslint-disable-next-line no-console
  console.log("[club-title]", JSON.stringify(data, null, 2));

  // Numerical calculation: gap between g descender and next line C cap.
  const fs = parseFloat(data.computedFontSize);
  const lh = parseFloat(data.computedLineHeight);
  const gDesc = data.gDescent;
  const cAsc = data.cAscent;
  // distance from g baseline to NEXT line's baseline = lh
  // g descender extends `gDesc` below g baseline
  // C glyph ascender extends `cAsc` above C baseline (= next line baseline)
  // gap = lh - gDesc - cAsc
  const gap = lh - gDesc - cAsc;
  // eslint-disable-next-line no-console
  console.log(`[club-title] computed gap between g descender and C cap = ${gap.toFixed(2)} px (fs=${fs}, lh=${lh}, gDesc=${gDesc.toFixed(1)}, cAsc=${cAsc.toFixed(1)})`);
});
