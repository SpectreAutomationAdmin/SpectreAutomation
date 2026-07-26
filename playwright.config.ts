import { defineConfig, devices } from "@playwright/test";

// Step 38 — minimal Playwright config so floor-plan drag interaction
// is testable in a real browser. Run with:
//   npm run test:e2e            (headless, single browser)
//   npm run test:e2e:headed     (visible browser for debugging)
//
// The dev server must already be running on http://localhost:3000.
// We do NOT start it automatically because the project's data setup
// flow assumes the operator (or the previous task in CI) has primed
// the DB via `npm run dev:reset && npm run db:seed`. Auto-spawning
// a second `next dev` in headless tests would race with the human
// dev server on port 3000.

export default defineConfig({
  testDir: "./tests/e2e",
  // Long enough for next.js cold compilation but not so long that
  // hangs go unnoticed.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // No retries in dev — fail loudly.
  retries: 0,
  // One worker keeps DB-mutating tests deterministic. Crank up later
  // once we have read-only specs.
  workers: 1,
  fullyParallel: false,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "test-results/html" }],
  ],
  outputDir: "test-results/artifacts",
  use: {
    baseURL: "http://localhost:3000",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    trace: "retain-on-failure",
    actionTimeout: 10_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
