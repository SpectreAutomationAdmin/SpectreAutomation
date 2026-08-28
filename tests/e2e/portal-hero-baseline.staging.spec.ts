// One-shot baseline capture for the desktop hero (2026-08-27).
// Logs in as the synthetic fixture, opens /employee, and records
// hero + image geometry at 1536×864. Screenshot saved so before/
// after can be compared.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/portal-hero-baseline");
fs.mkdirSync(OUT, { recursive: true });

const EMAIL = process.env.SPECTRE_PLAYWRIGHT_FIXTURE_EMAIL
  ?? "playwright-fixture@spectreautomation.internal";
const PASSWORD = process.env.SPECTRE_PLAYWRIGHT_FIXTURE_PASSWORD
  ?? "playwright-fixture-2026-test";

test("desktop hero baseline at 1536×864", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({
    viewport: { width: 1536, height: 864 },
    baseURL: "https://staging.spectreautomation.com",
  });
  const page = await context.newPage();
  await page.goto("/employee/login");
  await page.locator('[data-testid="employee-login-email"]').fill(EMAIL);
  await page.locator('[data-testid="employee-login-password"]').fill(PASSWORD);
  await page.locator('[data-testid="employee-login-submit"]').click();
  await page.waitForURL(/\/employee(?!\/login)/, { timeout: 30_000 });
  await page.evaluate(async () => {
    try { await fetch("/api/employee/tour-completed", { method: "POST" }); } catch {}
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  const measurements = await page.evaluate(() => {
    const shell = document.querySelector('[data-testid="portal-desktop-shell"]');
    const hero = shell?.querySelector('[data-testid="portal-hero-desktop"]') as HTMLElement | null;
    const img = shell?.querySelector('[data-testid="portal-hero-image-desktop"]') as HTMLImageElement | null;
    if (!hero || !img) return null;
    const heroRect = hero.getBoundingClientRect();
    const imgRect = img.getBoundingClientRect();
    return {
      hero: {
        width: heroRect.width,
        height: heroRect.height,
        aspect: heroRect.width / heroRect.height,
        top: heroRect.top,
        bottom: heroRect.bottom,
      },
      image: {
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        naturalAspect: img.naturalWidth / img.naturalHeight,
        renderedWidth: imgRect.width,
        renderedHeight: imgRect.height,
        objectFit: getComputedStyle(img).objectFit,
        objectPosition: getComputedStyle(img).objectPosition,
      },
    };
  });

  console.log("BASELINE HERO GEOMETRY (1536×864):");
  console.log(JSON.stringify(measurements, null, 2));

  fs.writeFileSync(path.join(OUT, "baseline-1536x864.json"), JSON.stringify(measurements, null, 2));
  await page.screenshot({ path: path.join(OUT, "baseline-1536x864-full.png"), fullPage: false });
  const hero = page.locator('[data-testid="portal-desktop-shell"] [data-testid="portal-hero-desktop"]').first();
  await hero.screenshot({ path: path.join(OUT, "baseline-1536x864-hero.png") });

  expect(measurements).not.toBeNull();
  await context.close();
});
