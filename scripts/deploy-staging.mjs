#!/usr/bin/env node
// DRH-1 (2026-09-19) — Spectre staging deployment controller.
//
// Owns the full lifecycle: preflight → build/push → release_command →
// machine rollout → health verification → success or classified failure.
// Runs the deployment as a supervised child process with a
// last-output watchdog so a stalled Docker / Fly step is terminated
// automatically rather than waiting for a human to notice.
//
// Usage:
//   node scripts/deploy-staging.mjs           # normal deploy
//   node scripts/deploy-staging.mjs --diag    # collect diagnostics only
//
// Or:
//   npm run deploy:staging
//
// Founder acceptance: the founder must NEVER need to prompt Claude to
// check on this deploy. Either it succeeds cleanly, or it terminates
// itself with a classified failure and diagnostics.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// -----------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------

const APP     = "spectre-staging";
const CONFIG  = "deploy/fly.web.toml";
const HEALTH_URL = "https://staging.spectreautomation.com/api/health";

// Stage-specific timeouts in milliseconds.
// - build:    Next.js compile + prisma generate + Docker layer create.
// - export:   buildkit "exporting layers" — the step that stalled at 17 min.
// - push:     Fly registry upload.
// - release:  Prisma migrate deploy.
// - rollout:  Machine restart + boot.
// - health:   /api/health returning 200 after rollout.
// - overall:  Hard ceiling on a single attempt.
//
// Each stage has an independent "no-output for N ms" watchdog. If a
// child process emits nothing to stdout/stderr for that window, we
// terminate it with a classified BUILD_TIMEOUT / EXPORT_TIMEOUT / etc.
const STAGE_TIMEOUTS_MS = {
  overall:        30 * 60_000, // 30 min hard ceiling
  buildIdleKill:  10 * 60_000, // 10 min no output during compile
  exportIdleKill:  8 * 60_000, // 8 min no output during buildkit export (the historical stall point)
  pushIdleKill:    6 * 60_000, // 6 min no output during registry push
  releaseIdleKill: 3 * 60_000, // 3 min no output for release_command
  rolloutIdleKill: 5 * 60_000, // 5 min for machine rollout
  healthMaxMs:     3 * 60_000, // 3 min to see /api/health 200 after Fly reports success
  healthIntervalMs:   5_000,   // poll interval
};

const MAX_ATTEMPTS = 2;
const REPO_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const LOG_DIR   = path.join(REPO_ROOT, "test-results", "deploy-staging");
const LOCK_FILE = path.join(REPO_ROOT, ".deploy-staging.lock");

// -----------------------------------------------------------------------
// Failure taxonomy
// -----------------------------------------------------------------------

const FAILURES = {
  BUILD_TIMEOUT:    { retryable: true,  reason: "Docker build stalled (compile/layer step)" },
  EXPORT_TIMEOUT:   { retryable: true,  reason: "Buildkit image export stalled" },
  PUSH_TIMEOUT:     { retryable: true,  reason: "Registry push stalled" },
  ROLLOUT_TIMEOUT:  { retryable: true,  reason: "Machine rollout stalled" },
  HEALTH_FAILED:    { retryable: true,  reason: "/api/health did not return 200 after rollout" },
  RELEASE_FAILED:   { retryable: false, reason: "release_command (Prisma migrate) failed" },
  MIGRATION_FAILED: { retryable: false, reason: "Database migration reported an error" },
  AUTH_FAILED:      { retryable: false, reason: "flyctl authentication is not set up" },
  CONFIG_INVALID:   { retryable: false, reason: "fly.web.toml validation failed" },
  PREFLIGHT:        { retryable: false, reason: "Preflight check failed" },
  LOCK_CONFLICT:    { retryable: false, reason: "Another staging deploy is already in progress" },
  UNKNOWN:          { retryable: false, reason: "Unclassified failure — see diagnostics" },
};

