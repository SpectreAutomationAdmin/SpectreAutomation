// Phase 15 — Placeholder scanner.
//
// Fails the build if production source contains scaffolding language unless
// the offending line is on the allowlist. The "production source" set is
// every .ts / .tsx under src/, the Prisma schema, and the seed.
//
// Allowlist rules: see config/placeholder-allowlist.json. A line is permitted
// if AT LEAST ONE rule's `pattern` matches AND its `paths` glob matches the
// file's path.
//
// Usage: `npm run scan:placeholders` → exits 0 / 1.

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import path from "path";

const PROJECT_ROOT = process.cwd();

const FORBIDDEN: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bTODO\b/i, label: "TODO" },
  { pattern: /\bplaceholder\b/i, label: "placeholder" },
  { pattern: /\bcoming soon\b/i, label: "coming soon" },
  { pattern: /\bnot implemented\b/i, label: "not implemented" },
  { pattern: /\bnot[\s-]?yet[\s-]?implemented\b/i, label: "not yet implemented" },
  { pattern: /\bmock[\s-]?only\b/i, label: "mock-only" },
  { pattern: /\bfake[\s-]?data\b/i, label: "fake data" },
  { pattern: /\bscaffold[\s-]?only\b/i, label: "scaffold only" },
  { pattern: /\bfuture[\s-]?implementation\b/i, label: "future implementation" },
  { pattern: /\btemporary\b/i, label: "temporary" },
  { pattern: /\bFIXME\b/i, label: "FIXME" },
  { pattern: /\bXXX\b/, label: "XXX" },
  { pattern: /\bHACK\b/, label: "HACK" },
];

const SCAN_GLOBS = [
  "src/**/*.ts",
  "src/**/*.tsx",
  "prisma/schema.prisma",
  "prisma/seed.ts",
];

const SKIP_DIRS = ["node_modules", ".next", ".git", "dist", "build"];

type AllowRule = { pattern: string; paths: string[]; reason: string };
type Allowlist = { rules: AllowRule[] };

function loadAllowlist(): Allowlist {
  const file = path.join(PROJECT_ROOT, "config/placeholder-allowlist.json");
  if (!existsSync(file)) return { rules: [] };
  const text = readFileSync(file, "utf8");
  return JSON.parse(text) as Allowlist;
}

function globToRegex(glob: string): RegExp {
  // Minimal glob → regex: handle ** and *.
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLE::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLE::/g, ".*");
  return new RegExp(`^${esc}$`);
}

function ruleMatchesPath(rule: AllowRule, relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  return rule.paths.some((g) => globToRegex(g).test(normalized));
}

function isLineAllowed(line: string, relPath: string, allowlist: Allowlist): boolean {
  for (const rule of allowlist.rules) {
    let re: RegExp;
    try { re = new RegExp(rule.pattern, "i"); }
    catch { continue; }
    if (re.test(line) && ruleMatchesPath(rule, relPath)) return true;
  }
  return false;
}

function walk(dir: string, exts: Set<string>, out: string[]) {
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    if (SKIP_DIRS.includes(entry)) continue;
    const full = path.join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, exts, out);
    else if (exts.has(path.extname(entry))) out.push(path.relative(PROJECT_ROOT, full));
  }
}

function collectFiles(): string[] {
  const out: string[] = [];
  walk(path.join(PROJECT_ROOT, "src"), new Set([".ts", ".tsx"]), out);
  const schemaRel = "prisma/schema.prisma";
  if (existsSync(path.join(PROJECT_ROOT, schemaRel))) out.push(schemaRel);
  const seedRel = "prisma/seed.ts";
  if (existsSync(path.join(PROJECT_ROOT, seedRel))) out.push(seedRel);
  return out;
}

type Hit = { file: string; line: number; label: string; text: string };

function scan(): Hit[] {
  const allowlist = loadAllowlist();
  const hits: Hit[] = [];
  for (const rel of collectFiles()) {
    const full = path.join(PROJECT_ROOT, rel);
    const text = readFileSync(full, "utf8");
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const forbidden of FORBIDDEN) {
        if (forbidden.pattern.test(line) && !isLineAllowed(line, rel, allowlist)) {
          hits.push({ file: rel, line: i + 1, label: forbidden.label, text: line.trim().slice(0, 200) });
        }
      }
    }
  }
  return hits;
}

function main() {
  const hits = scan();
  if (hits.length === 0) {
    // eslint-disable-next-line no-console
    console.log("[scan-placeholders] clean — no scaffolding language in production sources.");
    process.exit(0);
  }
  // eslint-disable-next-line no-console
  console.error(`[scan-placeholders] ${hits.length} forbidden mention(s):`);
  for (const h of hits) {
    // eslint-disable-next-line no-console
    console.error(`  ${h.file}:${h.line} [${h.label}] ${h.text}`);
  }
  // eslint-disable-next-line no-console
  console.error("");
  // eslint-disable-next-line no-console
  console.error("If a hit is intentional, add a rule to config/placeholder-allowlist.json with a reason.");
  process.exit(1);
}

main();
