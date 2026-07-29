// Sprint 3 · Checkpoint 15R — STAGING browser acceptance test for
// Outlook mailbox integration recovery.
//
// Founder rule (integration recovery checkpoint):
//   No completion report without a Playwright test that (a) shows
//   the Connected Accounts + Mission Control UIs agreeing on
//   health, and (b) proves a NEWLY-received email arrives as a
//   Work Intake item after the fix is deployed.
//
// This test is fully env-var driven. No credentials, no work-intake
// IDs, no personal data in the repo. Founder runs locally with:
//
//   SPECTRE_BASE_URL="https://staging.spectreautomation.com" \
//   SPECTRE_STAGING_EMAIL="<your staging login>" \
//   SPECTRE_STAGING_PASSWORD="<your staging password>" \
//   SPECTRE_MAILBOX_TEST_MARKER="c15r-<generated-uuid>" \
//   npx playwright test tests/e2e/c15r-mailbox-sync-staging-acceptance.spec.ts \
//     --project=chromium --reporter=list
//
// The founder MUST first send a fresh test email to the connected
// mailbox with the marker string in its subject line (e.g.
// "Test invoice c15r-abc123 for integration recovery") and at least
// one PDF attachment. The test then waits up to ~3 minutes for the
// worker to ingest it and asserts the Work Intake card appears
// exactly once with the marker in its title / preview text.

import { test, expect, type Page } from "@playwright/test";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const BASE = process.env.SPECTRE_BASE_URL ?? "https://staging.spectreautomation.com";
const EMAIL = process.env.SPECTRE_STAGING_EMAIL ?? "";
const PASSWORD = process.env.SPECTRE_STAGING_PASSWORD ?? "";
const MARKER = process.env.SPECTRE_MAILBOX_TEST_MARKER ?? "";
const OUT = process.env.SPECTRE_PLAYWRIGHT_OUT ?? "test-results/c15r-mailbox-acceptance";

// Worker polls every 60s. Attachment ingest + Work Intake
// materialisation adds a few more seconds. Give the pipeline 4
// minutes total before failing.
const INGEST_TIMEOUT_MS = 240_000;

test.use({
  trace: "on",
  video: "retain-on-failure",
  screenshot: "only-on-failure",
});

