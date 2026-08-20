#!/usr/bin/env node
// scripts/gate-hr-touched.mjs
//
// 2026-08-20 · Test-workflow optimization.
//
// Usage: `npm run gate:hr:touched` — resolves changed source files
// (via `git diff --name-only <base>...HEAD` where base defaults to
// `main`) into vitest globs, then runs the gate:hr-full config with
// only those tests. Per-worker DB isolation + fork pool make this
// safe to parallelise.
//
// Uses gate-hr-full's config (isolation + parallelism) but overrides
// `include` via positional args on the vitest CLI. When no tests match,
// runs only the integration sentinel.
//
// SCHEMA-ESCALATION: When the resolver emits `tests/hr/**/*.test.ts`
// (meaning schema, migration, or test-harness change → broad blast
// radius), we skip CLI positional filtering entirely and just run the
// full HR gate. Vitest 4 treats CLI positional args as substring
// filters that do NOT glob-expand, so passing `tests/hr/**/*.test.ts`
// literally would match zero files. Escalating to the full config
// preserves the founder-mandated invariant that a schema change runs
// the full HR set.

import { spawnSync } from "node:child_process";

const BROAD_GLOBS = new Set([
  "tests/hr/**/*.test.ts",
  "tests/hr/**/*.test.tsx",
]);

function resolveTouched() {
  const res = spawnSync("npx", ["tsx", "scripts/resolve-touched-tests.ts"], {
    encoding: "utf8",
    shell: true,
  });
  if (res.status !== 0) {
    process.stderr.write(res.stderr ?? "");
    process.exit(res.status ?? 1);
  }
  const line = (res.stdout ?? "").trim();
  if (!line) return [];
  return line.split(/\s+/).filter(Boolean);
}

const patterns = resolveTouched();
const hasBroadTrigger = patterns.some((p) => BROAD_GLOBS.has(p));

if (patterns.length === 0) {
  process.stdout.write("No touched tests resolved. Running integration sentinel only.\n");
  patterns.push("tests/mission-control-integration-sentinel.test.ts");
}

let cliArgs;
if (hasBroadTrigger) {
  process.stdout.write(
    "Broad-blast trigger detected (schema / migration / test-harness change). " +
    "Escalating to full HR gate — CLI filter dropped.\n",
  );
  cliArgs = ["vitest", "run", "--config", "vitest.gate-hr-full.config.ts"];
} else {
  process.stdout.write(`Running ${patterns.length} test file(s) / pattern(s):\n`);
  for (const p of patterns) process.stdout.write(`  · ${p}\n`);
  cliArgs = ["vitest", "run", "--config", "vitest.gate-hr-full.config.ts", ...patterns];
}

const res = spawnSync("npx", cliArgs, { stdio: "inherit", shell: true });
process.exit(res.status ?? 1);
