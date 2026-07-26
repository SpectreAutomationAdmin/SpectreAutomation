// Stable, bounded full-validation chain.
//
//   npm run quality:stable
//
// Sequence:
//   1. test:cleanup       — kill stray workers, clear WAL/SHM
//   2. typecheck          — tsc --noEmit
//   3. test:unit:fast     — no-DB tests
//   4. test:db:serial     — DB-using tests, one worker, --bail=1
//   5. build              — next build
//   6. nav:audit          — navigation discoverability
//   7. test:e2e:serial    — Playwright, one worker
//
// Each phase prints start + end timestamps. The chain fails fast on
// the first non-zero exit. There is NO automatic retry. If a phase
// trips a wall-clock timeout, the chain exits with code 124 and
// prints "run `npm run test:cleanup` and retry once" — the operator
// (or harness) decides whether to retry.
//
// Total bounded wall-clock: ~20 min worst case.

import { spawnSync } from "node:child_process";
import { projectRoot } from "./lib/test-categories";

type Phase = {
  name: string;
  script: string;
  // wall-clock budget for individual phases that don't already bound
  // themselves internally (typecheck, nav:audit, etc.). The Vitest
  // and Playwright phases have their own internal timeouts.
  budgetMs?: number;
};

const PHASES: ReadonlyArray<Phase> = [
  { name: "1/7 cleanup",       script: "test:cleanup",     budgetMs: 30_000 },
  { name: "2/7 typecheck",     script: "typecheck",        budgetMs: 120_000 },
  { name: "3/7 unit:fast",     script: "test:unit:fast",   budgetMs: 120_000 },
  { name: "4/7 db:serial",     script: "test:db:serial" },  // self-bounded
  { name: "5/7 build",         script: "build",            budgetMs: 5 * 60_000 },
  { name: "6/7 nav:audit",     script: "nav:audit",        budgetMs: 60_000 },
  { name: "7/7 e2e:serial",    script: "test:e2e:serial" },  // self-bounded
];

const ROOT = projectRoot();
const overallStart = Date.now();

console.log(`[quality:stable] ${new Date().toISOString()} start — ${PHASES.length} phases`);

for (const phase of PHASES) {
  const start = Date.now();
  console.log(`[quality:stable] ${new Date().toISOString()} [${phase.name}] $ npm run ${phase.script}`);

  const r = spawnSync("npm", ["run", phase.script], {
    cwd: ROOT,
    stdio: "inherit",
    shell: true,
    timeout: phase.budgetMs,
    killSignal: "SIGKILL",
  });

  const elapsedMs = Date.now() - start;
  const elapsed = (elapsedMs / 1000).toFixed(1);

  // Timeout: spawnSync sets status to null when the timeout kills the child.
  if (phase.budgetMs && r.status === null && r.signal === "SIGKILL") {
    console.error(
      `[quality:stable] [${phase.name}] TIMEOUT after ${phase.budgetMs / 1000}s (elapsed=${elapsed}s). ` +
      `Run \`npm run test:cleanup\` and retry quality:stable once. Do not loop.`,
    );
    process.exit(124);
  }

  if (r.status !== 0) {
    const totalElapsed = ((Date.now() - overallStart) / 1000).toFixed(1);
    console.error(
      `[quality:stable] [${phase.name}] FAILED — exit=${r.status} elapsed=${elapsed}s ` +
      `(total ${totalElapsed}s). Failure is in phase \`npm run ${phase.script}\`. ` +
      `Address the failure before retrying. quality:stable does NOT auto-retry.`,
    );
    process.exit(r.status ?? 1);
  }

  console.log(`[quality:stable] ${new Date().toISOString()} [${phase.name}] OK (${elapsed}s)`);
}

const totalElapsed = ((Date.now() - overallStart) / 1000).toFixed(1);
console.log(`[quality:stable] ${new Date().toISOString()} ALL PHASES OK — total ${totalElapsed}s`);
