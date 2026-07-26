import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "fs";

// Visual + behavioural audit for Monthly Weather Summary (chapter XI).
// Captures the panel at 1440 / 1920 / 2560 and asserts:
//   - the rail entry reads "Weather & Utilization" (concise) while
//     the on-page chapter title remains "Monthly Weather Summary"
//   - the rail order under "Operations & Analytics": Operating
//     Statistics → Departmental P&L → Weather & Utilization →
//     Operations & Analytics → ...
//   - the rail remains sticky/visible after clicking the entry
//   - period-derived copy renders May 2026 (no Q1, no March, no
//     Scottsdale, no Arizona)
//   - 4 KPI cards + the donut chart + the bar chart + 4 events
//     + 3 correlation cards all render
//   - icons are SVG components (not emoji text)
//   - KPI grid + correlation grid grow with the viewport

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

const VIEWPORTS = [
  { w: 1440, h: 900 },
  { w: 1920, h: 1080 },
  { w: 2560, h: 1440 },
];

const KPI_KEYS = ["sunny-days", "rain-days", "avg-high-temp", "avg-wind-speed"];
const CORRELATION_KEYS = ["golf-rounds", "tennis-racquet", "dining-fb"];

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 30_000 });
}

async function measurePanel(page: Page) {
  return page.evaluate((opts) => {
    function r(n: number) { return Math.round(n * 100) / 100; }
    function rect(el: Element | null) {
      if (!el) return null;
      const b = (el as HTMLElement).getBoundingClientRect();
      return { x: r(b.x), y: r(b.y), w: r(b.width), right: r(b.x + b.width) };
    }
    const panel = document.querySelector("[data-testid='weather-and-utilization']");
    if (!panel) return { error: "panel not found" } as const;
    const kpiGrid = panel.querySelector("[data-testid='mws-kpi-grid']");
    const chartsGrid = panel.querySelector("[data-testid='mws-charts-grid']");
    const corrGrid = panel.querySelector("[data-testid='mws-correlation-grid']");
    const donut = panel.querySelector("[data-testid='mws-pattern-svg']");
    const bar = panel.querySelector("[data-testid='mws-rounds-bar-chart']");

    const kpiRects = opts.kpiKeys.map((k) => rect(panel.querySelector(`[data-testid='mws-kpi-${k}']`)));
    const yBuckets: Record<number, number> = {};
    for (const k of kpiRects.filter(Boolean)) {
      const yKey = Math.round(k!.y / 10) * 10;
      yBuckets[yKey] = (yBuckets[yKey] ?? 0) + 1;
    }

    const corrRects = opts.corrKeys.map((k) => rect(panel.querySelector(`[data-testid='mws-corr-${k}']`)));
    return {
      panelWidth: rect(panel)?.w ?? null,
      kpiGridWidth: rect(kpiGrid)?.w ?? null,
      chartsGridWidth: rect(chartsGrid)?.w ?? null,
      corrGridWidth: rect(corrGrid)?.w ?? null,
      donutWidth: rect(donut)?.w ?? null,
      barWidth: rect(bar)?.w ?? null,
      kpiCardCount: kpiRects.filter(Boolean).length,
      corrCardCount: corrRects.filter(Boolean).length,
      maxKpisPerRow: Math.max(...Object.values(yBuckets)),
    };
  }, { kpiKeys: KPI_KEYS, corrKeys: CORRELATION_KEYS });
}

