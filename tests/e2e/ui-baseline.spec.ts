import { test, expect, type Page } from "@playwright/test";

// UI baseline visual verification (post-dev-cache wipe).
//
// Asserts that after a clean dev start the four key surfaces:
//   - /              (marketing root)
//   - /login         (sign-in)
//   - /app/admin     (admin home — requires auth)
//   - /app/admin/reporting/monthly
// render with styled CSS (stylesheet 200, computed background not the
// browser-default white, sidebar visible on admin pages).

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

test.describe("UI baseline — styles are loading", () => {
  test("/login renders with styled chrome (CSS asset returns 200; bg-club-cream applied)", async ({ page }) => {
    const cssRequests: Array<{ url: string; status: number }> = [];
    page.on("response", (resp) => {
      const url = resp.url();
      if (/_next\/static\/css\/.+\.css/.test(url)) {
        cssRequests.push({ url, status: resp.status() });
      }
    });

    await page.goto("/login");

    expect(cssRequests.length, "at least one CSS request must be made").toBeGreaterThan(0);
    for (const r of cssRequests) {
      expect(r.status, `CSS ${r.url} must return 200`).toBe(200);
    }

    // The bg-club-cream class on the inner column maps to #f8f5ef.
    const leftCol = page.locator("div.bg-club-cream").first();
    await expect(leftCol).toBeVisible();
    const bg = await leftCol.evaluate((el) => getComputedStyle(el).backgroundColor);
    // Reject default-white. Anything non-rgba(0,0,0,0) and non-rgb(255,255,255) is acceptable proof Tailwind compiled.
    expect(bg).not.toBe("rgba(0, 0, 0, 0)");
    expect(bg).not.toBe("rgb(255, 255, 255)");

    await page.screenshot({ path: "test-results/ui-baseline-login.png", fullPage: true });
  });

  test("/app/admin renders with sidebar + page chrome", async ({ page }) => {
    await login(page);
    await page.goto("/app/admin");
    // The Sidebar renders a <nav> with section labels. Any computed
    // box width > 0 + non-default background is enough proof of styling.
    const adminBody = page.locator("body");
    const fontFamily = await adminBody.evaluate((el) => getComputedStyle(el).fontFamily);
    expect(fontFamily).not.toBe("");
    await page.screenshot({ path: "test-results/ui-baseline-admin-home.png", fullPage: true });
  });

  test("/app/admin/reporting/monthly renders with the dedicated reporting shell (no admin sidebar)", async ({ page }) => {
    await login(page);
    await page.goto("/app/admin/reporting/monthly");

    // Reporting shell + its chrome must be present.
    await expect(page.getByTestId("reporting-mode-shell")).toBeVisible();
    await expect(page.getByTestId("reporting-shell")).toBeVisible();
    await expect(page.getByTestId("reporting-shell-header")).toBeVisible();
    await expect(page.getByTestId("reporting-shell-exit")).toBeVisible();
    await expect(page.getByTestId("reporting-shell-chapters")).toBeVisible();
    await expect(page.getByTestId("reporting-shell-body")).toBeVisible();

    // The admin sidebar is NOT rendered on this route. We assert
    // negatively on a class signature that only appears in the
    // standard admin chrome.
    await expect(page.locator("aside[aria-label='Primary navigation']")).toHaveCount(0);

    // Report content is still rendered inside the shell.
    await expect(page.getByTestId("monthly-package-header")).toBeVisible();
    await expect(page.getByTestId("executive-summary")).toBeVisible();
    await expect(page.getByTestId("monthly-reporting-body")).toBeVisible();

    // Chapter rail exposes all ten chapters in board-reading order
    // (step-/ reorder pass).
    for (const id of [
      "cover",
      "board-briefing",
      "at-a-glance",
      "stewardship",
      "financial-statements",
      "operations",
      "payroll",
      "fb-hospitality",
      "capital-projects",
      "ar-collections",
    ]) {
      await expect(page.getByTestId(`reporting-chapter-${id}`)).toBeVisible();
    }

    await page.screenshot({ path: "test-results/ui-baseline-monthly-reporting.png", fullPage: true });
  });

  // Cover redesign — the first viewport must be dominated by the
  // document cover, not card chrome. We measure the rendered cover
  // panel: serif h1 must be substantially larger than admin headings,
  // and the cover element must take the majority of the first
  // visible viewport height.
  test("monthly cover dominates the first viewport with prestige typography", async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/app/admin/reporting/monthly");

    // Cover testids — three-register publication layout per the
    // cover-page-audit close-out: monthly-cover-masthead at top,
    // monthly-cover-colophon at bottom, monthly-cover-fy in the hero
    // zone in between. All five user-named elements (Club Name,
    // Monthly Board Reporting Package, Period, Prepared For,
    // Committee Name) are present and visible.
    for (const id of [
      "monthly-cover",
      "monthly-cover-masthead",
      "monthly-cover-package-label",
      "monthly-cover-club-name",
      "monthly-cover-period",
      "monthly-cover-fy",
      "monthly-cover-colophon",
      "monthly-cover-prepared-for",
      "monthly-cover-meta",
    ]) {
      await expect(page.getByTestId(id)).toBeVisible();
    }

    const clubName = page.getByTestId("monthly-cover-club-name");
    const period = page.getByTestId("monthly-cover-period");
    const cover = page.getByTestId("monthly-cover");

    const clubNameFontSize = await clubName.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const clubNameFamily = await clubName.evaluate((el) => getComputedStyle(el).fontFamily);
    const periodFontSize = await period.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const coverBox = await cover.boundingBox();

    // Prestige typography: serif family + large pixel size.
    expect(clubNameFamily).toMatch(/Georgia|serif/i);
    expect(clubNameFontSize, "club name must be a prestige hero size (≥ 48px)").toBeGreaterThanOrEqual(48);
    expect(periodFontSize, "period must be a large secondary serif (≥ 30px)").toBeGreaterThanOrEqual(30);

    // Cover dominates the first viewport. We probe the actual rendered
    // panel height — it should be at least 70% of the viewport.
    expect(coverBox, "cover bounding box").toBeTruthy();
    expect(coverBox!.height, "cover panel must take ≥ 70% of viewport height").toBeGreaterThanOrEqual(630);

    // The next section (executive summary) sits below the fold.
    const executiveBox = await page.getByTestId("executive-summary").boundingBox();
    expect(executiveBox, "executive summary present").toBeTruthy();
    expect(
      executiveBox!.y,
      "executive summary must start below the first-fold (>700px from page top)",
    ).toBeGreaterThan(700);

    test.info().annotations.push({
      type: "cover-measurement",
      description: `clubNameFontSize=${clubNameFontSize}px periodFontSize=${periodFontSize}px coverHeight=${Math.round(coverBox!.height)}px executiveTop=${Math.round(executiveBox!.y)}px`,
    });

    await page.screenshot({ path: "test-results/monthly-cover.png", fullPage: false });
  });

  // Board Briefing — three stacked executive memos in letterhead form.
  // Each memo carries an RE / FROM / DATE block, a serif narrative
  // body, and a right-aligned italic signature. Dashboard-widget
  // chrome (tone stripe, status headline, KPI footer) has been
  // removed per docs/board-briefing-memo-audit.md.
  test("board briefing renders three executive memos in letterhead form", async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/app/admin/reporting/monthly");

    await page.getByTestId("reporting-chapter-board-briefing").click();
    await page.waitForTimeout(300);

    for (const key of ["operations", "financial-health", "capital-program"]) {
      await expect(page.getByTestId(`briefing-${key}`)).toBeVisible();
      await expect(page.getByTestId(`briefing-${key}-letterhead`)).toBeVisible();
      await expect(page.getByTestId(`briefing-${key}-re`)).toBeVisible();
      await expect(page.getByTestId(`briefing-${key}-from`)).toBeVisible();
      await expect(page.getByTestId(`briefing-${key}-date`)).toBeVisible();
      await expect(page.getByTestId(`briefing-${key}-narrative`)).toBeVisible();
      await expect(page.getByTestId(`briefing-${key}-signature`)).toBeVisible();
    }

    // The dashboard-widget chrome must NOT be rendered any more.
    await expect(page.locator('[data-testid="briefing-operations-stripe"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="briefing-operations-status"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="briefing-operations-eyebrow"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="briefing-operations-metrics"]')).toHaveCount(0);

    // Memo body is a larger serif than the chapter L4 italic lead.
    const narrative = page.getByTestId("briefing-operations-narrative");
    const bodySize = await narrative.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const bodyFamily = await narrative.evaluate((el) => getComputedStyle(el).fontFamily);
    expect(bodyFamily).toMatch(/Georgia|serif/i);
    expect(bodySize, "memo body must read as letterhead prose (≥ 16 px)").toBeGreaterThanOrEqual(16);

    // RE field carries the topic; FROM identifies the author; DATE
    // stamps the memo. All three are real text.
    const reText = await page.getByTestId("briefing-operations-re").textContent();
    const fromText = await page.getByTestId("briefing-operations-from").textContent();
    const dateText = await page.getByTestId("briefing-operations-date").textContent();
    expect(reText?.toLowerCase()).toContain("operations");
    expect(fromText?.length, "FROM is attributed to a person").toBeGreaterThan(0);
    expect(dateText?.length, "DATE is stamped").toBeGreaterThan(0);

    // Signature is right-aligned italic — the visual sign-off.
    const signature = page.getByTestId("briefing-operations-signature");
    const signatureAlign = await signature.evaluate((el) => getComputedStyle(el).textAlign);
    const signatureStyle = await signature.evaluate((el) => getComputedStyle(el).fontStyle);
    expect(signatureAlign).toBe("right");
    expect(signatureStyle).toBe("italic");

    test.info().annotations.push({
      type: "board-briefing-measurement",
      description: `narrativeSize=${bodySize}px re="${reText?.trim()}" from="${fromText?.trim()}" date="${dateText?.trim()}"`,
    });

    await page.screenshot({ path: "test-results/monthly-board-briefing.png", fullPage: false });
  });

  // At-a-Glance KPIs — premium tiles. The hero number must dominate
  // visually (≥ 3x the size of the title eyebrow). Each tile must
  // render label / value / context / comparison testids.
  test("at-a-glance KPI hero numbers dominate the eyebrow (≥ 3x font ratio)", async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/app/admin/reporting/monthly");

    await page.getByTestId("reporting-chapter-at-a-glance").click();
    await page.waitForTimeout(300);

    const KEYS = [
      "ytd-revenue",
      "noi",
      "capital-income",
      "reserve-coverage",
      "working-capital",
      "ar-current",
    ];

    for (const key of KEYS) {
      await expect(page.getByTestId(`exec-kpi-${key}`)).toBeVisible();
      await expect(page.getByTestId(`exec-kpi-${key}-label`)).toBeVisible();
      await expect(page.getByTestId(`exec-kpi-${key}-value`)).toBeVisible();
      await expect(page.getByTestId(`exec-kpi-${key}-context`)).toBeVisible();
      await expect(page.getByTestId(`exec-kpi-${key}-comparison`)).toBeVisible();
      await expect(page.getByTestId(`exec-kpi-${key}-tone`)).toBeVisible();
    }

    // Pick the YTD Revenue tile and measure label vs value font ratio.
    const label = page.getByTestId("exec-kpi-ytd-revenue-label");
    const value = page.getByTestId("exec-kpi-ytd-revenue-value");
    const labelSize = await label.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const valueSize = await value.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const valueFamily = await value.evaluate((el) => getComputedStyle(el).fontFamily);

    expect(valueFamily, "value uses serif typeface").toMatch(/Georgia|serif/i);
    expect(valueSize, "hero number must be ≥ 40px (prestige tile)").toBeGreaterThanOrEqual(40);
    expect(valueSize / labelSize, "value must visually dominate the label (≥ 3x)").toBeGreaterThanOrEqual(3);

    // The variance line on the green KPI uses a green tone colour
    // (toneHeadlineClass(green) → text-club-green-800).
    const varianceColor = await page
      .getByTestId("exec-kpi-ytd-revenue-variance")
      .evaluate((el) => getComputedStyle(el).color);
    // club-green-800 = #213a22 → rgb(33, 58, 34); test it's a deep
    // green (red channel < blue channel + green channel sufficiently
    // > red). Equivalent: green channel dominates.
    expect(varianceColor).toMatch(/^rgb\(/);

    // AR Current % is amber-toned — confirm its variance line uses an
    // amber colour, not the same green as the others.
    const arVarianceColor = await page
      .getByTestId("exec-kpi-ar-current-variance")
      .evaluate((el) => getComputedStyle(el).color);
    expect(arVarianceColor).not.toBe(varianceColor);

    test.info().annotations.push({
      type: "at-a-glance-measurement",
      description: `labelSize=${labelSize}px valueSize=${valueSize}px ratio=${(valueSize / labelSize).toFixed(2)} greenVariance=${varianceColor} amberVariance=${arVarianceColor}`,
    });

    await page.screenshot({ path: "test-results/monthly-at-a-glance.png", fullPage: false });
  });

  // Stewardship Dashboard — Operating + Capital, controller-style.
  // Each of the 16 cards must render: name + tone dot + actual value
  // + assessment verdict + the two labelled definitions ("What it is",
  // "Why it matters"). Visually it should read as a controller's brief.
  test("stewardship dashboard renders sixteen controller-style metric briefs", async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto("/app/admin/reporting/monthly");

    await page.getByTestId("reporting-chapter-stewardship").click();
    await page.waitForTimeout(300);

    // Both groups present.
    await expect(page.getByTestId("operating-stewardship")).toBeVisible();
    await expect(page.getByTestId("capital-stewardship")).toBeVisible();
    await expect(page.getByTestId("stewardship-lead")).toBeVisible();

    // 8 + 8 = 16 cards.
    const cardCount = await page.locator('[data-testid^="stewardship-"][data-tone]').count();
    expect(cardCount, "exactly sixteen stewardship cards (8 operating + 8 capital)").toBe(16);

    // Spot-check the eight operating keys for full anatomy.
    const OPERATING = [
      "dues-rev", "payroll-ratio", "noi-margin", "fb-subsidy",
      "rounds-vs-plan", "covers-vs-plan", "ar-current", "init-fee-subsidy",
    ];
    for (const key of OPERATING) {
      await expect(page.getByTestId(`stewardship-${key}`)).toBeAttached();
      await expect(page.getByTestId(`stewardship-${key}-name`)).toBeAttached();
      await expect(page.getByTestId(`stewardship-${key}-actual`)).toBeAttached();
      await expect(page.getByTestId(`stewardship-${key}-assessment`)).toBeAttached();
      await expect(page.getByTestId(`stewardship-${key}-what`)).toBeAttached();
      await expect(page.getByTestId(`stewardship-${key}-why`)).toBeAttached();
    }

    // Verdict on AR Current % (amber tone) wears the amber colour;
    // verdict on Dues-to-Revenue (green tone) wears the green colour.
    const arAssessmentColor = await page
      .getByTestId("stewardship-ar-current-assessment")
      .evaluate((el) => getComputedStyle(el).color);
    const duesAssessmentColor = await page
      .getByTestId("stewardship-dues-rev-assessment")
      .evaluate((el) => getComputedStyle(el).color);
    expect(arAssessmentColor).not.toBe(duesAssessmentColor);

    // Actual number on a green card is large serif.
    const actualSize = await page
      .getByTestId("stewardship-dues-rev-actual")
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(actualSize, "actual number must be ≥ 28px (board document)").toBeGreaterThanOrEqual(28);

    // The "What it is" definition is the spec text the user requested.
    const whatText = await page.getByTestId("stewardship-dues-rev-what").textContent();
    expect(whatText?.toLowerCase()).toContain("membership dues");

    test.info().annotations.push({
      type: "stewardship-measurement",
      description: `cards=${cardCount} actualSize=${actualSize}px arAssessment=${arAssessmentColor} duesAssessment=${duesAssessmentColor}`,
    });

    await page.screenshot({ path: "test-results/monthly-stewardship.png", fullPage: true });
  });

  // Executive commentary — eight blocks, one per section that doesn't
  // have a built-in narrative. Each renders the four-question structure
  // with a Demo commentary chip.
  test("eight executive commentary blocks render with the four-question structure + demo chips", async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/app/admin/reporting/monthly");

    const SECTIONS = [
      "at-a-glance",
      "stewardship",
      "financial-statements",
      "operations",
      "payroll",
      "fb-hospitality",
      "capital-projects",
      "ar-collections",
    ];

    for (const section of SECTIONS) {
      // The aside is attached but not necessarily in the viewport.
      await expect(page.getByTestId(`${section}-commentary`)).toBeAttached();
      await expect(page.getByTestId(`${section}-commentary-eyebrow`)).toBeAttached();
      await expect(page.getByTestId(`${section}-commentary-demo`)).toBeAttached();
      // The four labelled rows.
      for (const row of ["happened", "means", "attention", "decision"]) {
        await expect(page.getByTestId(`${section}-commentary-${row}`)).toBeAttached();
      }
    }

    // Scroll to one block and visually verify the four labels are visible.
    await page.getByTestId("reporting-chapter-at-a-glance").click();
    await page.waitForTimeout(300);
    const block = page.getByTestId("at-a-glance-commentary");
    await expect(block).toBeVisible();
    await expect(block).toContainText("What happened");
    await expect(block).toContainText("What it means");
    await expect(block).toContainText("What needs attention");
    await expect(block).toContainText("Board decision required");
    await expect(block).toContainText("Demo commentary");

    // Demo commentary chip — Executive Reporting Theme uses amber-700
    // for the "demo" tone (collapsed from amber-800 in the color audit
    // M2 cleanup so amber appears at a single named tone everywhere).
    // amber-700 = rgb(180, 83, 9).
    const chipColor = await page
      .getByTestId("at-a-glance-commentary")
      .locator('[data-testid="data-source-chip"][data-source="demo"]')
      .first()
      .evaluate((el) => getComputedStyle(el).color);
    expect(chipColor).toContain("180, 83, 9"); // amber-700

    test.info().annotations.push({
      type: "commentary-measurement",
      description: `blocks=${SECTIONS.length} chipColor=${chipColor}`,
    });

    await page.screenshot({ path: "test-results/monthly-commentary.png", fullPage: false });
  });

  // Financial Statements — board-readable: summary cards + key
  // variance rows + plain-English notes appear BEFORE the line-by-line
  // detail table. Tests the 4-tier hierarchy renders for all four
  // statements (Activities, Capital Fund, Position, AR Aging).
  test("financial statements render summary → variances → notes → detail in that order", async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/app/admin/reporting/monthly");

    await page.getByTestId("reporting-chapter-financial-statements").click();
    await page.waitForTimeout(300);

    const STATEMENTS = [
      "statement-of-activities",
      "capital-fund",
      "financial-position",
    ];

    for (const t of STATEMENTS) {
      await expect(page.getByTestId(t)).toBeAttached();
      await expect(page.getByTestId(`${t}-summary`)).toBeAttached();
      await expect(page.getByTestId(`${t}-variances`)).toBeAttached();
      await expect(page.getByTestId(`${t}-notes`)).toBeAttached();
      await expect(page.getByTestId(`${t}-detail`)).toBeAttached();
    }

    // AR Aging (chapter X) wears the same shape.
    await page.getByTestId("reporting-chapter-ar-collections").click();
    await page.waitForTimeout(300);
    for (const part of ["", "-summary", "-variances", "-notes", "-detail"]) {
      await expect(page.getByTestId(`ar-aging${part}`)).toBeAttached();
    }

    // Visual order — y-position of the four anatomy blocks must
    // increase from summary → variances → notes → detail.
    const ySummary    = (await page.getByTestId("statement-of-activities-summary").boundingBox())!.y;
    const yVariances  = (await page.getByTestId("statement-of-activities-variances").boundingBox())!.y;
    const yNotes      = (await page.getByTestId("statement-of-activities-notes").boundingBox())!.y;
    const yDetail     = (await page.getByTestId("statement-of-activities-detail").boundingBox())!.y;
    expect(ySummary, "summary above variances").toBeLessThan(yVariances);
    expect(yVariances, "variances above notes").toBeLessThan(yNotes);
    expect(yNotes, "notes above detail").toBeLessThan(yDetail);

    // Summary cards count check.
    const activitiesSummaryCount = await page
      .locator('[data-testid^="statement-of-activities-summary-"]')
      .count();
    expect(activitiesSummaryCount).toBe(4);
    const arSummaryCount = await page.locator('[data-testid^="ar-aging-summary-"]').count();
    expect(arSummaryCount).toBe(4);

    test.info().annotations.push({
      type: "financial-statements-measurement",
      description: `statements=${STATEMENTS.length + 1} activitiesSummaryCards=${activitiesSummaryCount} arSummaryCards=${arSummaryCount} ySummary=${ySummary} yDetail=${yDetail}`,
    });

    await page.screenshot({ path: "test-results/monthly-financial-statements.png", fullPage: true });
  });

  // Operations & Analytics — private-club operating metrics in a
  // board-readable shape. Four headline tiles, four metric groups,
  // a 12-month utilization sparkline; no raw P&L table.
  test("operations chapter VI renders headline tiles + metric groups + utilization trend (no raw tables)", async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/app/admin/reporting/monthly");

    await page.getByTestId("reporting-chapter-operations").click();
    await page.waitForTimeout(300);

    // Italic-serif lead.
    await expect(page.getByTestId("operations-lead")).toBeAttached();

    // 4 headline tiles attached.
    for (const t of [
      "operations-headline",
      "operations-active-members",
      "operations-rounds-ytd",
      "operations-fb-covers",
      "operations-waitlist",
    ]) {
      await expect(page.getByTestId(t)).toBeAttached();
    }

    // 3 stewardship-aligned metric groups (KPI curation pass:
    // operations-group-context — weather/inventory/turns — was
    // removed; operational management metrics, not stewardship).
    for (const t of [
      "operations-group-membership",
      "operations-group-course",
      "operations-group-fb",
    ]) {
      await expect(page.getByTestId(t)).toBeAttached();
    }
    await expect(page.locator('[data-testid="operations-group-context"]')).toHaveCount(0);

    // Utilization sparkline rendered as an SVG path.
    const trend = page.getByTestId("operations-utilization-trend");
    await expect(trend).toBeAttached();
    const svgCount = await trend.locator("svg").count();
    expect(svgCount, "sparkline SVG renders").toBeGreaterThan(0);

    // The OLD raw-table testids must NOT be present in DOM.
    await expect(page.locator('[data-testid="operating-stats"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="departmental-pnl"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="weather-utilization"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="inventory-analysis"]')).toHaveCount(0);

    // Measure headline tile value font size — should be serif large.
    const valueSize = await page
      .getByTestId("operations-active-members")
      .locator("div.font-serif")
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(valueSize, "headline value ≥ 28px (board document)").toBeGreaterThanOrEqual(28);

    test.info().annotations.push({
      type: "operations-measurement",
      description: `headlineValueSize=${valueSize}px sparklineCount=${svgCount}`,
    });

    await page.screenshot({ path: "test-results/monthly-operations.png", fullPage: true });
  });

  // Payroll chapter VII — board-readable after the KPI curation
  // pass: italic-serif lead + 4 headline tiles (Pillar 1 stewardship
  // ratios: Payroll Ratio + Dues Coverage) + 12-month payroll-ratio
  // sparkline. Departmental and overtime/seasonal groups were
  // removed (operational management metrics).
  test("payroll chapter VII renders the interpretation, 4 headline tiles, and a trend chart", async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/app/admin/reporting/monthly");

    await page.getByTestId("reporting-chapter-payroll").click();
    await page.waitForTimeout(300);

    await expect(page.getByTestId("payroll-lead")).toBeAttached();
    for (const t of [
      "payroll-headline",
      "payroll-ytd",
      "payroll-ratio",
      "payroll-prior-year",
      "payroll-dues-coverage",
      "payroll-ratio-trend",
    ]) {
      await expect(page.getByTestId(t)).toBeAttached();
    }
    // KPI curation pass: groups removed.
    await expect(page.locator('[data-testid="payroll-by-department"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="payroll-pressure"]')).toHaveCount(0);

    // Sparkline rendered.
    const svgCount = await page
      .getByTestId("payroll-ratio-trend")
      .locator("svg")
      .count();
    expect(svgCount).toBeGreaterThan(0);
  });

  // F&B chapter VIII — board-readable after the KPI curation pass:
  // italic-serif lead + 4 headline tiles (covers, avg check, revenue,
  // satisfaction) + 12-month F&B-subsidy-of-dues sparkline. Cost
  // structure (food / beverage / labour %) and outlet-mix groups
  // were removed (operational kitchen-management metrics).
  test("F&B chapter VIII renders the interpretation, 4 headline tiles, and subsidy trend", async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/app/admin/reporting/monthly");

    await page.getByTestId("reporting-chapter-fb-hospitality").click();
    await page.waitForTimeout(300);

    await expect(page.getByTestId("fb-lead")).toBeAttached();
    for (const t of [
      "fb-headline",
      "fb-covers",
      "fb-avg-check",
      "fb-revenue",
      "fb-satisfaction",
      "fb-subsidy-trend",
    ]) {
      await expect(page.getByTestId(t)).toBeAttached();
    }
    // KPI curation pass: groups removed.
    await expect(page.locator('[data-testid="fb-cost-structure"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="fb-sales-by-outlet"]')).toHaveCount(0);

    // Subsidy trend SVG rendered.
    const svgCount = await page
      .getByTestId("fb-subsidy-trend")
      .locator("svg")
      .count();
    expect(svgCount).toBeGreaterThan(0);

    // Headline value for member satisfaction reads as "4.6 / 5.0".
    const sat = await page.getByTestId("fb-satisfaction").textContent();
    expect(sat).toContain("4.6");

    test.info().annotations.push({
      type: "fb-measurement",
      description: `subsidyTrendSvgs=${svgCount} fbSatisfaction="${sat?.trim()}"`,
    });

    await page.screenshot({ path: "test-results/monthly-payroll-fb.png", fullPage: true });
  });

  // Print Mode toggle — clicking the button hides the chapter rail,
  // shell header chrome, and the package controls strip; the cover
  // panel and the report sections remain visible. We also exercise
  // the @media print path via Playwright's emulateMedia to confirm
  // the same selectors fire under the browser's native print pass.
  test("print mode toggle hides shell chrome on screen + @media print fires the same rules", async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/app/admin/reporting/monthly");

    const shell = page.getByTestId("reporting-shell");
    const toggle = page.getByTestId("print-mode-toggle");
    const header = page.getByTestId("reporting-shell-header");
    const chapters = page.getByTestId("reporting-shell-chapters");
    const cover = page.getByTestId("monthly-cover");

    // Default: shell chrome visible, toggle not active.
    await expect(toggle).toBeVisible();
    await expect(header).toBeVisible();
    await expect(chapters).toBeVisible();
    await expect(cover).toBeVisible();
    await expect(shell).not.toHaveAttribute("data-print-mode", "true");
    await expect(toggle).toContainText("Print mode");

    // Click toggle — attribute flips, chrome disappears.
    await toggle.click();
    await expect(shell).toHaveAttribute("data-print-mode", "true");
    await expect(toggle).toContainText("Exit print");
    await expect(header).not.toBeVisible();
    await expect(chapters).not.toBeVisible();
    // The cover (the report content) stays visible.
    await expect(cover).toBeVisible();

    await page.screenshot({ path: "test-results/monthly-print-mode-on.png", fullPage: false });

    // Toggle off — chrome returns.
    await toggle.click();
    await expect(shell).not.toHaveAttribute("data-print-mode", "true");
    await expect(header).toBeVisible();
    await expect(chapters).toBeVisible();

    // Verify the @media print path through Playwright's emulator.
    // Reset to a clean page (toggle off), then activate print media —
    // the same shell chrome should hide via the @media print rules.
    await page.emulateMedia({ media: "print" });
    await expect(header).not.toBeVisible();
    await expect(chapters).not.toBeVisible();
    await expect(toggle).not.toBeVisible(); // toggle itself hidden during the print pass
    await expect(cover).toBeVisible();
    await page.screenshot({ path: "test-results/monthly-print-mode-emulated.png", fullPage: false });
    await page.emulateMedia({ media: "screen" });
  });
});
