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
  // HR-2B.2 (2026-08-18) — auto-start `npm run dev` for local specs.
  // `reuseExistingServer: true` outside CI keeps the founder's own
  // dev server alive if it happens to be running on :3000 already,
  // and prevents a second `next dev` from racing on the same port.
  // Staging specs bypass this by pointing baseURL at the remote host.
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  },
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
    // Sprint 3 · Post-16H Phase 3.2 (2026-08-05) — permanent
    // authenticated-staging project. Runs specs that end in
    // `.staging.spec.ts` against https://staging.spectreautomation.com
    // using founder credentials read from a git-ignored
    // .env.playwright.local (see tests/e2e/_lib/staging-auth.ts).
    //
    // Invoked explicitly via `npm run test:e2e:staging` so it never
    // fires accidentally in the local iteration loop.
    {
      name: "staging-authenticated",
      testMatch: /.*\.staging\.spec\.ts$/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL:
          process.env.SPECTRE_STAGING_BASE_URL ??
          "https://staging.spectreautomation.com",
        // Login screen is exempt from screenshot-on-failure — the
        // form-fill moment is the only place a populated password
        // field could otherwise leak into an artefact. Individual
        // specs may re-enable screenshotting AFTER navigating away
        // from /login.
        screenshot: "only-on-failure",
        video: "retain-on-failure",
        trace: "retain-on-failure",
      },
    },
  ],
});
