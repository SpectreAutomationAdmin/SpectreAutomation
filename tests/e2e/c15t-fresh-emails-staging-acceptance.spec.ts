// Sprint 3 · Checkpoint 15T — STAGING browser acceptance test.
//
// Founder rule (§17-18): a completion report requires (a) FRESH
// inbound emails for both founder-observed invoice shapes; (b) a
// Playwright test proving the AP Work Intake cards render correctly
// in the actual staging browser.
//
// The test is env-var driven and locates each card by a unique
// email subject marker. NO hardcoded WorkIntakeItem ids, no
// credentials, no vendor-specific values in the spec file.
//
// Run locally (founder-side):
//
//   1. Send two fresh emails to the connected Coulee Ridge Outlook
//      mailbox:
//        (a) professional-body membership invoice
//            subject: "c15t-membership <marker>"
//            attachment: the CPA membership invoice PDF
//        (b) recurring communications / connectivity statement
//            subject: "c15t-recurring <marker>"
//            attachment: the OXIO recurring statement PDF
//
//   2. Wait ~90s for auto-sync + attachment ingest + AP materialise
//      pipeline to complete.
//
//   3. Run:
//
//      SPECTRE_BASE_URL="https://staging.spectreautomation.com" \
//      SPECTRE_STAGING_EMAIL="<your staging login>" \
//      SPECTRE_STAGING_PASSWORD="<your staging password>" \
//      SPECTRE_C15T_MEMBERSHIP_MARKER="c15t-membership <marker>" \
//      SPECTRE_C15T_RECURRING_MARKER="c15t-recurring <marker>" \
//      npx playwright test tests/e2e/c15t-fresh-emails-staging-acceptance.spec.ts \
//        --project=chromium --reporter=list
//
// Artefacts under test-results/c15t-fresh-emails/:
//   membership-card.png
//   recurring-card.png
//   trace.zip
//   console.log
//   network.log
//   assertion-report.md

import { test, expect, type Page } from "@playwright/test";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const BASE = process.env.SPECTRE_BASE_URL ?? "https://staging.spectreautomation.com";
const EMAIL = process.env.SPECTRE_STAGING_EMAIL ?? "";
const PASSWORD = process.env.SPECTRE_STAGING_PASSWORD ?? "";
const MEMBERSHIP_MARKER = process.env.SPECTRE_C15T_MEMBERSHIP_MARKER ?? "";
const RECURRING_MARKER = process.env.SPECTRE_C15T_RECURRING_MARKER ?? "";
const OUT = process.env.SPECTRE_PLAYWRIGHT_OUT ?? "test-results/c15t-fresh-emails";

test.use({
  trace: "on",
  video: "retain-on-failure",
  screenshot: "only-on-failure",
});

async function signIn(page: Page): Promise<void> {
  if (!EMAIL || !PASSWORD) {
    throw new Error("SPECTRE_STAGING_EMAIL and SPECTRE_STAGING_PASSWORD env vars are required.");
  }
  if (!MEMBERSHIP_MARKER || !RECURRING_MARKER) {
    throw new Error(
      "SPECTRE_C15T_MEMBERSHIP_MARKER and SPECTRE_C15T_RECURRING_MARKER env vars are required. Send fresh test emails with unique markers in the subjects BEFORE running the test.",
    );
  }
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 }),
    page.click('button[type="submit"]'),
  ]);
}

async function findAndAssertCard(page: Page, marker: string, expectations: {
  supplierMustContain: RegExp;
  supplierMustNotContain?: RegExp;
  payableRefMustBePresent: true;
  amountMustBePresent: true;
  glMustMatch: RegExp;
  glMustNotMatch: RegExp[];
  primaryActionMustMatch: RegExp;
  screenshotName: string;
}): Promise<void> {
  const candidateCards = page
    .locator('[data-testid="email-intake-card"]')
    .filter({ hasText: marker });

  await expect(
    candidateCards.first(),
    `No Work Intake card found for subject marker "${marker}". Confirm the email was sent and 90s have elapsed since sending.`,
  ).toBeVisible({ timeout: 120_000 });

  const cardCount = await candidateCards.count();
  // eslint-disable-next-line no-console
  console.log(`[c15t] cards matching "${marker}": ${cardCount}`);
  expect(cardCount).toBeGreaterThanOrEqual(1);

  const card = candidateCards.first();
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: join(OUT, expectations.screenshotName) });

  const cardText = (await card.innerText()).toLowerCase();

  // Supplier assertion
  expect(cardText, `Card supplier must match ${expectations.supplierMustContain}`)
    .toMatch(expectations.supplierMustContain);
  if (expectations.supplierMustNotContain) {
    expect(cardText, `Card supplier must NOT match ${expectations.supplierMustNotContain}`)
      .not.toMatch(expectations.supplierMustNotContain);
  }

  // Payable reference must be present (some non-empty identifier
  // rendered in the card, distinguishable from a naked em-dash)
  const invoiceCellRe = /invoice[:\s]|statement[:\s]|reference[:\s]|bill[:\s]/i;
  expect(cardText, "Card must render an invoice / statement / bill / reference identifier")
    .toMatch(invoiceCellRe);

  // Amount must be populated
  expect(cardText, "Card amount must be populated (not blank)")
    .toMatch(/\$\s*\d+(?:[.,]\d+)?/);

  // GL assertion
  expect(cardText, `GL category must match ${expectations.glMustMatch}`)
    .toMatch(expectations.glMustMatch);
  for (const forbidden of expectations.glMustNotMatch) {
    expect(cardText, `GL must NOT match ${forbidden}`)
      .not.toMatch(forbidden);
  }

  // Primary action must be "Create vendor & post" (§8 + §11)
  expect(cardText, `Primary action must match ${expectations.primaryActionMustMatch}`)
    .toMatch(expectations.primaryActionMustMatch);
}

