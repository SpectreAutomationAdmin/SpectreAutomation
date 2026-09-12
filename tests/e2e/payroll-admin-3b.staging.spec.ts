// Payroll Admin Slice 3B (2026-09-12) — staging acceptance.
//
// Verifies the tab navigation and the Exceptions + Approvals tab
// content against Coulee Ridge live data. Read-only: this spec
// does not click Prepare or Approve. The founder's manual
// acceptance path performs those mutations.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/payroll-admin-3b-staging");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const FOUNDER_PP = "cmtjc2wud001bgnjugkqrdz2r"; // Aug 30 – Sep 12

test.use({ viewport: { width: 1440, height: 900 } });

test.describe.serial("Payroll 3B — staging", () => {
  test.setTimeout(180_000);

  test("A. Tab strip renders + Exceptions tab activates via URL", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll?payPeriodId=${FOUNDER_PP}&tab=exceptions`, { waitUntil: "networkidle" });
    await expect(page.getByTestId("payroll-admin-tabs")).toBeVisible();
    // Either populated (`payroll-admin-exceptions-tab`) or empty
    // (`payroll-admin-exceptions-empty`), never both.
    const populated = await page.getByTestId("payroll-admin-exceptions-tab").count();
    const empty = await page.getByTestId("payroll-admin-exceptions-empty").count();
    expect(populated + empty).toBeGreaterThan(0);
    await page.screenshot({ path: path.join(OUT, "staging-payroll-3b-exceptions-1440x900.png"), fullPage: false });
  });

  test("B. Approvals tab renders department rows OR an empty state", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll?payPeriodId=${FOUNDER_PP}&tab=approvals`, { waitUntil: "networkidle" });
    const populated = await page.getByTestId("payroll-admin-approvals-tab").count();
    const empty = await page.getByTestId("payroll-admin-approvals-empty").count();
    expect(populated + empty).toBeGreaterThan(0);
    await page.screenshot({ path: path.join(OUT, "staging-payroll-3b-approvals-1440x900.png"), fullPage: false });
  });

  test("C. Review time deep-link points into the scope-version-safe workspace", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll?payPeriodId=${FOUNDER_PP}&tab=approvals`, { waitUntil: "networkidle" });
    const rows = page.locator('[data-testid^="payroll-admin-approval-review-"]');
    const n = await rows.count();
    if (n === 0) {
      console.log("[3b] no approval rows — approvals-empty path");
      return;
    }
    // Every Review-time link must carry scope=timesheet + payPeriodId + departmentId.
    for (let i = 0; i < n; i++) {
      const href = await rows.nth(i).getAttribute("href");
      expect(href, `row ${i} href`).toMatch(/\/app\/admin\/payroll\/time\?/);
      expect(href).toContain("scope=timesheet");
      expect(href).toContain(`payPeriodId=${FOUNDER_PP}`);
      expect(href).toMatch(/departmentId=/);
    }
  });

  test("D. Resolve Exceptions right-rail: disabled when no batch, activates Exceptions tab when a batch exists", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll?payPeriodId=${FOUNDER_PP}`, { waitUntil: "networkidle" });
    const btn = page.getByTestId("payroll-admin-actions-resolve-exceptions");
    await expect(btn).toBeVisible();
    const disabled = await btn.getAttribute("disabled");
    if (disabled != null) {
      // Unprepared branch — button is disabled, tooltip explains why.
      const title = await btn.getAttribute("title");
      expect(title).toContain("Prepare");
    } else {
      // Prepared branch — click activates the exceptions tab.
      await btn.click();
      await page.waitForURL(/tab=exceptions/, { timeout: 20_000 });
    }
  });

  test("E. View Time Approvals right-rail: same enabled/disabled contract as Resolve Exceptions", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll?payPeriodId=${FOUNDER_PP}`, { waitUntil: "networkidle" });
    const btn = page.getByTestId("payroll-admin-actions-view-approvals");
    await expect(btn).toBeVisible();
    const disabled = await btn.getAttribute("disabled");
    if (disabled != null) {
      const title = await btn.getAttribute("title");
      expect(title).toContain("Prepare");
    } else {
      await btn.click();
      await page.waitForURL(/tab=approvals/, { timeout: 20_000 });
    }
  });

  test("F. Checklist item 3 (Resolve payroll exceptions) is present in the right rail", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll?payPeriodId=${FOUNDER_PP}`, { waitUntil: "networkidle" });
    await expect(page.getByTestId("payroll-admin-checklist-item-resolve-exceptions")).toBeVisible();
    await expect(page.getByTestId("payroll-admin-checklist-item-department-approvals")).toBeVisible();
    await expect(page.getByTestId("payroll-admin-checklist-item-time-imported")).toBeVisible();
  });

  test("G. Terminology: no customer-facing 'Club Member'/'Club Membership' phrasing appears on the payroll surface", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll?payPeriodId=${FOUNDER_PP}`, { waitUntil: "networkidle" });
    const surface = await page.getByTestId("payroll-admin-surface").innerText();
    expect(surface, "surface must not say 'Club Member'").not.toMatch(/Club Member/);
    expect(surface, "surface must not say 'Club Membership'").not.toMatch(/Club Membership/);
  });
});