test("rail entry reads 'Weather & Utilization' but the section title remains 'Monthly Weather Summary'", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  const railEntry = page.getByTestId("reporting-chapter-weather-and-utilization");
  await railEntry.waitFor({ timeout: 20_000 });
  await expect(railEntry).toContainText("Weather & Utilization");
  await expect(railEntry).not.toContainText("Monthly Weather Summary");

  // Rail order: Operating Statistics → Departmental P&L → Weather
  // & Utilization → Operations & Analytics → ...
  const railIds = await page.evaluate(() => {
    const seen: string[] = [];
    document.querySelectorAll("[data-testid^='reporting-chapter-']").forEach((el) => {
      const id = el.getAttribute("data-testid")!.replace("reporting-chapter-", "");
      if (!seen.includes(id)) seen.push(id);
    });
    return seen;
  });
  const opStatIdx = railIds.indexOf("operating-statistics");
  const dplIdx = railIds.indexOf("departmental-p-and-l");
  const mwsIdx = railIds.indexOf("weather-and-utilization");
  expect(opStatIdx, "Operating Statistics in rail").toBeGreaterThan(-1);
  expect(dplIdx, "Departmental P&L is after Operating Statistics").toBeGreaterThan(opStatIdx);
  expect(mwsIdx, "Weather & Utilization is after Departmental P&L").toBeGreaterThan(dplIdx);
  // (Legacy standalone "Operations & Analytics" chapter was removed
  // 2026-06-19; the group label persists but it is no longer a
  // clickable rail entry.)

  // Click scrolls into view + rail stays visible.
  await railEntry.click();
  await page.getByTestId("weather-and-utilization").waitFor({ timeout: 20_000 });
  await expect(page.getByTestId("weather-and-utilization")).toBeInViewport();
  await expect(page.getByTestId("mws-title")).toHaveText("Monthly Weather Summary");
  await expect(railEntry).toBeInViewport();
});

test("header chrome flows from ReportingPeriod (May 2026, NO Q1 / March / Scottsdale / Arizona)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-weather-and-utilization").click();
  await page.getByTestId("weather-and-utilization").waitFor({ timeout: 20_000 });

  await expect(page.getByTestId("mws-period")).toContainText("May 2026");
  await expect(page.getByTestId("mws-statement-number")).toHaveText("Statement 11 of 14");
  await expect(page.getByTestId("mws-document-chip")).toHaveText("Weather & Utilization");
  await expect(page.getByTestId("mws-prepared-for")).toHaveText("Operations & GM Level");

  const panel = page.getByTestId("weather-and-utilization");
  await expect(panel).not.toContainText("Scottsdale");
  await expect(panel).not.toContainText("Arizona");
  await expect(panel).not.toContainText("Hypothetical Illustration");
  await expect(panel).toContainText("NW Calgary, Alberta");
});

test("Silver Springs (Calgary, Alberta) renders Avg High Temp in °C — NOT °F", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-weather-and-utilization").click();
  await page.getByTestId("weather-and-utilization").waitFor({ timeout: 20_000 });
  const tempValue = page.getByTestId("mws-kpi-avg-high-temp-value");
  await expect(tempValue).toContainText("°C");
  await expect(tempValue).not.toContainText("°F");
});

test("Notable weather events table — Event pill column does not overlap the Description column", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-weather-and-utilization").click();
  await page.getByTestId("weather-and-utilization").waitFor({ timeout: 20_000 });
  await page.getByTestId("mws-events-table").scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);

  // Pick the prime-conditions row (the widest pill text in the seed)
  // and the heavy-rain row's description (one of the longer
  // descriptions). For each event row, the pill's right edge must
  // sit to the LEFT of the description's left edge.
  for (const key of ["cold-frost-early", "heavy-rain-mid", "prime-stretch-late", "high-wind-end"]) {
    const overlap = await page.evaluate((k) => {
      const row = document.querySelector(`[data-testid='mws-event-row-${k}']`) as HTMLElement | null;
      if (!row) return null;
      const pill = row.querySelector(`[data-testid='mws-event-row-${k}-pill']`) as HTMLElement | null;
      if (!pill) return null;
      // Grid template tracks ordered: date, event-pill, description, …
      const cells = Array.from(row.children) as HTMLElement[];
      // Description cell is the 3rd grid child (index 2 in the row's
      // direct children, since date / event / description appear in
      // source order).
      const descriptionCell = cells[2];
      const pillRect = pill.getBoundingClientRect();
      const descRect  = descriptionCell.getBoundingClientRect();
      return {
        pillRight: pillRect.right,
        descLeft:  descRect.left,
        gap:       descRect.left - pillRect.right,
      };
    }, key);
    expect(overlap, `event row "${key}" must measure`).not.toBeNull();
    if (!overlap) continue;
    expect(
      overlap.gap,
      `event "${key}" pill right (${overlap.pillRight}) must sit to the LEFT of description left (${overlap.descLeft}); gap was ${overlap.gap}`,
    ).toBeGreaterThan(0);
  }

  await page.screenshot({ path: "test-results/weather-events-table-1440.png", fullPage: false });
});

