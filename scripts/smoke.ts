// scripts/smoke.ts — production smoke runner.
//
//   npm run smoke
//
// Exits 0 if all checks PASS (warnings allowed), 1 if any FAIL.

import { runSmokeTests, summarizeResults } from "../src/lib/smoke";

async function main() {
  const results = await runSmokeTests();
  const summary = summarizeResults(results);

  const lines: string[] = [];
  lines.push("# Spectre smoke test report");
  lines.push(`Total: ${results.length} · PASS ${summary.pass} · WARN ${summary.warn} · FAIL ${summary.fail}`);
  lines.push("");
  for (const r of results) {
    const icon = r.status === "PASS" ? "OK " : r.status === "WARN" ? "WARN" : "FAIL";
    lines.push(`[${icon}] ${r.category}/${r.key} (${r.durationMs}ms) — ${r.label}: ${r.message}`);
  }
  // eslint-disable-next-line no-console
  console.log(lines.join("\n"));

  process.exit(summary.ok ? 0 : 1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Smoke runner failed:", err);
  process.exit(2);
});
