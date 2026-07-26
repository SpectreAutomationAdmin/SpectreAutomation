// Sprint 2 B3 screenshots — Connected Accounts states + Mission
// Control connect prompt. Uses fake `?_status=<STATUS>` support that
// the client component recognises via document.body.dataset — no,
// this script drives real states via URL params for the callback
// banner and captures the current (Not-connected) state directly.

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = "http://localhost:3000";
const OUT = "test-results/mailbox-b3";
fs.mkdirSync(OUT, { recursive: true });

async function login(page) {
  await page.goto(`${BASE}/login`);
  await page.locator(`form:has(input[name="email"][value="super@spectre.app"]) button`).first().click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
}

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await login(page);

  // 1 — Connected Accounts page, Not connected (default state)
  await page.goto(`${BASE}/app/user/settings/connected-accounts`);
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: path.join(OUT, "1-not-connected-1440.png"), fullPage: false });

  // 2 — Success banner after callback
  await page.goto(`${BASE}/app/user/settings/connected-accounts?mailbox=connected&cx=fake_id`);
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: path.join(OUT, "2-callback-success-1440.png"), fullPage: false });

  // 3 — Consent denied error banner
  await page.goto(`${BASE}/app/user/settings/connected-accounts?mailbox=error&error=oauth_denied_by_user`);
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: path.join(OUT, "3-callback-denied-1440.png"), fullPage: false });

  // 4 — Personal-account rejected error banner
  await page.goto(`${BASE}/app/user/settings/connected-accounts?mailbox=error&error=oauth_personal_account_rejected`);
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: path.join(OUT, "4-callback-personal-account-1440.png"), fullPage: false });

  // 5 — Replacement-required error banner
  await page.goto(`${BASE}/app/user/settings/connected-accounts?mailbox=error&error=active_personal_mailbox_replacement_required`);
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: path.join(OUT, "5-callback-replace-1440.png"), fullPage: false });

  // 6 — Mission Control with the connect prompt visible
  await page.goto(`${BASE}/app/admin`);
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: path.join(OUT, "6-mission-control-with-prompt-1440.png"), fullPage: false });
  // Tight crop of the rail's connect prompt.
  const promptBox = await page.locator("[data-testid='mission-control-connect-prompt']").boundingBox();
  if (promptBox) {
    await page.screenshot({
      path: path.join(OUT, "6b-mission-control-prompt-crop-1440.png"),
      clip: {
        x: Math.max(0, promptBox.x - 8),
        y: Math.max(0, promptBox.y - 8),
        width: promptBox.width + 16,
        height: promptBox.height + 16,
      },
    });
  }

  await ctx.close();
} finally {
  await browser.close();
}
console.log("done");