test("4 KPI cards render with one uniform white/cream treatment (Sunny Days is the standard)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-weather-and-utilization").click();
  await page.getByTestId("weather-and-utilization").waitFor({ timeout: 20_000 });

  // The icon, value, and label DOM colours must be identical across
  // every KPI card. Sunny Days is the reference; the other three are
  // compared against it.
  const reference = "sunny-days";
  const ref = await page.evaluate((key) => {
    const icon  = document.querySelector(`[data-testid='mws-kpi-${key}'] svg`)  as SVGElement | null;
    const value = document.querySelector(`[data-testid='mws-kpi-${key}-value']`) as HTMLElement | null;
    const label = document.querySelector(`[data-testid='mws-kpi-${key}-label']`) as HTMLElement | null;
    return {
      iconColor:  icon  ? getComputedStyle(icon).color  : null,
      valueColor: value ? getComputedStyle(value).color : null,
      labelColor: label ? getComputedStyle(label).color : null,
      iconBox:    icon  ? icon.getBoundingClientRect().width  : null,
      valueFontSize: value ? getComputedStyle(value).fontSize : null,
      labelFontSize: label ? getComputedStyle(label).fontSize : null,
    };
  }, reference);
  // Sanity — the reference values resolved.
  expect(ref.iconColor).toBeTruthy();
  expect(ref.valueColor).toBeTruthy();
  expect(ref.labelColor).toBeTruthy();

  for (const key of ["rain-days", "avg-high-temp", "avg-wind-speed"]) {
    const other = await page.evaluate((k) => {
      const icon  = document.querySelector(`[data-testid='mws-kpi-${k}'] svg`)  as SVGElement | null;
      const value = document.querySelector(`[data-testid='mws-kpi-${k}-value']`) as HTMLElement | null;
      const label = document.querySelector(`[data-testid='mws-kpi-${k}-label']`) as HTMLElement | null;
      return {
        iconColor:  icon  ? getComputedStyle(icon).color  : null,
        valueColor: value ? getComputedStyle(value).color : null,
        labelColor: label ? getComputedStyle(label).color : null,
        iconBox:    icon  ? icon.getBoundingClientRect().width  : null,
        valueFontSize: value ? getComputedStyle(value).fontSize : null,
        labelFontSize: label ? getComputedStyle(label).fontSize : null,
      };
    }, key);
    expect(other.iconColor,  `${key} icon color must match Sunny Days`).toBe(ref.iconColor);
    expect(other.valueColor, `${key} value color must match Sunny Days`).toBe(ref.valueColor);
    expect(other.labelColor, `${key} label color must match Sunny Days`).toBe(ref.labelColor);
    expect(other.iconBox,    `${key} icon size must match Sunny Days`).toBe(ref.iconBox);
    expect(other.valueFontSize, `${key} value font-size must match Sunny Days`).toBe(ref.valueFontSize);
    expect(other.labelFontSize, `${key} label font-size must match Sunny Days`).toBe(ref.labelFontSize);
  }

  // Capture the rest-state KPI strip for the founder review.
  await page.getByTestId("mws-kpi-grid").scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  await page.screenshot({ path: "test-results/weather-kpi-rest-1440.png", fullPage: false });
});

test("donut resting ring thickness matches the Financial Performance donut (radius 80, stroke 36)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-weather-and-utilization").click();
  await page.getByTestId("weather-and-utilization").waitFor({ timeout: 20_000 });
  await page.getByTestId("mws-charts-grid").scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);

  // Every resting donut slice circle uses r=80 + stroke-width=36 (the
  // Financial Performance section donut's geometry, now enforced by
  // the shared `EditorialDonut` primitive via DONUT_GEOMETRY).
  for (const slice of ["sunny-clear", "partly-cloudy", "rain-storms", "high-wind"]) {
    const c = page.getByTestId(`mws-pattern-slice-${slice}`);
    await expect(c).toHaveAttribute("r", "80");
    await expect(c).toHaveAttribute("stroke-width", "36");
  }
  await page.screenshot({ path: "test-results/weather-donut-rest-1440.png", fullPage: false });
});

