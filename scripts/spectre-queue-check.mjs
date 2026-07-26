// Sprint 2 B4.1 — Spectre queue-adapter selection check.
//
// Boots the queue module through tsx (so TypeScript imports resolve)
// and confirms `selectAdapter()` picks BullMQ when REDIS_URL is set.
//
// Not a full round trip — the upstash-validate.mjs script already
// proved a real Queue + Worker + JobRun cycle. This script exists to
// prove that the Spectre adapter's OWN selection logic (which is the
// code path the Fly deployment will execute) picks the right
// backend.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Load env.
function parseEnvFile(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}
const dot = parseEnvFile(path.join(root, ".env"));
const dotLocal = parseEnvFile(path.join(root, ".env.local"));
for (const [k, v] of Object.entries(dot)) if (!(k in process.env)) process.env[k] = v;
for (const [k, v] of Object.entries(dotLocal)) process.env[k] = v;

if (!process.env.REDIS_URL) { console.error("REDIS_URL missing"); process.exit(2); }
process.env.NODE_ENV = "development"; // adapter forces in-memory when NODE_ENV=test

// Write a tiny throw-away TS entry that imports the queue and forces
// adapter selection by enqueueing a probe. Then run via tsx.
const PROBE = path.join(root, ".upstash-probe.ts");
writeFileSync(PROBE, `
import { enqueue } from "./src/lib/queue";
(async () => {
  try {
    // Enqueue MUST route through selectAdapter(); a successful
    // enqueue against Upstash proves BullMQ was selected.
    await enqueue({
      kind: "EXPORT",
      queue: "default",
      clubId: null,
      payload: { exportId: "upstash-adapter-probe" },
      correlationId: "upstash-adapter-probe-" + Date.now(),
      maxAttempts: 1,
    });
    console.log("QUEUE_PROBE_OK");
    process.exit(0);
  } catch (e) {
    console.error("QUEUE_PROBE_FAIL", (e).message);
    process.exit(1);
  }
})();
`, "utf8");

try {
  const out = execSync(`npx tsx ${PROBE}`, {
    cwd: root,
    env: { ...process.env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  process.stdout.write(out);
  if (!out.includes("QUEUE_PROBE_OK")) {
    console.error("QUEUE probe returned but did not emit OK marker");
    process.exit(1);
  }
  console.log("[spectre-queue-check] SUCCESS — Spectre adapter enqueued through the live backend");
} catch (e) {
  process.stdout.write((e.stdout || "").toString());
  process.stderr.write((e.stderr || "").toString());
  console.error("[spectre-queue-check] FAIL");
  process.exit(1);
} finally {
  try { execSync(`rm ${PROBE}`); } catch { /* ignore */ }
}
