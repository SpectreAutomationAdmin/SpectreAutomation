// Sprint 2 B4.1 — AWS KMS diagnostic.
//
// This script does NOT change any AWS resource, does NOT broaden IAM
// permissions, and does NOT recreate the key. It answers the seven
// diagnostic questions the founder asked:
//
//   1. What are AWS_REGION and AWS_KMS_KEY_ID as loaded from
//      .env.local?
//   2. Which SDK call is being made (DescribeKey / Encrypt / …)?
//   3. What KeyId string is actually sent to AWS (short alias, alias
//      ARN, key UUID, key ARN)?
//   4. What did the resolved env look like immediately after loading?
//   5. Which credential source did the SDK actually use?
//   6. Is the SDK really targeting us-east-2, or is something
//      overriding the region?
//   7. Does DescribeKey succeed against a specific full key ARN?
//
// Every AWS call is DescribeKey (read-only, no side effects). No
// Encrypt / Decrypt is attempted here.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// -----------------------------------------------------------------------------
// Question 4 — env immediately after loading. No secrets printed.
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

console.log("=========================================================");
console.log("[kms-diagnose] Q4 — env values as loaded from .env.local");
console.log("=========================================================");
console.log(`AWS_REGION                = ${JSON.stringify(process.env.AWS_REGION)}`);
console.log(`AWS_KMS_KEY_ID            = ${JSON.stringify(process.env.AWS_KMS_KEY_ID)}`);
console.log(`SPECTRE_KMS_PROVIDER      = ${JSON.stringify(process.env.SPECTRE_KMS_PROVIDER)}`);
console.log(`AWS_ACCESS_KEY_ID present = ${process.env.AWS_ACCESS_KEY_ID ? "yes (" + process.env.AWS_ACCESS_KEY_ID.length + " chars)" : "MISSING"}`);
console.log(`AWS_SECRET_ACCESS_KEY present = ${process.env.AWS_SECRET_ACCESS_KEY ? "yes (" + process.env.AWS_SECRET_ACCESS_KEY.length + " chars)" : "MISSING"}`);