// -----------------------------------------------------------------------
// Logging
// -----------------------------------------------------------------------

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_FILE = path.join(LOG_DIR, `deploy-${runId}.log`);
const CHECKPOINT_FILE = path.join(LOG_DIR, `deploy-${runId}.json`);

// Log lines: timestamp + severity + message. Written to file always
// and mirrored to stdout so a human tail follows along.
function log(severity, msg) {
  const line = `[${new Date().toISOString()}] ${severity} ${msg}`;
  fs.appendFileSync(LOG_FILE, line + "\n");
  process.stdout.write(line + "\n");
}
const info  = (m) => log("INFO ", m);
const warn  = (m) => log("WARN ", m);
const errL  = (m) => log("ERROR", m);

// Structured checkpoint — the JSON artifact the founder can eyeball.
const checkpoint = {
  runId,
  startedAtIso: new Date().toISOString(),
  sha: null,
  branch: null,
  strategy: null,
  attempts: [],
  rollbackAnchor: null,
  final: null, // "SUCCESS" | "FAILURE"
  failureClass: null,
  totalMs: null,
  healthCheck: null,
};
function persistCheckpoint() {
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
}

// Redact secrets before logging (belt & braces — we already avoid
// echoing them, but a stray env dump in a child's output should not
// end up in the log).
const SECRET_KEYS = [
  "DATABASE_URL", "DIRECT_DATABASE_URL", "SPECTRE_SESSION_SECRET",
  "FLY_API_TOKEN", "FLY_ACCESS_TOKEN", "MICROSOFT_CLIENT_SECRET",
  "AWS_SECRET_ACCESS_KEY", "R2_SECRET_ACCESS_KEY",
];
function redact(text) {
  let out = text;
  for (const k of SECRET_KEYS) {
    // <KEY>=value or <KEY>="value" or <KEY>: value
    const re = new RegExp(`(${k})[\\s]*[=:][\\s]*["']?([^"'\\s]+)["']?`, "gi");
    out = out.replace(re, `$1=<redacted>`);
  }
  return out;
}

// -----------------------------------------------------------------------
// Deployment lock
// -----------------------------------------------------------------------

function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    let owner = "?";
    try { owner = fs.readFileSync(LOCK_FILE, "utf8"); } catch {}
    // Stale lock detection — if the pid is not alive, take the lock.
    const m = owner.match(/pid=(\d+)/);
    if (m) {
      const pid = Number(m[1]);
      try {
        process.kill(pid, 0); // signal 0 = existence check
        // pid alive — genuine conflict
        return { ok: false, owner };
      } catch {
        // stale
        fs.unlinkSync(LOCK_FILE);
      }
    } else {
      fs.unlinkSync(LOCK_FILE);
    }
  }
  fs.writeFileSync(LOCK_FILE, `pid=${process.pid} host=${os.hostname()} startedAt=${new Date().toISOString()}\n`);
  return { ok: true };
}
function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}

// -----------------------------------------------------------------------
// Preflight
// -----------------------------------------------------------------------

async function runOnce(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: REPO_ROOT, shell: false, ...opts });
    let out = "", errOut = "";
    child.stdout && child.stdout.on("data", (b) => { out += b.toString(); });
    child.stderr && child.stderr.on("data", (b) => { errOut += b.toString(); });
    child.on("close", (code) => resolve({ code, stdout: out, stderr: errOut }));
    child.on("error", (e) => resolve({ code: -1, stdout: out, stderr: String(e) }));
  });
}

