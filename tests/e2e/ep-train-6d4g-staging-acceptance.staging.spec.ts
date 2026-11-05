// EP-TRAIN-6D-4G § 6 + § 7 — authenticated Playwright acceptance
// against staging.spectreautomation.com using the founder's
// CLUB_ADMIN session.
//
// Scope:
//   § 6 — persisted-mode UI acceptance. CLUB_ADMIN now holds the
//        `hr:training:ai:read` grant and MUST land on the persisted
//        route (no redirect back to fixture). Capture 5 screenshots:
//          1. desktop 1440×900 — persisted candidate detail (top of
//             queue = APPROVED_DRAFT fixture)
//          2. desktop 1440×900 — rejected candidate
//          3. desktop 1440×900 — empty queue (state filter yields 0)
//          4. desktop 1440×900 — missing-evidence candidate
//          5. mobile 390×844   — persisted candidate detail
//   § 7 — deployed API security:
//          a) /api/health 200 (public baseline)
//          b) GET /api/admin/ai-training/drafts unauth → 401
//          c) POST /api/admin/ai-training/drafts → 404 / 405 (no handler)
//          d) GET /api/admin/ai-training/drafts (CLUB_ADMIN) → 200 + rows
//          e) GET /api/admin/ai-training/drafts/<cross-tenant> → 404 same-shape
//          f) GET /api/admin/ai-training/drafts?limit=999 → 400 invalid-param
//          g) PATCH /api/admin/ai-training/drafts/<id> → 404 / 405 (no handler)
//
// Precondition: `scratchpad/ep-train-6d4g/seed-test-candidates.mjs` has
// been run on staging via `fly ssh console` so Coulee Ridge has the
// four fixture rows with `pilotAuthorizationId = "TEST-FIXTURE-6D-4G"`.
//
// Credentials come from .env.playwright.local via tests/e2e/_lib/
// staging-auth.ts (SPECTRE_STAGING_EMAIL / SPECTRE_STAGING_PASSWORD).

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const OUT = "test-results/ep-train-6d4g";

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

const creds = stagingCredsAvailable();
test.skip(!creds.ready, "staging credentials missing");