// Check for any AWS-region-influencing overrides that might silently redirect.
console.log("\n----- Region-influencing env vars (any of these override?) -----");
for (const k of ["AWS_DEFAULT_REGION", "AWS_PROFILE", "AWS_SDK_LOAD_CONFIG", "AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_KMS", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE"]) {
  const v = process.env[k];
  if (v !== undefined) console.log(`  ${k} = ${JSON.stringify(v)}`);
}
if (!process.env.AWS_DEFAULT_REGION && !process.env.AWS_PROFILE) console.log("  (none set — AWS_REGION alone controls region)");

// -----------------------------------------------------------------------------
// Question 5 — credential source. Ask the SDK's default chain what
// it will hand us BEFORE we make a real call.
// -----------------------------------------------------------------------------
console.log("\n=========================================================");
console.log("[kms-diagnose] Q5 — credential source (what the SDK will use)");
console.log("=========================================================");
const { fromNodeProviderChain } = await import("@aws-sdk/credential-providers");
const providerChain = fromNodeProviderChain({});
let creds;
try {
  creds = await providerChain();
  const envAccessId = process.env.AWS_ACCESS_KEY_ID;
  console.log(`  credentials resolved: yes`);
  console.log(`  access key prefix (first 4 chars only): ${creds.accessKeyId?.slice(0, 4)}****`);
  console.log(`  access key length: ${creds.accessKeyId?.length}`);
  console.log(`  matches process.env.AWS_ACCESS_KEY_ID exactly? ${creds.accessKeyId === envAccessId ? "YES → env source" : "no → different source (profile / SSO / EC2 role / …)"}`);
  if (creds.sessionToken) console.log(`  session token present: yes (STS-issued short-lived credentials)`);
  else console.log(`  session token present: no (long-lived IAM user access key)`);
  if (creds.expiration) console.log(`  credential expiration: ${creds.expiration.toISOString()} (temporary — from STS)`);
  else console.log(`  credential expiration: none (permanent IAM user access key)`);
} catch (e) {
  console.error(`  credential resolution FAILED: ${e.name} ${e.message?.slice(0, 200)}`);
}

// STS GetCallerIdentity — the definitive answer to "whose credentials
// are these?" from AWS's own point of view. Requires no permissions.
console.log("\n=========================================================");
console.log("[kms-diagnose] STS GetCallerIdentity");
console.log("=========================================================");
try {
  const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
  const sts = new STSClient({ region: process.env.AWS_REGION || "us-east-2" });
  const id = await sts.send(new GetCallerIdentityCommand({}));
  console.log(`  Account: ${id.Account}`);
  console.log(`  Arn:     ${id.Arn}`);
  console.log(`  UserId:  ${id.UserId}`);
} catch (e) {
  console.error(`  STS GetCallerIdentity FAILED: ${e.name} ${e.message?.slice(0, 200)}`);
}

// -----------------------------------------------------------------------------
// Question 3 + 7 — try DescribeKey with FOUR KeyId formats, one by
// one, so we can see which formats AWS accepts.
// -----------------------------------------------------------------------------
console.log("\n=========================================================");
console.log("[kms-diagnose] Q2, Q3, Q7 — DescribeKey with 4 KeyId formats");
console.log("=========================================================");
const { KMSClient, DescribeKeyCommand } = await import("@aws-sdk/client-kms");

const REGION = process.env.AWS_REGION || "us-east-2";
console.log(`Region passed to KMSClient: ${REGION}`);
const client = new KMSClient({ region: REGION });

// Confirm client's actual resolved region + endpoint AFTER construction.
try {
  const resolved = await client.config.region();
  console.log(`Client resolved region:     ${resolved}`);
} catch (e) {
  console.log(`Client resolved region:     (unable to inspect: ${e.message?.slice(0, 120)})`);
}
try {
  const endpoint = await client.config.endpoint?.();
  if (endpoint) console.log(`Client resolved endpoint:   ${endpoint.protocol}//${endpoint.hostname}${endpoint.path === "/" ? "" : endpoint.path}`);
} catch { /* SDK versions differ on this API */ }

const ACCOUNT_ID = "162105037982"; // Confirmed by founder from console.
const KEY_UUID = "cf55a9be-8bba-46b9-85d2-116fec0dfb81"; // Confirmed by founder from console.
const ALIAS_SHORT = "alias/spectre-staging-envelope";
const ALIAS_ARN = `arn:aws:kms:${REGION}:${ACCOUNT_ID}:alias/spectre-staging-envelope`;
const KEY_ARN = `arn:aws:kms:${REGION}:${ACCOUNT_ID}:key/${KEY_UUID}`;

// Candidate KeyId formats — all four AWS accepts.
const candidates = [
  { label: "1. short alias name (what env sends today)",   keyId: process.env.AWS_KMS_KEY_ID ?? ALIAS_SHORT },
  { label: "2. explicit short alias literal",              keyId: ALIAS_SHORT },
  { label: "3. full alias ARN with region + account",      keyId: ALIAS_ARN },
  { label: "4. bare key UUID (no ARN)",                    keyId: KEY_UUID },
  { label: "5. full KEY ARN (bypass alias resolution)",    keyId: KEY_ARN },
];

for (const c of candidates) {
  console.log(`\n--- ${c.label}`);
  console.log(`    KeyId sent to AWS: ${c.keyId}`);
  try {
    const res = await client.send(new DescribeKeyCommand({ KeyId: c.keyId }));
    const meta = res.KeyMetadata;
    console.log(`    ✓ DescribeKey OK`);
    console.log(`      KeyId:      ${meta?.KeyId}`);
    console.log(`      Arn:        ${meta?.Arn}`);
    console.log(`      State:      ${meta?.KeyState}`);
    console.log(`      Enabled:    ${meta?.Enabled}`);
    console.log(`      MultiRegion:${meta?.MultiRegion}`);
    console.log(`      KeyManager: ${meta?.KeyManager}`);
  } catch (err) {
    console.log(`    ✗ ${err.name}: ${err.message?.slice(0, 200)}`);
    if (err.$metadata) {
      console.log(`      httpStatus: ${err.$metadata.httpStatusCode}`);
      console.log(`      requestId:  ${err.$metadata.requestId}`);
    }
  }
}

console.log("\n=========================================================");
console.log("[kms-diagnose] end. No AWS resource was created or modified.");
console.log("=========================================================");
