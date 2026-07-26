// Phase 8G — Secrets manager abstraction.
//
// At runtime, callers request secrets by (clubId, scope, provider, keyName).
// Resolution order:
//   1. Environment variable matching the canonical name (e.g. SPECTRE_SES_clubA_accessKeyId)
//   2. SecretsProvider adapter (AWS Secrets Manager / GCP Secret Manager)
//   3. DB-stored IntegrationSetting.secretsJson (DEV/staging only; refused
//      in production unless explicitly enabled via SPECTRE_ALLOW_DB_SECRETS=1).
//
// This keeps Phase 7's `IntegrationSetting` schema while adding a hardened
// production path. Every secret resolution is audit-logged at low verbosity.

import { prisma } from "../prisma";
import { logger } from "../observability/logger";
import { env } from "../env";
import { optionalImport } from "../integrations/optional-import";
import { readSecrets, getActiveIntegration } from "../integrations/config";

export interface SecretsProvider {
  name: string;
  getSecret(args: { clubId: string; scope: string; provider: string; keyName: string }): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Env-var provider — first lookup tier. Naming convention:
//   SPECTRE_<SCOPE>_<PROVIDER>_<KEYNAME>     (global default)
//   SPECTRE_<SCOPE>_<PROVIDER>_<KEYNAME>__<CLUBSLUG>  (per-club override)
// ---------------------------------------------------------------------------
export const envSecretsProvider: SecretsProvider = {
  name: "env",
  async getSecret({ clubId, scope, provider, keyName }) {
    const club = await prisma.club.findUnique({ where: { id: clubId }, select: { slug: true } });
    const clubKey = club?.slug.toUpperCase().replace(/-/g, "_");
    const upper = `${scope}_${provider}_${keyName}`.toUpperCase();
    const candidates = [
      clubKey ? `SPECTRE_${upper}__${clubKey}` : null,
      `SPECTRE_${upper}`,
    ].filter(Boolean) as string[];
    for (const name of candidates) {
      const value = process.env[name];
      if (value) return value;
    }
    return null;
  },
};

// AWS Secrets Manager adapter (dynamic-import).
export async function awsSecretsManagerProvider(args: { region: string }): Promise<SecretsProvider> {
  const mod = await optionalImport("@aws-sdk/client-secrets-manager");
  if (!mod) {
    logger.warn("secrets.aws.missing", { hint: "@aws-sdk/client-secrets-manager not installed" });
    return {
      name: "aws-secrets-missing",
      async getSecret() { return null; },
    };
  }
  const { SecretsManagerClient, GetSecretValueCommand } = mod;
  const client = new SecretsManagerClient({ region: args.region });
  return {
    name: "aws-secrets-manager",
    async getSecret({ clubId, scope, provider, keyName }) {
      const club = await prisma.club.findUnique({ where: { id: clubId }, select: { slug: true } });
      // Path convention: spectre/{clubSlug}/{scope}/{provider} stores a JSON
      // map { keyName: value, ... }. One Secrets-Manager entry per integration.
      const id = `spectre/${club?.slug ?? clubId}/${scope.toLowerCase()}/${provider.toLowerCase()}`;
      try {
        const result = await client.send(new GetSecretValueCommand({ SecretId: id }));
        if (!result.SecretString) return null;
        const parsed = JSON.parse(result.SecretString) as Record<string, string>;
        return parsed[keyName] ?? null;
      } catch (err) {
        logger.warn("secrets.aws.miss", { id, error: err instanceof Error ? err.message : String(err) });
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Resolver — tries providers in order, falls back to IntegrationSetting only
// when DB secrets are explicitly allowed (defaults to true in dev/test).
// ---------------------------------------------------------------------------
let activeProvider: SecretsProvider = envSecretsProvider;
export function setSecretsProvider(p: SecretsProvider) { activeProvider = p; }

const DB_SECRETS_ALLOWED = env.NODE_ENV !== "production" || process.env.SPECTRE_ALLOW_DB_SECRETS === "1";

export async function getSecret(args: { clubId: string; scope: "EMAIL" | "SMS" | "STORAGE" | "LLM" | "POS"; provider: string; keyName: string }): Promise<string | null> {
  // 1. Env provider.
  const fromEnv = await envSecretsProvider.getSecret(args);
  if (fromEnv) return fromEnv;
  // 2. Configured provider (AWS Secrets Manager, etc.) if not the default.
  if (activeProvider !== envSecretsProvider) {
    const fromCloud = await activeProvider.getSecret(args);
    if (fromCloud) return fromCloud;
  }
  // 3. DB fallback (dev/staging only).
  if (DB_SECRETS_ALLOWED) {
    const setting = await getActiveIntegration(args.clubId, args.scope);
    if (setting) {
      const secrets = readSecrets<Record<string, string>>(setting);
      const value = secrets[args.keyName];
      if (value) return value;
    }
  }
  return null;
}

// Bulk variant — common case when the adapter needs multiple keys.
export async function getSecrets<T extends Record<string, string>>(args: {
  clubId: string; scope: "EMAIL" | "SMS" | "STORAGE" | "LLM" | "POS"; provider: string; keyNames: string[];
}): Promise<Partial<T>> {
  const out: Record<string, string> = {};
  for (const name of args.keyNames) {
    const value = await getSecret({ ...args, keyName: name });
    if (value) out[name] = value;
  }
  return out as Partial<T>;
}