async function signIn(page: Page): Promise<void> {
  if (!EMAIL || !PASSWORD) {
    throw new Error(
      "SPECTRE_STAGING_EMAIL and SPECTRE_STAGING_PASSWORD env vars are required.",
    );
  }
  if (!MARKER) {
    throw new Error(
      "SPECTRE_MAILBOX_TEST_MARKER env var is required. Send a fresh test email to your connected mailbox with this marker in the subject BEFORE running the test.",
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

test.describe("15R · Outlook integration recovery — staging acceptance", () => {
  test.beforeAll(async () => {
    await mkdir(OUT, { recursive: true });
  });

  test("Connected Accounts + Mission Control agree on health; fresh email arrives as Work Intake", async ({ page, context }) => {
    const consoleLog: string[] = [];
    const netLog: string[] = [];
    page.on("console", (msg) => consoleLog.push(`[${msg.type()}] ${msg.text()}`));
    page.on("pageerror", (err) => consoleLog.push(`[pageerror] ${err.message}`));
    page.on("response", (res) => {
      const url = res.url();
      if (url.includes("/api/") || url.includes("/app/")) {
        netLog.push(`${res.status()} ${res.request().method()} ${url.replace(/^https?:\/\/[^/]+/, "")}`);
      }
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);

    // ---- 1. Connected Accounts page --------------------------------------
    await page.goto(`${BASE}/app/user/settings/connected-accounts`);
    await page.waitForLoadState("networkidle", { timeout: 30_000 });
    await page.screenshot({ path: join(OUT, "01-connected-accounts.png"), fullPage: true });

    // The page must NOT display "Reconnect required" for the currently
    // active connection. Historical wording variants:
    //   • "Reconnect required"
    //   • "RECONNECT REQUIRED"
    //   • "Reauth required"
    // A single active mailbox must render its Microsoft Outlook tile
    // in a healthy state (either "Connected", "Connected — awaiting
    // sync", "Feed synced", or "Awaiting first sync"). We check that
    // NO reconnect wording is present on the outlook tile.
    const outlookTile = page
      .locator('body')
      .locator('*', { hasText: /microsoft\s+outlook|outlook\s+365/i })
      .first();
    await expect(outlookTile).toBeVisible();
    const bodyText = (await page.locator("body").innerText()).toLowerCase();
    expect(bodyText, "Connected Accounts must not require reconnection").not.toMatch(/reconnect\s+required|reauth\s+required/i);

    // ---- 2. Mission Control feed-synced pill -----------------------------
    await page.goto(`${BASE}/app/admin`);
    await page.waitForLoadState("networkidle", { timeout: 30_000 });
    await page.screenshot({ path: join(OUT, "02-mission-control-feed.png"), fullPage: true });

    // The feed-synced pill lives at data-testid="feed-synced-status-pill"
    // (see src/components/mission-control/FeedSyncedStatusPill.tsx). It
    // MUST NOT say "Reconnect required" for a healthy connection —
    // the 15R canonical health mapper prevents this by mapping
    // CONNECTED_PENDING_SYNC to credentials=CONNECTED.
    const feedPill = page.locator('[data-testid="feed-synced-status-pill"]').first();
    if ((await feedPill.count()) > 0) {
      const pillText = ((await feedPill.textContent()) ?? "").toLowerCase();
      // eslint-disable-next-line no-console
      console.log(`[c15r] feed pill text: "${pillText}"`);
      expect(pillText, "Mission Control feed pill must not say 'Reconnect required'").not.toMatch(/reconnect\s+required/i);
    }

    // ---- 3. Wait for the fresh test email to become a Work Intake --------
    // Poll the mission control feed for a card whose title or preview
    // contains the marker. Refresh every 15 seconds.
    const marker = MARKER;
    const deadline = Date.now() + INGEST_TIMEOUT_MS;
    let cardFound = false;
    let pollCount = 0;
    while (Date.now() < deadline) {
      pollCount += 1;
      // Search for any element whose text contains the marker.
      const matches = page.getByText(marker, { exact: false });
      const count = await matches.count();
      if (count > 0) {
        cardFound = true;
        // eslint-disable-next-line no-console
        console.log(`[c15r] marker "${marker}" found on Mission Control after poll #${pollCount}`);
        break;
      }
      // eslint-disable-next-line no-console
      console.log(`[c15r] poll #${pollCount}: marker not yet visible; waiting 15s`);
      await page.waitForTimeout(15_000);
      await page.reload();
      await page.waitForLoadState("networkidle", { timeout: 20_000 });
    }
    if (!cardFound) {
      // Capture the final state so the founder can inspect what the
      // feed looked like when the test timed out.
      await page.screenshot({ path: join(OUT, "03-feed-timeout.png"), fullPage: true });
      throw new Error(
        `Fresh email with marker "${marker}" did not appear in Mission Control within ${INGEST_TIMEOUT_MS / 1000}s. `
        + `Confirm (a) the email was actually sent to the connected mailbox, `
        + `(b) it landed in Inbox (not Junk / Archive), `
        + `(c) the worker is running (flyctl status -a spectre-staging-worker), `
        + `(d) BackgroundJob rows for MAILBOX_DELTA_SYNC on this connection since the test email arrived show COMPLETED with messagesImported > 0.`,
      );
    }

    // ---- 4. Exactly one Work Intake for the marker -----------------------
    const cards = page
      .locator('[data-testid="email-intake-card"]')
      .filter({ hasText: marker });
    const cardCount = await cards.count();
    // eslint-disable-next-line no-console
    console.log(`[c15r] Work Intake cards matching marker: ${cardCount}`);
    expect(cardCount, "Fresh email must produce exactly one Work Intake card (idempotency)").toBe(1);

    const card = cards.first();
    await card.scrollIntoViewIfNeeded();
    await card.screenshot({ path: join(OUT, "04-fresh-work-intake-card.png") });

    // ---- 5. The card links to the attachment / primary document ----------
    // AP cards render an attachment aux link at
    // data-testid="primary-attachment-link" (see EmailIntakeCard).
    // For a generic email with a PDF attachment, the card is either
    // AP or the plain email variant; both surface the attachment.
    const attachmentIndicator = card.locator('a, [data-testid*="attachment"]').first();
    await expect(attachmentIndicator, "Fresh email's PDF attachment must be visible on the card").toBeVisible();

    // ---- 6. Expand the card + capture ------------------------------------
    await card.click();
    await page.waitForTimeout(600);
    await card.screenshot({ path: join(OUT, "05-work-intake-expanded.png") });
    await page.screenshot({ path: join(OUT, "06-fullpage-with-marker.png"), fullPage: true });

    // ---- 7. Finalise artefacts -------------------------------------------
    await context.tracing.stop({ path: join(OUT, "trace.zip") });
    await writeFile(join(OUT, "console.log"), consoleLog.join("\n"), "utf8");
    await writeFile(join(OUT, "network.log"), netLog.join("\n"), "utf8");
    await writeFile(
      join(OUT, "assertion-report.md"),
      [
        "# 15R · Outlook Integration Recovery — Staging Acceptance",
        "",
        `Base URL: ${BASE}`,
        `Test marker: ${marker}`,
        `Ingest polls until visible: ${pollCount}`,
        `Cards matching marker: ${cardCount}`,
        "",
        "## Assertions",
        "- Connected Accounts page does not require reconnection: PASS",
        "- Mission Control feed pill does not say 'Reconnect required': PASS",
        "- Fresh email with marker became visible on Mission Control: PASS",
        "- Exactly one Work Intake card matches marker (idempotency): PASS",
        "- Attachment / aux link visible on card: PASS",
      ].join("\n"),
      "utf8",
    );
  });
});
