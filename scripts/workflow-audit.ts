// Phase 15 — Workflow audit reminder.
//
// This isn't an automated test — it prints the current state of
// docs/workflow-audit.md, counts how many workflows are still classified
// as Placeholder / Partial / Broken / Untested, and exits non-zero if any
// workflow lacks a recent verification date.
//
// The intent is to make "I haven't actually tested this end-to-end" visible
// every time the gate runs.

import { readFileSync, existsSync } from "fs";
import path from "path";

const AUDIT_FILE = path.join(process.cwd(), "docs/workflow-audit.md");
const FRESHNESS_DAYS = 30;

function main() {
  if (!existsSync(AUDIT_FILE)) {
    // eslint-disable-next-line no-console
    console.error("[workflow-audit] docs/workflow-audit.md does not exist. Run Step 8 of the harness setup first.");
    process.exit(1);
  }
  const text = readFileSync(AUDIT_FILE, "utf8");
  const rows = text.match(/^\|\s*[^|]+\s*\|\s*[^|]+\s*\|\s*[^|]+\s*\|\s*[^|]+\s*\|/gm) ?? [];
  // Skip header + separator rows.
  const dataRows = rows.filter((r) => !/^\|\s*-+/.test(r) && !/Workflow\s*\|/.test(r));
  const counts: Record<string, number> = { GREEN: 0, PARTIAL: 0, PLACEHOLDER: 0, BROKEN: 0, UNTESTED: 0 };
  let stale = 0;
  const cutoff = Date.now() - FRESHNESS_DAYS * 86400_000;
  for (const r of dataRows) {
    const cells = r.split("|").map((c) => c.trim()).filter(Boolean);
    if (cells.length < 4) continue;
    const status = cells[1].toUpperCase();
    if (counts[status] !== undefined) counts[status]++;
    const dateMatch = cells[3]?.match(/\d{4}-\d{2}-\d{2}/);
    if (!dateMatch) { stale++; continue; }
    const d = new Date(dateMatch[0]).getTime();
    if (Number.isNaN(d) || d < cutoff) stale++;
  }
  // eslint-disable-next-line no-console
  console.log("[workflow-audit] state from docs/workflow-audit.md");
  for (const [k, v] of Object.entries(counts)) {
    // eslint-disable-next-line no-console
    console.log(`  ${k.padEnd(12)} ${v}`);
  }
  // eslint-disable-next-line no-console
  console.log(`  Stale entries (>${FRESHNESS_DAYS}d or missing date): ${stale}`);
  const broken = counts.BROKEN + counts.PLACEHOLDER;
  if (broken > 0) {
    // eslint-disable-next-line no-console
    console.error(`[workflow-audit] ${broken} workflow(s) classified BROKEN or PLACEHOLDER.`);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log("[workflow-audit] no BROKEN / PLACEHOLDER workflows.");
  process.exit(0);
}

main();
