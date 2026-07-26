// Verify interactive affordances on the migrated flagship: menu
// dropdown opens, keyboard focus works, and navigating to a legacy
// admin route lands on the OLD chrome (proving the visual seam is
// clean, not a broken layout leak).

import { chromium } from "playwright";

const BASE = "http://localhost:3000";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  await page.goto(`${BASE}/login`);
  await page.locator('form:has(input[name="email"][value="admin@silversprings.club"]) button').first().click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
  await page.goto(`${BASE}/app/admin`);
  await page.waitForLoadState("networkidle", { timeout: 30_000 });

  // 1. Topbar user menu opens
  await page.locator('[data-testid="spectre-topbar-user-trigger"]').click();
  const menu = page.locator('[data-testid="spectre-topbar-user-menu"]');
  await menu.waitFor({ state: "visible", timeout: 5000 });
  const menuItems = menu.locator('[data-menu-item]');
  const menuItemCount = await menuItems.count();
  console.log(`user-menu items visible: ${menuItemCount} (expected 2)`);

  // 2. Escape closes it
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  const menuAfterEsc = await menu.count();
  console.log(`user-menu after Esc: ${menuAfterEsc === 0 ? "closed" : "STILL OPEN"}`);

  // 3. Navigate to a legacy admin route (Settings) — should render the
  //    LEGACY chrome (no SpectreShell) proving the exact-URL opt-in
  //    only fires for /app/admin.
  await page.goto(`${BASE}/app/admin/settings`);
  await page.waitForLoadState("networkidle", { timeout: 30_000 });
  const spectreOnLegacy = await page.locator('[data-testid="spectre-shell"]').count();
  const legacyTopbar = await page.locator('[data-testid="topbar"]').count();
  console.log(`/app/admin/settings — SpectreShell mounted: ${spectreOnLegacy === 0 ? "NO (correct)" : "YES (leak!)"}`);
  console.log(`/app/admin/settings — legacy TopBar mounted: ${legacyTopbar === 1 ? "YES (correct)" : "NO"}`);

  // 4. Confirm no horizontal scroll on the flagship at either viewport
  for (const size of [{ w: 1440, h: 900 }, { w: 1920, h: 1080 }]) {
    await page.setViewportSize({ width: size.w, height: size.h });
    await page.goto(`${BASE}/app/admin`);
    await page.waitForLoadState("networkidle", { timeout: 30_000 });
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    const overflow = scrollWidth - clientWidth;
    console.log(`viewport ${size.w}x${size.h}: horizontal overflow ${overflow}px ${overflow <= 1 ? "(clean)" : "(EXCESS)"}`);
  }

  // 5. Confirm the sidebar's active-nav indicator is present on the
  //    admin home item
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE}/app/admin`);
  await page.waitForLoadState("networkidle", { timeout: 30_000 });
  const activeItems = await page.locator('.spectre-nav-item.spectre-nav-item--active').count();
  console.log(`active nav items in sidebar: ${activeItems}`);

  await browser.close();
  console.log("\nInteractions verified.");
}

main().catch((e) => { console.error(e); process.exit(1); });
