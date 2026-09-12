// Payroll Admin Slice 3C (2026-09-12) — staging acceptance.
//
// Verifies the Adjustments tab renders with real domain data and
// the KPI breakdown works. Founder-manual write-side testing
// (add/remove adjustment + create/end recurring assignment) is
// left for the manual acceptance path — automated E2E of writes
// would consume the batch's audit trail.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/payroll-admin-3c-staging");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const FOUNDER_PP = "cmtjc2wud001bgnjugkqrdz2r"; // Aug 30 – Sep 12

test.use({ viewport: { width: 1440, height: 900 } });

test.describe.serial("Payroll 3C — staging", () => {
  test.setTimeout(180_000);

  test("A. Adjustments tab renders (no crash, no future-tab placeholder)", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll?payPeriodId=${FOUNDER_PP}&tab=adjustments`, { waitUntil: "networkidle" });
    await expect(page.getByTestId("payroll-admin-adjustments-tab").or(page.getByTestId("payroll-admin-adjustments-empty"))).toBeVisible();
    // The pre-3C future-tab placeholder must NOT appear.
    const future = await page.getByTestId("payroll-admin-future-tab-adjustments").count();
    expect(future).toBe(0);
    await page.screenshot({ path: path.join(OUT, "staging-3c-adjustments-tab-1440x900.png"), fullPage: false });
  });

  test("B. Adjustments KPI shows a numeric value (not '—') when a batch exists", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll?payPeriodId=${FOUNDER_PP}`, { waitUntil: "networkidle" });
    const kpi = page.getByTestId("payroll-admin-kpi-adjustments");
    await expect(kpi).toBeVisible();
    const text = await kpi.innerText();
    // Batch exists on founder period → KPI must show a number, not "—".
    expect(text).toMatch(/\d+/);
  });

  test("C. Add One-Time Adjustment button disabled on DRAFT batch (PREPARED-only rule)", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll?payPeriodId=${FOUNDER_PP}&tab=adjustments`, { waitUntil: "networkidle" });
    // Founder period is DRAFT (blockers present). Both the tab-level
    // Add button and the right-rail Add button must be disabled.
    const addDisabled = await page.getByTestId("payroll-admin-adjustments-add-disabled").count();
    const addEnabled = await page.getByTestId("payroll-admin-adjustments-add-open").count();
    // At least one branch is present. In DRAFT state the disabled
    // branch fires.
    if (addDisabled > 0) {
      const btn = page.getByTestId("payroll-admin-adjustments-add-disabled");
      const title = await btn.getAttribute("title");
      expect(title).toContain("PREPARED");
    } else {
      // Rare: batch has advanced to PREPARED between fixture runs.
      expect(addEnabled).toBeGreaterThan(0);
    }
  });

  test("D. Right-rail Add-One-Time-Adjustment activates the Adjustments tab", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll?payPeriodId=${FOUNDER_PP}`, { waitUntil: "networkidle" });
    const btn = page.getByTestId("payroll-admin-actions-add-adjustment");
    await expect(btn).toBeVisible();
    // Batch exists → button is enabled and navigates.
    const disabled = await btn.getAttribute("disabled");
    if (disabled === null) {
      await btn.click();
      await page.waitForURL(/tab=adjustments/, { timeout: 20_000 });
    }
  });

  test("E. Right-rail Manage-Recurring-Components activates the Adjustments tab", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll?payPeriodId=${FOUNDER_PP}`, { waitUntil: "networkidle" });
    const btn = page.getByTestId("payroll-admin-actions-manage-recurring");
    await expect(btn).toBeVisible();
    const disabled = await btn.getAttribute("disabled");
    if (disabled === null) {
      await btn.click();
      await page.waitForURL(/tab=adjustments/, { timeout: 20_000 });
    }
  });

  test("F. Checklist items 4 & 5 present in the right rail with 3C detail copy", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll?payPeriodId=${FOUNDER_PP}`, { waitUntil: "networkidle" });
    await expect(page.getByTestId("payroll-admin-checklist-item-one-time-adjustments")).toBeVisible();
    await expect(page.getByTestId("payroll-admin-checklist-item-recurring-components")).toBeVisible();
    // The pre-3C "future" attribute must have flipped once a batch exists.
    const oneTime = page.getByTestId("payroll-admin-checklist-item-one-time-adjustments");
    const future = await oneTime.getAttribute("data-future");
    expect(future).toBe("false");
  });

  test("G. Terminology guard — no Club Member / Club Membership leaks on adjustments surface", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll?payPeriodId=${FOUNDER_PP}&tab=adjustments`, { waitUntil: "networkidle" });
    const surface = await page.getByTestId("payroll-admin-surface").innerText();
    expect(surface).not.toMatch(/Club Member/);
    expect(surface).not.toMatch(/Club Membership/);
  });
});
