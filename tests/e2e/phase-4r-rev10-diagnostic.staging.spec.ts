// Diagnostic-only. Fetch recent MAILBOX_MARK_READ jobs + any
// OutlookMarkReadMutation rows via the staging debug endpoint.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = "test-results/phase-4r-rev10-diagnostic";
fs.mkdirSync(OUT, { recursive: true });

test.describe("Rev-10 diagnostic", () => {
  const avail = stagingCredsAvailable();
  test.skip(!avail.ready, avail.reason ?? "creds missing");

  test("dump recent MAILBOX_MARK_READ jobs + mutations for the founder's fleet", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(ctx, { landing: "/app/admin" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(500);

    // Grab any card's email id to use as the probe key.
    const cards = page.locator('[data-testid="email-intake-card"]');
    const total = await cards.count();
    console.log(`[dump] cards visible = ${total}`);
    // Iterate a handful of card emails to see mutations across the fleet.
    const emailIds: string[] = [];
    for (let i = 0; i < Math.min(total, 5); i += 1) {
      const c = cards.nth(i);
      const emailId = await c.getAttribute("data-email-id");
      const workIntakeItemId = await c.getAttribute("data-work-intake-item-id");
      const unread = await c.getAttribute("data-unread");
      console.log(`[dump] card ${i} — intake=${(workIntakeItemId ?? "").slice(-8)} email=${(emailId ?? "").slice(-8)} unread=${unread}`);
      if (emailId) emailIds.push(emailId);
    }

    // Query the debug endpoint for each. First one carries the
    // recent-jobs list (same for the whole club).
    for (const emailId of emailIds) {
      const res = await page.request.get(
        `${avail.baseURL}/api/staging/outlook-mark-read-status?emailMessageId=${encodeURIComponent(emailId)}`,
      );
      const body = await res.json();
      console.log(`[dump] email=${emailId.slice(-8)} =>`, JSON.stringify({
        status: res.status(),
        email: body.email ? { isRead: body.email.isRead } : null,
        origins: body.origins?.map((o: { role: string; workIntakeItemId: string }) => ({
          role: o.role, wiTail: o.workIntakeItemId.slice(-8),
        })),
        mutation: body.mutation,
        recentJobsCount: body.recentJobs?.length,
        flag: body.featureFlags?.isEmailMarkReadOnInteractionEnabled,
      }));
      if (body.recentJobs?.length) {
        console.log(`[dump] recentJobs sample:`, JSON.stringify(body.recentJobs[0]));
      }
    }
    // Guarantee at least one query happened.
    expect(emailIds.length).toBeGreaterThan(0);
    await ctx.close();
  });
});
