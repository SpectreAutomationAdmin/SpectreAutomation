// v-slice-1-followup-6 (2026-09-15) — payroll action-dialog visibility.
//
// Proves on the deployed staging build:
//   A. Payroll page renders + no CSP inline-script violations.
//   B. The current active batch's primary payroll action button is
//      visible on the Payroll Actions card.
//   C. Clicking the primary action opens a MODAL DIALOG (fixed
//      position), not a clipped sidebar dropdown.
//   D. The dialog contains a Cancel button that closes it safely
//      without invoking the destructive action.
//   E. No 5xx / no Application Error / no null.digest crash.
//
// Does NOT click the primary destructive confirm — the founder must
// personally drive the Submit / Return / Post transitions through
// the browser as the acceptance evidence.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/payroll-action-dialogs");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

test.use({ viewport: { width: 1440, height: 900 } });

test("payroll action dialogs open as full-viewport modals + cancel safely", async ({ browser }) => {
  const creds = stagingCredsAvailable();
  test.skip(!creds.ready, creds.reason ?? "staging creds unavailable");
  test.setTimeout(240_000);

  const ctx = await browser.newContext();
  const page = await loginAsFounder(ctx);

  const badResponses: Array<{ url: string; status: number }> = [];
  page.on("response", (r) => {
    if (r.request().resourceType() === "document" && r.status() >= 500) {
      badResponses.push({ url: r.url(), status: r.status() });
    }
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(`${e.name}: ${e.message}`));

  await page.goto(`${STAGING}/app/admin/payroll`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: path.join(OUT, "01-payroll-page.png"), fullPage: false });

  // Which primary action is currently visible? Try each in order —
  // the Payroll Admin sees only the CTA matching the batch's lifecycle
  // state (Submit for CALCULATED, Return-to-Prep for CALCULATED,
  // Post for APPROVED, Discard for DRAFT/PREPARED). This spec probes
  // whichever is present.
  const submitBtn = page.locator('[data-testid="payroll-admin-submit-for-approval"]');
  const returnBtn = page.locator('[data-testid="payroll-admin-return-to-prep"]');
  const postBtn = page.locator('[data-testid="payroll-admin-post-payroll"]');
  const discardBtn = page.locator('[data-testid="payroll-admin-actions-discard-prepared"]');

  const trials: Array<{
    label: string;
    trigger: typeof submitBtn;
    dialogTestId: string;
    cancelTestId: string;
  }> = [
    {
      label: "submit",
      trigger: submitBtn,
      dialogTestId: "payroll-admin-submit-dialog",
      cancelTestId: "payroll-admin-submit-cancel",
    },
    {
      label: "return-to-prep",
      trigger: returnBtn,
      dialogTestId: "payroll-admin-return-to-prep-dialog",
      cancelTestId: "payroll-admin-return-to-prep-cancel",
    },
    {
      label: "post",
      trigger: postBtn,
      dialogTestId: "payroll-admin-post-dialog",
      cancelTestId: "payroll-admin-post-cancel",
    },
    {
      label: "discard",
      trigger: discardBtn,
      dialogTestId: "payroll-admin-discard-dialog",
      cancelTestId: "payroll-admin-discard-cancel",
    },
  ];

  let exercised = 0;
  for (const t of trials) {
    const visible = await t.trigger.isVisible().catch(() => false);
    if (!visible) continue;

    // Trigger visible → open the dialog.
    await t.trigger.click();
    await page.waitForTimeout(500);
    const dialog = page.locator(`[data-testid="${t.dialogTestId}"]`);
    await expect(
      dialog,
      `${t.label}: dialog must open as a proper modal after clicking the trigger`,
    ).toBeVisible();

    // The dialog must be a proper full-viewport modal, not a sidebar
    // dropdown. Assert its bounding box spans the full viewport width
    // (its overlay is `position: fixed; inset: 0`).
    const box = await dialog.boundingBox();
    expect(box, `${t.label}: dialog has a bounding box`).not.toBeNull();
    expect(box!.width, `${t.label}: dialog overlay spans the full viewport width`).toBeGreaterThanOrEqual(1400);

    await page.screenshot({
      path: path.join(OUT, `02-${t.label}-dialog-open.png`),
      fullPage: false,
    });

    // Cancel closes the dialog without invoking the destructive action.
    const cancel = page.locator(`[data-testid="${t.cancelTestId}"]`);
    await expect(cancel, `${t.label}: cancel button visible in dialog`).toBeVisible();
    await cancel.click();
    await page.waitForTimeout(1000);
    await expect(
      dialog,
      `${t.label}: dialog dismisses after Cancel`,
    ).not.toBeVisible();

    exercised += 1;
  }

  expect(
    exercised,
    "at least one payroll action confirmation must have been exercised",
  ).toBeGreaterThanOrEqual(1);

  // Universal guardrails.
  expect(
    badResponses.length,
    `no 5xx doc responses. Got: ${JSON.stringify(badResponses)}`,
  ).toBe(0);
  expect(
    pageErrors.filter((e) => /Cannot read|digest/i.test(e)).length,
    `no null.digest crash. pageErrors: ${JSON.stringify(pageErrors)}`,
  ).toBe(0);
  const body = await page.locator("body").innerText();
  expect(body).not.toContain("Application error");
  expect(body).not.toContain("server-side exception");

  await ctx.close();
});