async function preflight() {
  info("Preflight — beginning checks");

  // git SHA + branch
  const sha = (await runOnce("git", ["rev-parse", "HEAD"])).stdout.trim();
  const branch = (await runOnce("git", ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  checkpoint.sha = sha;
  checkpoint.branch = branch;
  info(`Git — branch=${branch} sha=${sha}`);

  // flyctl on PATH
  const fly = await runOnce("flyctl", ["version"]);
  if (fly.code !== 0) {
    errL(`Preflight FAIL — flyctl not runnable: ${fly.stderr.slice(0, 200)}`);
    return { ok: false, cls: "PREFLIGHT" };
  }
  info(`flyctl — ${fly.stdout.trim().split("\n")[0]}`);

  // flyctl auth
  const auth = await runOnce("flyctl", ["auth", "whoami"]);
  if (auth.code !== 0) {
    errL(`Preflight FAIL — flyctl not authenticated: ${auth.stderr.slice(0, 200)}`);
    return { ok: false, cls: "AUTH_FAILED" };
  }
  info(`flyctl auth — signed in as ${auth.stdout.trim()}`);

  // fly.web.toml exists
  const cfgPath = path.join(REPO_ROOT, CONFIG);
  if (!fs.existsSync(cfgPath)) {
    errL(`Preflight FAIL — ${CONFIG} missing`);
    return { ok: false, cls: "CONFIG_INVALID" };
  }

  // App exists on Fly + record current release as rollback anchor
  const status = await runOnce("flyctl", ["status", "-a", APP, "--json"]);
  if (status.code !== 0) {
    errL(`Preflight FAIL — cannot read Fly status for ${APP}: ${status.stderr.slice(0, 200)}`);
    return { ok: false, cls: "PREFLIGHT" };
  }
  try {
    const j = JSON.parse(status.stdout);
    const machines = j?.Machines ?? [];
    const anchor = machines[0]?.image_ref?.tag ?? j?.ImageRef ?? "unknown";
    const version = machines[0]?.instance_id ?? j?.Version ?? "unknown";
    checkpoint.rollbackAnchor = { version, image: anchor, capturedAtIso: new Date().toISOString() };
    info(`Rollback anchor — machine=${machines[0]?.id ?? "?"} version=${machines[0]?.instance_id ?? "?"} image=${anchor}`);
  } catch (e) {
    warn(`Rollback anchor — could not parse status JSON: ${String(e).slice(0, 100)}`);
    checkpoint.rollbackAnchor = { version: "unknown", image: "unknown", capturedAtIso: new Date().toISOString() };
  }

  // Docker daemon reachable (only relevant for --local-only path).
  const docker = await runOnce("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (docker.code !== 0) {
    errL(`Preflight FAIL — Docker not reachable: ${docker.stderr.slice(0, 200)}`);
    return { ok: false, cls: "PREFLIGHT" };
  }
  info(`docker — server ${docker.stdout.trim()}`);

  // Disk pressure — refuse if buildkit builder is over 40 GB.
  const bx = await runOnce("docker", ["buildx", "du", "--format", "{{.Size}}"]);
  if (bx.code === 0) {
    const totalBytes = bx.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
      .map(s => Number(s)).filter(n => !Number.isNaN(n))
      .reduce((a, b) => a + b, 0);
    const gb = totalBytes / 1e9;
    info(`buildkit cache — ${gb.toFixed(2)} GB`);
    if (gb > 40) {
      warn(`buildkit cache >40 GB. Recommend: docker builder prune -f --keep-storage 2GB`);
    }
  }

  info("Preflight — OK");
  return { ok: true };
}

// -----------------------------------------------------------------------
// Supervised child with idle-output watchdog
// -----------------------------------------------------------------------

/**
 * Run a child process, streaming stdout+stderr to the log. If either
 * stream is silent for `idleMs`, kill the process and return a
 * timeout class. If the child prints a marker in `stageTransitions`,
 * flip the current stage — different stages can have different idle
 * budgets.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{
 *   overallMs: number,
 *   stageIdleMs: Record<string, number>,
 *   initialStage: string,
 *   stageTransitions: Array<{stage: string, match: RegExp}>,
 *   onLine?: (line: string) => void,
 * }} opts
 */
async function supervisedChild(cmd, args, opts) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stage = opts.initialStage;
    let lastByteAt = Date.now();
    let killed = false;
    let killClass = null;
    let bufOut = "";
    const child = spawn(cmd, args, { cwd: REPO_ROOT, shell: false });
    info(`> ${cmd} ${args.map(a => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`);

    const flushLine = (line) => {
      const clean = redact(line.replace(/\r$/, ""));
      fs.appendFileSync(LOG_FILE, clean + "\n");
      process.stdout.write(clean + "\n");
      opts.onLine && opts.onLine(clean);
      // Detect stage transitions.
      for (const t of opts.stageTransitions ?? []) {
        if (t.match.test(clean)) {
          stage = t.stage;
          info(`[stage] → ${stage}`);
        }
      }
    };
    const consume = (buf) => {
      lastByteAt = Date.now();
      bufOut += buf.toString();
      let idx;
      while ((idx = bufOut.indexOf("\n")) >= 0) {
        const line = bufOut.slice(0, idx);
        bufOut = bufOut.slice(idx + 1);
        if (line.length) flushLine(line);
      }
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);

    // Watchdog — 5s tick, check idle time against the current stage budget.
    const tick = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      if (elapsed > opts.overallMs) {
        killClass = "OVERALL_TIMEOUT";
        errL(`WATCHDOG — overall ceiling ${(opts.overallMs / 60_000).toFixed(1)} min exceeded (stage=${stage})`);
        killed = true;
        child.kill("SIGKILL");
        return;
      }
      const idleBudget = opts.stageIdleMs[stage] ?? opts.stageIdleMs.default ?? 300_000;
      const idle = Date.now() - lastByteAt;
      if (idle > idleBudget) {
        killClass = stageToFailureClass(stage);
        errL(`WATCHDOG — stage=${stage} idle ${Math.round(idle / 1000)}s > ${Math.round(idleBudget / 1000)}s. Killing.`);
        killed = true;
        child.kill("SIGKILL");
      }
    }, 5_000);

    child.on("close", (code) => {
      clearInterval(tick);
      if (bufOut.length) flushLine(bufOut);
      resolve({ code, killed, killClass, stage, elapsedMs: Date.now() - startedAt });
    });
    child.on("error", (e) => {
      clearInterval(tick);
      resolve({ code: -1, killed: true, killClass: "UNKNOWN", stage, elapsedMs: Date.now() - startedAt, error: String(e) });
    });
  });
}

