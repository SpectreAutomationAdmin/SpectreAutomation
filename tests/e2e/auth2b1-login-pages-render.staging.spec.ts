// AUTH-2B.1 regression — the digest-745435047 defect rendered both
// login pages as "Application error: a server-side exception has
// occurred" because the staging Prisma client had no `prisma.session`
// accessor (schema-drift; see tests/auth2/schema-parity.test.ts).
//
// This live-staging spec asserts the observable browser behaviour: no
// matter which cookie state a visitor arrives in (none, legacy pre-
// AUTH-2 shape, malformed value, or a valid AUTH-2 cookie whose sid
// resolves to no Session row), GET /employee/login and GET /login MUST
// render the unauthenticated login screen — never a 500 error page.
//
// Run against live staging with the founder's credentials NOT required:
//   npx playwright test tests/e2e/auth2b1-login-pages-render.staging.spec.ts

import { test, expect } from "@playwright/test";

const STAGING = "https://staging.spectreautomation.com";
const ADMIN_COOKIE = "spectre_session";
const EMPLOYEE_COOKIE = "spectre_employee_session";

const COOKIE_SCENARIOS: Array<{ label: string; value: string | null }> = [
  { label: "no-cookie", value: null },
  { label: "malformed-cookie", value: "not-a-real-iron-session-value" },
  {
    label: "legacy-plausible-cookie",
    value: "Fe26.2**abc123**stale-legacy-payload**def456",
  },
];

test.describe("AUTH-2B.1 · login pages fail closed, never 500", () => {
  test.setTimeout(90_000);

  for (const { label, value } of COOKIE_SCENARIOS) {
    test(`/employee/login renders login screen with ${label}`, async ({ browser }) => {
      const ctx = await browser.newContext();
      if (value) {
        await ctx.addCookies([{
          name: EMPLOYEE_COOKIE,
          value,
          domain: "staging.spectreautomation.com",
          path: "/employee",
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        }]);
      }
      const page = await ctx.newPage();
      const resp = await page.goto(`${STAGING}/employee/login`, { waitUntil: "domcontentloaded" });
      expect(resp?.status(), `HTTP status for /employee/login (${label})`).toBe(200);
      // Must NOT be the Next.js server-error surface.
      const body = await page.content();
      expect(body).not.toContain("Application error: a server-side exception has occurred");
      expect(body).not.toContain("745435047");
      // Must show the Employee Portal login shell.
      await expect(page.locator('[data-auth="employee"]')).toBeVisible();
      await expect(page.getByRole("heading", { name: "Employee Portal" })).toBeVisible();
      await ctx.close();
    });

    test(`/login renders admin login screen with ${label}`, async ({ browser }) => {
      const ctx = await browser.newContext();
      if (value) {
        await ctx.addCookies([{
          name: ADMIN_COOKIE,
          value,
          domain: "staging.spectreautomation.com",
          path: "/",
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        }]);
      }
      const page = await ctx.newPage();
      const resp = await page.goto(`${STAGING}/login`, { waitUntil: "domcontentloaded" });
      expect(resp?.status(), `HTTP status for /login (${label})`).toBe(200);
      const body = await page.content();
      expect(body).not.toContain("Application error: a server-side exception has occurred");
      expect(body).not.toContain("745435047");
      await expect(page.locator('[data-auth="admin"]')).toBeVisible();
      await ctx.close();
    });
  }
});
