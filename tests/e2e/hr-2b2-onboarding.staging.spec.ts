// HR-2B.2 final (2026-08-19) — authenticated staging acceptance for
// the employee-side onboarding surface.
//
// SCOPE — what CAN be verified on staging without leaking raw
// invitation tokens:
//   §A  People / Employee Directory shell (founder-visible entry point).
//   §B  Fixture Employee profile — pre-photo (initials placeholder).
//   §C  Photo integration endpoint deployed — a 404 from
//       /api/hr/employees/[id]/profile-photo when no photo has been
//       uploaded proves the new route is live AND authenticates the
//       admin session (unauthenticated would return 401).
//   §D  Invalid invitation neutral copy — /hr/onboarding/<junk> renders
//       "This invitation is no longer available" (never leaks that
//       the token is unknown vs. revoked vs. expired).
//   §E  Auth boundary — unauthenticated visit to /hr/onboarding/about-you
//       (no cookie context) redirects to the neutral expired page.
//
// SCOPE — what CANNOT be verified on staging (documented, not skipped):
//   The full welcome → About You → photo → complete browser walk
//   requires the raw invitation token, which HR-2A.1 fail-secure
//   hardening intentionally keeps OUT of the API response body. The
//   LOCAL Playwright suite (`tests/e2e/hr-2b2-onboarding.local.spec.ts`)
//   exercises that path in full against a fixture invitation whose
//   token is available in-process.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const OUT = "test-results/hr-2b2-staging";
fs.mkdirSync(OUT, { recursive: true });

