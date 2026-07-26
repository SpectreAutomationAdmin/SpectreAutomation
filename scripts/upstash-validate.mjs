// Sprint 2 B4.1 — Upstash Redis validation.
//
// Reads REDIS_URL from process env / .env.local. NEVER prints it.
// Does a raw ioredis PING, then a BullMQ Queue + Worker round trip
// against the live Upstash instance. All test keys are prefixed
// `spectre:pgvalidate:<pid>:` and cleaned up at the end.

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), "..");

// -----------------------------------------------------------------------------
// Env load (same convention as neon-migrate.mjs: .env.local wins).
// -----------------------------------------------------------------------------
function parseEnvFile(file) {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8");
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}
const dotenv = parseEnvFile(path.join(root, ".env"));
const dotenvLocal = parseEnvFile(path.join(root, ".env.local"));
for (const [k, v] of Object.entries(dotenv)) {
  if (!(k in process.env)) process.env[k] = v;
}
for (const [k, v] of Object.entries(dotenvLocal)) {
  process.env[k] = v;
}

// -----------------------------------------------------------------------------
// Guards.
// -----------------------------------------------------------------------------
const REDIS_URL = process.env.REDIS_URL ?? "";
if (!REDIS_URL) {
  console.error("[upstash-validate] REDIS_URL is not set. Put it in .env.local.");
  process.exit(2);
}
if (!/^rediss?:\/\//.test(REDIS_URL)) {
  console.error("[upstash-validate] REDIS_URL scheme must be redis:// or rediss://.");
  process.exit(2);
}
if (!REDIS_URL.startsWith("rediss://") && !process.env.SPECTRE_ACCEPT_PLAIN_REDIS) {
  console.error("[upstash-validate] Refusing a non-TLS redis:// URL. Set SPECTRE_ACCEPT_PLAIN_REDIS=1 if this is intentional.");
  process.exit(2);
}
try {
  const u = new URL(REDIS_URL);
  console.log(`[upstash-validate] target: ${u.protocol}//<user>:<hidden>@${u.host}`);
} catch (e) {
  console.error("[upstash-validate] REDIS_URL is not a valid URL:", e.message);
  process.exit(2);
}

// -----------------------------------------------------------------------------
// 1) Raw ioredis PING.
// -----------------------------------------------------------------------------
console.log("\n[upstash-validate] Step 1 — ioredis PING");
const { default: Redis } = await import("ioredis");
const pingConn = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});
try {
  const pong = await pingConn.ping();
  if (pong !== "PONG") throw new Error(`unexpected reply: ${pong}`);
  console.log("  ✓ PING → PONG");
  const info = (await pingConn.info("server")).split(/\r?\n/).filter((l) => l.startsWith("redis_version") || l.startsWith("redis_mode"));
  for (const line of info) console.log(`  ${line}`);
} catch (err) {
  console.error("  ✗ PING failed:", err.message);
  await pingConn.quit();
  process.exit(1);
}
await pingConn.quit();

// -----------------------------------------------------------------------------
// 2) BullMQ Queue init + enqueue.
// -----------------------------------------------------------------------------
console.log("\n[upstash-validate] Step 2 — BullMQ Queue init + enqueue");
const bullmq = await import("bullmq");
const QueueCtor = bullmq.Queue;
const WorkerCtor = bullmq.Worker;
const QueueEventsCtor = bullmq.QueueEvents;

// Prefix so this run's keys are trivially identifiable + cleaned up.
const QUEUE_NAME = `spectre_probe_${process.pid}_${Date.now().toString(36)}`;
console.log(`  queue name: ${QUEUE_NAME}`);
const queueConnection = new Redis(REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
const queue = new QueueCtor(QUEUE_NAME, { connection: queueConnection });

const jobId = `probe-${Date.now()}`;
await queue.add("probe", { echo: "hello-from-spectre" }, { jobId, removeOnComplete: true, removeOnFail: true });
console.log(`  ✓ enqueued job ${jobId}`);

// -----------------------------------------------------------------------------
// 3) Worker startup + job processing round trip.
// -----------------------------------------------------------------------------
console.log("\n[upstash-validate] Step 3 — Worker startup + processing");
const workerConnection = new Redis(REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
const worker = new WorkerCtor(
  QUEUE_NAME,
  async (job) => {
    console.log(`  worker received: id=${job.id} data=${JSON.stringify(job.data)}`);
    return { processed: true, echo: job.data.echo };
  },
  { connection: workerConnection, concurrency: 1 },
);

// Wait for the worker to finish OR timeout after 20s.
const eventsConnection = new Redis(REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
const events = new QueueEventsCtor(QUEUE_NAME, { connection: eventsConnection });
const outcome = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("worker did not complete within 20s")), 20_000);
  events.on("completed", ({ jobId: completedId, returnvalue }) => {
    if (completedId === jobId) {
      clearTimeout(timer);
      resolve({ jobId: completedId, returnvalue });
    }
  });
  events.on("failed", ({ jobId: failedId, failedReason }) => {
    if (failedId === jobId) {
      clearTimeout(timer);
      reject(new Error(`job failed: ${failedReason}`));
    }
  });
});
console.log(`  ✓ worker processed job: ${JSON.stringify(outcome)}`);

// -----------------------------------------------------------------------------
// Cleanup.
// -----------------------------------------------------------------------------
console.log("\n[upstash-validate] Step 4 — cleanup");
await worker.close();
await events.close();
await queue.obliterate({ force: true });
await queue.close();
await queueConnection.quit();
await workerConnection.quit();
await eventsConnection.quit();
console.log("  ✓ all connections closed; queue obliterated");

console.log("\n[upstash-validate] SUCCESS — Upstash is a live queue backend.");
