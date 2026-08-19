// scripts/check-founder-baseline.ts
//
// Founder-mandated pre-flight for new feature branches (see
// docs/development-workflow.md).
//
// Usage:
//   npm run check:founder-baseline                        # implicit: main is baseline
//   npm run check:founder-baseline -- <founder-approved-sha>
//   npm run check:founder-baseline -- --branch <branch-name>
//
// Exits 0 if the founder-approved SHA is an ancestor of `main`, i.e.
// starting a new branch off `main` will NOT silently rewind
// founder-approved work.
//
// Exits 1 (with a loud diagnostic) if founder-approved work would be
// lost. That's the "STOP" signal: reconcile main first.
//
// The staging-image SHA lookup is intentionally NOT automated here
// (see the workflow doc for why — Fly parse would be brittle). The
// script accepts the founder-approved SHA as a positional arg.

import { execSync } from "node:child_process";

type Args = {
  founderSha: string | null;
  branchName: string | null;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { founderSha: null, branchName: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--branch" && i + 1 < argv.length) {
      args.branchName = argv[i + 1];
      i += 1;
    } else if (a && !a.startsWith("--")) {
      args.founderSha = a;
    }
  }
  return args;
}

function git(cmd: string): string {
  return execSync(`git ${cmd}`, { encoding: "utf8" }).trim();
}

function tryGit(cmd: string): string | null {
  try { return git(cmd); } catch { return null; }
}

const { founderSha: cliSha, branchName } = parseArgs(process.argv.slice(2));

// Resolve the founder-approved SHA:
//   1. explicit CLI arg wins
//   2. if --branch given, use that branch's tip
//   3. otherwise pull the last commit SHA committed by the founder from
//      docs/*checkpoint*.md files — fallback to just verifying the
//      current working tree state against main.
let founderSha = cliSha;
if (!founderSha && branchName) {
  founderSha = tryGit(`rev-parse ${branchName}`);
  if (!founderSha) {
    console.error(`✖ Branch not found locally: ${branchName}. Try 'git fetch' first.`);
    process.exit(1);
  }
}
if (!founderSha) {
  console.error("Usage:");
  console.error("  npm run check:founder-baseline -- <founder-approved-sha>");
  console.error("  npm run check:founder-baseline -- --branch <branch-name>");
  console.error("");
  console.error("The founder-approved SHA is the commit currently running on staging");
  console.error("(or the last commit the founder accepted in a checkpoint). Look at:");
  console.error("  • flyctl status --app spectre-staging (the Image tag)");
  console.error("  • the most recent docs/*checkpoint*.md file");
  console.error("  • the last commit whose message begins 'merge:' or 'test+docs:' after acceptance");
  process.exit(1);
}

const shortSha = founderSha.slice(0, 8);
const mainHead = git("rev-parse main");
const shortMain = mainHead.slice(0, 8);

// Check ancestry.
let isAncestor = false;
try {
  execSync(`git merge-base --is-ancestor ${founderSha} main`, { stdio: "ignore" });
  isAncestor = true;
} catch { isAncestor = false; }

if (isAncestor) {
  console.log(`✓ Founder-approved ${shortSha} is an ancestor of main (${shortMain}).`);
  console.log("  Safe to branch new work off main.");
  process.exit(0);
}

// Not an ancestor — surface the drift and refuse.
console.error("");
console.error("╔════════════════════════════════════════════════════════════════════╗");
console.error("║ STOP · Founder-approved work is NOT integrated into main.          ║");
console.error("╚════════════════════════════════════════════════════════════════════╝");
console.error("");
console.error(`  Founder-approved: ${founderSha}`);
console.error(`  main HEAD:        ${mainHead}`);
console.error("");
console.error("If you start a new feature branch from main right now, it will silently");
console.error("REGRESS every founder-approved commit that isn't in main. This is exactly");
console.error("the failure that produced the 2026-08-18 Mission Control regression.");
console.error("");
console.error("Commits present in the founder-approved SHA but NOT in main:");
try {
  const missing = git(`log --oneline main..${founderSha}`);
  console.error(missing.split("\n").map((l) => `  · ${l}`).join("\n"));
} catch {
  console.error("  (could not compute — try 'git fetch --all' and re-run)");
}
console.error("");
console.error("Reconcile main before starting the new feature branch:");
console.error(`  git checkout main`);
console.error(`  git merge <founder-approved-branch>       # or fast-forward if possible`);
console.error(`  git push origin main`);
console.error(`  npm run check:founder-baseline -- ${shortSha}   # must pass`);
console.error("");
process.exit(1);
