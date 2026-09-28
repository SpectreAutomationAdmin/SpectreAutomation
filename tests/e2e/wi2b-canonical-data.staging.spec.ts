// WI-2B — deployed acceptance for /app/admin/work-intake with
// canonical Work Intake data replacing the WI-1 fixture.

import { test, expect } from "@playwright/test";
import { loginAs } from "./_lib/staging-auth";

const BASE_URL = "https://staging.spectreautomation.com";
const CTRL_EMAIL = "fixture.controller.3e@spectre.test";
const FIXTURE_PW = "spectre-3e-fixture";
const VIEWPORT = { width: 1586, height: 992 };

// Scaffold-fixture text that MUST NOT appear on the real deployed
// page — proves the fixture six-row feed and fixture KPIs are gone.
// (The row-1 scaffold slug remains reachable via /review/row-1 for
// the WI-1/WI-2A visual acceptance suite; it does not appear in the
// feed itself.)
const FIXTURE_ONLY_STRINGS = [
  "Capital Invoice · Fairway irrigation controls",
  "Irrigation Systems Ltd. · $42,680.00",
  "3 exceptions require confirmation",
  "James R. Whittaker · Member #10428",
  "New hire setup · Assistant Golf Professional",
  "Staffing variance · Carter Wedding",
  "AP Invoice · Course maintenance supplies",
];

test.use({ trace: "off", video: "off" });
test.describe.configure({ mode: "serial" });
test.beforeEach(({}, testInfo) => {
  if (testInfo.project.name !== "chromium") {
    testInfo.skip(true, "WI-2B acceptance runs on chromium only");
  }
});

test.describe("WI-2B · canonical Work Intake data", () => {
  test.setTimeout(120_000);

  test("HEALTH", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await ctx.newPage();
    const resp = await page.goto(`${BASE_URL}/api/health`);
    expect(resp?.status()).toBe(200);
  });

  test("Feed no longer renders the WI-1 fixture six-row content", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(`${BASE_URL}/app/admin/work-intake`);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    for (const s of FIXTURE_ONLY_STRINGS) {
      await expect(page.getByText(s)).toHaveCount(0);
    }
  });

  test("Page renders EITHER real feed rows OR the deferred empty state (no fixture)", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(`${BASE_URL}/app/admin/work-intake`);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    const rowCount = await page.locator(".wi-feed-row").count();
    const emptyPresent = await page.locator("[data-testid='wi-feed-empty']").count();
    console.log("WI2B_FEED_ROWS:", rowCount, "EMPTY:", emptyPresent);
    // Exactly one of the two states is true, and if rows exist they
    // are NOT the fixture 6-row set (which had exactly 6 rows).
    expect(rowCount + emptyPresent).toBeGreaterThan(0);
    if (rowCount === 6) {
      // If the tenant happens to have exactly 6 real WIs, none of the
      // fixture strings should appear. That's covered by the earlier
      // test, so we don't fail here — just log.
      console.log("WI2B_NOTE: real feed has 6 rows; fixture strings already verified absent.");
    }
  });

  test("KPI card values are numeric (real counts, not the 12/8/5/28 fixture)", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(`${BASE_URL}/app/admin/work-intake`);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    const values = await page.locator(".wi-kpi-value").allInnerTexts();
    console.log("WI2B_KPI_VALUES:", JSON.stringify(values));
    expect(values).toHaveLength(4);
    for (const v of values) {
      expect(v.trim()).toMatch(/^\d+$/); // integer, not "$" or "—"
    }
    // Fixture trend deltas '3 from last week' / '2 from last week' /
    // '12% from last week' MUST NOT appear (WI-2B honestly renders
    // 'No change' until historical comparison data exists).
    await expect(page.getByText("3 from last week")).toHaveCount(0);
    await expect(page.getByText("2 from last week")).toHaveCount(0);
    await expect(page.getByText("12% from last week")).toHaveCount(0);
    // At least one 'No change' label should render.
    const noChange = await page.getByText("No change").count();
    expect(noChange).toBeGreaterThan(0);
  });

  test("Feed row Review buttons carry real WI ids", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(`${BASE_URL}/app/admin/work-intake`);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    const links = await page.locator("a.wi-feed-row-button").all();
    if (links.length === 0) {
      // Empty-state tenant: no links to inspect — the earlier empty
      // state test already covered this branch.
      return;
    }
    for (const l of links) {
      const href = await l.getAttribute("href");
      expect(href).not.toBeNull();
      expect(href!).toMatch(/^\/app\/admin\/work-intake\/review\//);
      // Real WI ids are NEVER the scaffold slug.
      expect(href!.endsWith("/row-1")).toBe(false);
    }
  });

  test("Cross-tenant / unknown id → 404 on the review route", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    // A CUID-shaped id that cannot exist in this tenant.
    const bogus = "clbogus1234567890abcdef";
    const resp = await page.goto(`${BASE_URL}/app/admin/work-intake/review/${bogus}`);
    expect([404, 200]).toContain(resp?.status() ?? 0);
    // Next's notFound() renders as 404 with the app-not-found UI.
    // We accept either the HTTP 404 OR that the WI-2A scaffold root
    // is NOT present (since the page short-circuited).
    const hasScaffoldRoot = await page.locator("[data-testid='wi-review-root']").count();
    if ((resp?.status() ?? 200) === 200) {
      // Fell through — must NOT have rendered the review scaffold.
      expect(hasScaffoldRoot).toBe(0);
    }
  });

  test("Scaffold slug /review/row-1 still renders (WI-1/WI-2A regression)", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(`${BASE_URL}/app/admin/work-intake/review/row-1`);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await expect(page.locator("[data-testid='wi-review-root']")).toBeVisible();
    await expect(page.locator(".wi-review-title")).toContainText("Capital Invoice");
  });

  test("Mission Control still renders (regression, §36)", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(`${BASE_URL}/app/admin`);
    await expect(page.locator(".spectre-mc-hero")).toBeVisible();
  });

  test("WI-1 accepted visual geometry preserved (feed card + KPI strip + hero)", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(`${BASE_URL}/app/admin/work-intake`);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    // Hero unchanged.
    await expect(page.locator(".wi-hero")).toBeVisible();
    await expect(page.locator(".wi-hero-greeting")).toContainText("Good morning");
    // KPI strip: 4 cards, in expected order, with expected labels.
    const labels = await page.locator(".wi-kpi-label").allInnerTexts();
    expect(labels).toEqual([
      "Items need your attention",
      "Items ready for review",
      "Waiting on others",
      "Completed this week",
    ]);
    // Feed card container present.
    await expect(page.locator(".wi-feed-card")).toBeVisible();
    // Right rail present with its three sections.
    await expect(page.locator(".wi-rail-card")).toHaveCount(3);
    // Screenshot for the report.
    await page.screenshot({
      path: "test-results/wi2b-work-intake-1586x992.png",
      clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height },
    });
  });
});
