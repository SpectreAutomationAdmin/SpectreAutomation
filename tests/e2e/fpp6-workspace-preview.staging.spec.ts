// FPP-6 (2026-09-21) — Mission Control master-detail preview browser
// acceptance. Read-only against the founder's Sep 15 SUBMITTED batch
// cmual2acx002tegdvxrr4lrzo (Work Intake item cmual5x0x00087hkl20vowupf).
// Does NOT click Approve or Return — both would refuse anyway because
// submitter == approver, and either way we never mutate.

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OVERVIEW_URL = "/app/admin";
const WORK_INTAKE_ITEM_ID = "cmual5x0x00087hkl20vowupf";
const OPEN_URL = `/app/admin?workItem=${WORK_INTAKE_ITEM_ID}`;

test.describe("FPP-6 workspace preview — closed + open + preservation", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("closed state: KPI strip + rail intact, no preview", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");
    const page = await loginAsFounder(context, { landing: OVERVIEW_URL });
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByTestId("mission-control-workspace")).toHaveAttribute("data-preview-open", "false");
    await expect(page.getByTestId("payroll-approval-preview")).toHaveCount(0);
    // Executive rail + KPI strip visible.
    await expect(page.getByRole("complementary", { name: /Executive rail/i })).toBeVisible();
    await expect(page.getByText("Ready for approval", { exact: false }).first()).toBeVisible();
    await page.screenshot({ path: "test-results/fpp6-closed-1440x900.png", fullPage: false });
  });

  test("open state at 1440×900: preview binds to Sep 15 frozen totals", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");
    const page = await loginAsFounder(context, { landing: OPEN_URL });
    await page.waitForLoadState("domcontentloaded");
    const workspace = page.getByTestId("mission-control-workspace");
    await expect(workspace).toHaveAttribute("data-preview-open", "true");
    const preview = page.getByTestId("payroll-approval-preview");
    await expect(preview).toBeVisible({ timeout: 15_000 });
    // Frozen submitted totals.
    const summary = page.getByTestId("preview-summary");
    await expect(summary).toContainText("1");
    await expect(summary).toContainText("Sep 15, 2026");
    await expect(summary).toContainText("$4,620.83");
    await expect(summary).toContainText("$1,583.50");
    await expect(summary).toContainText("$3,037.33");
    await expect(summary).toContainText("$639.96");
    // Review checks (no direct-deposit fabrication).
    const checks = page.getByTestId("preview-review-checks");
    await expect(checks).toContainText("Payroll calculation reviewed");
    await expect(checks).toContainText("Statutory deductions calculated");
    await expect(checks).toContainText("Payroll reconciliation balanced");
    await expect(checks).toContainText("Frozen payroll inputs preserved");
    await expect(checks).not.toContainText(/direct deposit/i);
    // Executive Insights — factual, not fabricated.
    const insights = page.getByTestId("preview-executive-insights");
    await expect(insights).toContainText(/1 employee.*\$4,620\.83/);
    await expect(insights).not.toContainText(/budget|prior period|department.+overtime/i);
    // Provenance line names the frozen calculation package.
    await expect(page.getByTestId("preview-provenance")).toContainText(/Calculation v1/);
    await expect(page.getByTestId("preview-provenance")).toContainText(/spectre-payroll-3c3d7-v2/);
    // Executive rail still visible — not covered.
    await expect(page.getByRole("complementary", { name: /Executive rail/i })).toBeVisible();
    await page.screenshot({ path: "test-results/fpp6-open-1440x900.png", fullPage: false });
  });

  test("close via X returns to closed state (URL cleared)", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");
    const page = await loginAsFounder(context, { landing: OPEN_URL });
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByTestId("payroll-approval-preview")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("preview-close").click();
    // router.replace is async — wait for the URL to lose the param
    // before asserting on it.
    await page.waitForURL((url) => !url.search.includes("workItem="), { timeout: 10_000 });
    expect(page.url()).not.toContain("workItem=");
    await expect(page.getByTestId("mission-control-workspace")).toHaveAttribute("data-preview-open", "false");
  });
});

test.describe("FPP-6 workspace preview — 1366×768", () => {
  test.use({ viewport: { width: 1366, height: 768 } });
  test("open state at 1366×768: no horizontal scroll, rail + KPI visible", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");
    const page = await loginAsFounder(context, { landing: OPEN_URL });
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByTestId("payroll-approval-preview")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("complementary", { name: /Executive rail/i })).toBeVisible();
    // No horizontal scrollbar on the body.
    const bodyOverflowX = await page.evaluate(() =>
      window.getComputedStyle(document.body).overflowX);
    expect(bodyOverflowX).not.toBe("scroll");
    await page.screenshot({ path: "test-results/fpp6-open-1366x768.png", fullPage: false });
  });
});