test.describe("EP-TRAIN-6D-4G staging acceptance", () => {
  test("§7.a /api/health returns 200 (public baseline)", async ({ page }) => {
    const r = await page.request.get(`${BASE}/api/health`);
    expect(r.status()).toBe(200);
    const body = await r.json();
    // "warn" is also accepted — it indicates one non-critical
    // subsystem (e.g. queue DLQ depth) is degraded but the app is
    // reachable. DB sub-check must remain "ok".
    expect(["ok", "warn"]).toContain(body.status);
    const dbCheck = (body.checks ?? []).find((c: { name: string }) => c.name === "database");
    expect(dbCheck?.status).toBe("ok");
  });

  test("§7.b GET /api/admin/ai-training/drafts unauth → 401", async ({ page }) => {
    const r = await page.request.get(`${BASE}/api/admin/ai-training/drafts`);
    expect(r.status()).toBe(401);
    const body = await r.json();
    expect(body).toEqual({ error: "unauthenticated" });
  });

  test("§7.c POST /api/admin/ai-training/drafts → 404 or 405 (no handler)", async ({ page }) => {
    const r = await page.request.post(`${BASE}/api/admin/ai-training/drafts`, {
      data: { test: true },
    });
    expect([404, 405]).toContain(r.status());
  });

  test("§7.g PATCH /api/admin/ai-training/drafts/<id> → 404 or 405 (no handler)", async ({ page }) => {
    const r = await page.request.patch(`${BASE}/api/admin/ai-training/drafts/draft_test_6d4g_approved_xxxxxx`, {
      data: { approve: true },
    });
    expect([404, 405]).toContain(r.status());
  });

  test("Authenticated flows — § 6 screenshots + § 7 CLUB_ADMIN API", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await loginAsFounder(context);

    // §7.d — authenticated GET to drafts → 200 + rows
    const authGet = await page.request.get(`${BASE}/api/admin/ai-training/drafts`);
    expect(authGet.status()).toBe(200);
    const authBody = await authGet.json();
    expect(authBody).toHaveProperty("rows");
    expect(Array.isArray(authBody.rows)).toBe(true);
    expect(authBody.rows.length).toBeGreaterThan(0);

    // Pick fixture draft IDs by state. The seed produced:
    //   APPROVED_DRAFT → "approved"
    //   REJECTED       → "rejected"
    //   REQUIRES_HUMAN_REVIEW with sourceVideoSha256 === ""   → "missing"
    //   REQUIRES_HUMAN_REVIEW with populated sourceVideoSha256 → "pending"
    //
    // The rows[] is state-agnostic (newest first). Pull IDs by looking
    // for the fixture marker on each row.
    interface QueueRow { draftId: string; state: string }
    const rows: QueueRow[] = (authBody.rows as unknown[])
      .filter((r): r is QueueRow => typeof r === "object" && r !== null && "draftId" in r && "state" in r);
    const approvedId = rows.find((r) => /_approved_/.test(r.draftId))?.draftId;
    const rejectedId = rows.find((r) => /_rejected_/.test(r.draftId))?.draftId;
    const missingId  = rows.find((r) => /_missing_/.test(r.draftId))?.draftId;
    expect(approvedId, "APPROVED_DRAFT fixture missing — run seed script first").toBeDefined();
    expect(rejectedId, "REJECTED fixture missing — run seed script first").toBeDefined();
    expect(missingId,  "missing-evidence fixture missing — run seed script first").toBeDefined();

    // §7.e — cross-tenant / unknown id → same-shape 404 (no enumeration signal)
    const crossTenant = await page.request.get(
      `${BASE}/api/admin/ai-training/drafts/does-not-exist-cross-tenant`,
    );
    expect(crossTenant.status()).toBe(404);
    const crossBody = await crossTenant.json();
    expect(crossBody).toEqual({ error: "not_found" });

    // §7.f — invalid pagination → 400
    const invalidLimit = await page.request.get(
      `${BASE}/api/admin/ai-training/drafts?limit=999`,
    );
    expect(invalidLimit.status()).toBe(400);

    // ---------------- § 6 screenshots ----------------

    // Screenshot 1 — persisted detail @ 1440×900 (top of queue)
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/app/admin/ai-training/review/persisted?candidate=${approvedId}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByText("Persisted review", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState("load").catch(() => {});
    await page.screenshot({
      path: `${OUT}/01-persisted-detail-approved-1440x900.png`,
      fullPage: false,
    });

    // Screenshot 2 — rejected candidate detail @ 1440×900
    await page.goto(`${BASE}/app/admin/ai-training/review/persisted?candidate=${rejectedId}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByText("Persisted review", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState("load").catch(() => {});
    await page.screenshot({
      path: `${OUT}/02-persisted-detail-rejected-1440x900.png`,
      fullPage: false,
    });

    // Screenshot 3 — empty queue @ 1440×900 (filter yields zero rows)
    await page.goto(`${BASE}/app/admin/ai-training/review/persisted?state=ARCHIVED`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByText("Persisted review", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState("load").catch(() => {});
    await page.screenshot({
      path: `${OUT}/03-persisted-empty-queue-1440x900.png`,
      fullPage: false,
    });

    // Screenshot 4 — missing-evidence candidate @ 1440×900
    await page.goto(`${BASE}/app/admin/ai-training/review/persisted?candidate=${missingId}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByText("Persisted review", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState("load").catch(() => {});
    await page.screenshot({
      path: `${OUT}/04-persisted-detail-missing-evidence-1440x900.png`,
      fullPage: false,
    });

    // Screenshot 5 — mobile persisted detail @ 390×844
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/app/admin/ai-training/review/persisted?candidate=${approvedId}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByText("Persisted review", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState("load").catch(() => {});
    await page.screenshot({
      path: `${OUT}/05-persisted-detail-approved-390x844.png`,
      fullPage: false,
    });

    // §6 end — no mutation controls must be enabled in the persisted
    // workspace. Assert zero enabled buttons whose label matches a
    // mutation verb. (The component renders all mutation buttons with
    // the `disabled` attribute set.)
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/app/admin/ai-training/review/persisted?candidate=${approvedId}`, {
      waitUntil: "domcontentloaded",
    });
    const mutationVerbs = ["Approve", "Edit", "Reject", "Revalidate", "Request regeneration"];
    for (const verb of mutationVerbs) {
      const enabledCount = await page.locator(`button:not([disabled]):has-text("${verb}")`).count();
      expect(
        enabledCount,
        `No enabled "${verb}" button must exist on the persisted review surface`,
      ).toBe(0);
    }
  });
});