function stageToFailureClass(stage) {
  switch (stage) {
    case "BUILD":   return "BUILD_TIMEOUT";
    case "EXPORT":  return "EXPORT_TIMEOUT";
    case "PUSH":    return "PUSH_TIMEOUT";
    case "RELEASE": return "RELEASE_FAILED";
    case "ROLLOUT": return "ROLLOUT_TIMEOUT";
    default:        return "UNKNOWN";
  }
}

// -----------------------------------------------------------------------
// One deploy attempt
// -----------------------------------------------------------------------

async function attemptDeploy(attemptNumber) {
  info(`Attempt ${attemptNumber}/${MAX_ATTEMPTS} — starting`);
  const attempt = {
    number: attemptNumber,
    startedAtIso: new Date().toISOString(),
    strategy: "local-only",
    stage: null,
    exitCode: null,
    killed: false,
    killClass: null,
    elapsedMs: null,
    finishedAtIso: null,
  };
  checkpoint.attempts.push(attempt);
  checkpoint.strategy = "local-only";
  persistCheckpoint();

  const args = ["deploy", "--local-only", "-a", APP, "--config", CONFIG];
  const res = await supervisedChild("flyctl", args, {
    overallMs: STAGE_TIMEOUTS_MS.overall,
    initialStage: "BUILD",
    stageIdleMs: {
      BUILD:   STAGE_TIMEOUTS_MS.buildIdleKill,
      EXPORT:  STAGE_TIMEOUTS_MS.exportIdleKill,
      PUSH:    STAGE_TIMEOUTS_MS.pushIdleKill,
      RELEASE: STAGE_TIMEOUTS_MS.releaseIdleKill,
      ROLLOUT: STAGE_TIMEOUTS_MS.rolloutIdleKill,
      default: STAGE_TIMEOUTS_MS.buildIdleKill,
    },
    stageTransitions: [
      { stage: "EXPORT",  match: /exporting to image|exporting layers/i },
      { stage: "PUSH",    match: /Pushing image|Waiting for image|--> Pushing image/i },
      { stage: "RELEASE", match: /Running.*release_command|release_command/i },
      { stage: "ROLLOUT", match: /Preparing to run|Updating|update finished|Machines? are up/i },
    ],
  });

  attempt.exitCode = res.code;
  attempt.killed = res.killed;
  attempt.killClass = res.killClass;
  attempt.stage = res.stage;
  attempt.elapsedMs = res.elapsedMs;
  attempt.finishedAtIso = new Date().toISOString();
  persistCheckpoint();

  if (res.killed) {
    return { ok: false, cls: res.killClass ?? "UNKNOWN", attempt };
  }
  if (res.code !== 0) {
    // exit != 0 — classify by last known stage.
    return { ok: false, cls: stageToFailureClass(res.stage), attempt };
  }
  return { ok: true, attempt };
}

