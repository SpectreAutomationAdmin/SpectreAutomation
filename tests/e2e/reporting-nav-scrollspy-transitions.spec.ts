import { test, type Page } from "@playwright/test";

// Founder-requested transition visuals 2026-06-19. For each of the
// four named transitions, capture two screenshots:
//   - BEFORE: just before the next section crosses the 60%-visible
//     activation threshold (rail still highlights the previous
//     section).
//   - AFTER: at the moment the next section is unambiguously
//     dominant (>60% of usable viewport — rail highlights the new
//     section).

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";
const HEADER_HEIGHT = 80;
const ACTIVATE_THRESHOLD = 0.60;

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

const TRANSITIONS = [
  { fromId: "executive-opening",        toId: "financial-performance",            label: "exec-opening-to-financial-perf" },
  { fromId: "financial-performance",         toId: "stewardship-dashboard",       label: "financial-perf-to-stewardship" },
  { fromId: "capital-projects",  toId: "financial-position", label: "capital-projects-to-financial-position" },
  { fromId: "weather-and-utilization",  toId: "payroll-analysis",  label: "weather-to-payroll" },
] as const;

// Find the scrollY at which `toId` first exceeds the activation
// threshold (>60% of usable viewport).
async function findActivationScrollY(page: Page, toId: string, viewportHeight: number): Promise<number> {
  return await page.evaluate(
    ({ id, headerHeight, activate, viewportHeight }) => {
      const el = document.getElementById(id);
      if (!el) return -1;
      const sectionTop = el.offsetTop;
      const sectionHeight = el.getBoundingClientRect().height;
      const usable = viewportHeight - headerHeight;
      // visible = max(0, min(sectionBottom - scrollY, viewportHeight) - max(sectionTop - scrollY, headerHeight))
      // Solve for scrollY such that visible / usable > activate.
      // The next section becomes visible at scrollY = sectionTop - viewportHeight.
      // It hits 60% visible at scrollY ≈ sectionTop - (viewportHeight - 0.6 * usable)
      //   = sectionTop - viewportHeight + 0.6 * usable
      // Cap at the section staying mostly in viewport.
      const cap = Math.min(
        sectionTop - viewportHeight + activate * usable,
        sectionTop, // can't go past the section's own top
      );
      return Math.max(0, Math.ceil(cap));
    },
    { id: toId, headerHeight: HEADER_HEIGHT, activate: ACTIVATE_THRESHOLD, viewportHeight },
  );
}

for (const t of TRANSITIONS) {
  test(`transition visual: ${t.label} (1440x900)`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    await page.goto("/app/admin/reporting/monthly");
    await page.waitForLoadState("networkidle");
    await page.getByTestId("reporting-shell-chapters").waitFor({ timeout: 20_000 });
    await page.waitForTimeout(400);

    const activationY = await findActivationScrollY(page, t.toId, 900);

    // BEFORE: scroll 200 px short of activation — `toId` should
    // not yet be active.
    const beforeY = Math.max(0, activationY - 200);
    await page.evaluate((y) => window.scrollTo({ top: y, behavior: "instant" as ScrollBehavior }), beforeY);
    await page.waitForTimeout(300);
    await page.screenshot({
      path: `test-results/scrollspy-transition-${t.label}-before.png`,
      fullPage: false,
    });

    // AFTER: scroll 200 px past activation — `toId` is now
    // unambiguously dominant.
    const afterY = activationY + 200;
    await page.evaluate((y) => window.scrollTo({ top: y, behavior: "instant" as ScrollBehavior }), afterY);
    await page.waitForTimeout(300);
    await page.screenshot({
      path: `test-results/scrollspy-transition-${t.label}-after.png`,
      fullPage: false,
    });
  });
}
