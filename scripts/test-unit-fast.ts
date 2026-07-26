// Fast unit + source-contract tests (no DB).
//
//   npm run test:unit:fast
//
// Runs only the test files that do NOT import `@/lib/prisma`, do not
// call `resetDb()` / `seedRbac()`, and do not write to the SQLite
// test DB. Typical runtime: 5–10 s.
//
// Single fork worker keeps the run deterministic and avoids any
// chance of accidental DB contention from a future test that adds
// a Prisma import.

import { spawnSync } from "node:child_process";
import { NO_DB_FILES, projectRoot } from "./lib/test-categories";

const ROOT = projectRoot();
const start = Date.now();
console.log(`[test:unit:fast] ${new Date().toISOString()} start — ${NO_DB_FILES.length} target paths`);

const args = [
  "vitest",
  "run",
  "--pool=forks",
  "--maxWorkers=1",
  ...NO_DB_FILES,
];

const r = spawnSync("npx", args, {
  cwd: ROOT,
  stdio: "inherit",
  shell: true,
});

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`[test:unit:fast] ${new Date().toISOString()} end — exit=${r.status} elapsed=${elapsed}s`);
process.exit(r.status ?? 1);
