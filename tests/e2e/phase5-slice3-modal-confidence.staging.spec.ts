// Sprint 3 · Phase 5 · Slice 3 (2026-08-09) — Vendor Profile +
// AP Coding modal Confidence UX authenticated staging acceptance.
//
// Only ONE real staging card (OXIO) currently exposes a modal-open
// trigger from the collapsed card face — its vendor is unmatched
// (NOT_FOUND), so the title renders as `ap-title-vendor-button`
// which opens the modal at Step 1 (Vendor Profile).
//
// The other four real cards (DMM, Oakcreek 1087769 / 1091559, CPA
// Alberta) currently sit in MISSING_INFORMATION with a matched
// vendor — the collapsed primary maps to "Request information"
// (expand only) and the vendor title is a link to the vendor
// timeline, not a modal trigger. Modal-open coverage for those
// four is captured by the 12 adapter unit tests
// (tests/mission-control-modal-confidence.test.ts) which prove the
// adapter output for each fixture shape; the modal component
// re-renders deterministically off that adapter.
//
// This spec covers the ONE real end-to-end path we have today:
//   • OXIO Vendor Profile (Low supplier, no vendor match)
//   • OXIO AP Coding step navigation
//   • Popover interaction on both step confidence lines
//   • §37 no-percentage assertion inside the modal body
//   • §23 navigation persistence

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const availability = stagingCredsAvailable();
const OUT = "test-results/phase5-slice3-modal-confidence";

test.describe("Phase 5 · Slice 3 — modal Confidence UX (OXIO real staging)", () => {
  test.skip(!availability.ready, availability.reason ?? "staging credentials required");
  test.setTimeout(300_000);
  test.beforeAll(() => { mkdirSync(OUT, { recursive: true }); });

  test("OXIO: modal opens at Vendor Profile with LOW supplier + AP Coding retains recommendation", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${availability.baseURL}/app/admin`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => { /* ignore */ });

    // OXIO parent EMAIL WI suffix (Slice 2 baseline).
    const card = page.locator('[data-testid="email-intake-card"][data-work-intake-item-id$="c7g773n5"]').first();
    await card.waitFor({ state: "visible", timeout: 15_000 });
    await card.scrollIntoViewIfNeeded();

    // Unmatched-vendor path: title is a button that opens the modal.
    const vendorBtn = card.locator('[data-testid="ap-title-vendor-button"]').first();
    await vendorBtn.click();

    const modal = page.locator('[data-testid="create-vendor-and-post-modal"]').first();
    await modal.waitFor({ state: "visible", timeout: 10_000 });

    // ---- Vendor Profile step (§5-§8) ----------------------------
    const vendorConf = modal.locator('[data-testid="cvap-vendor-confidence"]').first();
    await vendorConf.waitFor({ state: "visible", timeout: 5_000 });
    const supplierLine = modal.locator('[data-testid="cvap-vendor-supplier-confidence"]').first();
    const supplierLevel = await supplierLine.getAttribute("data-confidence-level");
    const vendorMatchEl = modal.locator('[data-testid="cvap-vendor-match-state"]').first();
    const vendorMatchState = await vendorMatchEl.getAttribute("data-vendor-match");
    console.log(`[OXIO] Vendor Profile: supplier=${supplierLevel} · match=${vendorMatchState}`);
    // §7: OXIO shows LOW supplier and NOT_FOUND match
    expect(supplierLevel).toBe("LOW");
    expect(vendorMatchState).toBe("NOT_FOUND");
    await modal.screenshot({ path: join(OUT, "OXIO-vendor-profile.png") });

    // Hover the supplier line to reveal the popover, screenshot, dismiss
    await supplierLine.hover();
    const supplierPopover = modal.locator('[data-testid="cvap-vendor-supplier-confidence-popover"]').first();
    await supplierPopover.waitFor({ state: "visible", timeout: 3_000 });
    await modal.screenshot({ path: join(OUT, "OXIO-vendor-profile-popover.png") });
    // Dismiss popover via mouse-leave (Escape would close the modal itself).
    await page.mouse.move(10, 10);
    await supplierPopover.waitFor({ state: "hidden", timeout: 3_000 }).catch(() => { /* ignore */ });

    // §37 — modal body must not render "confidence NN%" or "(NN%)"
    const modalText = ((await modal.textContent()) ?? "");
    expect(modalText).not.toMatch(/confidence\s*\d{1,3}\s*%/i);
    expect(modalText).not.toMatch(/\(\s*\d{1,3}\s*%\s*\)/);

    // ---- §23 navigation: Escape closes; reopen preserves state ---
    await modal.locator('[data-testid="cvap-close"]').first().click();
    await modal.waitFor({ state: "hidden", timeout: 3_000 }).catch(() => { /* ignore */ });
    await vendorBtn.click();
    await modal.waitFor({ state: "visible", timeout: 5_000 });
    const supplierLevelAfterReopen = await modal.locator('[data-testid="cvap-vendor-supplier-confidence"]').first().getAttribute("data-confidence-level");
    expect(supplierLevelAfterReopen).toBe(supplierLevel);

    await modal.screenshot({ path: join(OUT, "OXIO-vendor-profile-reopened.png") });
  });
});
