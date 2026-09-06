// Payroll-3C-5B (2026-09-04) — employee portal + admin history +
// PDF download Playwright acceptance.
//
// Covers §21 desktop / §22 mobile employee portal + §23 admin
// payroll history + §24 PDF download surface.
//
// Preconditions (make with `npm run fixture:payroll-founder-preview`
// + `npm run fixture:payroll-3c1-components` + `npx tsx
// scripts/payroll-3c3d1-sam-reset-history.ts`). Sam Complex is now
// a signable Employee-Portal user (email complex.pay@preview.spectre.test,
// password TA1C-Preview-99).

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/payroll-3c5b");
fs.mkdirSync(OUT, { recursive: true });

const SAM_EMAIL   = "complex.pay@preview.spectre.test";
const SAM_PASS    = "TA1C-Preview-99";
const RAELENE     = "raelene.sample@preview.spectre.test";
const ADMIN_PASS  = "TA1C-Preview-99";

const prisma = new PrismaClient();

async function adminSignIn(page: Page, email: string) {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(ADMIN_PASS);
  await Promise.all([
    page.waitForURL(/\/app(?!\/.*login).*/, { timeout: 30_000 }),
    page.getByRole("button", { name: /^Sign in$/ }).click(),
  ]);
}

async function employeeSignIn(page: Page) {
  await page.goto("/employee/login");
  await page.locator('[data-testid="employee-login-email"]').fill(SAM_EMAIL);
  await page.locator('[data-testid="employee-login-password"]').fill(SAM_PASS);
  await Promise.all([
    page.waitForURL(/\/employee(?!\/login).*/, { timeout: 30_000 }),
    page.locator('[data-testid="employee-login-submit"]').click(),
  ]);
}

// -------------------------------------------------------------------
// §21 — Employee desktop
// -------------------------------------------------------------------
test.describe("Payroll-3C-5B · Employee desktop @1440x900", () => {
  test.beforeAll(async () => {
    // Sanity: Sam credential exists.
    const club = await prisma.club.findFirstOrThrow({ where: { slug: "coulee-ridge" } });
    const sam = await prisma.employee.findFirstOrThrow({ where: { clubId: club.id, email: SAM_EMAIL } });
    const cred = await prisma.employeePortalCredential.findUnique({ where: { employeeId: sam.id } });
    expect(cred).not.toBeNull();
  });

  test("Sam sees his pay history, statement detail, and can request the PDF", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await employeeSignIn(page);

    await page.goto("/employee/pay");
    await page.waitForURL(/\/employee\/pay/, { timeout: 30_000 });
    // The portal ships both a desktop and a mobile shell in the DOM;
    // the CSS-hidden one is `hidden` for the current viewport. Filter
    // to the visible copy.
    await expect(page.locator('[data-testid^="portal-pay-row:"]:visible').first()).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: path.join(OUT, "desktop-01-pay-list.png"), fullPage: true });

    // History should show at least 1 POSTED statement (13 from the reset).
    // Two DOM copies render (desktop + mobile shell); scope to the
    // visible copy for the viewport we're testing.
    const rows = page.locator('[data-testid^="portal-pay-row:"]:visible');
    expect(await rows.count()).toBeGreaterThanOrEqual(13);

    // Open the newest — Aug 31 flagship.
    const firstRowHref = await rows.first().getAttribute("href");
    expect(firstRowHref).toMatch(/^\/employee\/pay\/\w+$/);
    await page.goto(firstRowHref!);
    await page.waitForURL(/\/employee\/pay\/\w+/, { timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 });
    await page.screenshot({ path: path.join(OUT, "desktop-02-statement.png"), fullPage: true });
    // The statement page's outer div carries data-testid=portal-pay-statement.
    // Two DOM copies render — grab the one that isn't inside the CSS-hidden
    // mobile shell.
    await expect(page.locator('[data-testid="portal-pay-statement"]').first()).toBeAttached({ timeout: 30_000 });

    // Net pay renders the frozen 3C-3D.7 value.
    await expect(page.locator('[data-testid="portal-pay-net"]:visible').first()).toHaveText(/3037\.85/);

    // No SIN / TD1 claim leaks in the rendered HTML.
    const html = await page.content();
    expect(html).not.toMatch(/\b\d{3}[\s-]?\d{3}[\s-]?\d{3}\b/);
    expect(html).not.toContain("16452");
    expect(html).not.toContain("22769");

    // PDF endpoint returns a real PDF for this employee.
    const pdfRes = await ensurePdfDownload(context, page.url());
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.contentType).toContain("application/pdf");
    expect(pdfRes.bodyPrefix).toBe("%PDF");

    await context.close();
  });
});