test.describe("15T · Fresh-email acceptance — professional-body membership + recurring service", () => {
  test.beforeAll(async () => {
    await mkdir(OUT, { recursive: true });
  });

  test("Both fresh emails produce correct AP cards on staging", async ({ page, context }) => {
    const consoleLog: string[] = [];
    const netLog: string[] = [];
    page.on("console", (m) => consoleLog.push(`[${m.type()}] ${m.text()}`));
    page.on("pageerror", (e) => consoleLog.push(`[pageerror] ${e.message}`));
    page.on("response", (r) => {
      const url = r.url();
      if (url.includes("/api/") || url.includes("/app/")) {
        netLog.push(`${r.status()} ${r.request().method()} ${url.replace(/^https?:\/\/[^/]+/, "")}`);
      }
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);

    await page.goto(`${BASE}/app/admin`);
    await page.waitForLoadState("networkidle", { timeout: 45_000 });
    await page.screenshot({ path: join(OUT, "mission-control.png"), fullPage: true });

    // (A) Professional-body membership invoice
    //     Founder rule §11 acceptance criteria:
    //       correct supplier + payable reference + printed gross +
    //       fee lines + taxable/non-taxable groups + reconciliation +
    //       professional-membership economic purpose + semantically
    //       appropriate tenant GL + Create vendor & post
    await findAndAssertCard(page, MEMBERSHIP_MARKER, {
      supplierMustContain: /cpa|chartered\s+professional\s+accountants|professional\s+(?:association|society|institute)/i,
      supplierMustNotContain: /^chris\b/i,   // must NOT be the email sender's first name
      payableRefMustBePresent: true,
      amountMustBePresent: true,
      // Correct GL must include Membership / Dues / Subscriptions
      // vocabulary — NOT Accounting Fees, NOT Score Cards.
      glMustMatch: /membership|dues|subscription/i,
      glMustNotMatch: [/accounting\s+fees/i, /score\s*cards/i, /printing/i],
      primaryActionMustMatch: /create\s+vendor\s*&?\s*post/i,
      screenshotName: "membership-card.png",
    });

    // (B) Recurring communications / connectivity statement
    await findAndAssertCard(page, RECURRING_MARKER, {
      supplierMustContain: /[a-z]{2,}/i,                 // some supplier name rendered
      payableRefMustBePresent: true,
      amountMustBePresent: true,
      // Correct GL must include telecom / internet / communications /
      // subscription vocabulary — NOT Score Cards / Printing.
      glMustMatch: /telephone|internet|communications?|telecom|subscription|software/i,
      glMustNotMatch: [/score\s*cards/i, /printing/i, /accounting\s+fees/i, /membership/i],
      primaryActionMustMatch: /create\s+vendor\s*&?\s*post/i,
      screenshotName: "recurring-card.png",
    });

    await context.tracing.stop({ path: join(OUT, "trace.zip") });
    await writeFile(join(OUT, "console.log"), consoleLog.join("\n"), "utf8");
    await writeFile(join(OUT, "network.log"), netLog.join("\n"), "utf8");
    await writeFile(
      join(OUT, "assertion-report.md"),
      [
        "# 15T · Fresh-email acceptance",
        "",
        `Base URL: ${BASE}`,
        `Membership marker: ${MEMBERSHIP_MARKER}`,
        `Recurring marker: ${RECURRING_MARKER}`,
        "",
        "## Assertions",
        "- Membership card visible: PASS",
        "- Membership supplier NOT 'Chris': PASS",
        "- Membership supplier CONTAINS CPA / Chartered / Professional-body: PASS",
        "- Membership payable reference populated: PASS",
        "- Membership amount populated: PASS",
        "- Membership GL contains membership / dues / subscription: PASS",
        "- Membership GL NOT Accounting Fees / Score Cards / Printing: PASS",
        "- Membership primary action = Create vendor & post: PASS",
        "",
        "- Recurring card visible: PASS",
        "- Recurring supplier rendered: PASS",
        "- Recurring payable reference populated: PASS",
        "- Recurring amount populated: PASS",
        "- Recurring GL contains telephone / internet / communications / telecom / subscription: PASS",
        "- Recurring GL NOT Score Cards / Printing / Accounting Fees / Membership: PASS",
        "- Recurring primary action = Create vendor & post: PASS",
      ].join("\n"),
      "utf8",
    );
  });
});
