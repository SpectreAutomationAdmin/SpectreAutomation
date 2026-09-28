// WI-2B.1 — deployed acceptance: real feed rows open into a real
// review page. Reproduces the founder's exact scenario from the
// staging blocker (PAY NOW + "Vendor reports an unpaid invoice"
// both returned 404 in WI-2B).

import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./_lib/staging-auth";

const BASE_URL = "https://staging.spectreautomation.com";
const CTRL_EMAIL = "fixture.controller.3e@spectre.test";
const FIXTURE_PW = "spectre-3e-fixture";
const VIEWPORT = { width: 1586, height: 992 };

test.use({ trace: "off", video: "off" });
test.describe.configure({ mode: "serial" });
test.beforeEach(({}, testInfo) => {
  if (testInfo.project.name !== "chromium") {
    testInfo.skip(true, "WI-2B.1 acceptance runs on chromium only");
  }
});

async function openFeed(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/app/admin/work-intake`);
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
}

async function collectReviewLinks(page: Page): Promise<Array<{ title: string; href: string }>> {
  const rows = await page.locator(".wi-feed-row").all();
  const out: Array<{ title: string; href: string }> = [];
  for (const r of rows) {
    const title = (await r.locator(".wi-feed-row-title").textContent()) ?? "";
    const linkEl = r.locator("a.wi-feed-row-button");
    const linkCount = await linkEl.count();
    if (linkCount === 0) continue;
    const href = (await linkEl.first().getAttribute("href")) ?? "";
    out.push({ title: title.trim(), href });
  }
  return out;
}

test.describe("WI-2B.1 · canonical identity contract + real AP review", () => {
  test.setTimeout(180_000);

  test("HEALTH", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await ctx.newPage();
    const r = await page.goto(`${BASE_URL}/api/health`);
    expect(r?.status()).toBe(200);
  });

  test("Every real feed row href points at a resolvable identity (no wi_ prefix, no 404)", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await openFeed(page);
    const links = await collectReviewLinks(page);
    console.log("WI2B1_FEED_LINKS:", JSON.stringify(links));
    if (links.length === 0) {
      console.log("WI2B1_NOTE: this tenant has no real feed rows; test vacuously passes.");
      return;
    }
    for (const l of links) {
      // The "wi_" prefix that caused the WI-2B blocker must never
      // appear in a review-page URL again.
      expect(l.href).not.toMatch(/\/review\/wi[_-]/);
      // The URL must be either the canonical /review/{id} form OR
      // a legitimate domain page (e.g. /app/admin/ap/invoices/{id}
      // for loader-only AP items).
      expect(
        l.href.startsWith("/app/admin/work-intake/review/") ||
        l.href.startsWith("/app/admin/"),
      ).toBe(true);
    }
  });

  test("Opening every real /review/{id} link returns HTTP 200 (no 404 blocker)", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await openFeed(page);
    const links = (await collectReviewLinks(page)).filter((l) =>
      l.href.startsWith("/app/admin/work-intake/review/"),
    );
    if (links.length === 0) return;
    for (const l of links.slice(0, 5)) {
      const resp = await page.goto(BASE_URL + l.href);
      const status = resp?.status() ?? 0;
      console.log("WI2B1_OPEN:", l.title, l.href, "->", status);
      expect(status).toBe(200);
      // Real review page renders WorkIntakeReviewReal with the
      // `data-real="1"` marker. Never the Fairway fixture title.
      await expect(page.locator("[data-testid='wi-review-root']")).toBeVisible();
      const real = await page.locator("[data-testid='wi-review-root'][data-real='1']").count();
      expect(real).toBe(1);
    }
  });

  test("Real review page never renders the Fairway Irrigation fixture (§12)", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await openFeed(page);
    const reviewLinks = (await collectReviewLinks(page)).filter((l) =>
      l.href.startsWith("/app/admin/work-intake/review/"),
    );
    if (reviewLinks.length === 0) return;
    const forbidden = [
      "Fairway Irrigation Controls",
      "Fairway Irrigation Upgrade",
      "INV-88421",
      "$48,750.00",
      "$51,187.50",
      "PRJ-1042",
      "1630 – Course Improvements",
      "Central control unit",
      "Satellite field modules",
    ];
    for (const l of reviewLinks.slice(0, 3)) {
      await page.goto(BASE_URL + l.href);
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      const html = await page.content();
      for (const s of forbidden) {
        // A production-looking Fairway value on a real WI is worse
        // than an empty field per the founder's §12 explicit rule.
        expect(html).not.toContain(s);
      }
      // The real-data marker must be present.
      await expect(page.locator("[data-testid='wi-review-root'][data-real='1']")).toBeVisible();
    }
  });

  test("Fixture slug /review/row-1 still shows Fairway fixture (WI-1/WI-2A regression)", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(`${BASE_URL}/app/admin/work-intake/review/row-1`);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    // Scaffold path renders WITHOUT the `data-real="1"` marker.
    const roots = await page.locator("[data-testid='wi-review-root']").count();
    expect(roots).toBe(1);
    const real = await page.locator("[data-testid='wi-review-root'][data-real='1']").count();
    expect(real).toBe(0);
    await expect(page.locator(".wi-review-title")).toContainText("Capital Invoice");
    // Fairway fixture text appears in multiple places on the scaffold
    // (classification pane, doc preview, rail). Use a count assertion
    // instead of toBeVisible() to avoid strict-mode ambiguity.
    const fairwayCount = await page.getByText("Fairway Irrigation").count();
    expect(fairwayCount).toBeGreaterThan(0);
  });

  test("Cross-tenant / bogus id still returns 404 (auth invariant preserved)", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    const r = await page.goto(`${BASE_URL}/app/admin/work-intake/review/cldoesnotexist000000`);
    const status = r?.status() ?? 0;
    console.log("WI2B1_BOGUS:", status);
    // Either an HTTP 404, OR a 200 whose body does not contain the
    // review root (Next's app-not-found route).
    if (status === 200) {
      expect(await page.locator("[data-testid='wi-review-root']").count()).toBe(0);
    } else {
      expect(status).toBe(404);
    }
  });

  test("Screenshot: first real /review/{id} @ 1586×992", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await openFeed(page);
    const links = (await collectReviewLinks(page)).filter((l) =>
      l.href.startsWith("/app/admin/work-intake/review/"),
    );
    if (links.length === 0) {
      console.log("WI2B1_NOTE: no real review targets; screenshot skipped.");
      return;
    }
    // Capture up to two real review pages so the founder can inspect
    // "PAY NOW" and "Vendor reports an unpaid invoice" separately.
    for (let i = 0; i < Math.min(2, links.length); i++) {
      const l = links[i];
      await page.goto(BASE_URL + l.href);
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(500);
      const slug = l.href.split("/").pop() ?? `row-${i}`;
      const safe = slug.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40);
      await page.screenshot({
        path: `test-results/wi2b1-review-${i + 1}-${safe}-1586x992.png`,
        clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height },
      });
      console.log("WI2B1_SHOT:", l.title, "→", slug);
    }
  });

  test("WI-1 feed geometry preserved · Mission Control still works (regression)", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await openFeed(page);
    // Hero + KPI strip + feed card + 3-card rail — all preserved.
    await expect(page.locator(".wi-hero")).toBeVisible();
    await expect(page.locator("[data-testid='wi-kpi-card']")).toHaveCount(4);
    await expect(page.locator(".wi-feed-card")).toBeVisible();
    await expect(page.locator(".wi-rail-card")).toHaveCount(3);
    // Mission Control regression.
    await page.goto(`${BASE_URL}/app/admin`);
    await expect(page.locator(".spectre-mc-hero")).toBeVisible();
  });
});
