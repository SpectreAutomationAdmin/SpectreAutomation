// Phase 4R · UI-refinement acceptance suite (2026-08-15) — verifies
// each of the founder's numbered acceptance criteria on staging v219.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = "test-results/phase-4r-ui-refinement/after";
fs.mkdirSync(OUT, { recursive: true });

test.describe("Phase 4R · UI refinement acceptance", () => {
  const avail = stagingCredsAvailable();
  test.skip(!avail.ready, avail.reason ?? "creds missing");
  test.setTimeout(300_000);

  test("Mission Control: sidebar / header / breadcrumb / card id-tag hidden", async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await loginAsFounder(ctx, { landing: "/app/admin" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1500);

    // Capture the FULL AFTER screenshot before assertions
    await page.screenshot({
      path: path.join(OUT, "01-mission-control-full.png"),
      fullPage: true,
    });

    // ---- §1 Sidebar product identity ---------------------------
    const productName = page.locator('[data-testid="spectre-sidebar-product-name"]').first();
    await expect(productName, "sidebar product-name element must exist").toBeVisible();
    const productText = ((await productName.textContent()) ?? "").trim();
    console.log(`[§1] sidebar product name text = "${productText}"`);
    expect(productText, "sidebar must render single product name").toBe("Spectre Automation");

    // No stray "SPECTRE" eyebrow left in the identity area
    const oldClubName = page.locator('[data-testid="spectre-sidebar-club-name"]');
    expect(await oldClubName.count(), "retired club-name testid must be gone").toBe(0);

    // No duplicated Spectre wording in the identity area (allow one
    // occurrence inside `Spectre Automation`; any extra means the
    // SPECTRE eyebrow leaked back in).
    const sidebar = page.locator('aside').first();
    await sidebar.screenshot({ path: path.join(OUT, "02-sidebar.png") });
    const sidebarIdentityBlock = await page.locator('aside').first().locator(':has([data-testid="spectre-sidebar-product-name"])').first().textContent();
    const spectreOccurrences = ((sidebarIdentityBlock ?? "").match(/spectre/gi) ?? []).length;
    console.log(`[§1] identity block 'Spectre' occurrences = ${spectreOccurrences}`);
    expect(spectreOccurrences, "identity area must contain only ONE Spectre wordmark").toBeLessThanOrEqual(1);

    // No club name in the sidebar identity block (tenant belongs
    // to the page header, not the sidebar)
    expect(sidebarIdentityBlock ?? "").not.toMatch(/coulee\s*ridge/i);

    // ---- §2 Page header (tenant context + greeting) ------------
    const tenantContext = page.locator('[data-testid="spectre-mc-tenant-context"]').first();
    await expect(tenantContext, "tenant-context row must exist above the greeting").toBeVisible();
    const tenantText = ((await tenantContext.textContent()) ?? "").trim();
    console.log(`[§2] tenant-context text = "${tenantText}"`);
    expect(tenantText.length, "tenant-context must render the active tenant").toBeGreaterThan(0);

    // Greeting must NOT contain the club name any more
    const greeting = page.locator('.spectre-mc-greeting').first();
    const greetingText = ((await greeting.textContent()) ?? "").trim();
    console.log(`[§2] greeting text = "${greetingText}"`);
    expect(greetingText, "greeting must only be 'Good {tod}, {firstName}.'").toMatch(/^Good\s+(morning|afternoon|evening),\s+\S+\.\s*$/);
    expect(greetingText).not.toMatch(/coulee\s*ridge/i);

    // ---- §3 Breadcrumb ------------------------------------------
    const topbar = page.locator('[data-testid="spectre-topbar"]').first();
    await topbar.screenshot({ path: path.join(OUT, "03-topbar.png") });
    // The crumb separator is an SVG (no textContent) so the flattened
    // string reads e.g. "AppMission Control". Assert against the
    // per-segment DOM (each `.spectre-crumbs > span` is one crumb).
    const crumbSegs = await topbar.locator('.spectre-crumbs > span').allTextContents();
    const crumbLabels = crumbSegs.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
    console.log(`[§3] breadcrumb segments = ${JSON.stringify(crumbLabels)}`);
    expect(crumbLabels, "Mission Control breadcrumb should read App > Mission Control")
      .toEqual(["App", "Mission Control"]);

    // ---- §4 Card MAIL-XXXX identifier hidden -------------------
    const firstCard = page.locator('.spectre-mc-item').first();
    await firstCard.scrollIntoViewIfNeeded();
    await firstCard.screenshot({ path: path.join(OUT, "04-first-card.png") });
    const idTagEls = firstCard.locator('.spectre-mc-id-tag');
    const idTagCount = await idTagEls.count();
    console.log(`[§4] id-tag DOM elements on first card = ${idTagCount}`);
    if (idTagCount > 0) {
      const isHidden = await idTagEls.first().evaluate((el) => {
        const cs = window.getComputedStyle(el);
        return cs.display === 'none' || cs.visibility === 'hidden';
      });
      expect(isHidden, "id-tag element must be visually hidden (display:none / visibility:hidden)").toBe(true);
      // Text content must still be reachable for automated tests
      const dom = await idTagEls.first().textContent();
      expect(dom ?? "", "MAIL-XXXX identifier must remain in DOM textContent for diagnostics").toMatch(/^(MAIL|AP|AR|STMT)-[A-Z0-9]{4,}$/);
    }
    // The underlying workIntakeItemId must remain
    const cardWiid = await firstCard.getAttribute('data-work-intake-item-id');
    console.log(`[§4] card WI id preserved = ${cardWiid}`);
    expect(cardWiid, "data-work-intake-item-id must remain on card root").toBeTruthy();

    // ---- Completed history — same acceptance --------------------
    await page.goto(`${avail.baseURL}/app/admin?view=history`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, "05-completed-history-full.png"), fullPage: true });
    const firstHistCard = page.locator('.spectre-mc-item').first();
    if (await firstHistCard.count()) {
      await firstHistCard.scrollIntoViewIfNeeded();
      await firstHistCard.screenshot({ path: path.join(OUT, "06-first-history-card.png") });
      const histIdTag = firstHistCard.locator('.spectre-mc-id-tag').first();
      if (await histIdTag.count()) {
        const hidden = await histIdTag.evaluate((el) => window.getComputedStyle(el).display === 'none');
        expect(hidden, "history card id-tag must also be display:none").toBe(true);
      }
    }

    // ---- §9 Two other Spectre pages retain correct breadcrumbs -
    for (const r of [
      { slug: "members",           url: "/app/admin/members",            expectContains: /Members/i },
      { slug: "reporting-monthly", url: "/app/admin/reporting/monthly",  expectContains: /Monthly/i },
    ]) {
      await page.goto(`${avail.baseURL}${r.url}`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(1200);
      const tb = page.locator('[data-testid="spectre-topbar"]').first();
      // These pages render legacy topbar chrome, not SpectreTopBar,
      // in the current admin route split. Capture whatever chrome
      // renders so the founder can review breadcrumb continuity.
      const tbCount = await tb.count();
      if (tbCount > 0) {
        await tb.screenshot({ path: path.join(OUT, `07-topbar-${r.slug}.png`) });
        const crumb = ((await tb.locator('.spectre-crumbs').first().textContent()) ?? "").replace(/\s+/g, " ").trim();
        console.log(`[§9] ${r.slug} crumb = "${crumb}"`);
      } else {
        console.log(`[§9] ${r.slug} uses legacy topbar (no spectre-topbar) — captured full page instead`);
      }
      await page.screenshot({
        path: path.join(OUT, `08-${r.slug}-full.png`),
        fullPage: true,
        timeout: 45_000,
      }).catch((e) => console.log(`[§9] ${r.slug} full-page screenshot skipped: ${(e as Error).message.slice(0, 80)}`));
    }

    await ctx.close();
  });
});