test("4 KPI cards render with their premium SVG icons (NOT emoji)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-weather-and-utilization").click();
  await page.getByTestId("weather-and-utilization").waitFor({ timeout: 20_000 });

  for (const key of KPI_KEYS) {
    await expect(
      page.getByTestId(`mws-kpi-${key}`),
      `KPI card "${key}" must render`,
    ).toBeVisible();
  }
  // Premium SVG icons — these locators all resolve to real <svg>
  // elements, not emoji text. Strict-mode safety: pick the first
  // match inside the chapter section.
  for (const icon of ["sun", "rain-cloud", "thermometer", "wind"]) {
    const svg = page.locator(`[data-testid='weather-and-utilization'] [data-testid='weather-icon-${icon}']`).first();
    await expect(svg).toBeVisible();
    await expect(svg).toHaveAttribute("aria-hidden", "true");
    // Tag name must be SVG.
    const tag = await svg.evaluate((el) => el.tagName.toLowerCase());
    expect(tag, `icon "${icon}" must be an inline <svg>`).toBe("svg");
  }
});

test("weather-pattern donut + rounds bar chart render as SVG", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-weather-and-utilization").click();
  await page.getByTestId("weather-and-utilization").waitFor({ timeout: 20_000 });

  await expect(page.getByTestId("mws-pattern-card")).toBeVisible();
  await expect(page.getByTestId("mws-pattern-svg")).toBeVisible();
  // Four donut slices.
  for (const slice of ["sunny-clear", "partly-cloudy", "rain-storms", "high-wind"]) {
    await expect(page.getByTestId(`mws-pattern-slice-${slice}`)).toBeAttached();
  }
  // Pattern subtitle quotes the period + location.
  await expect(page.getByTestId("mws-pattern-card-subtitle")).toContainText("May 2026 · NW Calgary, Alberta");

  await expect(page.getByTestId("mws-rounds-card")).toBeVisible();
  await expect(page.getByTestId("mws-rounds-svg")).toBeVisible();
  for (const bar of ["sunny-clear", "partly-cloudy", "high-wind", "rain-storm"]) {
    await expect(page.getByTestId(`mws-rounds-bar-${bar}`)).toBeAttached();
  }
  await expect(page.getByTestId("mws-rounds-card-commentary")).toContainText("Sunny Calgary days");
});

test("notable weather events table renders 4 rows with tone-classified impact cells", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-weather-and-utilization").click();
  await page.getByTestId("weather-and-utilization").waitFor({ timeout: 20_000 });

  for (const key of [
    "cold-frost-early",
    "heavy-rain-mid",
    "prime-stretch-late",
    "high-wind-end",
  ]) {
    await expect(page.getByTestId(`mws-event-row-${key}`)).toBeVisible();
  }

  // Heavy rain: golf = risk, F&B = favorable.
  await expect(page.getByTestId("mws-event-row-heavy-rain-mid-golf")).toHaveAttribute("data-tone", "risk");
  await expect(page.getByTestId("mws-event-row-heavy-rain-mid-fb")).toHaveAttribute("data-tone", "favorable");
  // Prime stretch: both favorable.
  await expect(page.getByTestId("mws-event-row-prime-stretch-late-golf")).toHaveAttribute("data-tone", "favorable");
  await expect(page.getByTestId("mws-event-row-prime-stretch-late-fb")).toHaveAttribute("data-tone", "favorable");

  // Pills carry the documented tones.
  await expect(page.getByTestId("mws-event-row-heavy-rain-mid-pill")).toHaveAttribute("data-tone", "heavy-rain");
  await expect(page.getByTestId("mws-event-row-prime-stretch-late-pill")).toHaveAttribute("data-tone", "prime-conditions");
});

test("3 correlation cards render with their accent palette", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-weather-and-utilization").click();
  await page.getByTestId("weather-and-utilization").waitFor({ timeout: 20_000 });
  // Wait for the correlation grid to hydrate — batched test runs can
  // race the panel render before this assertion lands.
  await page.getByTestId("mws-corr-golf-rounds").waitFor({ timeout: 20_000 });

  await expect(page.getByTestId("mws-corr-golf-rounds")).toHaveAttribute("data-accent", "green");
  await expect(page.getByTestId("mws-corr-tennis-racquet")).toHaveAttribute("data-accent", "slate");
  await expect(page.getByTestId("mws-corr-dining-fb")).toHaveAttribute("data-accent", "rust");
  // Each correlation card renders the documented SVG icon (golf flag,
  // tennis racquet, dining utensils) — first match inside each card.
  for (const [card, icon] of [
    ["golf-rounds", "golf-flag"],
    ["tennis-racquet", "tennis"],
    ["dining-fb", "dining"],
  ] as const) {
    const svg = page.locator(`[data-testid='mws-corr-${card}'] [data-testid='weather-icon-${icon}']`).first();
    await expect(svg).toBeVisible();
  }
});

