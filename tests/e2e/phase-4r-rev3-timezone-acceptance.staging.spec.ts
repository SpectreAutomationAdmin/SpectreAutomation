// Phase 4R rev-3 timezone acceptance — verifies on staging v221 that:
//   • greeting reflects America/Edmonton wall-clock time (not UTC)
//   • Today's Commitments renders times in 12-hour AM/PM format
//   • rev-2 UI (sidebar eyebrow + tenant-first header rail + hidden
//     card id-tag) is intact.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = "test-results/phase-4r-rev3-timezone/after";
fs.mkdirSync(OUT, { recursive: true });
const EDMONTON = "America/Edmonton";

function expectedGreetingForEdmontonNow(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: EDMONTON, hour: "2-digit", hour12: false,
  }).formatToParts(now);
  const h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const hour = h === 24 ? 0 : h;
  if (hour >= 17) return "Good evening";
  if (hour >= 12) return "Good afternoon";
  if (hour >= 5) return "Good morning";
  return "Good evening";
}

test.describe("Phase 4R rev-3 · timezone-aware Mission Control", () => {
  const avail = stagingCredsAvailable();
  test.skip(!avail.ready, avail.reason ?? "creds missing");
  test.setTimeout(300_000);

  test("greeting reflects Edmonton local time + commitments show AM/PM", async ({ browser }) => {
    expect(avail.baseURL, "safety: staging-only").toMatch(/staging|localhost/i);
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      timezoneId: "UTC", // force browser to UTC so any client-only leak surfaces
    });
    const page = await loginAsFounder(ctx, { landing: "/app/admin" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1500);

    await page.screenshot({ path: path.join(OUT, "01-mission-control-full.png"), fullPage: true });

    // ---- §1 Greeting reflects Edmonton wall-clock -----------------
    const greeting = page.locator('.spectre-mc-greeting').first();
    const greetingText = ((await greeting.textContent()) ?? "").trim();
    const expectedPhrase = expectedGreetingForEdmontonNow();
    console.log(`[§1] page greeting = "${greetingText}"`);
    console.log(`[§1] expected phrase (based on Edmonton now) = "${expectedPhrase}"`);
    expect(greetingText).toMatch(new RegExp(`^${expectedPhrase},\\s+\\S+\\.\\s*$`));
    // Extra guardrail: greeting must be one of the three canonical
    // phrases (no fallbacks / no stale hydration).
    expect(greetingText).toMatch(/^Good (morning|afternoon|evening),\s+\S+\.\s*$/);

    // ---- §2 Today's Commitments time format ------------------------
    const commitments = page.locator('[data-testid="todays-commitments"]').first();
    await expect(commitments, "todays-commitments panel must render").toBeVisible();
    await commitments.scrollIntoViewIfNeeded();
    await commitments.screenshot({ path: path.join(OUT, "02-todays-commitments.png") });

    const timeCells = commitments.locator('.spectre-mc-commitment-time');
    const timeTexts = (await timeCells.allTextContents()).map((s) => s.trim()).filter(Boolean);
    console.log(`[§2] commitment time labels = ${JSON.stringify(timeTexts)}`);
    // AM/PM pattern: `H:MM AM/PM` (no leading zero on hour). "All day"
    // and the empty-state message are allowed too.
    const patt = /^(?:[1-9]|1[0-2]):[0-5]\d\s(AM|PM)$|^All day$/;
    for (const t of timeTexts) {
      // Bypass if this is the empty-state row (which uses different classes anyway)
      if (/no appointments|no proposed/i.test(t)) continue;
      expect(t, `commitment time "${t}" must be 12h AM/PM or All day`).toMatch(patt);
      expect(t, `no 24h form allowed`).not.toMatch(/^(1[3-9]|2[0-3]):[0-5]\d$/);
      expect(t, `no leading zero on hour`).not.toMatch(/^0/);
    }

    // ---- §3 rev-2 UI regressions ----------------------------------
    // Sidebar eyebrow SPECTRE / AUTOMATION intact
    await expect(page.locator('[data-testid="spectre-sidebar-product-name-line-1"]')).toHaveText("SPECTRE");
    await expect(page.locator('[data-testid="spectre-sidebar-product-name-line-2"]')).toHaveText("AUTOMATION");
    // Header rail: tenant BEFORE crumbs
    const rail = page.locator('[data-testid="spectre-header-rail"]').first();
    const railChildren = await rail.locator(':scope > *').evaluateAll((els) =>
      els.map((el) => (el as HTMLElement).dataset.testid ?? el.tagName.toLowerCase()),
    );
    console.log(`[§3] header-rail order = ${JSON.stringify(railChildren)}`);
    const tenantIdx = railChildren.indexOf("spectre-header-rail-tenant");
    const crumbsIdx = railChildren.indexOf("spectre-header-rail-crumbs");
    expect(tenantIdx).toBeGreaterThanOrEqual(0);
    expect(crumbsIdx).toBeGreaterThan(tenantIdx);
    // Crumbs
    const crumbLabels = (await rail.locator('[data-testid="spectre-header-rail-crumbs"] > span').allTextContents())
      .map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
    expect(crumbLabels).toEqual(["App", "Mission Control"]);
    // Card id-tag remains display:none
    const firstCard = page.locator('.spectre-mc-item').first();
    await firstCard.scrollIntoViewIfNeeded();
    await firstCard.screenshot({ path: path.join(OUT, "03-first-card.png") });
    const idTag = firstCard.locator('.spectre-mc-id-tag').first();
    if (await idTag.count()) {
      const isHidden = await idTag.evaluate((el) => window.getComputedStyle(el).display === 'none');
      expect(isHidden).toBe(true);
    }

    await ctx.close();
  });
});
