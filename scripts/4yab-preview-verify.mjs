#!/usr/bin/env node
// EP-TRAIN-4Y-AB §8 (2026-11-10) — verify Preview-as-employee opens
// the CORRECT course + version.
//
// Visits /app/admin/people/safety-training/<COURSE>/<VERSION>/preview-as-employee
// and asserts that the rendered page is scoped to the pilot course
// (title "Employee Onboarding and Policies" + version id in the URL),
// NOT a different / unrelated course like "Equipment Safety".
//
// Also captures a screenshot so the acceptance report has evidence.

import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = "https://staging.spectreautomation.com";
const COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";
const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";
const EXPECTED_TITLE = "Employee Onboarding and Policies";

function env(k) {
  if (process.env[k]) return process.env[k];
  for (const f of [".env.playwright.local", ".env.local"]) {
    const p = path.join(process.cwd(), f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)\s*$/);
      if (m && m[1] === k) return m[2].replace(/^["']|["']$/g, "");
    }
  }
  return null;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[name="email"]', env("SPECTRE_STAGING_EMAIL"));
  await page.fill('input[name="password"]', env("SPECTRE_STAGING_PASSWORD"));
  await Promise.all([
    page.waitForURL(/\/app\//, { timeout: 30_000 }),
    page.click('button[type="submit"]'),
  ]);

  const url = `${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/preview-as-employee`;
  console.log(`→ ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  const rendered = {
    url: page.url(),
    finalPathname: new URL(page.url()).pathname,
    containsCourseId: page.url().includes(COURSE_ID),
    containsVersionId: page.url().includes(VERSION_ID),
    title: await page.title(),
    h1: await page.locator("h1").first().textContent().catch(() => null),
    pageBodySample: (await page.locator("main").innerText().catch(() => "")).slice(0, 500),
  };
  rendered.showsExpectedCourse = (rendered.pageBodySample ?? "").toLowerCase().includes(EXPECTED_TITLE.toLowerCase())
    || (rendered.h1 ?? "").toLowerCase().includes(EXPECTED_TITLE.toLowerCase());
  rendered.showsUnrelatedEquipmentSafety = /equipment safety/i.test(rendered.pageBodySample ?? "");

  fs.mkdirSync("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/4yab-preview-as-employee.png", fullPage: true });
  fs.writeFileSync("test-results/4yab-preview-verify.json", JSON.stringify(rendered, null, 2));

  console.log("━━━━━ PREVIEW-AS-EMPLOYEE ROUTING ━━━━━");
  console.log(`  final path:           ${rendered.finalPathname}`);
  console.log(`  contains courseId:    ${rendered.containsCourseId}`);
  console.log(`  contains versionId:   ${rendered.containsVersionId}`);
  console.log(`  h1:                   "${rendered.h1}"`);
  console.log(`  shows expected course: ${rendered.showsExpectedCourse}`);
  console.log(`  mentions Equipment:    ${rendered.showsUnrelatedEquipmentSafety}`);
  console.log(`  body sample (first 240 chars):\n  ${rendered.pageBodySample.slice(0, 240)}`);
  console.log(`\n  screenshot: test-results/4yab-preview-as-employee.png`);
  await browser.close();

  if (rendered.showsUnrelatedEquipmentSafety) {
    console.error("\n✗ preview-as-employee is showing unrelated content. ROUTING DEFECT DETECTED.");
    process.exit(2);
  }
  if (!rendered.showsExpectedCourse) {
    console.error("\n✗ preview-as-employee is NOT showing the expected course title.");
    process.exit(2);
  }
  console.log("\n✓ routing verified — preview-as-employee shows the pilot course.");
}
main().catch((e) => { console.error(e); process.exit(1); });