test("Monthly Weather Summary — multi-viewport: KPI grid 4-across at lg + panel grows + charts/correlation cards fill row width", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-weather-and-utilization").click();
  await page.getByTestId("weather-and-utilization").waitFor({ timeout: 20_000 });
  await page.locator("[data-testid='weather-and-utilization']").scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);

  const report: any[] = [];
  for (const v of VIEWPORTS) {
    await page.setViewportSize({ width: v.w, height: v.h });
    await page.waitForTimeout(300);
    await page.locator("[data-testid='weather-and-utilization']").scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const m = await measurePanel(page);
    report.push({ viewport: `${v.w}x${v.h}`, ...m });
    await page.screenshot({
      path: `test-results/weather-and-utilization-${v.w}.png`,
      fullPage: false,
    });
  }

  writeFileSync(
    "test-results/weather-and-utilization-multi-viewport.json",
    JSON.stringify(report, null, 2),
    "utf8",
  );

  const by = (w: number) => report.find((r) => (r.viewport as string).startsWith(`${w}x`));
  const r1440 = by(1440), r1920 = by(1920), r2560 = by(2560);
  expect.soft(r1440 && r1920 && r2560, "all three viewports captured").toBeTruthy();

  if (r1440 && r1920 && r2560) {
    for (const r of [r1440, r1920, r2560]) {
      expect.soft(r.kpiCardCount, `4 KPI cards at ${r.viewport}`).toBe(4);
      expect.soft(r.corrCardCount, `3 correlation cards at ${r.viewport}`).toBe(3);
      // 4-up KPI row at desktop sizes (lg = 1024+).
      expect.soft(r.maxKpisPerRow, `KPI grid is 4-across at ${r.viewport}`).toBe(4);
    }
    expect.soft(
      r1920.panelWidth,
      "panel widens 1440 → 1920 (no fixed-width cap)",
    ).toBeGreaterThan(r1440.panelWidth);
    expect.soft(
      r2560.panelWidth,
      "panel does not shrink 1920 → 2560 (shell cap reached, panel still fills it)",
    ).toBeGreaterThanOrEqual(r1920.panelWidth);
  }
});

// =============================================================================
// Interactive hover behavior — donut + bar chart
// =============================================================================

// Snapshot the static card chrome at rest so we can assert it never
// changes during hover. The card's outerHTML up to (but excluding)
// the chart SVG is the "container" we expect to stay identical
// before / during / after hover.
async function captureCardChromeClasses(page: Page, cardTestId: string) {
  return page.evaluate((id) => {
    const card = document.querySelector(`[data-testid='${id}']`) as HTMLElement | null;
    return {
      className: card?.className ?? "",
      style: card?.getAttribute("style") ?? "",
    };
  }, cardTestId);
}