// -----------------------------------------------------------------------
// Health verification
// -----------------------------------------------------------------------

async function verifyHealth() {
  info(`Health — polling ${HEALTH_URL}`);
  const started = Date.now();
  while (Date.now() - started < STAGE_TIMEOUTS_MS.healthMaxMs) {
    try {
      const resp = await fetch(HEALTH_URL, { redirect: "manual" });
      if (resp.status === 200) {
        const body = await resp.text();
        info(`Health — HTTP 200 in ${Math.round((Date.now() - started) / 1000)}s. Body: ${body.slice(0, 200)}`);
        checkpoint.healthCheck = { ok: true, httpStatus: 200, elapsedMs: Date.now() - started };
        persistCheckpoint();
        return { ok: true };
      }
      info(`Health — HTTP ${resp.status}, retrying`);
    } catch (e) {
      info(`Health — fetch error: ${String(e).slice(0, 100)}, retrying`);
    }
    await new Promise(r => setTimeout(r, STAGE_TIMEOUTS_MS.healthIntervalMs));
  }
  errL(`Health — /api/health never returned 200 within ${STAGE_TIMEOUTS_MS.healthMaxMs / 60_000} min`);
  checkpoint.healthCheck = { ok: false, elapsedMs: STAGE_TIMEOUTS_MS.healthMaxMs };
  persistCheckpoint();
  return { ok: false };
}

// -----------------------------------------------------------------------
// Diagnostics on failure
// -----------------------------------------------------------------------

async function collectDiagnostics() {
  info("Diagnostics — gathering post-failure state");
  const st = await runOnce("flyctl", ["status", "-a", APP]);
  info(`Fly status:\n${st.stdout}`);
  const logs = await runOnce("flyctl", ["logs", "-a", APP, "--no-tail"]);
  const logsTail = logs.stdout.split(/\r?\n/).slice(-80).join("\n");
  info(`Fly logs (last 80 lines):\n${logsTail}`);
  const df = await runOnce("docker", ["system", "df"]);
  info(`docker system df:\n${df.stdout}`);
  const bx = await runOnce("docker", ["buildx", "du", "--format", "table {{.ID}}\t{{.Size}}\t{{.LastAccessed}}"]);
  info(`docker buildx du:\n${bx.stdout.split("\n").slice(0, 10).join("\n")}`);
}

