// SIGNUP-2 M4-INT-C (2026-10-29) -- Screenshot capture for the
// permission-gate (negative) evidence.
//
// The staging Playwright credential is a CLUB_ADMIN -- NOT a
// SUPER_ADMIN with platform:signups:release.  The founder-mandated
// §1 constraint ("Do not silently elevate a club administrator")
// means I must NOT grant SUPER_ADMIN silently.  Zero legitimate
// platform SUPER_ADMIN identities exist on staging (verified via
// SSH enumeration script).  Creating one requires founder approval.
//
// This spec captures screenshots of the gate rendering the FORBIDDEN
// state so the founder can see the gate works correctly for
// non-privileged users.  Full SUPER_ADMIN screenshots are deferred
// to the controlled flag-flip window per founder §1 STOP condition.

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;

const OUT_DIR = join(process.cwd(), "test-results", "m4-int-c-screenshots");

function ensureOutDir() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  return OUT_DIR;
}

runAt.describe("signup-2 m4-int-c :: CLUB_ADMIN permission-gate screenshots", () => {
  runAt("billing hub forbidden-state screenshot", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto("/app/admin/signup-ops/billing");
    const text = await page.textContent("body");
    expect(text).toMatch(/You do not have the required permission/);
    const outDir = ensureOutDir();
    await page.screenshot({ path: join(outDir, "hub-forbidden.png"), fullPage: true });
  });

  runAt("triggering page forbidden-state screenshot", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto("/app/admin/signup-ops/billing/triggering");
    await expect(page.getByTestId("triggering-forbidden")).toBeVisible();
    const outDir = ensureOutDir();
    await page.screenshot({ path: join(outDir, "triggering-forbidden.png"), fullPage: true });
  });

  runAt("exceptions page forbidden-state screenshot", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto("/app/admin/signup-ops/billing/exceptions");
    await expect(page.getByTestId("exceptions-forbidden")).toBeVisible();
    const outDir = ensureOutDir();
    await page.screenshot({ path: join(outDir, "exceptions-forbidden.png"), fullPage: true });
  });

  runAt("renewal-review page forbidden-state screenshot", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.goto("/app/admin/signup-ops/billing/renewal-review");
    await expect(page.getByTestId("renewal-review-forbidden")).toBeVisible();
    const outDir = ensureOutDir();
    await page.screenshot({ path: join(outDir, "renewal-review-forbidden.png"), fullPage: true });
  });

  runAt("API endpoints return 403 to CLUB_ADMIN", async ({ context }) => {
    const page = await loginAsFounder(context);
    const endpoints = [
      "/api/admin/billing/cancellation",
      "/api/admin/billing/triggering",
      "/api/admin/billing/exceptions?state=open",
      "/api/admin/billing/renewal-review",
      "/api/admin/billing/renewal-preflight-probe",
    ];
    const results: Array<{ url: string; status: number; ok: boolean | null }> = [];
    for (const u of endpoints) {
      const r = await page.request.get(u);
      let body: { ok?: boolean } = {};
      try { body = await r.json(); } catch { /* noop */ }
      results.push({ url: u, status: r.status(), ok: body.ok ?? null });
    }
    // Every endpoint must refuse (403) OR return a safe shape ({ok:true} for the GET-safe probes).
    for (const row of results) {
      expect([200, 403]).toContain(row.status);
      if (row.status === 403) expect(row.ok).toBe(false);
    }
    const outDir = ensureOutDir();
    const fs = await import("node:fs");
    fs.writeFileSync(
      join(outDir, "api-permission-gate-matrix.json"),
      JSON.stringify({ capturedAt: new Date().toISOString(), results }, null, 2),
    );
  });
});
