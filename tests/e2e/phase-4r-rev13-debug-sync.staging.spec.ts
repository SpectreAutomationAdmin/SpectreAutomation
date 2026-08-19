// Quick diag: check if the mailboxSync + email.lastSyncedAt advanced
// after the recent INITIAL_SYNC — that will tell us if the ingest path
// actually touched #221007's row.
import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

test.describe("rev-13 sync-run diag", () => {
  const avail = stagingCredsAvailable();
  test.skip(!avail.ready, avail.reason ?? "creds missing");
  test("check lastSyncedAt vs mailboxSync.lastSuccessfulSyncAt for #221007", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(ctx, { landing: "/app/admin" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(500);
    const cards = page.locator('[data-testid="email-intake-card"]');
    for (let i = 0; i < await cards.count(); i += 1) {
      const title = ((await cards.nth(i).locator("h3").first().textContent().catch(() => "")) ?? "").trim();
      if (title.includes("#221007")) {
        const emailId = await cards.nth(i).getAttribute("data-email-id");
        const res = await page.request.get(
          `${avail.baseURL}/api/staging/outlook-mark-read-status?emailMessageId=${encodeURIComponent(emailId!)}&probeGraph=1`,
        );
        const body = await res.json();
        console.log(JSON.stringify({
          email: body.email,
          mailboxSync: body.mailboxSync,
          graphProbe: body.graphProbe,
        }, null, 2));
        expect(body.email).toBeTruthy();
        break;
      }
    }
    await ctx.close();
  });
});
