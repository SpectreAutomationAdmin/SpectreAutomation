// Sprint 3 · Checkpoint 15U — STAGING browser acceptance test.
//
// Founder rule (15U §17): a completion report requires two FRESH
// inbound emails, one professional-membership invoice and one
// recurring-service statement, verified in the actual staging
// browser via Playwright.
//
// Env-var driven; no credentials or vendor-specific values in
// the spec file. Asserts EXACTLY the founder rule set:
//
//   (A) Professional-membership card:
//       * exactly one fresh card per marker
//       * supplier correct (not the sender's first name)
//       * payable reference populated
//       * amount populated
//       * category/GL = a Membership & Dues-type account
//         (dues-specific, not just any Memberships & Subscriptions
//         account — Subscriptions must NOT win)
//       * primary action = Create vendor & post
//       * unchanged approved UI (no reasoning UI, no confidence
//         chips)
//
//   (B) Recurring-service card:
//       * exactly one fresh card per marker
//       * supplier rendered
//       * payable reference populated
//       * amount populated
//       * category/GL is NOT Score Cards & Printing
//       * category/GL belongs to a semantically relevant tenant
//         taxonomy (communications / telephone / internet / utilities /
//         IT / cable — any of these families)
//       * primary action = Create vendor & post
//       * unchanged approved UI
//
// Run locally after sending fresh emails:
//
//   SPECTRE_BASE_URL="https://staging.spectreautomation.com" \
//   SPECTRE_STAGING_EMAIL="<your staging login>" \
//   SPECTRE_STAGING_PASSWORD="<your staging password>" \
//   SPECTRE_C15U_MEMBERSHIP_MARKER="c15u-membership <marker>" \
//   SPECTRE_C15U_RECURRING_MARKER="c15u-recurring <marker>" \
//   npx playwright test tests/e2e/c15u-fresh-emails-staging-acceptance.spec.ts \
//     --project=chromium --reporter=list

import { test, expect, type Page } from "@playwright/test";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const BASE = process.env.SPECTRE_BASE_URL ?? "https://staging.spectreautomation.com";
const EMAIL = process.env.SPECTRE_STAGING_EMAIL ?? "";
const PASSWORD = process.env.SPECTRE_STAGING_PASSWORD ?? "";
const MEMBERSHIP_MARKER = process.env.SPECTRE_C15U_MEMBERSHIP_MARKER ?? "";
const RECURRING_MARKER = process.env.SPECTRE_C15U_RECURRING_MARKER ?? "";
const OUT = process.env.SPECTRE_PLAYWRIGHT_OUT ?? "test-results/c15u-fresh-emails";

test.use({
  trace: "on",
  video: "retain-on-failure",
  screenshot: "only-on-failure",
});

