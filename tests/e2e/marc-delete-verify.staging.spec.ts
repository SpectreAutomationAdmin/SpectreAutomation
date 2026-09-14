// Pre-hire employee deletion hotfix — real founder-visible delete of Marc.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/marc-delete-hotfix");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

test.use({ viewport: { width: 1440, height: 900 } });

test("delete Marc through the real product path + verify directory", async ({ browser }) => {
  test.setTimeout(240_000);
  const ctx = await browser.newContext();
  const page = await loginAsFounder(ctx);
  const consoleErrors: string[] = [];
  page.on("pageerror", (e) => consoleErrors.push(`${e.name}: ${e.message}`));

  // 01 — Employee Directory shows Marc as PRE_HIRE.
  await page.goto(`${STAGING}/app/admin/people/employees`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const marcRow = page.locator('a', { hasText: /Marc/i }).first();
  await marcRow.click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, "01-marc-prehire-delete-eligible.png"), fullPage: false });

  // 02 — Delete confirmation.
  const deleteOpener = page.locator('[data-testid="employee-delete-button"]');
  await deleteOpener.scrollIntoViewIfNeeded();
  await deleteOpener.click();
  await page.waitForTimeout(800);
  const confirmInput = page.locator('[data-testid="employee-lifecycle-confirm-input"]');
  await confirmInput.fill("DELETE");
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, "02-marc-delete-confirmation.png"), fullPage: false });

  const confirmBtn = page.locator('[data-testid="employee-lifecycle-confirm-button"]');
  await confirmBtn.click();
  await page.waitForTimeout(5000);
  await page.screenshot({ path: path.join(OUT, "03-marc-delete-success-directory.png"), fullPage: false });

  const url = page.url();
  const finalText = await page.locator("body").innerText();

  // 04 — Reload and confirm Marc absent.
  await page.goto(`${STAGING}/app/admin/people/employees`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(OUT, "04-directory-after-reload.png"), fullPage: false });
  const dirText = await page.locator("body").innerText();
  expect(dirText, `Marc should be absent from the directory. Body: ${dirText.slice(0, 800)}`)
    .not.toContain("Marc");
  expect(dirText).toContain("Chris Turcato");

  // No client-side crashes.
  expect(consoleErrors.filter((e) => /Cannot read|TypeError/.test(e)).length,
    `No client exceptions. Got: ${JSON.stringify(consoleErrors)}`).toBe(0);

  await ctx.close();
});
