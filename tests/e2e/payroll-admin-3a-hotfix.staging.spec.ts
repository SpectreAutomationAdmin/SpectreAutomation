// Payroll 3A hotfix (2026-09-11) — staging acceptance for the four
// UX + one salary-earning changes. Verifies the new UI wiring and
// the reverse-chronological horizon + status-suffix labels against
// Coulee Ridge's live data.
//
// This spec is READ-ONLY on staging. It does not click Prepare —
// the founder's manual acceptance path performs that click.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/payroll-admin-3a-hotfix-staging");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const FOUNDER_PP = "cmtjc2wud001bgnjugkqrdz2r"; // Aug 30 – Sep 12
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

test.use({ viewport: { width: 1440, height: 900 } });

test.describe.serial("Payroll 3A hotfix — staging", () => {
  test.setTimeout(180_000);

  test("A. Bare /app/admin/payroll resumes to the current pay period (not a distant future one)", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll`, { waitUntil: "networkidle" });
    // Confirm the header rendered a period — the resume algorithm
    // should never leave chosenPeriod null when historical periods
    // exist.
    await expect(page.getByTestId("payroll-admin-period-line")).toBeVisible();
    const periodLine = await page.getByTestId("payroll-admin-period-line").innerText();
    // Today is 2026-09-11 → current period is Aug 30 – Sep 12.
    // Regression guard: MUST NOT default to a Dec/Jan future period.
    expect(periodLine, `default period must not be a Dec/Jan far-future period, got: ${periodLine}`)
      .not.toMatch(/Dec 20, 2026|Jan 2, 2027|Jan 16, 2027|Dec 31, 2026/);
  });

  test("B. Page-size control is a real <select> with 10/25/50 options", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll?payPeriodId=${FOUNDER_PP}`, { waitUntil: "networkidle" });
    const pageSize = page.getByTestId("payroll-admin-page-size");
    await expect(pageSize).toBeVisible();
    const tag = await pageSize.evaluate((el) => el.tagName.toLowerCase());
    expect(tag).toBe("select");
    const options = await pageSize.locator("option").evaluateAll((els) => els.map((o) => (o as HTMLOptionElement).value));
    expect(options).toEqual(["10", "25", "50"]);
  });

  test("C. Change Period dropdown horizon — max one period beyond current (no Dec/Jan far-future rows)", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll?payPeriodId=${FOUNDER_PP}`, { waitUntil: "networkidle" });
    const changePeriod = page.getByTestId("payroll-admin-change-period");
    const labels = await changePeriod.locator("option").evaluateAll(
      (els) => els.map((o) => (o as HTMLOptionElement).textContent ?? ""),
    );
    // Parse each label's end date (portion after "– ").
    const endDatesMs = labels
      .map((l) => l.match(/–\s+([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => {
        const mo = MONTHS.indexOf(m[1]!);
        return Date.UTC(Number(m[3]), mo, Number(m[2]));
      });
    console.log("[horizon] option end dates:", endDatesMs.map((t) => new Date(t).toISOString().slice(0, 10)));
    // No option should end past Sep 26, 2026 (current + 1 next period
    // for Coulee's biweekly cadence). Guards against the old
    // "furthest-future" behaviour.
    const capMs = Date.UTC(2026, 8, 26); // Sep 26 2026
    for (const t of endDatesMs) {
      expect(t, `option end date ${new Date(t).toISOString().slice(0,10)} must not exceed Sep 26, 2026 horizon`).toBeLessThanOrEqual(capMs);
    }
  });

  test("D. Change Period options are reverse-chronological (newest first)", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll?payPeriodId=${FOUNDER_PP}`, { waitUntil: "networkidle" });
    const changePeriod = page.getByTestId("payroll-admin-change-period");
    const labels = await changePeriod.locator("option").evaluateAll(
      (els) => els.map((o) => (o as HTMLOptionElement).textContent ?? ""),
    );
    const endDatesMs = labels
      .map((l) => l.match(/–\s+([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => {
        const mo = MONTHS.indexOf(m[1]!);
        return Date.UTC(Number(m[3]), mo, Number(m[2]));
      });
    for (let i = 1; i < endDatesMs.length; i++) {
      expect(endDatesMs[i - 1]!).toBeGreaterThanOrEqual(endDatesMs[i]!);
    }
  });

  test("E. Every option label carries a batch-status suffix (' · No batch' or ' · <STATUS>')", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll?payPeriodId=${FOUNDER_PP}`, { waitUntil: "networkidle" });
    const changePeriod = page.getByTestId("payroll-admin-change-period");
    const labels = await changePeriod.locator("option").evaluateAll(
      (els) => els.map((o) => (o as HTMLOptionElement).textContent ?? ""),
    );
    for (const l of labels) {
      if (!l || /No pay periods available/i.test(l)) continue;
      expect(l, `option "${l}" must carry status suffix`).toMatch(/·\s+(DRAFT|PREPARED|CALCULATED|SUBMITTED_FOR_APPROVAL|APPROVED|POSTED|No batch)$/);
    }
  });

  test("F. Founder-period option carries a batch-status suffix ('No batch' or a domain status)", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll?payPeriodId=${FOUNDER_PP}`, { waitUntil: "networkidle" });
    const changePeriod = page.getByTestId("payroll-admin-change-period");
    const founderOption = changePeriod.locator(`option[value="${FOUNDER_PP}"]`);
    const label = await founderOption.innerText();
    expect(label).toContain("Aug 30");
    expect(label).toContain("Sep 12");
    // Founder may have already run Prepare during the earlier
    // acceptance path (batch → DRAFT). Either "No batch" or a
    // valid batch status is acceptable.
    expect(label).toMatch(/·\s+(No batch|DRAFT|PREPARED|CALCULATED|SUBMITTED_FOR_APPROVAL|APPROVED|POSTED)$/);
  });

  test("G. Prepare Payroll button UX — idle when unprepared; hidden when prepared", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll?payPeriodId=${FOUNDER_PP}`, { waitUntil: "networkidle" });
    const btn = page.getByTestId("payroll-admin-prepare");
    const btnCount = await btn.count();
    if (btnCount > 0) {
      // Unprepared branch: button must be visible, enabled, idle.
      await expect(btn).toBeVisible();
      await expect(btn).toBeEnabled();
      await expect(btn).toHaveText(/Prepare Payroll/);
      const pending = await btn.getAttribute("data-pending");
      expect(pending).toBe("false");
      const ariaBusy = await btn.getAttribute("aria-busy");
      expect(ariaBusy).toBe("false");
    } else {
      // Prepared branch: button correctly disappears once
      // view.hasBatch flips true.
      const badge = await page.getByTestId("payroll-admin-header").innerText();
      expect(badge).toMatch(/DRAFT|PREPARED|CALCULATED|SUBMITTED FOR APPROVAL|APPROVED|POSTED/);
    }
    await page.screenshot({ path: path.join(OUT, "staging-payroll-hotfix-founder-1440x900.png"), fullPage: false });
  });

  test("I. Employee gross pay is populated for salaried employees when a batch exists (post-v360 or backfilled)", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll?payPeriodId=${FOUNDER_PP}`, { waitUntil: "networkidle" });
    // Only assert when a batch exists — the empty state has no rows.
    const empty = await page.getByTestId("payroll-admin-employee-empty").count();
    if (empty > 0) {
      console.log("[gross-pay] founder period unprepared — skipping row assertion");
      return;
    }
    // Chris Turcato — salaried, full-period membership. Expect a
    // non-"—" gross pay value for the row.
    const chrisRow = page.locator('tr[data-testid^="payroll-admin-employee-row-"]', { hasText: "Chris Turcato" });
    await expect(chrisRow).toBeVisible();
    const rowCells = await chrisRow.locator("td").allInnerTexts();
    // Column index 6 (0-based) is Gross Pay per the table header.
    const gross = rowCells[6] ?? "";
    console.log(`[gross-pay] Chris row cells:`, rowCells);
    expect(gross, `Chris gross pay must be a dollar figure, not '—'; got '${gross}'`).toMatch(/^\$[\d,]+\.\d{2}$/);
  });

  test("H. Page-size dropdown default is 10; changing to 25 pushes ?pageSize=25 to URL", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto(`${STAGING}/app/admin/payroll?payPeriodId=${FOUNDER_PP}`, { waitUntil: "networkidle" });
    const pageSize = page.getByTestId("payroll-admin-page-size");
    await expect(pageSize).toHaveValue("10");
    await pageSize.selectOption("25");
    await page.waitForURL(/pageSize=25/, { timeout: 30_000 });
    expect(page.url()).toMatch(/pageSize=25/);
  });
});
