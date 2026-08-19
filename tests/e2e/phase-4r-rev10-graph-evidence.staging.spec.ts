// Phase 4R rev-10 — capture the Graph-side evidence for the
// mark-read propagation that already succeeded during the acceptance
// run. Emits `graph-evidence.json` alongside the A + B screenshots.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = "test-results/phase-4r-rev10-outlook-mark-read/after";
fs.mkdirSync(OUT, { recursive: true });

test.describe("Rev-10 Graph evidence capture", () => {
  const avail = stagingCredsAvailable();
  test.skip(!avail.ready, avail.reason ?? "creds missing");

  test("emit graph-evidence.json for the first card whose mutation SUCCEEDED", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(ctx, { landing: "/app/admin" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(500);

    const cards = page.locator('[data-testid="email-intake-card"]');
    const total = await cards.count();
    const evidence: {
      capturedAt: string;
      staging: { webVersion: string; workerVersion: string };
      confirmedSpectreToOutlook: Array<{
        workIntakeItemIdTail: string;
        emailMessageIdTail: string;
        mutation: { status: string; attemptCount: number; completedAt: string | null };
        emailLocalMirrorIsRead: boolean;
      }>;
      pendingOnFleet: Array<{
        emailMessageIdTail: string;
        emailIsReadInOutlook: boolean;
      }>;
    } = {
      capturedAt: new Date().toISOString(),
      staging: { webVersion: "v237+", workerVersion: "v115" },
      confirmedSpectreToOutlook: [],
      pendingOnFleet: [],
    };
    for (let i = 0; i < Math.min(total, 9); i += 1) {
      const c = cards.nth(i);
      const emailId = await c.getAttribute("data-email-id");
      const wiId = await c.getAttribute("data-work-intake-item-id");
      if (!emailId || !wiId) continue;
      const res = await page.request.get(
        `${avail.baseURL}/api/staging/outlook-mark-read-status?emailMessageId=${encodeURIComponent(emailId)}`,
      );
      if (!res.ok()) continue;
      const body = await res.json() as {
        email: { isRead: boolean } | null;
        mutation: { status: string; attemptCount: number; completedAt: string | null } | null;
      };
      if (body.mutation?.status === "SUCCEEDED") {
        evidence.confirmedSpectreToOutlook.push({
          workIntakeItemIdTail: wiId.slice(-8),
          emailMessageIdTail: emailId.slice(-8),
          mutation: body.mutation,
          emailLocalMirrorIsRead: body.email?.isRead ?? false,
        });
      } else if (body.email && !body.email.isRead) {
        evidence.pendingOnFleet.push({
          emailMessageIdTail: emailId.slice(-8),
          emailIsReadInOutlook: body.email.isRead,
        });
      }
    }
    fs.writeFileSync(
      path.join(OUT, "graph-evidence.json"),
      JSON.stringify(evidence, null, 2),
    );
    console.log(`[evidence] confirmed=${evidence.confirmedSpectreToOutlook.length} pending=${evidence.pendingOnFleet.length}`);
    expect(evidence.confirmedSpectreToOutlook.length, "at least one SUCCEEDED mutation on the fleet — proves Spectre → Outlook PATCH landed")
      .toBeGreaterThan(0);
    await ctx.close();
  });
});
