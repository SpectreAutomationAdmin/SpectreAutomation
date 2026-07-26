// One-shot measurement of resetDb() cost. Sets up the env exactly like
// tests/setup.ts then calls resetDb() N times and prints the per-call
// time so we can verify the post-refactor speedup.

import path from "node:path";
import { execSync } from "node:child_process";
import { rmSync, existsSync } from "node:fs";

const TEST_DB_PATH = path.resolve(process.cwd(), "prisma/test.db");
Object.assign(process.env, {
  NODE_ENV: "test",
  DATABASE_URL: `file:${TEST_DB_PATH.replace(/\\/g, "/")}`,
  SPECTRE_SESSION_SECRET: "test-only-secret-thats-at-least-32-characters-long-xx",
  SESSION_COOKIE_NAME: "spectre_session_test",
  TRUST_PROXY: "false",
});

if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH);
execSync("npx prisma db push --skip-generate --accept-data-loss --force-reset", {
  stdio: "ignore",
});

async function main() {
  // Dynamic import so the env vars above are in effect.
  const { resetDb, seedRbac } = await import("../tests/util/db");

  const N = 5;
  const times: number[] = [];
  // Warm up
  await resetDb();
  await seedRbac();
  for (let i = 0; i < N; i++) {
    const t0 = Date.now();
    await resetDb();
    await seedRbac();
    times.push(Date.now() - t0);
  }
  const avg = times.reduce((a, b) => a + b, 0) / N;
  console.log(`resetDb()+seedRbac() over ${N} runs:`);
  console.log(`  per-call times (ms): ${times.join(", ")}`);
  console.log(`  avg: ${avg.toFixed(1)} ms`);
  console.log(`  projected cost for 168 calls: ${(avg * 168 / 1000).toFixed(1)} s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
