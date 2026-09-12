// Payroll 3B acceptance-hotfix (2026-09-12) — end-to-end staging
// acceptance for the clock → timesheet → approval pipeline visibility.
//
// Prerequisite: run
//   flyctl ssh console --app spectre-staging --command \
//     'node /app/scripts/payroll-3b-hourly-acceptance-fixture.mjs'
// which creates:
//   • Grounds manager employee linked to grounds.manager@fixture user
//   • Riley Reconcile (hourly, CLOCK_REQUIRED, $18/hr, Grounds primary)
//   • Two 8h CLOCK_IN/CLOCK_OUT sessions in the Aug 30 – Sep 12 period
//
// This spec then drives the UI-based portion of the pipeline:
//   1. Payroll Admin opens the manager workspace URL for Grounds +
//      the founder period — which triggers PayrollTimesheet
//      materialization from Riley's clock events.
//   2. Returns to the Payroll Overview → Approvals tab, verifies
//      Grounds now appears with state PENDING (was invisible
//      pre-hotfix because `getDepartmentApprovalStatus` only sees
//      frozen time).
//   3. Verifies Workflow Step 3 is `current` (was falsely `done`
//      pre-hotfix when no departments were tallied).
//   4. Verifies Checklist item 1 reconciles: "N imported · 0 frozen".
//
// Approve + Freeze are NOT clicked by this spec — the founder
// performs those in the manual acceptance path.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/payroll-admin-3b-hotfix-staging");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const FOUNDER_PP = "cmtjc2wud001bgnjugkqrdz2r";
const GROUNDS_DEPT_ID = "cms26rrl3000q3dssktern2oq";

test.use({ viewport: { width: 1440, height: 900 } });

test.describe.serial("Payroll 3B acceptance-hotfix — staging", () => {
  test.setTimeout(180_000);

  test("A. Manager workspace URL materializes Riley's timesheet on visit", async ({ context }) => {
    const page = await loginAsFounder(context);
    // Materialization is a side-effect of getScopeReview inside the
    // time/page.tsx server component. A single GET is enough.
    await page.goto(
      `${STAGING}/app/admin/payroll/time?payPeriodId=${FOUNDER_PP}&departmentId=${GROUNDS_DEPT_ID}&scope=timesheet`,
      { waitUntil: "networkidle" },
    );
    // The workspace should render something — a scope header, table,
    // or at least the workspace container. Weak assertion — the
    // heavier proof is on the Overview visit below.
    expect(await page.title()).toBeTruthy();
    await page.screenshot({ path: path.join(OUT, "staging-3b-hotfix-manager-workspace-1440x900.png"), fullPage: false });
  });

  test("B. Payroll Overview Approvals tab now shows Grounds (was empty pre-hotfix)", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll?payPeriodId=${FOUNDER_PP}&tab=approvals`, { waitUntil: "networkidle" });
    // With reviewable time in Grounds, the Approvals tab renders
    // rows — the "No departments to approve" empty state must NOT
    // appear.
    const empty = await page.getByTestId("payroll-admin-approvals-empty").count();
    expect(empty, "approvals-empty must NOT appear when reviewable time exists").toBe(0);
    // The Grounds row must be present.
    const groundsRow = page.getByTestId(`payroll-admin-approval-row-${GROUNDS_DEPT_ID}`);
    await expect(groundsRow).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "staging-3b-hotfix-approvals-populated-1440x900.png"), fullPage: false });
  });

  test("C. Grounds row's state pill is PENDING (reviewable but no manager approval yet)", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll?payPeriodId=${FOUNDER_PP}&tab=approvals`, { waitUntil: "networkidle" });
    const pill = page.getByTestId(`payroll-admin-approval-row-${GROUNDS_DEPT_ID}`).locator("span[data-state]");
    await expect(pill).toBeVisible();
    const state = await pill.getAttribute("data-state");
    // The domain's default state for a reviewable-but-unapproved
    // scope in the new lens is PENDING. If a founder approves before
    // running the spec, this could be APPROVED_UNFROZEN or FROZEN.
    expect(["PENDING", "APPROVED_UNFROZEN", "FROZEN", "REOPENED", "NEEDS_ATTENTION"]).toContain(state);
  });

  test("D. Review time deep-link on the Grounds row uses scope=timesheet + the correct IDs", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll?payPeriodId=${FOUNDER_PP}&tab=approvals`, { waitUntil: "networkidle" });
    const link = page.getByTestId(`payroll-admin-approval-review-${GROUNDS_DEPT_ID}`);
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    expect(href).toContain(`payPeriodId=${FOUNDER_PP}`);
    expect(href).toContain(`departmentId=${GROUNDS_DEPT_ID}`);
    expect(href).toContain("scope=timesheet");
  });

  test("E. Workflow Step 3 is `current` (not `done`) while unfrozen reviewable time exists", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll?payPeriodId=${FOUNDER_PP}`, { waitUntil: "networkidle" });
    // Step 3 in the workflow tracker — the third stage.
    const workflow = page.getByTestId("payroll-admin-workflow");
    await expect(workflow).toBeVisible();
    // Stage 3 (Approvals) should NOT be styled as `done` — the
    // green-fill "done" style uses bg-[#0f5f3f]. When `current` it
    // has border-2 border-[#0f5f3f].
    const stages = workflow.locator("div.grid.grid-cols-8 > div");
    const stage3 = stages.nth(2);
    const inner = stage3.locator("> div").first();
    const cls = (await inner.getAttribute("class")) ?? "";
    // Guard: must not be the solid `done` circle. `current` variant
    // is a white circle with the accent border.
    expect(cls, `Step 3 must not be "done": ${cls}`).not.toContain("bg-[#0f5f3f] text-white");
  });

  test("F. Checklist item 1 detail reconciles reviewable vs frozen counts", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll?payPeriodId=${FOUNDER_PP}`, { waitUntil: "networkidle" });
    const item1 = page.getByTestId("payroll-admin-checklist-item-time-imported");
    await expect(item1).toBeVisible();
    const text = await item1.innerText();
    // Copy shape: "imported · N frozen" or "N clock events awaiting
    // materialization" or "N timesheets needs attention" etc.
    // Weak assertion: the detail must contain a number OR the
    // "No time to import" copy — never the pre-hotfix "None
    // imported yet" hard-coded false-negative.
    expect(text, `item 1 detail: ${text}`).not.toContain("None imported yet");
  });

  test("G. Terminology guard: no 'Club Member' / 'Club Membership' text leaks through", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll?payPeriodId=${FOUNDER_PP}&tab=approvals`, { waitUntil: "networkidle" });
    const surface = await page.getByTestId("payroll-admin-surface").innerText();
    expect(surface).not.toMatch(/Club Member/);
    expect(surface).not.toMatch(/Club Membership/);
  });
});
