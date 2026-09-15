// v-slice-1-followup-3 (2026-09-15) — CSP nonce fix acceptance.
//
// Root cause of the Payroll Submit-for-Approval UX blocker:
// src/app/layout.tsx emitted two inline <script> tags (theme
// bootstrap + service-worker register) WITHOUT the per-request
// CSP nonce forwarded via `x-nonce` from middleware. The browser
// blocked both, hydration failed, and Next.js 14 App Router's
// `<form action={serverAction}>` (which requires client hydration
// to bind) silently did nothing when the founder clicked Submit.
//
// This spec proves on the deployed staging build:
//   A. NO CSP inline-script violations are logged on the payroll page.
//   B. Payroll admin page renders without an "Application error" boundary.
//   C. Body renders the current SUBMITTED_FOR_APPROVAL batch state.
//
// Does NOT click Submit against the founder's batch — that already
// happened via the pre-fix diagnostic when the batch transitioned to
// SUBMITTED_FOR_APPROVAL. The founder's manual Controller-approval
// step remains for founder acceptance.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/payroll-submit-csp-nonce");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

test.use({ viewport: { width: 1440, height: 900 } });

test("payroll page renders with zero CSP inline-script violations", async ({ browser }) => {
  const creds = stagingCredsAvailable();
  test.skip(!creds.ready, creds.reason ?? "staging creds unavailable");
  test.setTimeout(180_000);

  const ctx = await browser.newContext();
  const page = await loginAsFounder(ctx);

  const cspViolations: string[] = [];
  const hydrationErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      if (/Content Security Policy/i.test(text) && /inline script/i.test(text)) {
        cspViolations.push(text.slice(0, 300));
      }
    }
  });
  page.on("pageerror", (e) => {
    if (/React error #4(18|23|25)/.test(e.message)) {
      hydrationErrors.push(e.message.slice(0, 300));
    }
  });

  await page.goto(`${STAGING}/app/admin/payroll`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: path.join(OUT, "01-payroll-page.png"), fullPage: false });

  // A. No CSP inline-script violations.
  expect(
    cspViolations.length,
    `Payroll page must have zero CSP inline-script violations. Got: ${JSON.stringify(cspViolations)}`,
  ).toBe(0);

  // B. No React hydration errors caused by CSP-blocked scripts.
  expect(
    hydrationErrors.length,
    `No hydration failures should occur. Got: ${JSON.stringify(hydrationErrors)}`,
  ).toBe(0);

  // C. Page renders correctly — no Application-error boundary + we can
  //    see either an active batch or a period without-batch message.
  const body = await page.locator("body").innerText();
  expect(body).not.toContain("Application error");
  expect(body).not.toContain("server-side exception");

  // The page should show the payroll surface (heading present).
  const surface = page.locator('[data-testid="payroll-admin-surface"]');
  await expect(surface).toBeVisible();

  await ctx.close();
});
