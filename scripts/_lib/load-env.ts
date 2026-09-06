// Founder-preview scripts run outside Next.js and therefore need
// to load `.env.local` explicitly so they share the same KMS
// provider (SPECTRE_KMS_PROVIDER, AWS_KMS_KEY_ID, SPECTRE_LOCAL_KMS_KEY,
// etc.) as the running dev server. Otherwise a fixture that writes
// through one provider may leave ciphertext the dev server cannot
// decrypt.
//
// Zero-dependency: no dotenv package required. Mimics Next.js's
// load order (.env.local overrides .env; existing process.env
// values always win — never overrides an intentionally-set var).

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) continue;
    if (process.env[key] !== undefined) continue; // never override
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

/**
 * Load .env.local then .env (both optional) from the current
 * working directory. Idempotent; existing env vars are never
 * overridden. Call at the top of every fixture / helper script
 * that touches KMS-backed data.
 */
export function loadEnvFiles(cwd: string = process.cwd()): void {
  loadEnvFile(resolve(cwd, ".env.local"));
  loadEnvFile(resolve(cwd, ".env"));
}