test("hovering the donut slice highlights ONLY that slice (no card-level lift / outline)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-weather-and-utilization").click();
  await page.getByTestId("weather-and-utilization").waitFor({ timeout: 20_000 });
  await page.getByTestId("mws-pattern-card").waitFor({ timeout: 20_000 });

  // Card chrome must NOT carry a hover-driven attribute or class.
  const patternCard = page.getByTestId("mws-pattern-card");
  await expect(patternCard).not.toHaveAttribute("data-hovered", "true");
  await expect(patternCard).not.toHaveAttribute("data-hovered", "false");
  const restChrome = await captureCardChromeClasses(page, "mws-pattern-card");
  // The card class string must not advertise the rejected lift/outline
  // treatment from the previous implementation.
  expect(restChrome.className).not.toMatch(/-translate-y-0\.5/);
  expect(restChrome.className).not.toMatch(/border-2/);
  expect(restChrome.className).not.toMatch(/border-club-green-700\/70/);
  expect(restChrome.className).not.toMatch(/shadow-lg/);

  // All donut slices start as data-active="false".
  for (const slice of ["sunny-clear", "partly-cloudy", "rain-storms", "high-wind"]) {
    await expect(page.getByTestId(`mws-pattern-slice-${slice}`)).toHaveAttribute("data-active", "false");
  }
  await expect(page.getByTestId("mws-pattern-tooltip")).toHaveCount(0);

  // Scroll the charts into the viewport so the screenshot captures
  // the per-datum hover state instead of the (still-visible) chapter
  // header above.
  await page.getByTestId("mws-charts-grid").scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);

  // Dispatch hover events programmatically (donut slices are
  // concentric <circle>s with stroke-only paint — Playwright's
  // centred hover misses the painted region).
  await page.locator("[data-testid='mws-pattern-slice-sunny-clear']").evaluate((el) => {
    const rect = (el as SVGElement).getBoundingClientRect();
    const clientX = rect.left + rect.width / 2 + 70;
    const clientY = rect.top + rect.height / 2;
    el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, clientX, clientY }));
    el.dispatchEvent(new MouseEvent("mousemove",  { bubbles: true, clientX, clientY }));
  });
  await page.getByTestId("mws-pattern-tooltip").waitFor({ timeout: 5_000 });

  // ONLY the hovered slice carries data-active="true". The other
  // slices remain inactive.
  await expect(page.getByTestId("mws-pattern-slice-sunny-clear")).toHaveAttribute("data-active", "true");
  for (const slice of ["partly-cloudy", "rain-storms", "high-wind"]) {
    await expect(page.getByTestId(`mws-pattern-slice-${slice}`)).toHaveAttribute("data-active", "false");
  }
  // Active slice carries the thicker stroke + drop-shadow filter.
  // Resting stroke width matches the Financial Performance donut
  // (36); active stroke bumps to 44 for the per-datum emphasis.
  await expect(page.getByTestId("mws-pattern-slice-sunny-clear")).toHaveAttribute("stroke-width", "44");
  await expect(page.getByTestId("mws-pattern-slice-sunny-clear")).toHaveAttribute("filter", "url(#spectre-chart-active-shadow)");
  await expect(page.getByTestId("mws-pattern-slice-partly-cloudy")).toHaveAttribute("stroke-width", "36");
  await expect(page.getByTestId("mws-pattern-slice-partly-cloudy")).not.toHaveAttribute("filter", /.+/);

  // CARD CHROME — unchanged during hover.
  await expect(patternCard).not.toHaveAttribute("data-hovered", "true");
  const hoveredChrome = await captureCardChromeClasses(page, "mws-pattern-card");
  expect(hoveredChrome.className, "card class string must not change on hover").toBe(restChrome.className);
  expect(hoveredChrome.style, "card style must not change on hover").toBe(restChrome.style);
  // The OTHER card chrome is also untouched.
  await expect(page.getByTestId("mws-rounds-card")).not.toHaveAttribute("data-hovered", "true");

  // Tooltip body — condition + days + percentage.
  await expect(page.getByTestId("mws-pattern-tooltip-label")).toHaveText("Sunny / Clear");
  await expect(page.getByTestId("mws-pattern-tooltip-row-days")).toContainText("17 days");
  await expect(page.getByTestId("mws-pattern-tooltip-row-percent")).toContainText("% of period");

  await page.screenshot({ path: "test-results/weather-pattern-hover-1440.png", fullPage: false });

  // Mouse-leave clears the tooltip + the active slice. The card
  // class is still unchanged.
  await page.locator("[data-testid='mws-pattern-svg']").evaluate((el) => {
    const body = document.body;
    el.dispatchEvent(new MouseEvent("mouseout",   { bubbles: true, relatedTarget: body }));
    el.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false, relatedTarget: body }));
  });
  await page.waitForTimeout(300);
  await expect(page.getByTestId("mws-pattern-tooltip")).toHaveCount(0);
  await expect(page.getByTestId("mws-pattern-slice-sunny-clear")).toHaveAttribute("data-active", "false");
  const finalChrome = await captureCardChromeClasses(page, "mws-pattern-card");
  expect(finalChrome.className).toBe(restChrome.className);
});

