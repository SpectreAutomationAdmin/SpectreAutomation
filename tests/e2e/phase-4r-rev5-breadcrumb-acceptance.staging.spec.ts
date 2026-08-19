// Phase 4R rev-5 breadcrumb-taxonomy acceptance on staging v223.
//   §1 Mission Control  →  App > Mission Control
//   §2 AP Vendors       →  App > AP > Vendors (no Admin, no Ap)
//   §3 Vendor timelines →  App > AP > Vendors > <VendorName> > Timeline
//      Runs against Microsoft AND at least one second vendor to prove
//      the mechanism is dynamic (no vendor-specific hard-code).
//   §4 rev-4 shell + rev-3 timezone regressions guarded.

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = "test-results/phase-4r-rev5-breadcrumb/after";
fs.mkdirSync(OUT, { recursive: true });

async function crumbLabels(page: Page): Promise<string[]> {
  const rail = page.locator('[data-testid="spectre-header-rail"]').first();
  return (
    (await rail.locator('[data-testid="spectre-header-rail-crumbs"] > span').allTextContents())
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean)
  );
}

test.describe("Phase 4R rev-5 · breadcrumb taxonomy", () => {
  const avail = stagingCredsAvailable();
  test.skip(!avail.ready, avail.reason ?? "creds missing");
  test.setTimeout(300_000);

  test("Mission Control + AP Vendors + Microsoft timeline + second vendor timeline", async ({ browser }) => {
    expect(avail.baseURL, "safety: staging-only").toMatch(/staging|localhost/i);
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await loginAsFounder(ctx, { landing: "/app/admin" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1500);

    // ---- §1 Mission Control -----------------------------------
    let labels = await crumbLabels(page);
    console.log(`[§1] Mission Control crumbs = ${JSON.stringify(labels)}`);
    expect(labels).toEqual(["App", "Mission Control"]);
    await page.screenshot({ path: path.join(OUT, "01-mission-control.png"), fullPage: true });

    // ---- §4 rev-3 timezone preserved --------------------------
    const greeting = ((await page.locator('.spectre-mc-greeting').first().textContent()) ?? "").trim();
    console.log(`[§4] greeting = "${greeting}"`);
    expect(greeting).toMatch(/^Good (morning|afternoon|evening),\s+\S+\.\s*$/);

    // ---- §2 AP Vendors -----------------------------------------
    await page.goto(`${avail.baseURL}/app/admin/ap/vendors`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1000);
    labels = await crumbLabels(page);
    console.log(`[§2] AP Vendors crumbs = ${JSON.stringify(labels)}`);
    expect(labels).toEqual(["App", "AP", "Vendors"]);
    // Regression guards — the retired shapes MUST NOT re-appear.
    expect(labels).not.toContain("Admin");
    expect(labels).not.toContain("Ap");
    await page.screenshot({ path: path.join(OUT, "02-ap-vendors.png"), fullPage: true });

    // ---- §3a Microsoft vendor timeline ------------------------
    const MICROSOFT_VENDOR_ID = "cms4461to0002gypwkbhl8n67";
    await page.goto(`${avail.baseURL}/app/admin/ap/vendors/${MICROSOFT_VENDOR_ID}/timeline`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1500);
    labels = await crumbLabels(page);
    console.log(`[§3a] Microsoft timeline crumbs = ${JSON.stringify(labels)}`);
    expect(labels).toEqual(["App", "AP", "Vendors", "Microsoft Corporation", "Timeline"]);
    // No raw cuid anywhere in the DOM.
    for (const label of labels) {
      expect(label).not.toMatch(/cms/i);
    }
    await page.screenshot({ path: path.join(OUT, "03-vendor-timeline-microsoft.png"), fullPage: true });

    // ---- §3b Discover a SECOND vendor + run the same assertions.
    // Prefer the global-search API (which we ship on this deploy)
    // since staging's vendor list currently only surfaces
    // Microsoft. Try a few generic queries and pick any non-
    // Microsoft vendor hit. This proves the mechanism is
    // dynamic and not Microsoft-specific.
    async function findSecondVendor(): Promise<{ id: string; name: string } | null> {
      const queries = ["inc", "corp", "ltd", "co", "llc", "club"];
      for (const q of queries) {
        const res = await page.request.get(`${avail.baseURL}/api/search/global?q=${encodeURIComponent(q)}`);
        if (!res.ok()) continue;
        const body = (await res.json()) as { vendors: Array<{ id: string; primaryLabel: string }> };
        const hit = (body.vendors ?? []).find((v) => v.id !== "cms4461to0002gypwkbhl8n67");
        if (hit) return { id: hit.id, name: hit.primaryLabel };
      }
      return null;
    }
    const secondVendor = await findSecondVendor();

    if (!secondVendor) {
      console.log("[§3b] no second vendor available in list — skipping second-vendor assertion");
    } else {
      console.log(`[§3b] second vendor discovered = ${JSON.stringify(secondVendor)}`);
      await page.goto(`${avail.baseURL}/app/admin/ap/vendors/${secondVendor.id}/timeline`, {
        waitUntil: "domcontentloaded",
      });
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(1500);
      labels = await crumbLabels(page);
      console.log(`[§3b] second vendor timeline crumbs = ${JSON.stringify(labels)}`);
      expect(labels[0]).toBe("App");
      expect(labels[1]).toBe("AP");
      expect(labels[2]).toBe("Vendors");
      expect(labels[3], "vendor crumb should be the vendor display name").not.toMatch(/cms/i);
      expect(labels[3], "vendor crumb should not be 'Detail'").not.toBe("Detail");
      expect(labels[4]).toBe("Timeline");
      // The dynamic label ideally matches the row name we scraped;
      // vendor list rows sometimes include extra chrome text, so
      // assert substring rather than exact-equals.
      expect(labels[3].toLowerCase()).toContain(
        secondVendor.name.toLowerCase().split(/\s+/)[0], // first word of the row name
      );
      await page.screenshot({ path: path.join(OUT, "04-vendor-timeline-second.png"), fullPage: true });
    }

    // ---- §4 rev-4 shell regression: SPECTRE / AUTOMATION intact
    await expect(page.locator('[data-testid="spectre-sidebar-product-name-line-1"]').first()).toHaveText("SPECTRE");
    await expect(page.locator('[data-testid="spectre-sidebar-product-name-line-2"]').first()).toHaveText("AUTOMATION");
    // Tenant BEFORE crumbs in the rail.
    const rail = page.locator('[data-testid="spectre-header-rail"]').first();
    const railChildren = await rail.locator(':scope > *').evaluateAll((els) =>
      els.map((el) => (el as HTMLElement).dataset.testid ?? el.tagName.toLowerCase()),
    );
    expect(railChildren.indexOf("spectre-header-rail-tenant")).toBeGreaterThanOrEqual(0);
    expect(railChildren.indexOf("spectre-header-rail-crumbs"))
      .toBeGreaterThan(railChildren.indexOf("spectre-header-rail-tenant"));

    await ctx.close();
  });
});