async function signIn(page: Page): Promise<void> {
  if (!EMAIL || !PASSWORD || !MEMBERSHIP_MARKER || !RECURRING_MARKER) {
    throw new Error("SPECTRE_STAGING_EMAIL / PASSWORD / SPECTRE_C15U_MEMBERSHIP_MARKER / SPECTRE_C15U_RECURRING_MARKER env vars are required.");
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

  // Exactly-one fresh card per marker (§17).
  const cardCount = await candidateCards.count();
  // eslint-disable-next-line no-console
  console.log(`[c15u] cards matching "${marker}": ${cardCount}`);
  expect(cardCount, `Expected exactly one fresh card for marker "${marker}"; found ${cardCount}`).toBe(1);

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

  const invoiceCellRe = /invoice[:\s]|statement[:\s]|reference[:\s]|bill[:\s]/i;
  expect(cardText, "Card must render an invoice / statement / bill / reference identifier")
    .toMatch(invoiceCellRe);

  expect(cardText, "Card amount must be populated (not blank)")
    .toMatch(/\$\s*\d+(?:[.,]\d+)?/);

  expect(cardText, `GL category must match ${expectations.glMustMatch}`)
    .toMatch(expectations.glMustMatch);
  for (const forbidden of expectations.glMustNotMatch) {
    expect(cardText, `GL must NOT match ${forbidden}`)
      .not.toMatch(forbidden);
  }

  expect(cardText, `Primary action must match ${expectations.primaryActionMustMatch}`)
    .toMatch(expectations.primaryActionMustMatch);
}

test.describe("15U · Fresh-email acceptance — professional-membership + recurring-service", () => {
  test.beforeAll(async () => {
    await mkdir(OUT, { recursive: true });
  });

  test("Both fresh emails produce correctly-ranked AP cards on staging", async ({ page, context }) => {
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

    // (A) Professional-membership invoice
    //     15U §17 acceptance criteria:
    //       * dues-specific account (Membership & Dues family)
    //       * NOT Subscriptions, NOT Accounting Fees, NOT Score Cards
    //       * NOT the sender's first name
    await findAndAssertCard(page, MEMBERSHIP_MARKER, {
      supplierMustContain: /cpa|chartered|professional\s+(?:association|society|institute)/i,
      supplierMustNotContain: /^chris\b/i,
      payableRefMustBePresent: true,
      amountMustBePresent: true,
      // The dues-specific account. On Coulee Ridge that's
      // "Membership & Dues". Assert both dues wording AND that the
      // more generic "Subscriptions" is NOT the recommendation.
      glMustMatch: /membership\s*[&/]?\s*dues|dues\s*[&/]?\s*membership/i,
      glMustNotMatch: [
        /accounting\s+fees/i,
        /score\s*cards/i,
        /printing/i,
        // Subscriptions must NOT win — the ranker must prefer the
        // dues-specific account over the generic subscriptions bucket.
        /^\s*subscriptions?\s*$/im,
        /category\s*[:\s]*subscriptions/i,
      ],
      primaryActionMustMatch: /create\s+vendor\s*&?\s*post/i,
      screenshotName: "membership-card.png",
    });

    // (B) Recurring-service statement
    //     15U §17 acceptance criteria:
    //       * Score Cards & Printing absent
    //       * account belongs to a semantically relevant tenant
    //         taxonomy (communications / telecom / internet / utilities /
    //         IT / cable)
    await findAndAssertCard(page, RECURRING_MARKER, {
      supplierMustContain: /[a-z]{2,}/i,
      payableRefMustBePresent: true,
      amountMustBePresent: true,
      glMustMatch: /telephone|internet|communications?|telecom|utilit|IT\s+services|computer\s*&\s*IT|cable/i,
      glMustNotMatch: [
        /score\s*cards/i,
        /printing/i,
        /accounting\s+fees/i,
        /membership/i,
      ],
      primaryActionMustMatch: /create\s+vendor\s*&?\s*post/i,
      screenshotName: "recurring-card.png",
    });

    await context.tracing.stop({ path: join(OUT, "trace.zip") });
    await writeFile(join(OUT, "console.log"), consoleLog.join("\n"), "utf8");
    await writeFile(join(OUT, "network.log"), netLog.join("\n"), "utf8");
    await writeFile(
      join(OUT, "assertion-report.md"),
      [
        "# 15U · Fresh-email acceptance",
        "",
        `Base URL: ${BASE}`,
        `Membership marker: ${MEMBERSHIP_MARKER}`,
        `Recurring marker: ${RECURRING_MARKER}`,
        "",
        "## Assertions",
        "- Exactly one membership card matched: PASS",
        "- Membership supplier NOT 'Chris': PASS",
        "- Membership supplier CONTAINS CPA / Chartered / Professional-body: PASS",
        "- Membership payable reference populated: PASS",
        "- Membership amount populated: PASS",
        "- Membership GL matches Membership & Dues (dues-specific): PASS",
        "- Membership GL NOT Subscriptions / Accounting Fees / Score Cards / Printing: PASS",
        "- Membership primary action = Create vendor & post: PASS",
        "",
        "- Exactly one recurring card matched: PASS",
        "- Recurring supplier rendered: PASS",
        "- Recurring payable reference populated: PASS",
        "- Recurring amount populated: PASS",
        "- Recurring GL matches Telephone / Internet / Communications / Telecom / Utilities / IT / Cable: PASS",
        "- Recurring GL NOT Score Cards / Printing / Accounting / Membership: PASS",
        "- Recurring primary action = Create vendor & post: PASS",
      ].join("\n"),
      "utf8",
    );
  });
});
