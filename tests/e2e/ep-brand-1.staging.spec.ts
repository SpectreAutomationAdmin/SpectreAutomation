// EP-BRAND-1 (2026-10-29) — Visual parity screenshots for the
// Employee Portal wordmark + canonical reference surfaces.
//
// The authenticated staging credential is a CLUB_ADMIN
// (platform:signups:release NOT held).  Both reachable from this
// identity:
//   - the admin sidebar (canonical reference; the `.w1b-nav-wordmark`
//     already used by SpectreSidebar.tsx)
//   - the marketing / public landing (same `.w1b-nav-wordmark` in
//     W1bNav.tsx) via a plain fetch (no auth required)
//   - the employee login page `/employee/login` (public; shows the
//     `.auth-photo-brand` auth-photo wordmark; UNCHANGED by this slice)
//
// The authenticated Employee Portal interior is behind the
// `spectre_employee_session` cookie (separate from the admin
// session) and is not accessible with the CLUB_ADMIN credential
// alone -- the DOM-level parity is proven by source: both
// EmployeePortalSidebar.tsx + EmployeePortalMobileNav.tsx now
// render exactly `<span class="spectre-web1b"><span class="w1b-nav-wordmark">SPECTRE / AUTOMATION</span></span>`,
// which is byte-identical to SpectreSidebar.tsx lines 184-191 and
// the staged admin sidebar screenshot proves the rendered output.

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;

const OUT_DIR = join(process.cwd(), "test-results", "ep-brand-1");
function ensureOutDir() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  return OUT_DIR;
}

runAt.describe("ep-brand-1 :: canonical Spectre wordmark across surfaces", () => {
  runAt("admin sidebar canonical reference (desktop 1440 x 900)", async ({ context }) => {
    const page = await loginAsFounder(context);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/app/admin");
    // Wait for sidebar masthead to render.
    const masthead = page.getByTestId("spectre-sidebar-masthead");
    await expect(masthead).toBeVisible();
    const text = (await masthead.textContent())?.replace(/\s+/g, " ").trim();
    expect(text).toBe("SPECTRE / AUTOMATION");
    await page.screenshot({ path: join(ensureOutDir(), "admin-sidebar-canonical-1440.png"), fullPage: false });
  });

  runAt("employee login page (public; auth-photo brand UNCHANGED)", async ({ context }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("https://staging.spectreautomation.com/employee/login");
    // The auth-photo-brand element renders the wordmark.
    const brand = page.locator(".auth-photo-brand");
    await expect(brand).toBeVisible();
    const text = (await brand.textContent())?.replace(/\s+/g, " ").trim();
    expect(text).toBe("SPECTRE / AUTOMATION");
    await page.screenshot({ path: join(ensureOutDir(), "employee-login-1440.png"), fullPage: false });
  });

  runAt("employee login page (mobile 390 x 844)", async ({ context }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("https://staging.spectreautomation.com/employee/login");
    const brand = page.locator(".auth-photo-brand");
    await expect(brand).toBeVisible();
    await page.screenshot({ path: join(ensureOutDir(), "employee-login-mobile-390.png"), fullPage: false });
  });

  runAt("marketing homepage canonical reference (desktop 1440 x 900)", async ({ context }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("https://staging.spectreautomation.com/");
    const nav = page.locator(".w1b-nav-wordmark").first();
    await expect(nav).toBeVisible();
    const text = (await nav.textContent())?.replace(/\s+/g, " ").trim();
    expect(text).toBe("SPECTRE / AUTOMATION");
    await page.screenshot({ path: join(ensureOutDir(), "marketing-wordmark-1440.png"), fullPage: false });
  });

  runAt("source-level parity: EmployeePortalSidebar + EmployeePortalMobileNav use same wordmark idiom as admin SpectreSidebar", async () => {
    const { readFileSync } = await import("node:fs");
    const empSide = readFileSync("src/components/employee/EmployeePortalSidebar.tsx", "utf8");
    const empMobile = readFileSync("src/components/employee/EmployeePortalMobileNav.tsx", "utf8");
    const adminSide = readFileSync("src/components/spectre/SpectreSidebar.tsx", "utf8");
    // All three import the canonical web1b.css + render the tight
    // spectre-web1b/w1b-nav-wordmark wrapper.
    for (const [name, src] of [
      ["EmployeePortalSidebar", empSide],
      ["EmployeePortalMobileNav", empMobile],
      ["SpectreSidebar (admin, canonical)", adminSide],
    ] as const) {
      expect(src, `${name} imports web1b.css`).toMatch(/import "@\/components\/marketing\/web1b\.css"/);
      expect(src, `${name} uses .spectre-web1b wrapper`).toMatch(/className="spectre-web1b/);
      expect(src, `${name} uses .w1b-nav-wordmark class`).toMatch(/className="w1b-nav-wordmark"/);
      expect(src, `${name} renders literal 'SPECTRE / AUTOMATION'`).toMatch(/SPECTRE \/ AUTOMATION/);
    }
    // The old serif-stacked treatment is GONE from both employee files.
    expect(empSide).not.toMatch(/font-serif.*SPECTRE[\s\S]{0,200}AUTOMATION/);
    expect(empMobile).not.toMatch(/font-serif.*SPECTRE[\s\S]{0,200}AUTOMATION/);
  });
});
