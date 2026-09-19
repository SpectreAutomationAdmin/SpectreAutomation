#!/usr/bin/env node
// DRH-1 (2026-09-19) — Spectre staging deployment controller.
//
// Canonical execution environment: **Linux CI runner** (GitHub Actions).
// Windows local runs are supported as a developer fallback but are no
// longer the normal staging deployment path.
//
// Two strategies:
//   1. `image` (default in CI, and preferred everywhere):
//      the caller has already built + pushed a Docker image to Fly's
//      registry. Controller invokes `flyctl deploy --image <ref>`
//      which skips flyctl's own Docker build entirely — meaning the
//      release-machine image is the SAME image that runs the app,
//      not a re-built copy. Eliminates the double-build failure mode
//      that stalled Windows Docker Desktop.
//
//   2. `local`: the controller invokes `flyctl deploy --local-only`
//      (developer fallback for the Windows workstation path).
//
// Usage:
//   node scripts/deploy-staging.mjs                             # auto-select strategy
//   node scripts/deploy-staging.mjs --strategy=image --image=<ref>
//   node scripts/deploy-staging.mjs --strategy=local
//   node scripts/deploy-staging.mjs --diag                      # diagnostics only
//
// Environment variables:
//   SPECTRE_DEPLOY_IMAGE   — image reference (registry.fly.io/spectre-staging:<tag>)
//                            equivalent to --image
//   SPECTRE_DEPLOY_STRATEGY — image | local (equivalent to --strategy)
//   CI                     — GitHub Actions sets this; forces strategy=image
//   FLY_API_TOKEN          — required for flyctl on CI runners
//
// Founder acceptance: after the one-time Fly-token secret is uploaded
// to GitHub, the founder must NEVER need to prompt Claude to check
// on this deploy. Either it succeeds cleanly, or it terminates itself
// with a classified failure and diagnostics.

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
const HEALTH_URL = process.env.SPECTRE_STAGING_HEALTH_URL ?? "https://staging.spectreautomation.com/api/health";

// Stage-specific timeouts in milliseconds. Idle = "no output from the
// child process for this long" (not overall elapsed).
//
// These budgets assume a Linux CI runner. Historical measurements:
//   - Fly image push: ~1-3 min from a GitHub Actions ubuntu runner.
//   - release_command (prisma migrate deploy on Neon direct URL): ~15-45s.
//   - Machine rollout (single instance): ~20-40s.
//   - /api/health post-rollout: usually ready inside 30s.
//
// Overall ceiling is deliberately tight — a staging deploy that takes
// longer than this is a bug worth investigating.
const STAGE_TIMEOUTS_MS = {
  overall:        20 * 60_000, // 20 min hard ceiling
  buildIdleKill:  10 * 60_000, // 10 min no output during any Docker build (only used in `local` fallback)
  exportIdleKill: 10 * 60_000, // 10 min for buildkit export (only `local` fallback)
  pushIdleKill:    6 * 60_000, // 6 min silent during Fly registry push
  releaseIdleKill: 3 * 60_000, // 3 min for release_command
  rolloutIdleKill: 5 * 60_000, // 5 min for machine rollout
  healthMaxMs:     3 * 60_000, // 3 min to see /api/health 200 after Fly reports success
  healthIntervalMs:   5_000,
};

const MAX_ATTEMPTS = 2;
const REPO_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const LOG_DIR   = path.join(REPO_ROOT, "test-results", "deploy-staging");
const LOCK_FILE = path.join(REPO_ROOT, ".deploy-staging.lock");

// -----------------------------------------------------------------------
// Failure taxonomy — retryable classes trigger the bounded retry policy;
// non-retryable classes fail closed immediately.
// -----------------------------------------------------------------------

