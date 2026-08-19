// Phase 20 (Member Database, 2026-08-15) — staging acceptance.
// Captures: members list, an individual profile (whichever member
// exists on the founder-review tenant), and the shell breadcrumb.
//
// The Coulee Ridge staging tenant is FOUNDER_REVIEW mode
// (synthetic Members forbidden per infra rules), so the acceptance
// verifies:
//   • the new Members list page renders without error
//   • the identity header + primary tabs + Member tab render on
//     whichever real member is present
//   • the breadcrumb integration is intact
//   • rev-2..rev-6 chrome regressions do not fire

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = "test-results/phase-20-member-database/after";
fs.mkdirSync(OUT, { recursive: true });

test.describe("Phase 20 · Member Database + Profile", () => {
  const avail = stagingCredsAvailable();
  test.skip(!avail.ready, avail.reason ?? "creds missing");
  test.setTimeout(300_000);

  test("Members list + first member profile + shell chrome", async ({ browser }) => {
    expect(avail.baseURL, "safety: staging-only").toMatch(/staging|localhost/i);
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await loginAsFounder(ctx, { landing: "/app/admin/members" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1500);

    // ---- Members list ------------------------------------------
    await page.screenshot({ path: path.join(OUT, "01-members-list.png"), fullPage: true });
    await expect(page.locator(".spectre-members-db-title").first()).toHaveText("Members");
    await expect(page.locator(".spectre-members-db-table").first()).toBeVisible();
    // Breadcrumb: App > Membership > Members  (or App > Members if
    // Membership isn't part of the current derivation — the shell
    // reads from the shared library, so we just assert the last
    // crumb is "Members").
    const crumbs = (await page.locator('[data-testid="spectre-header-rail-crumbs"] > span').allTextContents())
      .map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
    console.log(`[list] crumbs = ${JSON.stringify(crumbs)}`);
    expect(crumbs).toContain("Members");

    // ---- Try to click a real member profile ---------------------
    // Whichever member appears first — we don't hard-code an id.
    const firstMemberLink = page.locator(".spectre-members-db-name").first();
    if (await firstMemberLink.count() > 0) {
      const href = await firstMemberLink.getAttribute("href");
      console.log(`[list] first member href = ${href}`);
      await firstMemberLink.click();
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(OUT, "02-member-profile.png"), fullPage: true });

      // ---- Identity header ------------------------------------
      await expect(page.locator(".spectre-member-header").first()).toBeVisible();
      await expect(page.locator(".spectre-member-status-pill").first()).toBeVisible();
      const memberName = ((await page.locator(".spectre-member-header-name").textContent()) ?? "").trim();
      console.log(`[profile] member name = "${memberName}"`);

      // ---- Primary tabs ---------------------------------------
      for (const key of ["member", "plan", "billing", "esignatures", "notes", "documents"]) {
        await expect(page.locator(`[data-testid="member-tab-${key}"]`).first()).toBeVisible();
      }
      // Member tab should be selected by default.
      const memberTab = page.locator('[data-testid="member-tab-member"]').first();
      expect(await memberTab.getAttribute("aria-selected")).toBe("true");

      // ---- Member tab body ------------------------------------
      await expect(page.locator('[data-testid="member-tab-body"]').first()).toBeVisible();
      await expect(page.locator('[data-testid="member-basic-details"]').first()).toBeVisible();
      await expect(page.locator('[data-testid="member-picture"]').first()).toBeVisible();
      await expect(page.locator('[data-testid="member-groups"]').first()).toBeVisible();
      await expect(page.locator('[data-testid="member-other-info"]').first()).toBeVisible();
      await expect(page.locator('[data-testid="member-additional-info"]').first()).toBeVisible();

      // ---- Person switcher exists (primary always present) ----
      await expect(page.locator('[data-testid="member-person-primary"]').first()).toBeVisible();

      // ---- Breadcrumb dynamic label — vendor timeline pattern
      const profileCrumbs = (await page.locator('[data-testid="spectre-header-rail-crumbs"] > span').allTextContents())
        .map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
      console.log(`[profile] crumbs = ${JSON.stringify(profileCrumbs)}`);
      // Last crumb should be the member's display name (via
      // RegisterBreadcrumbLabel) — never a raw cuid.
      const lastCrumb = profileCrumbs[profileCrumbs.length - 1] ?? "";
      expect(lastCrumb).not.toMatch(/^cm[a-z0-9]/i);
      expect(lastCrumb).not.toBe("Detail");
    } else {
      console.log("[list] no members present on this staging tenant — profile assertions skipped");
    }

    // ---- Regression: canonical Spectre chrome intact ----------
    await expect(page.locator('[data-testid="spectre-sidebar-product-name-line-1"]').first()).toHaveText("SPECTRE");
    await expect(page.locator('[data-testid="spectre-sidebar-product-name-line-2"]').first()).toHaveText("AUTOMATION");

    await ctx.close();
  });
});
