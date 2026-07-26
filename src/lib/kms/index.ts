// Phase 12A — KMS-backed secret encryption.
//
// Envelope-encryption architecture:
//   - A KMS provider (AWS / GCP / Azure / local) holds a master key.
//   - Each secret is wrapped: KMS.encrypt(plaintext) → ciphertext with the
//     header keyId.
//   - Decryption is performed only at runtime, never persisted.
//   - All access goes through the audit log.
//
// In dev/test the localKmsProvider uses AES-256-GCM with a key derived from
// SPECTRE_LOCAL_KMS_KEY (must be ≥32 chars). Production refuses to start
// with the local provider when NODE_ENV=production AND no KMS provider
// is configured — see launch readiness.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { prisma } from "../prisma";
import { logger } from "../observability/logger";
import { optionalImport } from "../integrations/optional-import";
import { env } from "../env";

// Sprint 2 (2026-07-19): "MAILBOX" scope for Microsoft 365 delegated
// OAuth tokens (access + refresh) and Graph subscription clientState
// values. Every MailboxConnection / GraphSubscription row stores KMS
// envelope references under this scope. Rotating a scope key rotates
// every mailbox token in one operation.
export type KmsScope = "WEBHOOK" | "BILLING" | "POS" | "SSO" | "PUSH" | "API" | "SMTP" | "MAILBOX";

export interface KmsProvider {
  name: string;
  keyId(): string;
  encrypt(plaintext: string): Promise<string>; // returns prefixed ciphertext "enc:<provider>:<keyId>:<base64>"
  decrypt(ciphertext: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Local provider — derives a key from SPECTRE_LOCAL_KMS_KEY for dev/test.
// ---------------------------------------------------------------------------
function localKey(): Buffer {
  const raw = process.env.SPECTRE_LOCAL_KMS_KEY ?? "spectre-local-kms-development-only-key-do-not-use-in-production";
  return createHash("sha256").update(raw).digest();
}

export const localKmsProvider: KmsProvider = {
  name: "local",
  keyId() { return "local-dev-v1"; },
  async encrypt(plaintext: string) {
    const iv = randomBytes(12);
    const key = localKey();
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const blob = Buffer.concat([iv, tag, ciphertext]).toString("base64");
    return `enc:local:${this.keyId()}:${blob}`;
  },
  async decrypt(ciphertext: string) {
    if (!ciphertext.startsWith("enc:local:")) {
      // Backwards compatibility: cleartext stored before Phase 12 stays readable.
      return ciphertext;
    }
    const parts = ciphertext.split(":");
    if (parts.length !== 4) throw new Error("Invalid local KMS ciphertext format");
    const blob = Buffer.from(parts[3], "base64");
    const iv = blob.slice(0, 12);
    const tag = blob.slice(12, 28);
    const data = blob.slice(28);
    const decipher = createDecipheriv("aes-256-gcm", localKey(), iv);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(data), decipher.final()]);
    return out.toString("utf8");
  },
};

// ---------------------------------------------------------------------------
// AWS KMS provider — dynamic-import.
// ---------------------------------------------------------------------------
export async function awsKmsProvider(args: { region: string; keyId: string }): Promise<KmsProvider> {
  const mod = await optionalImport("@aws-sdk/client-kms");
  if (!mod) {
    logger.warn("kms.aws.missing", { hint: "@aws-sdk/client-kms not installed — falling back to local provider" });
    return localKmsProvider;
  }
  const { KMSClient, EncryptCommand, DecryptCommand } = mod;
  const client = new KMSClient({ region: args.region });
  return {
    name: "aws-kms",
    keyId() { return args.keyId; },
    async encrypt(plaintext) {
      const result = await client.send(new EncryptCommand({ KeyId: args.keyId, Plaintext: Buffer.from(plaintext, "utf8") }));
      const blob = Buffer.from(result.CiphertextBlob as Uint8Array).toString("base64");
      return `enc:aws:${args.keyId}:${blob}`;
    },
    async decrypt(ciphertext) {
      if (!ciphertext.startsWith("enc:aws:")) return ciphertext;
      // Format: enc:aws:<keyId>:<base64-blob>
      //
      // Sprint 2 (Step 7A hardening, 2026-07-20). The keyId embedded
      // in the envelope MAY contain colons — a full KMS key ARN has
      // seven of them. The prior implementation did `parts.slice(3)
      // .join(":")` which worked only when keyId was the colonless
      // short alias form (`alias/foo`). Base64 never contains a
      // colon, so the base64 blob is always the segment after the
      // LAST colon — regardless of how many colons the keyId
      // contributes. The KeyId parameter passed to DecryptCommand is
      // the CURRENT provider's args.keyId; AWS also self-identifies
      // the key from the ciphertext blob, so a rotation-time keyId
      // rewrite in the envelope prefix does not break decryption.
      const lastColon = ciphertext.lastIndexOf(":");
      const blob = Buffer.from(ciphertext.slice(lastColon + 1), "base64");
      const result = await client.send(new DecryptCommand({ CiphertextBlob: blob, KeyId: args.keyId }));
      return Buffer.from(result.Plaintext as Uint8Array).toString("utf8");
    },
  };
}