test("hovering a bar highlights ONLY that bar (no card-level lift / outline)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-weather-and-utilization").click();
  await page.getByTestId("weather-and-utilization").waitFor({ timeout: 20_000 });
  await page.getByTestId("mws-rounds-card").waitFor({ timeout: 20_000 });

  // Card chrome must not carry hover state at rest.
  const roundsCard = page.getByTestId("mws-rounds-card");
  await expect(roundsCard).not.toHaveAttribute("data-hovered", "true");
  await expect(roundsCard).not.toHaveAttribute("data-hovered", "false");
  const restChrome = await captureCardChromeClasses(page, "mws-rounds-card");
  expect(restChrome.className).not.toMatch(/-translate-y-0\.5/);
  expect(restChrome.className).not.toMatch(/border-2/);
  expect(restChrome.className).not.toMatch(/border-club-green-700\/70/);
  expect(restChrome.className).not.toMatch(/shadow-lg/);

  // Scroll the charts into view for the screenshot.
  await page.getByTestId("mws-charts-grid").scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);

  // All bars start as data-active="false".
  for (const bar of ["sunny-clear", "partly-cloudy", "high-wind", "rain-storm"]) {
    await expect(page.locator(`[data-testid='mws-rounds-bar-${bar}'] rect`)).toHaveAttribute("data-active", "false");
  }
  // Bar chart has its OWN tooltip (the rounds testidPrefix).
  await expect(page.getByTestId("mws-rounds-tooltip")).toHaveCount(0);

  // Hover the sunny/clear bar (highest).
  await page.locator("[data-testid='mws-rounds-bar-sunny-clear'] rect").hover();
  await page.getByTestId("mws-rounds-tooltip").waitFor({ timeout: 5_000 });

  // Capture the bar's exact y + height at rest BEFORE the hover so we
  // can prove the hover does not translate, scale, or otherwise alter
  // its geometry (the data-height the chart is meant to communicate).
  const sunnyBarRect = page.locator("[data-testid='mws-rounds-bar-sunny-clear'] rect");
  const restY = await sunnyBarRect.getAttribute("y");
  const restHeight = await sunnyBarRect.getAttribute("height");

  // Hover the sunny/clear bar again to reset state for the active
  // assertions below (the hover call above already triggered React).
  await page.locator("[data-testid='mws-rounds-bar-sunny-clear'] rect").hover();
  await page.getByTestId("mws-rounds-tooltip").waitFor({ timeout: 5_000 });

  // ONLY the hovered bar is active.
  await expect(sunnyBarRect).toHaveAttribute("data-active", "true");
  for (const bar of ["partly-cloudy", "high-wind", "rain-storm"]) {
    await expect(page.locator(`[data-testid='mws-rounds-bar-${bar}'] rect`)).toHaveAttribute("data-active", "false");
  }
  // Active bar carries the thicker, darker outline; non-active bars
  // keep the rest stroke. NO drop-shadow filter on any bar (would
  // visually lift it). NO change to the bar's y or height (would
  // distort the data-height).
  await expect(sunnyBarRect).toHaveAttribute("stroke-width", "2.4");
  await expect(sunnyBarRect).toHaveAttribute("stroke", "#1c2f1c");
  await expect(sunnyBarRect).not.toHaveAttribute("filter", /.+/);
  await expect(page.locator("[data-testid='mws-rounds-bar-rain-storm'] rect")).toHaveAttribute("stroke-width", "0.5");
  await expect(page.locator("[data-testid='mws-rounds-bar-rain-storm'] rect")).not.toHaveAttribute("filter", /.+/);
  // y + height are byte-identical to the rest snapshot — no lift,
  // no scale, no translation.
  const hoverY = await sunnyBarRect.getAttribute("y");
  const hoverHeight = await sunnyBarRect.getAttribute("height");
  expect(hoverY, "bar y must NOT change on hover (lifting would distort data)").toBe(restY);
  expect(hoverHeight, "bar height must NOT change on hover (scaling would distort data)").toBe(restHeight);

  // CARD CHROME — unchanged during hover.
  await expect(roundsCard).not.toHaveAttribute("data-hovered", "true");
  const hoveredChrome = await captureCardChromeClasses(page, "mws-rounds-card");
  expect(hoveredChrome.className, "card class string must not change on hover").toBe(restChrome.className);
  expect(hoveredChrome.style, "card style must not change on hover").toBe(restChrome.style);
  // The OTHER card chrome is also untouched.
  await expect(page.getByTestId("mws-pattern-card")).not.toHaveAttribute("data-hovered", "true");

  // Tooltip body: condition + avg rounds + variance vs. period avg.
  await expect(page.getByTestId("mws-rounds-tooltip-label")).toHaveText("Sunny/Clear");
  await expect(page.getByTestId("mws-rounds-tooltip-row-rounds")).toContainText("avg rounds/day");
  await expect(page.getByTestId("mws-rounds-tooltip-row-variance")).toContainText("vs. period avg");

  await page.screenshot({ path: "test-results/weather-rounds-hover-1440.png", fullPage: false });

  // Mouse-leave clears the tooltip + active bar. Card chrome still
  // unchanged.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  await expect(page.getByTestId("mws-rounds-tooltip")).toHaveCount(0);
  await expect(page.locator("[data-testid='mws-rounds-bar-sunny-clear'] rect")).toHaveAttribute("data-active", "false");
  const finalChrome = await captureCardChromeClasses(page, "mws-rounds-card");
  expect(finalChrome.className).toBe(restChrome.className);
});

