// Phase 7C — Storage adapters.
//
//   localFileStorageAdapter   — writes to a local directory under .data/
//   s3StorageAdapter          — dynamically imports @aws-sdk/client-s3
//
// Storage keys follow the convention: clubs/{clubId}/documents/{docId}/{filename}
// (composed by the document service; storage adapter is opaque).

import type { StorageAdapter } from "../enterprise/documents";
import { getActiveIntegration, readConfig, readSecrets } from "./config";
import { promises as fs } from "fs";
import { join, dirname } from "path";

// ---------------------------------------------------------------------------
// In-memory (default for tests + dev with no config).
// Re-exported from documents.ts is the simplest seed.
// ---------------------------------------------------------------------------

export function localFileStorageAdapter(rootDir = ".data/storage"): StorageAdapter {
  return {
    async put({ clubId, storageKey, body }) {
      const filePath = join(rootDir, clubId, storageKey);
      await fs.mkdir(dirname(filePath), { recursive: true });
      const buf = typeof body === "string" ? Buffer.from(body) : body;
      await fs.writeFile(filePath, buf);
    },
    async get({ clubId, storageKey }) {
      const filePath = join(rootDir, clubId, storageKey);
      try { return await fs.readFile(filePath); }
      catch { return null; }
    },
    async delete({ clubId, storageKey }) {
      const filePath = join(rootDir, clubId, storageKey);
      try { await fs.unlink(filePath); } catch { /* idempotent */ }
    },
  };
}

// ---------------------------------------------------------------------------
// S3 / S3-compatible
// ---------------------------------------------------------------------------
export async function s3StorageAdapter(args: { region: string; bucket: string; accessKeyId: string; secretAccessKey: string; endpoint?: string; forcePathStyle?: boolean; }): Promise<StorageAdapter> {
  const { optionalImport } = await import("./optional-import");
  const S3Module = await optionalImport("@aws-sdk/client-s3");
  if (!S3Module) {
    return {
      async put() { throw new Error("@aws-sdk/client-s3 not installed"); },
      async get() { return null; },
      async delete() { /* noop */ },
    };
  }
  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = S3Module;
  const client = new S3Client({
    region: args.region,
    credentials: { accessKeyId: args.accessKeyId, secretAccessKey: args.secretAccessKey },
    endpoint: args.endpoint,
    forcePathStyle: args.forcePathStyle,
  });
  return {
    async put({ clubId, storageKey, body, mimeType }) {
      const key = `clubs/${clubId}/${storageKey}`;
      const buf = typeof body === "string" ? Buffer.from(body) : body;
      await client.send(new PutObjectCommand({ Bucket: args.bucket, Key: key, Body: buf, ContentType: mimeType }));
    },
    async get({ clubId, storageKey }) {
      const key = `clubs/${clubId}/${storageKey}`;
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: args.bucket, Key: key }));
        const stream = result.Body as { transformToByteArray?: () => Promise<Uint8Array> } | null;
        if (!stream?.transformToByteArray) return null;
        const bytes = await stream.transformToByteArray();
        return Buffer.from(bytes);
      } catch { return null; }
    },
    async delete({ clubId, storageKey }) {
      const key = `clubs/${clubId}/${storageKey}`;
      await client.send(new DeleteObjectCommand({ Bucket: args.bucket, Key: key }));
    },
  };
}

// ---------------------------------------------------------------------------
// Sprint 2 B4.1 / Step 6 (2026-07-20) — Mailbox attachment storage.
//
// Env-driven S3-compatible adapter for the mailbox attachment
// pipeline. Reads:
//   • S3_BUCKET
//   • S3_ENDPOINT             (Cloudflare R2 endpoint)
//   • S3_REGION               (ignored by R2 but required by the AWS SDK)
//   • S3_FORCE_PATH_STYLE     (true for R2)
//   • R2_ACCESS_KEY_ID        (NEVER AWS_ACCESS_KEY_ID)
//   • R2_SECRET_ACCESS_KEY    (NEVER AWS_SECRET_ACCESS_KEY)
//
// AWS KMS uses AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY via the
// AWS SDK's default credential chain — these two providers are
// scope-separated at the env-var level (env.ts throws at boot if
// their values match).
//
// Returns `null` when required env vars are missing so the caller
// can decide whether to fall back to local storage or fail loudly.
export async function mailboxAttachmentStorageAdapter(): Promise<StorageAdapter | null> {
  const bucket = process.env.S3_BUCKET;
  const endpoint = process.env.S3_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const region = process.env.S3_REGION ?? "auto"; // R2 accepts "auto"
  const forcePathStyle = (process.env.S3_FORCE_PATH_STYLE ?? "true") === "true";
  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) return null;
  return s3StorageAdapter({
    region,
    bucket,
    endpoint,
    forcePathStyle,
    accessKeyId,
    secretAccessKey,
  });
}

export async function selectStorageAdapter(clubId: string, fallback: StorageAdapter): Promise<StorageAdapter> {
  const setting = await getActiveIntegration(clubId, "STORAGE");
  if (!setting) return fallback;
  const config = readConfig<{ region?: string; bucket?: string; endpoint?: string; forcePathStyle?: boolean; rootDir?: string }>(setting);
  const secrets = readSecrets<{ accessKeyId?: string; secretAccessKey?: string }>(setting);
  if (setting.provider === "s3") {
    if (!config.region || !config.bucket || !secrets.accessKeyId || !secrets.secretAccessKey) return fallback;
    return s3StorageAdapter({
      region: config.region, bucket: config.bucket, endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle, accessKeyId: secrets.accessKeyId, secretAccessKey: secrets.secretAccessKey,
    });
  }
  if (setting.provider === "local") return localFileStorageAdapter(config.rootDir ?? ".data/storage");
  if (setting.provider === "memory" || setting.provider === "dev") return fallback;
  return fallback;
}
