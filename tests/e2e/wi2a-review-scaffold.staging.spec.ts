// WI-2A — deployed acceptance for /app/admin/work-intake/review/[id].
// Visual scaffold; static content per reference. Primary viewport
// 1536 × 1024 per §24; secondary structural sanity at 1586 × 992.

import { test, expect } from "@playwright/test";
import { loginAs } from "./_lib/staging-auth";

const BASE_URL = "https://staging.spectreautomation.com";
const CTRL_EMAIL = "fixture.controller.3e@spectre.test";
const FIXTURE_PW = "spectre-3e-fixture";
const REF_VIEWPORT = { width: 1536, height: 1024 };
const WI_VIEWPORT = { width: 1586, height: 992 };
const REVIEW_URL = `${BASE_URL}/app/admin/work-intake/review/row-1`;

test.use({ trace: "off", video: "off" });
test.describe.configure({ mode: "serial" });
test.beforeEach(({}, testInfo) => {
  if (testInfo.project.name !== "chromium") {
    testInfo.skip(true, "WI-2A acceptance runs on chromium only");
  }
});

test.describe("WI-2A · Work Intake review scaffold @ 1536×1024", () => {
  test.setTimeout(120_000);

  test("HEALTH", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: REF_VIEWPORT });
    const page = await ctx.newPage();
    const resp = await page.goto(`${BASE_URL}/api/health`);
    expect(resp?.status()).toBe(200);
  });

  test("Route resolves + wi-review-root rendered", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: REF_VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(REVIEW_URL);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await expect(page.locator("[data-testid='wi-review-root']")).toBeVisible();
  });

  test("Feed row 1 links here", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: REF_VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(`${BASE_URL}/app/admin/work-intake`);
    const link = page.locator("[data-testid='wi-feed-review-link-row-1']");
    await expect(link).toHaveAttribute("href", "/app/admin/work-intake/review/row-1");
  });

  test("Header · back link + INTAKE eyebrow + title + metadata + 3 controls", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: REF_VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(REVIEW_URL);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await expect(page.locator(".wi-review-back")).toContainText("Back to Work Intake");
    await expect(page.locator(".wi-review-back")).toHaveAttribute("href", "/app/admin/work-intake");
    await expect(page.locator(".wi-review-eyebrow")).toHaveText("INTAKE");
    await expect(page.locator(".wi-review-title")).toContainText("Capital Invoice");
    await expect(page.locator(".wi-review-title")).toContainText("Fairway irrigation controls");
    await expect(page.locator(".wi-review-meta")).toContainText("Detected 2 hours ago");
    await expect(page.locator(".wi-review-meta")).toContainText("Invoice");
    await expect(page.locator(".wi-review-meta")).toContainText("Fairway Irrigation");
    await expect(page.locator(".wi-review-meta")).toContainText("$48,750.00");
    const actions = page.locator(".wi-review-header-actions button");
    await expect(actions).toHaveCount(3);
    await expect(page.locator(".wi-review-btn--primary")).toContainText("Approve");
  });

  test("Five tabs · Overview active + Documents(3)", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: REF_VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(REVIEW_URL);
    const tabs = page.locator(".wi-review-tab");
    await expect(tabs).toHaveCount(5);
    await expect(tabs.nth(0)).toContainText("Overview");
    await expect(tabs.nth(1)).toContainText("Documents");
    await expect(tabs.nth(1)).toContainText("(3)");
    await expect(tabs.nth(2)).toContainText("Extracted Data");
    await expect(tabs.nth(3)).toContainText("Related Work");
    await expect(tabs.nth(4)).toContainText("Audit Trail");
    await expect(page.locator("[data-testid='wi-review-tab-overview']"))
      .toHaveClass(/wi-review-tab--active/);
  });

  test("Invoice Details · document preview + classification rows", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: REF_VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(REVIEW_URL);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    // Preview shows real invoice content.
    await expect(page.locator(".wi-review-doc-brand-mark")).toContainText("FAIRWAY");
    await expect(page.locator(".wi-review-doc-title")).toContainText("INVOICE");
    await expect(page.locator(".wi-review-doc-vendor")).toContainText("Fairway Irrigation Controls Ltd.");
    await expect(page.locator(".wi-review-doc-vendor")).toContainText("Calgary, AB");
    // Extracted metadata rows.
    const meta = page.locator(".wi-review-classify");
    await expect(meta).toContainText("Vendor");
    await expect(meta).toContainText("Verified vendor");
    await expect(meta).toContainText("INV-88421");
    await expect(meta).toContainText("May 12, 2024");
    await expect(meta).toContainText("Jun 11, 2024 (Net 30)");
    await expect(meta).toContainText("$48,750.00 USD");
    // Classification rows.
    await expect(meta).toContainText("Capital Expenditure");
    await expect(meta).toContainText("Irrigation Controls");
    await expect(meta).toContainText("1630");
    await expect(meta).toContainText("Course Improvements");
    await expect(meta).toContainText("92% confidence");
    await expect(meta).toContainText("Fairway Irrigation Upgrade (PRJ-1042)");
    await expect(meta).toContainText("Course Operations");
    await expect(meta).toContainText("North Course");
    // "Matched" pill appears three times (Project, Cost Center, Location).
    const matchedPills = page.locator(".wi-review-pill--matched");
    await expect(matchedPills).toHaveCount(3);
  });

  test("Line Items table · 3 rows + summary", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: REF_VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(REVIEW_URL);
    const table = page.locator("[data-testid='wi-review-lines-table']");
    await expect(table.locator("tbody tr")).toHaveCount(3);
    await expect(table).toContainText("Central control unit");
    await expect(table).toContainText("Satellite field modules");
    await expect(table).toContainText("Installation & programming");
    await expect(table).toContainText("1630");
    await expect(page.locator(".wi-review-card--lines")).toContainText("3 items");
    await expect(page.locator(".wi-review-card--lines")).toContainText("$48,750.00");
  });

  test("Context card · 4 rows with green checks", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: REF_VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(REVIEW_URL);
    const ctx1 = page.locator(".wi-review-card--context");
    await expect(ctx1).toContainText("Vendor Status");
    await expect(ctx1).toContainText("Approved vendor");
    await expect(ctx1).toContainText("12 prior invoices");
    await expect(ctx1).toContainText("Project Match");
    await expect(ctx1).toContainText("87% match");
    await expect(ctx1).toContainText("Policy Check");
    await expect(ctx1).toContainText("Compliant");
    await expect(ctx1).toContainText("Similar Past Invoices");
    await expect(ctx1).toContainText("4 similar invoices");
    await expect(ctx1.locator(".wi-review-context-row")).toHaveCount(4);
  });

  test("Workflow · 5 stages · Intake=done, Review=active, others=pending", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: REF_VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(REVIEW_URL);
    const flow = page.locator("[data-testid='wi-review-flow']");
    await expect(flow.locator("li")).toHaveCount(5);
    await expect(flow.locator("li.wi-review-flow-stage--done")).toHaveCount(1);
    await expect(flow.locator("li.wi-review-flow-stage--active")).toHaveCount(1);
    await expect(flow.locator("li.wi-review-flow-stage--pending")).toHaveCount(3);
    await expect(flow).toContainText("Intake");
    await expect(flow).toContainText("Extracted & categorized");
    await expect(flow).toContainText("Review");
    await expect(flow).toContainText("You are here");
    await expect(flow).toContainText("Route");
    await expect(flow).toContainText("Send for approval");
    await expect(flow).toContainText("Execute");
    await expect(flow).toContainText("Post to ERP");
    await expect(flow).toContainText("Complete");
    await expect(flow).toContainText("Notify stakeholders");
  });

  test("Spectre rail · header + lead + Key Insights + Recommendations + Ask box", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: REF_VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(REVIEW_URL);
    const rail = page.locator(".wi-review-rail");
    await expect(rail).toBeVisible();
    await expect(rail.locator(".wi-review-rail-brand-name")).toHaveText("Spectre");
    await expect(rail.locator(".wi-review-rail-brand-sub")).toContainText("autonomous finance teammate");
    await expect(rail.locator(".wi-review-rail-lead")).toContainText("capital expenditure");
    await expect(rail.locator(".wi-review-insight")).toHaveCount(4);
    await expect(rail).toContainText("PRJ-1042");
    await expect(rail).toContainText("Vendor is approved and in good standing");
    await expect(rail).toContainText("capital in nature");
    await expect(rail).toContainText("1630");
    await expect(rail.locator(".wi-review-rec")).toHaveCount(3);
    await expect(rail).toContainText("Approve and route to Capital Approvals group");
    await expect(rail).toContainText("Assign to project PRJ-1042");
    await expect(rail).toContainText("Post to GL 1630");
    await expect(rail.locator(".wi-review-rail-btn")).toHaveCount(2);
    await expect(rail).toContainText("Show similar invoices");
    await expect(rail).toContainText("Explain why this is capital");
    await expect(rail.locator(".wi-review-ask-field")).toHaveAttribute(
      "placeholder",
      /Ask anything about this invoice/,
    );
  });

  test("Deployed geometry @ 1536 × 1024", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: REF_VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(REVIEW_URL);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

    const bounds = async (sel: string) => {
      const el = page.locator(sel).first();
      const b = await el.boundingBox();
      return b ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } : null;
    };
    const geom = {
      viewport: REF_VIEWPORT,
      root: await bounds("[data-testid='wi-review-root']"),
      grid: await bounds(".wi-review-grid"),
      main: await bounds(".wi-review-main"),
      rail: await bounds(".wi-review-rail"),
      header: await bounds(".wi-review-header"),
      tabs: await bounds(".wi-review-tabs"),
      details: await bounds(".wi-review-card--details"),
      docPreview: await bounds(".wi-review-doc"),
      classify: await bounds(".wi-review-classify"),
      lines: await bounds(".wi-review-card--lines"),
      context: await bounds(".wi-review-card--context"),
      workflow: await bounds(".wi-review-card--workflow"),
      insights: await bounds(".wi-review-insights"),
      recs: await bounds(".wi-review-recs"),
      ask: await bounds(".wi-review-ask"),
    };
    console.log("WI2A_GEOMETRY:", JSON.stringify(geom, null, 2));
    // Rail sits at the right edge of the viewport (small tolerance).
    expect(geom.rail).not.toBeNull();
    if (geom.rail) {
      expect(geom.rail.x + geom.rail.w).toBeGreaterThanOrEqual(REF_VIEWPORT.width - 2);
    }
    // Main column left edge is near, but not zero (sidebar occupies a
    // portion of the viewport before the workspace begins).
    expect(geom.main).not.toBeNull();
    // Grid columns don't overlap.
    if (geom.main && geom.rail) {
      expect(geom.main.x + geom.main.w).toBeLessThanOrEqual(geom.rail.x + 1);
    }
  });

  test("Screenshot @ 1536×1024", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: REF_VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(REVIEW_URL);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(500);
    await page.screenshot({
      path: "test-results/wi2a-review-1536x1024.png",
      clip: { x: 0, y: 0, width: REF_VIEWPORT.width, height: REF_VIEWPORT.height },
    });
    await page.locator(".wi-review-main").screenshot({ path: "test-results/wi2a-review-main.png" });
    await page.locator(".wi-review-rail").screenshot({ path: "test-results/wi2a-review-rail.png" });
    await page.locator(".wi-review-card--details").screenshot({ path: "test-results/wi2a-review-details.png" });
  });

  test("Also renders at 1586×992 (WI-1 canonical viewport)", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: WI_VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(REVIEW_URL);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await expect(page.locator("[data-testid='wi-review-root']")).toBeVisible();
    await expect(page.locator(".wi-review-rail")).toBeVisible();
  });

  test("WI-1 feed still renders (regression)", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: WI_VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(`${BASE_URL}/app/admin/work-intake`);
    await expect(page.locator(".wi-root")).toBeVisible();
    await expect(page.locator("[data-testid='wi-kpi-card']")).toHaveCount(4);
    await expect(page.locator(".wi-feed-row")).toHaveCount(6);
  });

  test("Mission Control still works (regression)", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: WI_VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(`${BASE_URL}/app/admin`);
    await expect(page.locator(".spectre-mc-hero")).toBeVisible();
  });
});
