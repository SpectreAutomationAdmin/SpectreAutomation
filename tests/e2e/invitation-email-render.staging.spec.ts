// Payroll-readiness hotfix — visual proof for the initial vs resent
// tenant invitation email. Loads pre-rendered composer output from
// test-results/payroll-readiness-hotfix/{04-initial,05-resent}.html
// (produced by scripts/render-invitation-emails.mjs at run time) and
// screenshots them at Gmail-preview-pane viewport dimensions.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/payroll-readiness-hotfix");
test.use({ viewport: { width: 760, height: 1000 } });

test("email composer · initial invitation render", async ({ browser }) => {
  const htmlPath = path.join(OUT, "04-initial.html");
  expect(fs.existsSync(htmlPath), `run render-invitation-emails.mjs first: ${htmlPath}`).toBe(true);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`file://${htmlPath.replace(/\\/g, "/")}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, "04-initial-tenant-invite-email.png"), fullPage: true });
  const body = await page.locator("body").innerText();
  expect(body).toContain("You've been invited.");
  expect(body).toContain("Chris Turcato has invited you");
  expect(body).toContain("Continue to accept");
  await ctx.close();
});

test("email composer · resent invitation render (distinct headline + preamble)", async ({ browser }) => {
  const htmlPath = path.join(OUT, "05-resent.html");
  expect(fs.existsSync(htmlPath), `run render-invitation-emails.mjs first: ${htmlPath}`).toBe(true);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`file://${htmlPath.replace(/\\/g, "/")}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, "05-resent-tenant-invite-email.png"), fullPage: true });
  const body = await page.locator("body").innerText();
  expect(body).toContain("Here's your new invitation.");
  expect(body).toContain("fresh invitation link");
  expect(body).toContain("Continue to accept");
  // Resent variant has a distinct headline — must not include the initial one.
  expect(body).not.toContain("You've been invited.");
  await ctx.close();
});
