// EP-TRAIN-4Y-G — standalone Playwright config for the Gate 2 pilot.
// Targets staging directly; does NOT spin up a local dev server.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /4y-g-pilot\.staging\.spec\.ts$/,
  timeout: 20 * 60 * 1000, // 20 min — cover Whisper + Qwen cold-boot + inference
  expect: { timeout: 30_000 },
  reporter: [["line"]],
  use: {
    baseURL:
      process.env.SPECTRE_STAGING_BASE_URL ??
      "https://staging.spectreautomation.com",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "staging-4yg",
      use: {
        ...devices["Desktop Chrome"],
      },
    },
  ],
});
