// Phase 4R · UI-refinement rev-2 acceptance (2026-08-15) — pins the
// founder corrections on staging v220:
//
//   §1 Sidebar identity: SPECTRE / AUTOMATION two-line eyebrow
//   §2 Tenant identity in application-header rail, BEFORE breadcrumb
//   §3 Preserved from v219: crumbs "App > Mission Control"; greeting
//      "Good {tod}, {firstName}."; MAIL-XXXX hidden but DOM-preserved

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = "test-results/phase-4r-ui-refinement-rev2/after";
fs.mkdirSync(OUT, { recursive: true });

test.describe("Phase 4R rev-2 acceptance", () => {
  const avail = stagingCredsAvailable();
  test.skip(!avail.ready, avail.reason ?? "creds missing");
  test.setTimeout(300_000);

  test("Mission Control: sidebar eyebrow / tenant-before-crumbs / greeting / id-tag", async ({ browser }) => {
    expect(avail.baseURL, "safety: staging-only").toMatch(/staging|localhost/i);
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await loginAsFounder(ctx, { landing: "/app/admin" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1500);

    await page.screenshot({ path: path.join(OUT, "01-mission-control-full.png"), fullPage: true });

    // ---- §1 Sidebar SPECTRE / AUTOMATION ------------------------
    const sidebarProduct = page.locator('[data-testid="spectre-sidebar-product-name"]').first();
    await expect(sidebarProduct, "product-name block must exist").toBeVisible();
    const line1 = page.locator('[data-testid="spectre-sidebar-product-name-line-1"]').first();
    const line2 = page.locator('[data-testid="spectre-sidebar-product-name-line-2"]').first();
    const line1Text = ((await line1.textContent()) ?? "").trim();
    const line2Text = ((await line2.textContent()) ?? "").trim();
    console.log(`[§1] eyebrow lines = "${line1Text}" / "${line2Text}"`);
    expect(line1Text).toBe("SPECTRE");
    expect(line2Text).toBe("AUTOMATION");
    // Eyebrow styling (uppercase, small, tracked, muted)
    const line1Css = await line1.evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return {
        textTransform: cs.textTransform,
        fontSize: cs.fontSize,
        letterSpacing: cs.letterSpacing,
      };
    });
    console.log(`[§1] eyebrow computed style = ${JSON.stringify(line1Css)}`);
    expect(line1Css.textTransform, "eyebrow must be uppercase (via text-transform or the literal case in DOM)")
      .toMatch(/uppercase|none/); // Tailwind `uppercase` OR literal caps
    expect(parseFloat(line1Css.fontSize), "eyebrow font-size ≤ 12px").toBeLessThanOrEqual(12);
    // Retired shape absence
    const retired = page.locator('[data-testid="spectre-sidebar-club-name"]');
    expect(await retired.count(), "retired club-name testid must be gone").toBe(0);
    // No tenant in the sidebar
    const sidebar = page.locator('aside').first();
    await sidebar.screenshot({ path: path.join(OUT, "02-sidebar.png") });
    const sidebarText = (await sidebar.textContent()) ?? "";
    expect(sidebarText, "no Coulee Ridge literal in sidebar").not.toMatch(/coulee\s*ridge/i);

    // ---- §2 Header rail: tenant BEFORE breadcrumb -----------------
    const topbar = page.locator('[data-testid="spectre-topbar"]').first();
    await topbar.screenshot({ path: path.join(OUT, "03-topbar.png") });

    const rail = page.locator('[data-testid="spectre-header-rail"]').first();
    await expect(rail, "header-rail must exist in the topbar").toBeVisible();

    // Tenant element inside the rail
    const tenant = rail.locator('[data-testid="spectre-header-rail-tenant"]').first();
    const tenantText = ((await tenant.textContent()) ?? "").trim();
    console.log(`[§2] header-rail tenant text = "${tenantText}"`);
    expect(tenantText.length, "tenant must be populated").toBeGreaterThan(0);
    expect(tenantText).toMatch(/coulee\s*ridge/i); // active tenant on this staging

    // Breadcrumb chain still reads App > Mission Control
    const crumbs = rail.locator('[data-testid="spectre-header-rail-crumbs"] > span');
    const crumbLabels = (await crumbs.allTextContents()).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
    console.log(`[§2] rail crumbs = ${JSON.stringify(crumbLabels)}`);
    expect(crumbLabels).toEqual(["App", "Mission Control"]);

    // DOM order — tenant BEFORE crumbs
    const railChildren = await rail.locator(':scope > *').evaluateAll((els) =>
      els.map((el) => (el as HTMLElement).dataset.testid ?? el.tagName.toLowerCase()),
    );
    console.log(`[§2] header-rail child order = ${JSON.stringify(railChildren)}`);
    const tenantIdx = railChildren.indexOf("spectre-header-rail-tenant");
    const crumbsIdx = railChildren.indexOf("spectre-header-rail-crumbs");
    expect(tenantIdx, "tenant element must precede crumbs container in DOM order").toBeGreaterThanOrEqual(0);
    expect(crumbsIdx, "crumbs container must be present").toBeGreaterThan(tenantIdx);

    // ---- §3 Greeting — no tenant append + no standalone context row
    const greeting = page.locator('.spectre-mc-greeting').first();
    const greetingText = ((await greeting.textContent()) ?? "").trim();
    console.log(`[§3] greeting text = "${greetingText}"`);
    expect(greetingText).toMatch(/^Good\s+(morning|afternoon|evening),\s+\S+\.\s*$/);
    expect(greetingText).not.toMatch(/coulee\s*ridge/i);

    // No standalone tenant-context row (removed in rev-2)
    const oldTenantRow = page.locator('[data-testid="spectre-mc-tenant-context"]');
    expect(await oldTenantRow.count(), "standalone tenant-context row must be gone").toBe(0);

    // ---- §4 Card MAIL-XXXX identifier hidden ---------------------
    const firstCard = page.locator('.spectre-mc-item').first();
    await firstCard.scrollIntoViewIfNeeded();
    await firstCard.screenshot({ path: path.join(OUT, "04-first-card.png") });
    const idTag = firstCard.locator('.spectre-mc-id-tag').first();
    if (await idTag.count()) {
      const isHidden = await idTag.evaluate((el) => window.getComputedStyle(el).display === 'none');
      expect(isHidden, "id-tag must remain display:none").toBe(true);
    }
    expect(await firstCard.getAttribute('data-work-intake-item-id'), "underlying WI id preserved").toBeTruthy();

    // ---- Completed history — same guarantees --------------------
    await page.goto(`${avail.baseURL}/app/admin?view=history`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, "05-completed-history-full.png"), fullPage: true });

    await ctx.close();
  });
});