test("hover transfers per-datum: only the hovered slice OR bar is active at any time, card chrome never changes", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-weather-and-utilization").click();
  await page.getByTestId("weather-and-utilization").waitFor({ timeout: 20_000 });

  const patternChromeAtRest = await captureCardChromeClasses(page, "mws-pattern-card");
  const roundsChromeAtRest = await captureCardChromeClasses(page, "mws-rounds-card");

  // Hover a donut slice — only that slice goes active.
  await page.locator("[data-testid='mws-pattern-slice-sunny-clear']").evaluate((el) => {
    const rect = (el as SVGElement).getBoundingClientRect();
    const clientX = rect.left + rect.width / 2 + 70;
    const clientY = rect.top + rect.height / 2;
    el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, clientX, clientY }));
    el.dispatchEvent(new MouseEvent("mousemove",  { bubbles: true, clientX, clientY }));
  });
  await page.getByTestId("mws-pattern-tooltip").waitFor({ timeout: 5_000 });
  await expect(page.getByTestId("mws-pattern-slice-sunny-clear")).toHaveAttribute("data-active", "true");
  // No bar is active.
  for (const bar of ["sunny-clear", "partly-cloudy", "high-wind", "rain-storm"]) {
    await expect(page.locator(`[data-testid='mws-rounds-bar-${bar}'] rect`)).toHaveAttribute("data-active", "false");
  }

  // Hover a bar — focus transfers per-datum. The donut clears its
  // own active state only when the mouse leaves the donut SVG, so
  // we dispatch that signal first.
  await page.locator("[data-testid='mws-pattern-svg']").evaluate((el) => {
    const body = document.body;
    el.dispatchEvent(new MouseEvent("mouseout",   { bubbles: true, relatedTarget: body }));
    el.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false, relatedTarget: body }));
  });
  await page.locator("[data-testid='mws-rounds-bar-rain-storm'] rect").hover();
  await page.waitForTimeout(200);

  await expect(page.locator("[data-testid='mws-rounds-bar-rain-storm'] rect")).toHaveAttribute("data-active", "true");
  // No donut slice is active anymore.
  for (const slice of ["sunny-clear", "partly-cloudy", "rain-storms", "high-wind"]) {
    await expect(page.getByTestId(`mws-pattern-slice-${slice}`)).toHaveAttribute("data-active", "false");
  }
  // Tooltip moves with the focus + shows the Rain/Storm condition.
  // (Bar chart has its OWN tooltip — the rounds testidPrefix.)
  await expect(page.getByTestId("mws-rounds-tooltip-label")).toHaveText("Rain/Storm");

  // Both card chromes have NOT changed throughout the transfer.
  const patternChromeNow = await captureCardChromeClasses(page, "mws-pattern-card");
  const roundsChromeNow = await captureCardChromeClasses(page, "mws-rounds-card");
  expect(patternChromeNow.className).toBe(patternChromeAtRest.className);
  expect(roundsChromeNow.className).toBe(roundsChromeAtRest.className);
});