// -------------------------------------------------------------------
// §22 — Employee mobile (iPhone-class portrait)
// -------------------------------------------------------------------
test.describe("Payroll-3C-5B · Employee mobile @390x844", () => {
  test("Statement renders without horizontal overflow on mobile", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true, isMobile: true, deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await employeeSignIn(page);

    await page.goto("/employee/pay");
    await page.waitForURL(/\/employee\/pay/, { timeout: 30_000 });
    // The portal ships both a desktop and a mobile shell in the DOM;
    // the CSS-hidden one is `hidden` for the current viewport. Filter
    // to the visible copy.
    await expect(page.locator('[data-testid^="portal-pay-row:"]:visible').first()).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: path.join(OUT, "mobile-01-pay-list.png"), fullPage: true });

    const mobileFirstHref = await page.locator('[data-testid^="portal-pay-row:"]:visible').first().getAttribute("href");
    expect(mobileFirstHref).toMatch(/^\/employee\/pay\/\w+$/);
    await page.goto(mobileFirstHref!);
    await page.waitForURL(/\/employee\/pay\/\w+/, { timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 });
    await page.screenshot({ path: path.join(OUT, "mobile-02-statement.png"), fullPage: true });
    await expect(page.locator('[data-testid="portal-pay-statement"]').first()).toBeAttached({ timeout: 30_000 });

    // No horizontal scrolling on the document.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1); // 1 px slack for sub-pixel rounding

    // Statement key facts visible on this viewport.
    await expect(page.locator('[data-testid="portal-pay-net"]:visible').first()).toBeVisible();

    await context.close();
  });
});

// -------------------------------------------------------------------
// §23 — Admin history
// -------------------------------------------------------------------
test.describe("Payroll-3C-5B · Admin history", () => {
  test("Payroll admin sees the flagship in history, opens paystubs, PDF link works", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await adminSignIn(page, RAELENE);

    await page.goto("/app/admin/payroll/history");
    await expect(page.locator('[data-testid="payroll-history-page"]')).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: path.join(OUT, "admin-01-history.png"), fullPage: true });

    // Click into the newest posted batch's statements.
    const openLinks = page.locator('[data-testid^="payroll-history-open:"]');
    const openCount = await openLinks.count();
    expect(openCount).toBeGreaterThanOrEqual(1);
    await openLinks.first().click();
    await expect(page.locator('[data-testid="paystubs-page"]')).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: path.join(OUT, "admin-02-paystubs.png"), fullPage: true });

    // PDF link exists per statement — pull the first and confirm it
    // fetches as application/pdf via the admin session.
    const pdfLink = page.locator('a[data-testid^="paystub-pdf:"]').first();
    const href = await pdfLink.getAttribute("href");
    expect(href).toMatch(/^\/api\/pay\/pdf\/[\w-]+$/);

    const pdfRes = await ensurePdfDownload(context, new URL(href!, page.url()).toString());
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.contentType).toContain("application/pdf");
    expect(pdfRes.bodyPrefix).toBe("%PDF");

    await context.close();
  });
});

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------
async function ensurePdfDownload(context: BrowserContext, url: string): Promise<{
  status: number; contentType: string; bodyPrefix: string;
}> {
  // Recompute PDF URL when the caller passed a viewer page URL.
  const derived = url.includes("/api/pay/pdf/")
    ? url
    : (() => {
        const m = url.match(/\/(employee\/pay|admin\/payroll\/batches\/[\w-]+\/paystubs)\/?/);
        if (m && m[1].startsWith("employee/pay")) {
          const batchEmpId = url.split("/employee/pay/")[1]?.split(/[?#]/)[0];
          return new URL(`/api/pay/pdf/${batchEmpId}`, url).toString();
        }
        return url;
      })();
  const res = await context.request.get(derived);
  const bodyBuffer = await res.body();
  return {
    status: res.status(),
    contentType: (res.headers()["content-type"] ?? "").toLowerCase(),
    bodyPrefix: bodyBuffer.slice(0, 4).toString(),
  };
}
