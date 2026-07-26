// DB-using tests, one worker only.
//
//   npm run test:db:serial
//
// Runs every Vitest test file EXCEPT the no-DB list. Uses a single
// fork worker so SQLite WAL/SHM locks are owned by exactly one
// process for the duration. `--bail=1` so a single failure stops
// the rest of the run rather than burning 8 minutes after the
// first regression.
//
// Wraps the spawn in a hard wall-clock timeout (default 15 min)
// so the run cannot hang indefinitely. If it trips, the script
// kills the vitest process group and prints the actionable
// "run npm run test:cleanup and retry" message.

import { spawn } from "node:child_process";
import { noDbExcludePatterns, projectRoot } from "./lib/test-categories";

const ROOT = projectRoot();
const HARD_TIMEOUT_MS = Number(process.env.TEST_DB_SERIAL_TIMEOUT_MS ?? 15 * 60 * 1000);

const excludes = noDbExcludePatterns();
const args = [
  "vitest",
  "run",
  "--pool=forks",
  "--maxWorkers=1",
  "--bail=1",
];
for (const e of excludes) {
  args.push("--exclude", e);
}

const start = Date.now();
console.log(`[test:db:serial] ${new Date().toISOString()} start — bail=1, timeout=${HARD_TIMEOUT_MS / 1000}s`);
console.log(`[test:db:serial] excluding ${excludes.length} no-DB pattern(s): ${excludes.join(", ")}`);

const child = spawn("npx", args, {
  cwd: ROOT,
  stdio: "inherit",
  shell: true,
});

let timedOut = false;
const killer = setTimeout(() => {
  timedOut = true;
  console.error(
    `[test:db:serial] TIMEOUT after ${HARD_TIMEOUT_MS / 1000}s. ` +
    `The Vitest run exceeded its wall-clock cap. ` +
    `Common cause: stale workers holding the SQLite test DB lock. ` +
    `Run \`npm run test:cleanup\` then retry once.`,
  );
  try {
    if (process.platform === "win32") {
      // `child` is `npx` (cmd.exe); kill the whole tree.
      spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    /* best-effort */
  }
}, HARD_TIMEOUT_MS);

child.on("exit", (code) => {
  clearTimeout(killer);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[test:db:serial] ${new Date().toISOString()} end — exit=${code} elapsed=${elapsed}s timedOut=${timedOut}`);
  process.exit(timedOut ? 124 : (code ?? 1));
});
