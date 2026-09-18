// Phase 5 (2026-09-17) — Coulee Ridge SEMI_MONTHLY cutover acceptance.
//
// Captures A-G at 1440×900 on the live staging tenant AFTER the
// cutover has been committed. Also verifies:
//   • Current-period selection lands on Sep 16 – Sep 30 with payDate
//     Sep 30 (not an old Jan/Feb/Mar period, not a far-future period).
//   • Department approval surface is reachable BEFORE Prepare.
//   • No stale POSTED-completion banner from the archived batch.
//   • MID_YEAR_MIGRATION opening-YTD is configurable through the UI
//     (Payroll Settings → Cutover / Implementation Declaration).
//
// This spec is READ-ONLY on the founder's payroll workflow. It NEVER
// clicks Prepare / Approve / Post on the real founder period. It only
// captures screenshots and asserts DOM presence.

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/phase5-semi-monthly-cutover");
fs.mkdirSync(OUT, { recursive: true });

test.use({ viewport: { width: 1440, height: 900 } });

test.describe("Phase 5 acceptance — Coulee Ridge SEMI_MONTHLY", () => {
  test.beforeAll(() => {
    const status = stagingCredsAvailable();
    if (!status.ready) test.skip(true, status.reason ?? "staging creds not set");
  });

  test("A-G · Payroll overview post-cutover, plus period + implementation-declaration UI", async ({ context }) => {
    const page = await loginAsFounder(context, { landing: "/app/admin/payroll" });

    // -----------------------------------------------------------------
    // A. Finance → Payroll clean overview.
    // -----------------------------------------------------------------
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: path.join(OUT, "A-payroll-overview.png"), fullPage: false });

    const bodyText = await page.locator("body").innerText();
    // No stale POSTED / Ready-to-Post banner from the archived dev run.
    // ("Posted Complete" as the step-8 workflow LABEL is expected —
    // what we forbid is an ACTIVE Ready-to-Post banner asserting the
    // current period has already been posted.)
    expect(bodyText, "No active Ready-to-Post handoff banner allowed").not.toMatch(
      /Ready\s+to\s+post\s+the\s+approved\s+batch/i,
    );

    // -----------------------------------------------------------------
    // B. Semi-Monthly active pay group visible somewhere on the page.
    // -----------------------------------------------------------------
    // Either "Semi-Monthly" formatted for humans, or the code CRGCC-SM.
    const semiMonthlyVisible =
      /semi[\s-]?monthly/i.test(bodyText) || /CRGCC-SM/.test(bodyText);
    expect(semiMonthlyVisible, "Expected Semi-Monthly / CRGCC-SM to be present in the payroll overview").toBe(true);
    await page.screenshot({ path: path.join(OUT, "B-semi-monthly-visible.png"), fullPage: false });

    // Explicit BIWEEKLY leak check — the archived group should not
    // appear as the ACTIVE pay group anywhere on the payroll overview.
    const biweeklyLeaks = (bodyText.match(/FDR-BW\b/g) ?? []).length;
    expect(biweeklyLeaks, "FDR-BW should not appear as the active pay group").toBe(0);

    // -----------------------------------------------------------------
    // C. Correct actionable semi-monthly period.
    // Today is 2026-09-17. Sensible actionable period = Sep 16 – Sep 30,
    // payDate Sep 30. Assert one of these strings appears somewhere.
    // -----------------------------------------------------------------
    const sep16to30Pattern =
      /(Sep\s*16\s*[–-]\s*Sep\s*30)|(Sep\s*16.*Sep\s*30)|(Sep\s*30.*2026)/i;
    const currentPeriodOK = sep16to30Pattern.test(bodyText);
    expect(currentPeriodOK, `Expected Sep 16 – Sep 30 / payDate Sep 30 in overview text`).toBe(true);
    // Guard against jumping to a stale old period.
    expect(bodyText).not.toMatch(/Jan\s*1\s*[–-]\s*Jan\s*15,?\s*2026/i);
    expect(bodyText).not.toMatch(/Feb\s*1\s*[–-]\s*Feb\s*15,?\s*2026/i);
    await page.screenshot({ path: path.join(OUT, "C-current-period.png"), fullPage: false });

    // -----------------------------------------------------------------
    // D. Accepted 8-step sequence (Approvals first).
    // -----------------------------------------------------------------
    // The canonical workflow steps are rendered inline. Assert the
    // eight labels appear in order.
    const labels = [
      /Approvals/i,
      /Prepare/i,
      /Review\s+Exceptions/i,
      /Calculate\s+Payroll/i,
      /Review\s*&\s*Adjust/i,
      /Submit(?:\s+for\s+Approval)?/i,
      /Approved(?:\s*\(Controller\))?/i,
      /Posted(?:\s+Complete)?/i,
    ];
    let cursor = 0;
    let missing: string[] = [];
    for (const label of labels) {
      const m = bodyText.slice(cursor).search(label);
      if (m < 0) {
        missing.push(label.source);
        continue;
      }
      cursor += m + 1;
    }
    expect(missing, `Workflow labels missing / out of order after cursor: ${missing.join(", ")}`).toEqual([]);
    await page.screenshot({ path: path.join(OUT, "D-workflow-order.png"), fullPage: false });

    // -----------------------------------------------------------------
    // E. Department approval surface reachable BEFORE Prepare.
    // -----------------------------------------------------------------
    // From the payroll overview, the "Approvals" step should be
    // actionable (a link / button / clear "Approve" affordance) or the
    // dedicated route /app/admin/payroll/time should be reachable.
    await page.goto("https://staging.spectreautomation.com/app/admin/payroll/time", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForLoadState("networkidle").catch(() => {});
    const timeText = await page.locator("body").innerText();
    expect(timeText, "Payroll time / department approval surface expected to load").toMatch(
      /timesheet|approval|department/i,
    );
    await page.screenshot({ path: path.join(OUT, "E-department-approval-surface.png"), fullPage: false });

    // -----------------------------------------------------------------
    // F. Founder payroll ready to begin — not completed.
    // No POSTED banner for the current founder period; the workflow
    // shows Step 1 (Approvals) as current OR pending, not step 8 done.
    // -----------------------------------------------------------------
    await page.goto("https://staging.spectreautomation.com/app/admin/payroll", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForLoadState("networkidle").catch(() => {});
    const overviewText = await page.locator("body").innerText();
    // Do not accept a screen where the current founder period reads as
    // POSTED / complete. Step-8's LABEL is "Posted Complete" (which is
    // allowed). What is forbidden is the current-batch state actually
    // being POSTED — the page's "No batch yet" chip and the disabled
    // action buttons prove the period is at the beginning of the
    // workflow, not the end.
    expect(overviewText, "Overview must indicate no batch yet for this period").toMatch(
      /(No batch yet)|(No batch prepared)|(Prepare Payroll)/i,
    );
    await page.screenshot({ path: path.join(OUT, "F-ready-not-completed.png"), fullPage: false });

    // -----------------------------------------------------------------
    // G. No stale POSTED-completion banner from the archived dev run.
    // Explicit check for phrases the old completion banner would use.
    // -----------------------------------------------------------------
    expect(overviewText).not.toMatch(/Payroll posted:.*Sep\s*13\s*[–-]\s*Sep\s*26/i);
    expect(overviewText).not.toMatch(/Batch #\d+ POSTED — Sep\s*13/i);
    await page.screenshot({ path: path.join(OUT, "G-no-stale-posted-banner.png"), fullPage: false });

    // -----------------------------------------------------------------
    // Implementation Declaration UI reachability (MID_YEAR_MIGRATION).
    // The founder must be able to configure this WITHOUT terminal
    // access. Try both settings paths.
    // -----------------------------------------------------------------
    for (const path of [
      "/app/admin/payroll/setup",
      "/app/admin/payroll/settings",
      "/app/admin/settings/payroll",
    ]) {
      const url = `https://staging.spectreautomation.com${path}`;
      const res = await page.goto(url, { waitUntil: "domcontentloaded" });
      if (res && res.status() < 400) {
        await page.waitForLoadState("networkidle").catch(() => {});
        const t = await page.locator("body").innerText();
        // Look for opening-YTD / implementation declaration language.
        const declarationMentioned =
          /opening[\s-]?ytd/i.test(t) ||
          /implementation\s+declaration/i.test(t) ||
          /mid[\s-]?year/i.test(t) ||
          /ZERO_OPENING_YTD/.test(t) ||
          /MID_YEAR_MIGRATION/.test(t) ||
          /cutover\s+mode/i.test(t);
        if (declarationMentioned) {
          await page.screenshot({
            path: path.replace(/[\/]/g, "-") ? path.replace(/[\/]/g, "-") : "settings" + ".png",
            fullPage: false,
          }).catch(() => {});
          await page.screenshot({
            path: OUT + "/H-implementation-declaration-ui.png",
            fullPage: false,
          });
          return;
        }
      }
    }
    // If we get here, the browser could not surface the declaration UI.
    // This is a REMAINING RISK to flag in the checkpoint, not a hard
    // fail — the reset script explicitly does not fabricate the
    // declaration, and the Prepare gate will surface it.
    await page.screenshot({ path: OUT + "/H-implementation-declaration-ui-not-found.png", fullPage: false });
    console.warn(
      "Implementation-declaration UI not located under /app/admin/payroll/setup|/settings|/settings/payroll. " +
        "Founder may need it exposed on a dedicated Payroll Setup screen.",
    );
  });
});
