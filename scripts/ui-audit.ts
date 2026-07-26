// Phase 15 — UI audit.
//
// Static checks against `src/app/**/page.tsx` for the minimum UI quality
// rules in CLAUDE.md. This isn't a substitute for clicking through, but it
// catches the obvious lapses: missing empty-state rows, inline styles,
// raw enum names rendered as user-facing text, missing error banners on
// pages that have server actions.
//
// Usage: `npm run ui:audit` → exits 0 on clean, 1 on findings.

import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

const PROJECT_ROOT = process.cwd();

type Finding = { file: string; line: number; rule: string; detail: string };

function pages(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (e === "node_modules" || e === ".next") continue;
      const full = path.join(dir, e);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
      else if (e === "page.tsx") out.push(path.relative(PROJECT_ROOT, full));
    }
  };
  walk(path.join(PROJECT_ROOT, "src/app"));
  return out;
}

function audit(): Finding[] {
  const findings: Finding[] = [];
  for (const rel of pages()) {
    const full = path.join(PROJECT_ROOT, rel);
    const text = readFileSync(full, "utf8");
    const lines = text.split(/\r?\n/);
    const hasTable = /\btable-base\b/.test(text);
    const hasEmptyRow = /No\s+\w+\s+(yet|recorded)|px-4 py-6 text-center text-stone-500/.test(text);
    if (hasTable && !hasEmptyRow) {
      findings.push({ file: rel, line: 1, rule: "missing-empty-row", detail: "Page renders a table but no 'No rows' fallback row was detected." });
    }
    // Inline style usage.
    lines.forEach((line, idx) => {
      if (/\bstyle=\{\{/.test(line)) {
        findings.push({ file: rel, line: idx + 1, rule: "inline-style", detail: line.trim().slice(0, 160) });
      }
      // Raw status enums rendered without Badge.
      if (/\b\{[a-z]+\.status\}/.test(line) && !/Badge/.test(line)) {
        findings.push({ file: rel, line: idx + 1, rule: "raw-status-enum", detail: line.trim().slice(0, 160) });
      }
      // Money rendered with .toFixed(2) instead of formatCurrency().
      if (/\.toFixed\(2\)/.test(line) && !/formatCurrency/.test(text)) {
        findings.push({ file: rel, line: idx + 1, rule: "money-not-formatted", detail: line.trim().slice(0, 160) });
      }
    });
    // Server action without error cookie pattern.
    const hasServerAction = /"use server"/.test(text);
    const hasErrorCookie = /spectre_\w+_error/.test(text);
    if (hasServerAction && !hasErrorCookie && /isAppError/.test(text)) {
      findings.push({ file: rel, line: 1, rule: "server-action-error-handling", detail: "Server actions reference isAppError but no spectre_*_error cookie pattern found." });
    }
  }
  return findings;
}

function main() {
  const findings = audit();
  if (findings.length === 0) {
    // eslint-disable-next-line no-console
    console.log("[ui-audit] clean — no obvious UI lapses detected.");
    process.exit(0);
  }
  // eslint-disable-next-line no-console
  console.error(`[ui-audit] ${findings.length} finding(s):`);
  for (const f of findings) {
    // eslint-disable-next-line no-console
    console.error(`  ${f.file}:${f.line} [${f.rule}] ${f.detail}`);
  }
  process.exit(1);
}

main();
