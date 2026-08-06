// Sprint 3 · Post-16H Phase 3.2 (2026-08-05) — the founder-mandated
// authenticated-staging smoke test. Every future checkpoint that
// touches user-facing behaviour MUST land its own `.staging.spec.ts`
// on top of this pattern.
//
// This spec proves that:
//   1. The plumbing in tests/e2e/_lib/staging-auth.ts can log in
//      via the real login form using credentials from
//      .env.playwright.local.
//   2. The founder's Mission Control landing page is reachable.
//   3. The endpoints Phase 3.2 shipped (canonical gate + review
//      overrides) are live at staging — verified by hitting the
//      health surface as an authenticated user.
//
// If SPECTRE_STAGING_EMAIL / SPECTRE_STAGING_PASSWORD are missing,
// the spec SKIPS with a clear message so CI in credential-less
// environments stays green.
//
// Never adds a screenshot of the login form after fill. Never logs
// the credentials themselves — only pass/fail.

import { test, expect } from "@playwright/test";
import {
  loginAsFounder,
  stagingCredsAvailable,
  assertAuthenticated,
} from "./_lib/staging-auth";

const availability = stagingCredsAvailable();

test.describe("Phase 3.2 · authenticated-staging smoke", () => {
  test.skip(!availability.ready, availability.reason ?? "creds unavailable");

  test("founder can log in with .env.playwright.local credentials", async ({ context }) => {
    const page = await loginAsFounder(context, { landing: "/app/admin" });
    // Being off /login and on any /app/* route is the authentication
    // proof — we do not screenshot before this point.
    await expect(page).toHaveURL(/\/app\//);
    await assertAuthenticated(page, "/app/admin");
  });

  test("Phase 3.2 diagnostics endpoint reports the shipped versions", async ({ context }) => {
    const page = await loginAsFounder(context);
    const res = await page.request.get(`${availability.baseURL}/api/health`);
    expect(res.status(), "authenticated health status").toBe(200);
    const body = await res.json();
    expect(body.apIntelligence?.eligibilityRuleVersion, "phase 2 eligibility rule version").toBeGreaterThanOrEqual(2);
    expect(body.apIntelligence?.workflowDecisionVersion, "phase 3 workflow decision version").toBeGreaterThanOrEqual(1);
    // §6 DLQ bucketing shape.
    const queue = (body.checks as Array<{ name: string; detail: string }>).find((c) => c.name === "queue");
    expect(queue?.detail ?? "", "DLQ bucketing detail").toMatch(/dlq total=\d+ · active=\d+ · historical=\d+/);
  });
});
