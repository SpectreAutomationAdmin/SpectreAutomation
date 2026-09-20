// FPP-5 (2026-09-20) — Founder batch reconciliation + period display.
//
// Read-only acceptance on Chris's real CALCULATED batch on staging.
// Proves the review workspace's reconciliation banner now shows the
// canonical aggregation and the period displays the inclusive last
// operational day (Sep 8, not Sep 9).

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

test.use({ viewport: { width: 1440, height: 900 } });

const BATCH_URL = "/app/admin/payroll/batches/cmuaeo41k002cajh7p8ni59z8";
const OVERVIEW_URL =
  "/app/admin/payroll?payGroupId=cmu5kg3e40002h4iupsaxezdl&payPeriodId=cmu5kg3ih000nh4iuqyal9zay";

test.describe("FPP-5 founder batch reconciliation (read-only)", () => {
  test("Review workspace reconciles $4,620.83 - $1,653.40 = $2,967.43", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");

    const page = await loginAsFounder(context, { landing: BATCH_URL });
    await page.waitForLoadState("domcontentloaded");

    // Reconciliation card renders green + "reconciled" state
    const recon = page.getByTestId("review-reconciliation");
    await expect(recon).toBeVisible();
    await expect(recon).toHaveAttribute("data-reconciled", "true");
    // The RECONCILIATION FAILED string must no longer be present.
    await expect(page.getByTestId("reconciliation-failed")).toHaveCount(0);

    // Summary card "Employee deductions" now shows $1,653.40 (was $1,396.12).
    const dedTile = page.getByTestId("summary-deductions");
    await expect(dedTile).toContainText("1,653.40");
    // Employer contributions now shows the FULL employer cost incl.
    // benefits ($639.96, was $386.78).
    const emplTile = page.getByTestId("summary-employer");
    await expect(emplTile).toContainText("639.96");

    // Screenshots
    await recon.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "test-results/fpp5-reconciliation-banner.png", fullPage: false });
    await dedTile.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "test-results/fpp5-summary-cards.png", fullPage: false });
  });

  test("Period display shows Aug 24 – Sep 8 (inclusive last day) on the workspace", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");

    const page = await loginAsFounder(context, { landing: OVERVIEW_URL });
    await page.waitForLoadState("domcontentloaded");

    const periodLine = page.getByTestId("payroll-admin-period-line");
    await expect(periodLine).toContainText("Aug 24");
    await expect(periodLine).toContainText("Sep 8");
    await expect(periodLine).not.toContainText("Sep 9");

    // Pay date remains Sep 15.
    await expect(page.getByTestId("payroll-admin-pay-date-line")).toContainText("Sep 15");

    await page.screenshot({ path: "test-results/fpp5-period-display.png", fullPage: false });
  });
});