// -----------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--diag")) {
    await collectDiagnostics();
    process.exit(0);
  }

  info("=".repeat(72));
  info(`Spectre staging deploy — run ${runId}`);
  info(`Log:        ${LOG_FILE}`);
  info(`Checkpoint: ${CHECKPOINT_FILE}`);
  info("=".repeat(72));

  // Acquire lock.
  const lock = acquireLock();
  if (!lock.ok) {
    errL(`Lock — another deployment is already in progress: ${lock.owner}`);
    process.exit(2);
  }

  const overallStart = Date.now();

  try {
    // Preflight.
    const pf = await preflight();
    if (!pf.ok) {
      checkpoint.final = "FAILURE";
      checkpoint.failureClass = pf.cls;
      persistCheckpoint();
      await collectDiagnostics();
      process.exit(2);
    }

    // Deploy attempts.
    let attemptNumber = 0;
    while (attemptNumber < MAX_ATTEMPTS) {
      attemptNumber += 1;
      const r = await attemptDeploy(attemptNumber);
      if (r.ok) {
        info(`flyctl deploy — exit 0 after ${Math.round(r.attempt.elapsedMs / 1000)}s`);
        break;
      }
      warn(`Attempt ${attemptNumber} — failed (class=${r.cls}): ${FAILURES[r.cls]?.reason ?? "unknown"}`);
      const retryable = FAILURES[r.cls]?.retryable ?? false;
      if (!retryable) {
        errL(`Failure class ${r.cls} is not retryable. Aborting.`);
        checkpoint.final = "FAILURE";
        checkpoint.failureClass = r.cls;
        persistCheckpoint();
        await collectDiagnostics();
        process.exit(3);
      }
      if (attemptNumber >= MAX_ATTEMPTS) {
        errL(`Retryable failure but MAX_ATTEMPTS (${MAX_ATTEMPTS}) reached. Aborting.`);
        checkpoint.final = "FAILURE";
        checkpoint.failureClass = r.cls;
        persistCheckpoint();
        await collectDiagnostics();
        process.exit(3);
      }
      // Between attempts: try a small self-heal for build/export/push timeouts.
      if (r.cls === "BUILD_TIMEOUT" || r.cls === "EXPORT_TIMEOUT" || r.cls === "PUSH_TIMEOUT") {
        warn(`Self-heal — pruning stale buildkit cache (keep 2 GB)`);
        await runOnce("docker", ["builder", "prune", "-f", "--keep-storage", "2GB"]);
      }
    }

    // Health verification.
    const hv = await verifyHealth();
    if (!hv.ok) {
      checkpoint.final = "FAILURE";
      checkpoint.failureClass = "HEALTH_FAILED";
      persistCheckpoint();
      await collectDiagnostics();
      process.exit(4);
    }

    // Success.
    checkpoint.final = "SUCCESS";
    checkpoint.totalMs = Date.now() - overallStart;
    persistCheckpoint();
    info(`Deploy — SUCCESS in ${Math.round(checkpoint.totalMs / 1000)}s`);

    // Record post-deploy release for future rollback anchor.
    const status = await runOnce("flyctl", ["status", "-a", APP, "--json"]);
    try {
      const j = JSON.parse(status.stdout);
      const machines = j?.Machines ?? [];
      const newVersion = machines[0]?.instance_id ?? j?.Version ?? "?";
      const newImage = machines[0]?.image_ref?.tag ?? j?.ImageRef ?? "?";
      info(`New release — machine=${machines[0]?.id ?? "?"} version=${newVersion} image=${newImage}`);
      checkpoint.newRelease = { version: newVersion, image: newImage };
      persistCheckpoint();
    } catch {}

    process.exit(0);
  } finally {
    releaseLock();
    info(`Log:        ${LOG_FILE}`);
    info(`Checkpoint: ${CHECKPOINT_FILE}`);
  }
}

// Kick off.
main().catch((e) => {
  errL(`Fatal — ${String(e)}`);
  checkpoint.final = "FAILURE";
  checkpoint.failureClass = "UNKNOWN";
  persistCheckpoint();
  releaseLock();
  process.exit(99);
});
