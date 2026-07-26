import { test, expect, type Page } from "@playwright/test";

// Validates the Monthly Reporting Package left-rail nav behaviour:
//   1. Chapter II's left-rail label reads "Financial Performance".
//   2. Clicking a chapter sets data-active="true" on the rail row.
//   3. Clicking a different chapter moves the active row.
//   4. Manually scrolling into a section updates the active row.
//   5. Clicking a nav item triggers a smooth scroll (NOT an instant
//      jump). We assert this by sampling the page's scroll position
//      twice within the animation window — between t=0 and t=200ms
//      the scrollY must change but the destination is NOT yet reached
//      (the smooth scroll is still animating).

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

test("reporting left-rail nav — rename, click-active, scroll-active, smooth scroll", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.locator("[data-testid='reporting-shell-chapters']").waitFor({ timeout: 20_000 });

  // ─── 1. Rename: chapter II's visible label ────────────────────
  const chII = page.locator("[data-testid='reporting-chapter-financial-performance']");
  await expect(chII).toContainText("Financial Performance");
  await expect(chII).not.toContainText("Chair's Dashboard");

  // ─── 2. Click Executive Opening → it becomes active ───────────
  const execOpening = page.locator("[data-testid='reporting-chapter-executive-opening']");
  await execOpening.click();
  await page.waitForTimeout(1100); // let the smooth scroll + observer settle
  await expect(execOpening).toHaveAttribute("data-active", "true");
  // No other row is active at the same time (the highlight is
  // exclusive — exactly one row carries data-active).
  const activeCount = await page.locator("[data-testid^='reporting-chapter-'][data-active='true']").count();
  expect(activeCount).toBe(1);

  // ─── 3. Click Financial Performance (chapter II) → highlight moves
  await chII.click();
  await page.waitForTimeout(1100);
  await expect(chII).toHaveAttribute("data-active", "true");
  await expect(execOpening).not.toHaveAttribute("data-active", "true");

  // ─── 4. Manual scroll → active follows ────────────────────────
  // Scroll down far enough to land deep into a later section. The
  // observer should promote whichever section's top edge has
  // crossed the upper-40% threshold.
  // First scroll back to the very top (avoid sticky-header drift).
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior }));
  await page.waitForTimeout(200);
  // Now scroll to the Statement of Activities section's anchor
  // (chapter IV — the original test used "financial-statements" but
  // that legacy composite chapter was removed in the 2026-06-16
  // consolidation; updated 2026-06-19 to use the canonical chapter
  // id that still exists). After settling, the rail row for that
  // chapter should be the active one — proving the active state
  // followed the scroll, not the prior click.
  const statementOfActivities = page.locator("[data-testid='reporting-chapter-statement-of-activities']");
  await page.evaluate(() => {
    const el = document.getElementById("statement-of-activities");
    if (el) window.scrollTo({ top: el.offsetTop + 100, behavior: "instant" as ScrollBehavior });
  });
  // Wait for IntersectionObserver to fire + state to update.
  await page.waitForTimeout(500);
  await expect(statementOfActivities).toHaveAttribute("data-active", "true", { timeout: 5_000 });
  await expect(chII).not.toHaveAttribute("data-active", "true");

  // ─── 5. Click → SMOOTH scroll (not instant jump) ──────────────
  // Reset to the top, then click chapter III "Stewardship Dashboard"
  // and sample window.scrollY at two points during the animation.
  // (The original test used a bare "stewardship" anchor that the
  // 2026-06-14 chapter consolidation replaced with
  // "stewardship-dashboard"; updated 2026-06-19.)
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior }));
  await page.waitForTimeout(200);
  const targetTop = await page.evaluate(() => {
    const el = document.getElementById("stewardship-dashboard");
    return el ? el.offsetTop : -1;
  });
  expect(targetTop).toBeGreaterThan(0);

  // Click the chapter and immediately sample scrollY before the
  // smooth scroll has had time to reach the target.
  const stewardship = page.locator("[data-testid='reporting-chapter-stewardship-dashboard']");
  await stewardship.click();
  // Sample at ~120 ms — well inside any reasonable smooth-scroll
  // animation window (typical durations are 300-600 ms).
  await page.waitForTimeout(120);
  const midScrollY = await page.evaluate(() => window.scrollY);
  // At 120 ms the page should be moving but NOT yet at the target.
  expect(midScrollY).toBeGreaterThan(0);
  expect(midScrollY).toBeLessThan(targetTop);
  // After settling, scroll completes (within sticky-header tolerance).
  await page.waitForTimeout(1500);
  const finalScrollY = await page.evaluate(() => window.scrollY);
  // The final scrollY should be near (target − headerOffset). We
  // expect roughly equal to target − ~80 px; allow a generous tolerance.
  expect(finalScrollY).toBeGreaterThan(midScrollY);
  expect(Math.abs(finalScrollY - (targetTop - 80))).toBeLessThan(50);

  // ─── Evidence screenshot ──────────────────────────────────────
  // Scroll back to the top so the sticky rail sits flush under the
  // shell header, then click chapter II once more so the active
  // highlight lands on "Financial Performance" — the canonical
  // founder-named row. Take a viewport-clip screenshot focused on
  // the upper-left area where the rail lives.
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior }));
  await page.waitForTimeout(200);
  await chII.click();
  await page.waitForTimeout(1100);
  await expect(chII).toHaveAttribute("data-active", "true");
  await page.screenshot({
    path: "test-results/reporting-nav-active.png",
    clip: { x: 0, y: 0, width: 360, height: 700 },
  });
});