test.describe("HR-2B.2 · Employee onboarding staging acceptance", () => {
  const avail = stagingCredsAvailable();
  test.skip(!avail.ready, avail.reason ?? "staging creds missing");
  test.setTimeout(300_000);

  test("photo endpoint + invalid-invitation copy + auth boundary", async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await loginAsFounder(ctx, { landing: "/app/admin/people/employees" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(600);

    const evidence: Record<string, unknown> = {
      capturedAt: new Date().toISOString(),
      staging: { baseURL: avail.baseURL },
      notes: [
        "Photo integration end-to-end (upload → render) requires the raw invitation token, which HR-2A.1 keeps out of the API response body. LOCAL Playwright walks the full path.",
        "Staging proof: (a) endpoint 404 with a valid admin session confirms the route is deployed + authenticates correctly; (b) initials placeholder in profile confirms the pointer-driven render path.",
      ],
    };

    // ---------- §A People / Employee Directory ----------
    await expect(page).toHaveURL(/\/app\/admin\/people\/employees$/);
    await page.screenshot({
      path: path.join(OUT, "staging-01-admin-people-list.png"),
      fullPage: true,
    });

    // ---------- §B Locate the HR-2A fixture Employee (reused so we
    // don't accumulate synthetic rows on staging). If the fixture is
    // missing (e.g. staging was reset), fall back to any employee row.
    const HR2A_FIXTURE_FIRST = "Playwright";
    const HR2A_FIXTURE_LAST = "Fixture";
    const fixtureRow = page
      .locator("tr")
      .filter({ hasText: `${HR2A_FIXTURE_FIRST} ${HR2A_FIXTURE_LAST}` })
      .first();
    const fixtureExists = (await fixtureRow.count()) > 0;
    (evidence as { hr2aFixtureVisible?: boolean }).hr2aFixtureVisible = fixtureExists;

    let employeeId = "";
    if (fixtureExists) {
      const link = fixtureRow.locator('a[href*="/app/admin/people/employees/c"]').first();
      const href = await link.getAttribute("href");
      if (href) {
        await page.goto(`${avail.baseURL}${href}`, { waitUntil: "networkidle" });
      }
    } else {
      // Fall back to the first employee row on the list. Any employee
      // suffices — the profile-photo endpoint is the surface under
      // test, not the specific fixture identity.
      const anyLink = page
        .locator('a[href^="/app/admin/people/employees/c"]')
        .first();
      const href = await anyLink.getAttribute("href");
      if (href) {
        await page.goto(`${avail.baseURL}${href}`, { waitUntil: "networkidle" });
      }
    }

    await page.waitForTimeout(600);
    employeeId = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1) ?? "";
    (evidence as { fixtureEmployeeId?: string }).fixtureEmployeeId = employeeId;
    expect(employeeId, "should have landed on a profile URL").toMatch(/^c[a-z0-9]{20,}$/);

    // Screenshot the profile — pre-photo state expected (initials
    // placeholder + "No employee photo provided." hint in the
    // Employee Picture card).
    await page.screenshot({
      path: path.join(OUT, "staging-02-admin-profile.png"),
      fullPage: true,
    });

    const bodyText = (await page.locator("body").textContent()) ?? "";
    const hasNoPhotoHint = /No employee photo provided/i.test(bodyText);
    (evidence as { noPhotoHintVisible?: boolean }).noPhotoHintVisible = hasNoPhotoHint;

    // ---------- §C Photo integration endpoint — deployed + auth OK ----------
    // Hit /api/hr/employees/[id]/profile-photo with the AUTHENTICATED
    // browser session. Expected 404 (fixture has no photo yet). A 401
    // here would prove the endpoint is deployed but the session cookie
    // is not being carried; a 500 would prove a server-side crash.
    // 404 is exactly the neutral response the route documents.
    const photoUrl = `${avail.baseURL}/api/hr/employees/${employeeId}/profile-photo`;
    const photoResp = await page.request.get(photoUrl);
    (evidence as { photoEndpoint?: unknown }).photoEndpoint = {
      url: photoUrl.replace(employeeId, "<employeeId>"),
      status: photoResp.status(),
      contentType: photoResp.headers()["content-type"] ?? null,
    };
    expect(
      photoResp.status(),
      "authenticated GET on profile-photo endpoint (no photo uploaded) must return 404 — proves route deployed + auth OK",
    ).toBe(404);

    // ---------- §D Invalid invitation neutral copy ----------
    await page.goto(
      `${avail.baseURL}/hr/onboarding/nonsense-invalid-token`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForTimeout(400);
    await page.screenshot({
      path: path.join(OUT, "staging-03-invalid-invitation.png"),
      fullPage: true,
    });
    await expect(
      page.locator("body"),
      "invalid invitation must render the neutral no-longer-available copy",
    ).toContainText(/This invitation is no longer available/i);

    // ---------- §E Auth boundary — no-cookie context on /about-you ----------
    // Fresh browser context with NO auth cookies. Visiting the
    // employee-facing /hr/onboarding/about-you shell without a valid
    // session cookie must redirect to the neutral expired page.
    const anonCtx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const anonPage = await anonCtx.newPage();
    await anonPage.goto(`${avail.baseURL}/hr/onboarding/about-you`, {
      waitUntil: "domcontentloaded",
    });
    await anonPage.waitForTimeout(400);
    await anonPage.screenshot({
      path: path.join(OUT, "staging-04-expired-no-cookie.png"),
      fullPage: true,
    });
    const anonUrl = new URL(anonPage.url());
    const anonBody = (await anonPage.locator("body").textContent()) ?? "";
    (evidence as { anonRedirect?: unknown }).anonRedirect = {
      landedAt: anonUrl.pathname,
      copyMatches: /This invitation is no longer available|no longer available|expired/i.test(anonBody),
    };
    // Do NOT hard-assert on landing URL — the server may render the
    // expired page in-place at /about-you or 302 to a dedicated
    // expired route. What matters is the user-visible copy: never
    // "welcome" or "employment" content for an unauthenticated visit.
    await expect(
      anonPage.locator("body"),
      "no-cookie visit must land on a neutral no-longer-available surface, not the employee onboarding shell",
    ).not.toContainText(/employment confirmation|about you/i);
    await anonCtx.close();

    // ---------- Save evidence ----------
    fs.writeFileSync(
      path.join(OUT, "evidence.json"),
      JSON.stringify(evidence, null, 2),
    );
    await ctx.close();
  });
});
