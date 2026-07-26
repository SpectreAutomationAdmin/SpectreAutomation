// Test-suite stability — safe cleanup for stale Vitest / Playwright
// workers and stale SQLite WAL/SHM lock files.
//
//   npm run test:cleanup
//
// Why this exists:
// On Windows, an interrupted Vitest run can leave worker processes
// holding `prisma/test.db-wal` and `prisma/test.db-shm` open. A
// subsequent `vitest run` then waits indefinitely for the lock, or
// times out in `beforeEach`. This script:
//
//   1. Lists node.exe processes whose command-line references vitest
//      or playwright AND whose cwd contains this project path.
//   2. Stops them via `taskkill /F /PID`.
//   3. Removes `prisma/test.db-wal` and `prisma/test.db-shm` if the
//      main DB file is no longer locked.
//   4. Prints what was cleaned. Exits 0 on success.
//
// The script NEVER deletes unrelated files and NEVER touches
// `prisma/dev.db`. It scopes everything by command-line + project
// path so a parallel npm session in another directory is safe.

import { execSync, spawnSync } from "node:child_process";
import { existsSync, rmSync, openSync, closeSync } from "node:fs";
import path from "node:path";

const PROJECT_ROOT = path.resolve(__dirname, "..").replace(/\\/g, "/");
const TEST_DB = path.resolve(PROJECT_ROOT, "prisma/test.db");
const TEST_DB_WAL = `${TEST_DB}-wal`;
const TEST_DB_SHM = `${TEST_DB}-shm`;

const isWindows = process.platform === "win32";

function fmt(n: number) { return String(n).padStart(2, " "); }

type CleanupSummary = {
  vitestWorkers: number[];
  playwrightWorkers: number[];
  removedWal: boolean;
  removedShm: boolean;
  dbLocked: boolean;
  errors: string[];
};

function findStrayWorkers(): { vitest: number[]; playwright: number[] } {
  // Returns PIDs of node processes whose command-line includes
  // "vitest" or "playwright" AND references this project root.
  // Windows-first; on other platforms returns empty arrays and the
  // doc lists the limitation.
  if (!isWindows) {
    return { vitest: [], playwright: [] };
  }
  try {
    // WMIC is deprecated but reliable for this query on Windows 10/11.
    // PowerShell Get-CimInstance is the supported alternative; we use
    // PowerShell here to avoid the WMIC deprecation prompt.
    const out = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name = \'node.exe\'\\" | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress"',
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    if (!out.trim()) return { vitest: [], playwright: [] };
    const raw = JSON.parse(out) as
      | { ProcessId: number; CommandLine: string | null }
      | Array<{ ProcessId: number; CommandLine: string | null }>;
    const list = Array.isArray(raw) ? raw : [raw];
    const projectPattern = PROJECT_ROOT.toLowerCase().replace(/\//g, "\\\\");
    const projectPatternFwd = PROJECT_ROOT.toLowerCase();
    const vitest: number[] = [];
    const playwright: number[] = [];
    for (const p of list) {
      if (!p.CommandLine) continue;
      const cmd = p.CommandLine.toLowerCase();
      // Scope: command line must reference our project path so we
      // never touch a vitest session running in another directory.
      const inProject = cmd.includes(projectPattern) || cmd.includes(projectPatternFwd);
      if (!inProject) continue;
      if (cmd.includes("vitest")) vitest.push(p.ProcessId);
      else if (cmd.includes("playwright")) playwright.push(p.ProcessId);
    }
    return { vitest, playwright };
  } catch {
    return { vitest: [], playwright: [] };
  }
}

function killPids(pids: number[]): number[] {
  // Returns the PIDs we successfully terminated.
  const killed: number[] = [];
  for (const pid of pids) {
    const r = spawnSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore" });
    if (r.status === 0) killed.push(pid);
  }
  return killed;
}

function isDbLocked(): boolean {
  // Best-effort test: try to open the DB file exclusively. If another
  // process holds it, this throws. SQLite WAL mode allows multiple
  // readers so EBUSY here means there is an active writer.
  if (!existsSync(TEST_DB)) return false;
  try {
    const fd = openSync(TEST_DB, "r+");
    closeSync(fd);
    return false;
  } catch {
    return true;
  }
}

function main(): number {
  const start = Date.now();
  console.log("[test:cleanup] start");

  const summary: CleanupSummary = {
    vitestWorkers: [],
    playwrightWorkers: [],
    removedWal: false,
    removedShm: false,
    dbLocked: false,
    errors: [],
  };

  // 1. Find + kill stray workers in this project.
  const { vitest, playwright } = findStrayWorkers();
  summary.vitestWorkers = killPids(vitest);
  summary.playwrightWorkers = killPids(playwright);

  if (vitest.length || playwright.length) {
    console.log(
      `[test:cleanup] stopped ${summary.vitestWorkers.length} vitest worker(s) ` +
      `(${vitest.length} found) and ${summary.playwrightWorkers.length} playwright worker(s) ` +
      `(${playwright.length} found)`,
    );
  } else {
    console.log("[test:cleanup] no stray vitest / playwright workers in this project");
  }

  // Give the OS a moment to release handles after taskkill.
  if (vitest.length || playwright.length) {
    const wait = Date.now() + 500;
    while (Date.now() < wait) { /* spin briefly */ }
  }

  // 2. Check whether the main test DB is still locked.
  summary.dbLocked = isDbLocked();
  if (summary.dbLocked) {
    summary.errors.push(
      `prisma/test.db is still locked by a process this script could not identify or kill. ` +
      `Close any open IDE that may have a SQLite browser pinned to test.db, or reboot.`,
    );
  }

  // 3. Remove stale WAL/SHM files only if the DB is NOT locked.
  if (!summary.dbLocked) {
    if (existsSync(TEST_DB_WAL)) {
      try { rmSync(TEST_DB_WAL); summary.removedWal = true; } catch (e) {
        summary.errors.push(`could not remove test.db-wal: ${String(e)}`);
      }
    }
    if (existsSync(TEST_DB_SHM)) {
      try { rmSync(TEST_DB_SHM); summary.removedShm = true; } catch (e) {
        summary.errors.push(`could not remove test.db-shm: ${String(e)}`);
      }
    }
  }

  // 4. Report.
  const elapsed = Date.now() - start;
  console.log(
    `[test:cleanup] summary: vitest killed=${summary.vitestWorkers.length} ` +
    `playwright killed=${summary.playwrightWorkers.length} ` +
    `wal-removed=${summary.removedWal} shm-removed=${summary.removedShm} ` +
    `db-locked=${summary.dbLocked} elapsed=${fmt(elapsed)}ms`,
  );
  if (summary.errors.length) {
    for (const e of summary.errors) console.error(`[test:cleanup] WARN: ${e}`);
  }

  if (!isWindows) {
    console.log(
      "[test:cleanup] NOTE: process discovery is Windows-only in this script. " +
      "On other OSes, the WAL/SHM cleanup still runs.",
    );
  }

  return summary.dbLocked ? 1 : 0;
}

process.exit(main());