const FAILURES = {
  BUILD_TIMEOUT:    { retryable: true,  reason: "Docker build stalled (local strategy only)" },
  EXPORT_TIMEOUT:   { retryable: true,  reason: "Buildkit image export stalled (local strategy only)" },
  PUSH_TIMEOUT:     { retryable: true,  reason: "Fly registry push stalled" },
  ROLLOUT_TIMEOUT:  { retryable: true,  reason: "Machine rollout stalled" },
  HEALTH_FAILED:    { retryable: true,  reason: "/api/health did not return 200 after rollout" },
  RELEASE_FAILED:   { retryable: false, reason: "release_command (Prisma migrate) failed" },
  MIGRATION_FAILED: { retryable: false, reason: "Database migration reported an error" },
  AUTH_FAILED:      { retryable: false, reason: "flyctl authentication is not set up" },
  CONFIG_INVALID:   { retryable: false, reason: "fly.web.toml validation failed" },
  PREFLIGHT:        { retryable: false, reason: "Preflight check failed" },
  LOCK_CONFLICT:    { retryable: false, reason: "Another staging deploy is already in progress" },
  IMAGE_MISSING:    { retryable: false, reason: "Image reference required for strategy=image was not provided" },
  UNKNOWN:          { retryable: false, reason: "Unclassified failure — see diagnostics" },
};

// -----------------------------------------------------------------------
// Logging
// -----------------------------------------------------------------------

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_FILE = path.join(LOG_DIR, `deploy-${runId}.log`);
const CHECKPOINT_FILE = path.join(LOG_DIR, `deploy-${runId}.json`);

function log(severity, msg) {
  const line = `[${new Date().toISOString()}] ${severity} ${msg}`;
  fs.appendFileSync(LOG_FILE, line + "\n");
  process.stdout.write(line + "\n");
}
const info  = (m) => log("INFO ", m);
const warn  = (m) => log("WARN ", m);
const errL  = (m) => log("ERROR", m);

const checkpoint = {
  runId,
  startedAtIso: new Date().toISOString(),
  sha: null,
  branch: null,
  strategy: null,
  image: null,
  workflowRun: process.env.GITHUB_RUN_ID ?? null,
  attempts: [],
  rollbackAnchor: null,
  final: null,
  failureClass: null,
  totalMs: null,
  healthCheck: null,
  newRelease: null,
};
function persistCheckpoint() {
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
}

// Redact secrets before logging.
const SECRET_KEYS = [
  "DATABASE_URL", "DIRECT_DATABASE_URL", "SPECTRE_SESSION_SECRET",
  "FLY_API_TOKEN", "FLY_ACCESS_TOKEN", "MICROSOFT_CLIENT_SECRET",
  "AWS_SECRET_ACCESS_KEY", "R2_SECRET_ACCESS_KEY",
];
function redact(text) {
  let out = text;
  for (const k of SECRET_KEYS) {
    const re = new RegExp(`(${k})[\\s]*[=:][\\s]*["']?([^"'\\s]+)["']?`, "gi");
    out = out.replace(re, `$1=<redacted>`);
  }
  return out;
}

// -----------------------------------------------------------------------
// Deployment lock (stale-pid recovery)
// -----------------------------------------------------------------------

function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    let owner = "?";
    try { owner = fs.readFileSync(LOCK_FILE, "utf8"); } catch {}
    const m = owner.match(/pid=(\d+)/);
    if (m) {
      const pid = Number(m[1]);
      try {
        process.kill(pid, 0);
        return { ok: false, owner };
      } catch {
        fs.unlinkSync(LOCK_FILE);
      }
    } else {
      fs.unlinkSync(LOCK_FILE);
    }
  }
  fs.writeFileSync(LOCK_FILE, `pid=${process.pid} host=${os.hostname()} startedAt=${new Date().toISOString()}\n`);
  return { ok: true };
}
function releaseLock() { try { fs.unlinkSync(LOCK_FILE); } catch {} }

// -----------------------------------------------------------------------
// Strategy detection
// -----------------------------------------------------------------------

function parseArgs() {
  const argv = process.argv.slice(2);
  const flags = {};
  for (const a of argv) {
    if (a === "--diag") flags.diag = true;
    else if (a.startsWith("--strategy=")) flags.strategy = a.split("=", 2)[1];
    else if (a.startsWith("--image="))    flags.image    = a.split("=", 2)[1];
  }
  return flags;
}

