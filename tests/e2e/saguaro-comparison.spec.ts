import { test, type Page } from "@playwright/test";

// Side-by-side reference capture: Saguaro (sample-club.netlify.app) +
// Spectre Monthly Reporting Package. Both at 1440x900 so the visual
// comparison is fair. Used to evaluate executive feel / typography /
// hierarchy / board readiness / private-club identity after the
// stewardship-chapters redesign.

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";
const VIEWPORT = { width: 1440, height: 900 };

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

// --- Saguaro reference pages ----------------------------------------

test("saguaro reference — cover (p01)", async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto("https://sample-club.netlify.app/#p01", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.screenshot({ path: "test-results/cmp-saguaro-cover.png", fullPage: false });
});

test("saguaro reference — exec summary (p03)", async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto("https://sample-club.netlify.app/#p03", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.screenshot({ path: "test-results/cmp-saguaro-p03.png", fullPage: false });
});

test("saguaro reference — KPI / financial page (p05)", async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto("https://sample-club.netlify.app/#p05", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.screenshot({ path: "test-results/cmp-saguaro-p05.png", fullPage: false });
});

test("saguaro reference — membership page (p08)", async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto("https://sample-club.netlify.app/#p08", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.screenshot({ path: "test-results/cmp-saguaro-p08.png", fullPage: false });
});

test("saguaro reference — operations / experience page (p11)", async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto("https://sample-club.netlify.app/#p11", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.screenshot({ path: "test-results/cmp-saguaro-p11.png", fullPage: false });
});

// --- Spectre Monthly Reporting Package ------------------------------

test("spectre — cover", async ({ page }) => {
  await login(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: "test-results/cmp-spectre-cover.png", fullPage: false });
});

test("spectre — at-a-glance KPIs (III)", async ({ page }) => {
  await login(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-at-a-glance").click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "test-results/cmp-spectre-at-a-glance.png", fullPage: false });
});

test("spectre — stewardship dashboard (IV)", async ({ page }) => {
  await login(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-stewardship").click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "test-results/cmp-spectre-stewardship.png", fullPage: false });
});

test("spectre — membership stewardship (XI)", async ({ page }) => {
  await login(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-membership-stewardship").click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "test-results/cmp-spectre-membership.png", fullPage: false });
});

test("spectre — experience stewardship (XII)", async ({ page }) => {
  await login(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-experience-stewardship").click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "test-results/cmp-spectre-experience.png", fullPage: false });
});
