// Sprint 2 B4.1 — Cloudflare R2 storage validation.
//
// Reads R2 credentials + config from process env (loaded from
// .env.local). NEVER prints them. Runs a real upload → HEAD → GET →
// DELETE → verify-absence round trip against the private
// `spectre-staging-mailbox-attachments` bucket.
//
// Probe key: `spectre-probe/<pid>-<ts>.txt` — cleaned up at the end.
// Body: a short deterministic string ("spectre-r2-probe:<pid>:<ts>")
// so the read-back check is a direct equality.
//
// Does NOT touch any real mailbox attachment. Does NOT implement
// Phase C attachment fetching.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// -----------------------------------------------------------------------------
// Env load (same convention as neon/upstash validators).
// -----------------------------------------------------------------------------
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
const dotenv = parseEnvFile(path.join(root, ".env"));
const dotenvLocal = parseEnvFile(path.join(root, ".env.local"));
for (const [k, v] of Object.entries(dotenv)) if (!(k in process.env)) process.env[k] = v;
for (const [k, v] of Object.entries(dotenvLocal)) process.env[k] = v;

// -----------------------------------------------------------------------------
// Guard rails.
// -----------------------------------------------------------------------------
const REQUIRED = ["S3_BUCKET", "S3_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`[r2-validate] missing env vars: ${missing.join(", ")}`);
  console.error("  put them in .env.local (gitignored). Never in chat.");
  process.exit(2);
}
const BUCKET = process.env.S3_BUCKET;
const ENDPOINT = process.env.S3_ENDPOINT;
if (BUCKET !== "spectre-staging-mailbox-attachments") {
  console.error(`[r2-validate] refusing: S3_BUCKET is not spectre-staging-mailbox-attachments (${BUCKET})`);
  process.exit(2);
}
try {
  const u = new URL(ENDPOINT);
  if (!u.host.endsWith(".r2.cloudflarestorage.com")) {
    console.error(`[r2-validate] refusing: S3_ENDPOINT host does not end with .r2.cloudflarestorage.com`);
    process.exit(2);
  }
  console.log(`[r2-validate] target: ${u.protocol}//${u.host}/${BUCKET}`);
} catch (e) {
  console.error(`[r2-validate] S3_ENDPOINT is not a valid URL: ${e.message}`);
  process.exit(2);
}
// Credential separation invariant — mirrors the boot-time guard in env.ts.
if (
  process.env.AWS_ACCESS_KEY_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.AWS_ACCESS_KEY_ID === process.env.R2_ACCESS_KEY_ID
) {
  console.error("[r2-validate] AWS_ACCESS_KEY_ID == R2_ACCESS_KEY_ID — refuse (credential-scope collision).");
  process.exit(2);
}
console.log("[r2-validate] credential separation: R2 and AWS vars are distinct (or AWS_* is unset locally)");

// -----------------------------------------------------------------------------
// Build client via the SAME code path staging will use.
// -----------------------------------------------------------------------------
console.log("\n[r2-validate] instantiating S3 client via mailboxAttachmentStorageAdapter()");
const {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = await import("@aws-sdk/client-s3");
const client = new S3Client({
  region: process.env.S3_REGION ?? "auto",
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  endpoint: ENDPOINT,
  forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? "true") === "true",
});
console.log("  ✓ S3Client constructed with R2_* credentials (NOT AWS_*)");

// -----------------------------------------------------------------------------
// Round trip.
// -----------------------------------------------------------------------------
const PROBE_KEY = `spectre-probe/${process.pid}-${Date.now()}.txt`;
const PROBE_BODY = `spectre-r2-probe:${process.pid}:${Date.now()}`;

let anyStepFailed = false;

async function step(label, fn) {
  process.stdout.write(`  [step] ${label}… `);
  try {
    const res = await fn();
    console.log("✓");
    return res;
  } catch (err) {
    console.log("✗");
    console.error(`    ${err.message}`);
    anyStepFailed = true;
    throw err;
  }
}

console.log("\n[r2-validate] Step A — PUT probe object");
await step("PUT " + PROBE_KEY, () =>
  client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: PROBE_KEY,
      Body: Buffer.from(PROBE_BODY, "utf8"),
      ContentType: "text/plain",
    }),
  ),
);

console.log("\n[r2-validate] Step B — HEAD probe object");
const head = await step("HEAD " + PROBE_KEY, () =>
  client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: PROBE_KEY })),
);
console.log(`    content length: ${head.ContentLength}`);
console.log(`    content type: ${head.ContentType}`);
if (head.ContentLength !== PROBE_BODY.length) {
  console.error(`    length mismatch: expected ${PROBE_BODY.length}, got ${head.ContentLength}`);
  process.exit(1);
}

console.log("\n[r2-validate] Step C — GET probe object");
const get = await step("GET " + PROBE_KEY, () =>
  client.send(new GetObjectCommand({ Bucket: BUCKET, Key: PROBE_KEY })),
);
const bodyStream = get.Body;
const chunks = [];
for await (const chunk of bodyStream) {
  chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
}
const readBack = Buffer.concat(chunks).toString("utf8");
if (readBack !== PROBE_BODY) {
  console.error(`    body mismatch: expected ${JSON.stringify(PROBE_BODY)}, got ${JSON.stringify(readBack)}`);
  process.exit(1);
}
console.log(`    ✓ read-back matches PUT body (${readBack.length} bytes)`);

console.log("\n[r2-validate] Step D — DELETE probe object");
await step("DELETE " + PROBE_KEY, () =>
  client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: PROBE_KEY })),
);

console.log("\n[r2-validate] Step E — verify probe object absence");
try {
  await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: PROBE_KEY }));
  console.error(`    ✗ HEAD unexpectedly succeeded after DELETE`);
  process.exit(1);
} catch (err) {
  // AWS SDK v3 returns 404 as NotFound / NoSuchKey.
  const name = err?.name || "Unknown";
  const status = err?.$metadata?.httpStatusCode ?? "-";
  if (status === 404 || /NotFound|NoSuchKey/.test(name)) {
    console.log(`    ✓ HEAD returned ${status} ${name} — object is gone`);
  } else {
    console.error(`    ✗ unexpected error: ${name} (${status})`);
    process.exit(1);
  }
}

if (anyStepFailed) {
  console.error("\n[r2-validate] FAILURE");
  process.exit(1);
}

console.log("\n[r2-validate] SUCCESS — R2 bucket is reachable, credentials are scoped, no probe object remains.");