function resolveStrategy(flags) {
  // Explicit override wins.
  if (flags.strategy) return flags.strategy;
  if (process.env.SPECTRE_DEPLOY_STRATEGY) return process.env.SPECTRE_DEPLOY_STRATEGY;
  // CI forces image strategy — CI runners must NEVER build via flyctl's
  // implicit Docker path, they must build/push explicitly and deploy the
  // exact pre-built image.
  if (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") return "image";
  // Local developer fallback.
  return "local";
}

function resolveImageRef(flags) {
  return flags.image ?? process.env.SPECTRE_DEPLOY_IMAGE ?? null;
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

async function preflight(strategy, imageRef) {
  info(`Preflight — strategy=${strategy}${imageRef ? ` image=${imageRef}` : ""}`);

  // Git SHA + branch.
  const sha = (process.env.GITHUB_SHA
    ?? (await runOnce("git", ["rev-parse", "HEAD"])).stdout).trim();
  const branch = (process.env.GITHUB_REF_NAME
    ?? (await runOnce("git", ["rev-parse", "--abbrev-ref", "HEAD"])).stdout).trim();
  checkpoint.sha = sha || null;
  checkpoint.branch = branch || null;
  info(`Git — branch=${branch || "?"} sha=${sha || "?"}`);

  // flyctl on PATH.
  const fly = await runOnce("flyctl", ["version"]);
  if (fly.code !== 0) {
    errL(`Preflight FAIL — flyctl not runnable: ${fly.stderr.slice(0, 200)}`);
    return { ok: false, cls: "PREFLIGHT" };
  }
  info(`flyctl — ${fly.stdout.trim().split("\n")[0]}`);

  // flyctl auth — CI uses FLY_API_TOKEN env var; developer machines use
  // the user's saved credentials.
  const auth = await runOnce("flyctl", ["auth", "whoami"]);
  if (auth.code !== 0) {
    errL(`Preflight FAIL — flyctl not authenticated: ${auth.stderr.slice(0, 200)}`);
    return { ok: false, cls: "AUTH_FAILED" };
  }
  info(`flyctl auth — signed in as ${auth.stdout.trim()}`);

  // fly.web.toml exists.
  if (!fs.existsSync(path.join(REPO_ROOT, CONFIG))) {
    errL(`Preflight FAIL — ${CONFIG} missing`);
    return { ok: false, cls: "CONFIG_INVALID" };
  }

  // Rollback anchor: record the release currently in service.
  const status = await runOnce("flyctl", ["status", "-a", APP, "--json"]);
  if (status.code !== 0) {
    errL(`Preflight FAIL — cannot read Fly status for ${APP}: ${status.stderr.slice(0, 200)}`);
    return { ok: false, cls: "PREFLIGHT" };
  }
  try {
    const j = JSON.parse(status.stdout);
    const machines = j?.Machines ?? [];
    const anchorImage = machines[0]?.image_ref?.tag ?? j?.ImageRef ?? "unknown";
    const anchorVersion = machines[0]?.instance_id ?? j?.Version ?? "unknown";
    checkpoint.rollbackAnchor = { version: anchorVersion, image: anchorImage, capturedAtIso: new Date().toISOString() };
    info(`Rollback anchor — machine=${machines[0]?.id ?? "?"} version=${anchorVersion} image=${anchorImage}`);
  } catch (e) {
    warn(`Rollback anchor — could not parse status JSON: ${String(e).slice(0, 100)}`);
    checkpoint.rollbackAnchor = { version: "unknown", image: "unknown", capturedAtIso: new Date().toISOString() };
  }

  // Strategy-specific preflight.
  if (strategy === "image") {
    if (!imageRef) {
      errL("Preflight FAIL — strategy=image requires --image or SPECTRE_DEPLOY_IMAGE");
      return { ok: false, cls: "IMAGE_MISSING" };
    }
    if (!/^registry\.fly\.io\/[a-z0-9-]+:[a-z0-9._-]+$/i.test(imageRef)) {
      errL(`Preflight FAIL — image ref must be registry.fly.io/<app>:<tag>, got: ${imageRef}`);
      return { ok: false, cls: "CONFIG_INVALID" };
    }
    info(`Image — ${imageRef}`);
  } else if (strategy === "local") {
    // Only require Docker if we are doing a local build.
    const docker = await runOnce("docker", ["info", "--format", "{{.ServerVersion}}"]);
    if (docker.code !== 0) {
      errL(`Preflight FAIL — Docker not reachable (strategy=local requires local Docker): ${docker.stderr.slice(0, 200)}`);
      return { ok: false, cls: "PREFLIGHT" };
    }
    info(`docker — server ${docker.stdout.trim()}`);
  } else {
    errL(`Preflight FAIL — unknown strategy: ${strategy}`);
    return { ok: false, cls: "CONFIG_INVALID" };
  }

  info("Preflight — OK");
  return { ok: true };
}

// -----------------------------------------------------------------------
// Supervised child with idle-output watchdog + stage tracking
// -----------------------------------------------------------------------

async function supervisedChild(cmd, args, opts) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stage = opts.initialStage;
    let lastByteAt = Date.now();
    let killed = false;
    let killClass = null;
    let bufOut = "";
    const child = spawn(cmd, args, { cwd: REPO_ROOT, shell: false, env: { ...process.env } });
    info(`> ${cmd} ${args.map(a => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`);

    const flushLine = (line) => {
      const clean = redact(line.replace(/\r$/, ""));
      fs.appendFileSync(LOG_FILE, clean + "\n");
      process.stdout.write(clean + "\n");
      opts.onLine && opts.onLine(clean);
      for (const t of opts.stageTransitions ?? []) {
        if (t.match.test(clean)) {
          if (stage !== t.stage) {
            stage = t.stage;
            info(`[stage] → ${stage}`);
          }
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
// One deploy attempt (strategy-aware)
// -----------------------------------------------------------------------

async function attemptDeploy(attemptNumber, strategy, imageRef) {
  info(`Attempt ${attemptNumber}/${MAX_ATTEMPTS} — strategy=${strategy}`);
  const attempt = {
    number: attemptNumber,
    startedAtIso: new Date().toISOString(),
    strategy,
    image: imageRef,
    stage: null,
    exitCode: null,
    killed: false,
    killClass: null,
    elapsedMs: null,
    finishedAtIso: null,
  };
  checkpoint.attempts.push(attempt);
  checkpoint.strategy = strategy;
  checkpoint.image = imageRef;
  persistCheckpoint();

  // Build flyctl argv based on strategy.
  const args = ["deploy", "-a", APP, "--config", CONFIG];
  if (strategy === "image") {
    args.push("--image", imageRef);
    // We already own the image — skip any implicit build.
    args.push("--strategy", "rolling");
  } else if (strategy === "local") {
    args.push("--local-only");
  }

  // Initial stage differs: image strategy skips the entire BUILD/EXPORT
  // phase and starts at PUSH (image is already in the Fly registry;
  // flyctl needs to verify + then release + rollout).
  const initialStage = strategy === "image" ? "PUSH" : "BUILD";

  const res = await supervisedChild("flyctl", args, {
    overallMs: STAGE_TIMEOUTS_MS.overall,
    initialStage,
    stageIdleMs: {
      BUILD:   STAGE_TIMEOUTS_MS.buildIdleKill,
      EXPORT:  STAGE_TIMEOUTS_MS.exportIdleKill,
      PUSH:    STAGE_TIMEOUTS_MS.pushIdleKill,
      RELEASE: STAGE_TIMEOUTS_MS.releaseIdleKill,
      ROLLOUT: STAGE_TIMEOUTS_MS.rolloutIdleKill,
      default: STAGE_TIMEOUTS_MS.pushIdleKill,
    },
    stageTransitions: [
      { stage: "EXPORT",  match: /exporting to image|exporting layers/i },
      { stage: "PUSH",    match: /Pushing image|--> Pushing image|The push refers to|Waiting for image|Searching for image/i },
      { stage: "RELEASE", match: /Running release_command|release_command|Running Prisma|Applying migration/i },
      { stage: "ROLLOUT", match: /Preparing to run|Updating|update finished|Machines? are up|Watch your deployment|Successfully deployed/i },
    ],
  });

  attempt.exitCode = res.code;
  attempt.killed = res.killed;
  attempt.killClass = res.killClass;
  attempt.stage = res.stage;
  attempt.elapsedMs = res.elapsedMs;
  attempt.finishedAtIso = new Date().toISOString();
  persistCheckpoint();

  if (res.killed) return { ok: false, cls: res.killClass ?? "UNKNOWN", attempt };
  if (res.code !== 0) return { ok: false, cls: stageToFailureClass(res.stage), attempt };
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

async function collectDiagnostics(strategy) {
  info("Diagnostics — gathering post-failure state");
  const st = await runOnce("flyctl", ["status", "-a", APP]);
  info(`Fly status:\n${st.stdout}`);
  const logs = await runOnce("flyctl", ["logs", "-a", APP, "--no-tail"]);
  const logsTail = logs.stdout.split(/\r?\n/).slice(-80).join("\n");
  info(`Fly logs (last 80 lines):\n${logsTail}`);
  if (strategy === "local") {
    const df = await runOnce("docker", ["system", "df"]);
    info(`docker system df:\n${df.stdout}`);
  }
}

// -----------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------

async function main() {
  const flags = parseArgs();
  if (flags.diag) {
    await collectDiagnostics("local");
    process.exit(0);
  }
  const strategy = resolveStrategy(flags);
  const imageRef = resolveImageRef(flags);

  info("=".repeat(72));
  info(`Spectre staging deploy — run ${runId}`);
  info(`Strategy:   ${strategy}${imageRef ? `  image=${imageRef}` : ""}`);
  info(`Log:        ${LOG_FILE}`);
  info(`Checkpoint: ${CHECKPOINT_FILE}`);
  info("=".repeat(72));

  const lock = acquireLock();
  if (!lock.ok) {
    errL(`Lock — another deployment is already in progress: ${lock.owner}`);
    process.exit(2);
  }

  const overallStart = Date.now();
  try {
    const pf = await preflight(strategy, imageRef);
    if (!pf.ok) {
      checkpoint.final = "FAILURE";
      checkpoint.failureClass = pf.cls;
      persistCheckpoint();
      await collectDiagnostics(strategy);
      process.exit(2);
    }

    let attemptNumber = 0;
    while (attemptNumber < MAX_ATTEMPTS) {
      attemptNumber += 1;
      const r = await attemptDeploy(attemptNumber, strategy, imageRef);
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
        await collectDiagnostics(strategy);
        process.exit(3);
      }
      if (attemptNumber >= MAX_ATTEMPTS) {
        errL(`Retryable failure but MAX_ATTEMPTS (${MAX_ATTEMPTS}) reached. Aborting.`);
        checkpoint.final = "FAILURE";
        checkpoint.failureClass = r.cls;
        persistCheckpoint();
        await collectDiagnostics(strategy);
        process.exit(3);
      }
    }

    const hv = await verifyHealth();
    if (!hv.ok) {
      checkpoint.final = "FAILURE";
      checkpoint.failureClass = "HEALTH_FAILED";
      persistCheckpoint();
      await collectDiagnostics(strategy);
      process.exit(4);
    }

    checkpoint.final = "SUCCESS";
    checkpoint.totalMs = Date.now() - overallStart;

    // Record post-deploy release.
    const status = await runOnce("flyctl", ["status", "-a", APP, "--json"]);
    try {
      const j = JSON.parse(status.stdout);
      const machines = j?.Machines ?? [];
      const newVersion = machines[0]?.instance_id ?? j?.Version ?? "?";
      const newImage = machines[0]?.image_ref?.tag ?? j?.ImageRef ?? "?";
      info(`New release — machine=${machines[0]?.id ?? "?"} version=${newVersion} image=${newImage}`);
      checkpoint.newRelease = { version: newVersion, image: newImage };
    } catch { /* ignored */ }

    persistCheckpoint();
    info(`Deploy — SUCCESS in ${Math.round(checkpoint.totalMs / 1000)}s`);
    process.exit(0);
  } finally {
    releaseLock();
    info(`Log:        ${LOG_FILE}`);
    info(`Checkpoint: ${CHECKPOINT_FILE}`);
  }
}

main().catch((e) => {
  errL(`Fatal — ${String(e)}`);
  checkpoint.final = "FAILURE";
  checkpoint.failureClass = "UNKNOWN";
  persistCheckpoint();
  releaseLock();
  process.exit(99);
});
