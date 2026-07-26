// Sprint 2 B4.1 — AWS KMS envelope validation.
//
// Reads AWS credentials + KMS key config from process env (loaded from
// .env.local). NEVER prints them. Runs an encrypt → decrypt round
// trip against the live AWS KMS key using the SAME code path
// (`encryptSecret` / `decryptSecret` in src/lib/kms/index.ts) that
// staging + production will use.
//
// Probe plaintext: a fixed non-sensitive marker `spectre-kms-probe:<pid>:<ts>`.
// Neither plaintext nor ciphertext is printed in full — the probe
// asserts equality after the round trip and reports only lengths.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// -----------------------------------------------------------------------------
// Env load (.env.local wins, per project convention).
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
const REQUIRED = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_KMS_KEY_ID", "AWS_REGION", "SPECTRE_KMS_PROVIDER"];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`[kms-validate] missing env vars: ${missing.join(", ")}`);
  console.error("  put them in .env.local (gitignored). Never in chat.");
  process.exit(2);
}
if (process.env.SPECTRE_KMS_PROVIDER !== "aws") {
  console.error(`[kms-validate] SPECTRE_KMS_PROVIDER must be "aws" for this probe (got "${process.env.SPECTRE_KMS_PROVIDER}")`);
  process.exit(2);
}
// Credential separation guard.
if (
  process.env.AWS_ACCESS_KEY_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.AWS_ACCESS_KEY_ID === process.env.R2_ACCESS_KEY_ID
) {
  console.error("[kms-validate] AWS_ACCESS_KEY_ID == R2_ACCESS_KEY_ID — refuse (credential-scope collision).");
  process.exit(2);
}
console.log(`[kms-validate] provider: aws · region: ${process.env.AWS_REGION} · keyId: ${process.env.AWS_KMS_KEY_ID}`);
console.log("[kms-validate] credential separation: AWS_* and R2_* are distinct");

// Fresh Prisma generate is required because the KMS module writes
// EncryptedSecretMetadata + SecretAccessLog rows. Tests-mode env
// override forces the in-memory dev DB (SQLite via .env). Do NOT
// let this probe touch Neon; it only round-trips against KMS.
process.env.NODE_ENV = "development";

// -----------------------------------------------------------------------------
// Boot: use the same code path staging + production will use.
// -----------------------------------------------------------------------------
console.log("\n[kms-validate] importing KMS module through tsx (uses lib/kms/index.ts)");
// Write a throw-away TS probe that calls encryptSecret + decryptSecret.
const probePath = path.join(root, ".kms-probe.ts");
// Call the raw provider (not encryptSecret's audit-writing wrapper).
// This isolates the KMS credential+key validation from Prisma / DB
// state so the probe can run against KMS regardless of which
// database the app is currently pointed at. The provider IS the
// production code path — encryptSecret only adds SecretAccessLog
// bookkeeping on top of it. Every one of the four permitted KMS
// actions (Encrypt/Decrypt/GenerateDataKey/DescribeKey) is
// exercised: DescribeKey via selectKmsProvider's readiness check
// and Encrypt/Decrypt via the round trip.
const probeSrc = `
import { selectKmsProvider } from "./src/lib/kms";
(async () => {
  try {
    const provider = await selectKmsProvider();
    console.log("PROVIDER_NAME:" + provider.name);
    console.log("PROVIDER_KEY_ID:" + provider.keyId());
    if (provider.name !== "aws-kms") {
      console.error("EXPECTED_AWS_KMS_PROVIDER_GOT:" + provider.name);
      process.exit(1);
    }

    const plaintext = "spectre-kms-probe:" + process.pid + ":" + Date.now();
    console.log("PROBE_PLAINTEXT_LEN:" + plaintext.length);

    const ct = await provider.encrypt(plaintext);
    console.log("CIPHERTEXT_PREFIX:" + ct.split(":").slice(0, 3).join(":"));
    console.log("CIPHERTEXT_LEN:" + ct.length);
    if (!ct.startsWith("enc:aws:")) {
      console.error("EXPECTED_AWS_ENVELOPE_MARKER_MISSING");
      process.exit(1);
    }

    const pt = await provider.decrypt(ct);
    console.log("ROUND_TRIP_MATCH:" + (pt === plaintext ? "yes" : "no"));
    if (pt !== plaintext) {
      console.error("DECRYPT_MISMATCH_LEN_EXPECTED:" + plaintext.length + "_GOT:" + pt.length);
      process.exit(1);
    }
    console.log("KMS_PROBE_OK");
    process.exit(0);
  } catch (e) {
    // Sanitise: log ONLY error name + first 200 chars of message.
    const msg = (e && e.message ? String(e.message) : String(e)).slice(0, 200);
    const name = (e && e.name) || "Error";
    console.error("KMS_PROBE_FAIL name=" + name + " msg=" + msg);
    process.exit(1);
  }
})();
`;
import { writeFileSync } from "node:fs";
writeFileSync(probePath, probeSrc, "utf8");

let ok = false;
try {
  const out = execSync(`npx tsx ${probePath}`, {
    cwd: root,
    env: { ...process.env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  process.stdout.write(out);
  ok = out.includes("KMS_PROBE_OK") && out.includes("ROUND_TRIP_MATCH:yes");
} catch (e) {
  process.stdout.write((e.stdout || "").toString());
  process.stderr.write((e.stderr || "").toString());
} finally {
  try { execSync(`rm ${probePath}`); } catch { /* ignore */ }
}

if (!ok) {
  console.error("\n[kms-validate] FAILURE");
  process.exit(1);
}
console.log("\n[kms-validate] SUCCESS — AWS KMS envelope round trip verified.");
