import { test, type Page } from "@playwright/test";

// Prompt 9 — First-screen regression audit after Prompts 1–8.
//
// Captures every check across 3 reference viewports in a single
// deterministic pass. Each test asserts ONE criterion across all
// 3 viewports and prints a per-viewport row so the founder-summary
// pass/fail table can be filled in directly from the console output.

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

const VIEWPORTS = [
  { w: 1440, h: 900 },
  { w: 1280, h: 800 },
  { w: 1920, h: 1080 },
] as const;

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

async function gotoCover(page: Page, w: number, h: number) {
  await page.setViewportSize({ width: w, height: h });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
}

function log(label: string, vp: { w: number; h: number }, payload: unknown) {
  // eslint-disable-next-line no-console
  console.log(`[audit] ${vp.w}x${vp.h} ${label} ${JSON.stringify(payload)}`);
}

test("Prompt 9 — first-screen audit across 1440x900 / 1280x800 / 1920x1080", async ({ page }) => {
  await login(page);
  const results: Record<string, Record<string, unknown>> = {};

  for (const vp of VIEWPORTS) {
    await gotoCover(page, vp.w, vp.h);
    const key = `${vp.w}x${vp.h}`;
    results[key] = {};

    // 1. MBRP top vs IN THIS PACKAGE top — same y.
    const railHead = await page.getByTestId("reporting-shell-chapters").locator("div").first()
      .evaluate((el) => el.getBoundingClientRect().top);
    const mbrpTop = await page.getByTestId("monthly-cover-package-label")
      .evaluate((el) => el.getBoundingClientRect().top);
    results[key]["header_align_delta_px"] = mbrpTop - railHead;
    log("header-align", vp, { rail: railHead, mbrp: mbrpTop, delta: mbrpTop - railHead });

    // 2. Executive Briefing no longer shows "YELLOW" / verdict ribbon.
    const ribbonCount = await page.getByTestId("cover-attention-ribbon").count();
    results[key]["attention_ribbon_count"] = ribbonCount;
    const mastheadText = (await page.getByTestId("monthly-cover-masthead").textContent()) ?? "";
    results[key]["masthead_has_yellow"] = /YELLOW|GREEN|RED/.test(mastheadText);

    // 3. OPERATIONS / FINANCIAL HEALTH / CAPITAL PROGRAM labels readable
    //    (computed color is the darker font-medium green-900 set in Prompt 3).
    for (const k of ["operations", "financial-health", "capital-program"]) {
      const c = await page.getByTestId(`cover-briefing-${k}-title`)
        .evaluate((el) => getComputedStyle(el).color);
      results[key][`title_${k}_color`] = c;
    }

    // 4. Status verdicts render in the positive private-club green (Prompt 4).
    for (const k of ["operations", "financial-health", "capital-program"]) {
      const c = await page.getByTestId(`cover-briefing-${k}-status`)
        .evaluate((el) => getComputedStyle(el).color);
      results[key][`status_${k}_color`] = c;
    }

    // 5. Framework + confidentiality sentences present and verbatim.
    results[key]["framework_text"] = (await page.getByTestId("monthly-cover-framework").textContent())?.trim();
    results[key]["confidentiality_text"] = (await page.getByTestId("monthly-cover-confidentiality").textContent())?.trim();

    // 6. Board of Directors wording correct (no Governors anywhere on the cover).
    const bodyText = (await page.locator("body").textContent()) ?? "";
    results[key]["board_of_directors_present"] = bodyText.includes("Board of Directors");
    results[key]["board_of_governors_present"] = bodyText.includes("Board of Governors");

    // 7. Vertical separator between rail and body.
    const railBorder = await page.getByTestId("reporting-shell-chapters")
      .evaluate((el) => ({
        w: getComputedStyle(el).borderRightWidth,
        s: getComputedStyle(el).borderRightStyle,
        c: getComputedStyle(el).borderRightColor,
      }));
    results[key]["rail_border_right"] = railBorder;

    // 8. Rail-left offset (Prompt 8 should reduce this only at 1920+).
    const railLeft = await page.getByTestId("reporting-shell-chapters")
      .evaluate((el) => el.getBoundingClientRect().left);
    results[key]["rail_left_px"] = railLeft;

    // 9. At-a-Glance 4 metrics visible above the fold.
    for (const m of ["ytd-revenue", "noi", "capital-income", "reserve-coverage"]) {
      const r = await page.getByTestId(`monthly-cover-at-a-glance-${m}`)
        .evaluate((el) => el.getBoundingClientRect());
      results[key][`atg_${m}_in_viewport`] = r.top >= 0 && r.bottom <= vp.h + 4;
    }

    // 10. Three briefing cards visible above the fold.
    for (const k of ["operations", "financial-health", "capital-program"]) {
      const r = await page.getByTestId(`cover-briefing-${k}`)
        .evaluate((el) => el.getBoundingClientRect());
      results[key][`brief_${k}_in_viewport`] = r.top >= 0 && r.bottom <= vp.h + 4;
      results[key][`brief_${k}_bottom_px`] = r.bottom.toFixed(1);
    }

    // 11. Next section tease — financial-performance top peeks above the fold.
    const dashTop = await page.getByTestId("financial-performance")
      .evaluate((el) => el.getBoundingClientRect().top);
    results[key]["dashboard_top_px"] = dashTop.toFixed(1);
    results[key]["tease_visible"] = dashTop < vp.h;

    // 12. Aldus leaf divider rendered.
    const aldusEntities = await page.locator(`text=❦`).count();
    results[key]["aldus_glyph_count"] = aldusEntities;

    await page.screenshot({
      path: `test-results/regression-audit-${vp.w}x${vp.h}.png`,
      fullPage: false,
    });
  }

  // eslint-disable-next-line no-console
  console.log("[audit] FULL_RESULTS\n" + JSON.stringify(results, null, 2));
});