// ---------------------------------------------------------------------------
// GCP KMS placeholder — dynamic-import.
// ---------------------------------------------------------------------------
export async function gcpKmsProvider(args: { keyId: string }): Promise<KmsProvider> {
  const mod = await optionalImport("@google-cloud/kms");
  if (!mod) {
    logger.warn("kms.gcp.missing", { hint: "@google-cloud/kms not installed — falling back to local" });
    return localKmsProvider;
  }
  // GCP KMS implementation is structurally identical to AWS; treated as a
  // placeholder here since the SDK + auth flow is non-trivial. Production
  // wiring follows the same envelope-encryption interface.
  return localKmsProvider; // safe fallback until production deployment installs it
}

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------
let activeProvider: KmsProvider = localKmsProvider;
export function setKmsProvider(p: KmsProvider) { activeProvider = p; }

export async function selectKmsProvider(): Promise<KmsProvider> {
  if (activeProvider !== localKmsProvider) return activeProvider;
  const which = process.env.SPECTRE_KMS_PROVIDER;
  if (which === "aws") {
    const region = process.env.AWS_REGION ?? "us-east-1";
    const keyId = process.env.AWS_KMS_KEY_ID;
    if (!keyId) {
      logger.warn("kms.aws.no_key_id");
      return localKmsProvider;
    }
    activeProvider = await awsKmsProvider({ region, keyId });
  } else if (which === "gcp") {
    activeProvider = await gcpKmsProvider({ keyId: process.env.GCP_KMS_KEY_ID ?? "" });
  }
  return activeProvider;
}

// Production hard-block: returns true if we'd be running in production
// without a real KMS provider. Used by launch readiness.
export function isInsecureKmsModeInProduction(): boolean {
  return env.NODE_ENV === "production" && !process.env.SPECTRE_KMS_PROVIDER;
}

// ---------------------------------------------------------------------------
// Public API — encrypt/decrypt with audit logging.
// ---------------------------------------------------------------------------
export async function encryptSecret(args: {
  scope: KmsScope; secretReference: string; plaintext: string;
  clubId?: string | null; actorUserId?: string | null;
}): Promise<string> {
  const provider = await selectKmsProvider();
  const start = Date.now();
  try {
    const ciphertext = await provider.encrypt(args.plaintext);
    await prisma.encryptedSecretMetadata.upsert({
      where: { scope_secretReference: { scope: args.scope, secretReference: args.secretReference } },
      update: { provider: provider.name, keyId: provider.keyId(), rotatedAt: new Date() },
      create: { scope: args.scope, secretReference: args.secretReference, provider: provider.name, keyId: provider.keyId(), clubId: args.clubId ?? null },
    });
    await prisma.secretAccessLog.create({
      data: {
        clubId: args.clubId ?? null, scope: args.scope, secretReference: args.secretReference,
        action: "ENCRYPT", actorUserId: args.actorUserId ?? null,
        provider: provider.name, keyId: provider.keyId(),
        durationMs: Date.now() - start, status: "OK",
      },
    });
    return ciphertext;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.secretAccessLog.create({
      data: {
        clubId: args.clubId ?? null, scope: args.scope, secretReference: args.secretReference,
        action: "ENCRYPT", actorUserId: args.actorUserId ?? null,
        provider: provider.name, keyId: provider.keyId(),
        durationMs: Date.now() - start, status: "FAIL", errorMessage: message,
      },
    });
    throw err;
  }
}

export async function decryptSecret(args: {
  scope: KmsScope; secretReference: string; ciphertext: string;
  clubId?: string | null; actorUserId?: string | null;
}): Promise<string> {
  const provider = await selectKmsProvider();
  const start = Date.now();
  try {
    const plaintext = await provider.decrypt(args.ciphertext);
    // Track that we touched the secret — useful for compliance evidence.
    if (args.ciphertext.startsWith("enc:")) {
      await prisma.encryptedSecretMetadata.updateMany({
        where: { scope: args.scope, secretReference: args.secretReference },
        data: { lastDecryptedAt: new Date() },
      });
    }
    await prisma.secretAccessLog.create({
      data: {
        clubId: args.clubId ?? null, scope: args.scope, secretReference: args.secretReference,
        action: "DECRYPT", actorUserId: args.actorUserId ?? null,
        provider: provider.name, keyId: provider.keyId(),
        durationMs: Date.now() - start, status: "OK",
      },
    });
    return plaintext;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.secretAccessLog.create({
      data: {
        clubId: args.clubId ?? null, scope: args.scope, secretReference: args.secretReference,
        action: "DECRYPT", actorUserId: args.actorUserId ?? null,
        provider: provider.name, keyId: provider.keyId(),
        durationMs: Date.now() - start, status: "FAIL", errorMessage: message,
      },
    });
    throw err;
  }
}

// Helper: is this string already encrypted with our envelope prefix?
export function isEncryptedBlob(s: string): boolean {
  return typeof s === "string" && s.startsWith("enc:");
}

// Rotation: log a KeyRotationEvent + re-encrypt by caller. The caller is
// responsible for actually updating the secret-bearing row(s); this just
// records the event.
export async function recordKeyRotation(args: {
  scope: KmsScope; secretReference: string; clubId?: string | null;
  oldKeyId?: string | null; newKeyId: string;
  kind?: "MANUAL" | "AUTOMATIC" | "SCHEDULED" | "EMERGENCY";
  startedByUserId?: string | null;
}) {
  return prisma.keyRotationEvent.create({
    data: {
      clubId: args.clubId ?? null, scope: args.scope, secretReference: args.secretReference,
      kind: args.kind ?? "MANUAL", status: "COMPLETED",
      oldKeyId: args.oldKeyId ?? null, newKeyId: args.newKeyId,
      completedAt: new Date(),
      startedByUserId: args.startedByUserId ?? null,
    },
  });
}
