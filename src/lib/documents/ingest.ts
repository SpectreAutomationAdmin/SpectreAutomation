// Sprint 3 Checkpoint 15D (2026-07-24) — Document ingest pipeline.
//
// Sequence:
//   1. Preflight (MIME + size + filename sanitise) — refuses BEFORE any
//      byte download.
//   2. Fetch bytes via the injected byte-source.
//   3. Content-signature check (magic number vs claimed MIME).
//   4. SHA256 fingerprint.
//   5. Dedup lookup by (clubId, sha256Hash).
//   6a. If duplicate → append evidence link + audit; return
//       STORED_DUPLICATE_LINKED.
//   6b. If new → put bytes → create IngestedDocument → optional
//       evidence link → audit; return STORED_NEW.
//
// Immutability contract: once an IngestedDocument row exists, the
// bytes at its storageKey are never rewritten. The storage adapter
// declines overwrites; this module never issues delete on the
// happy path.

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability/logger";
import { classifyDocument, CLASSIFY_RULES_VERSION, type ClassifySignals } from "./classify";
import { sha256Hex, storageKeyFor } from "./fingerprint";
import {
  preflightAttachment,
  assertContentMatchesMime,
  sanitiseFilename,
  type SupportedMime,
} from "./safety";
import { resolveDocumentStorage } from "./storage";
import {
  DocumentError,
  type IngestResult,
  type IngestedDocumentClassification,
  type IngestedDocumentEvidenceRole,
  type IngestedDocumentEvidenceTargetKind,
  type IngestedDocumentSourceKind,
  type DocumentStorageAdapter,
} from "./types";

// Callers supply a byte source. The Graph provider adapter implements
// this interface — in tests we inject a fixed-bytes source.
export interface DocumentByteSource {
  fetchBytes(): Promise<Buffer>;
}

export interface IngestAttachmentArgs {
  clubId: string;
  sourceKind: IngestedDocumentSourceKind;
  sourceReferenceId: string; // e.g. EmailAttachment.id
  claimedContentType: string;
  claimedSizeBytes: number;
  originalFilename: string;
  receivedAt: Date;
  isInline: boolean;
  bytes: DocumentByteSource;
  classifySignals?: Partial<Omit<ClassifySignals, "filename" | "originalFilename" | "mimeType">>;
  // Attach the ingested doc to a work-intake target as EVIDENCE by default.
  // Callers pass null to skip auto-linking.
  autoAttachTo?: {
    targetKind: IngestedDocumentEvidenceTargetKind;
    targetReferenceId: string;
    role?: IngestedDocumentEvidenceRole;
    reason?: string;
  } | null;
  // Test-only override so unit tests skip R2. Production leaves this
  // undefined and gets the configured R2/memory fallback.
  storageOverride?: DocumentStorageAdapter;
  actorUserId?: string | null;
}

export async function ingestAttachment(args: IngestAttachmentArgs): Promise<IngestResult> {
  // --- 1) Preflight -------------------------------------------------------
  const pre = preflightAttachment({
    contentType: args.claimedContentType,
    sizeBytes: args.claimedSizeBytes,
    filename: args.originalFilename,
    isInline: args.isInline,
  });
  if (!pre.ok) {
    const outcome =
      pre.reason === "UNSAFE_MIME" ? "REFUSED_UNSAFE_TYPE" :
      pre.reason === "OVERSIZED" ? "REFUSED_TOO_LARGE" :
      "REFUSED_CORRUPT";
    logger.info("documents.ingest.refused", {
      clubId: args.clubId,
      sourceKind: args.sourceKind,
      sourceReferenceIdTail: args.sourceReferenceId.slice(-6),
      reason: pre.reason,
      claimedContentType: args.claimedContentType,
      claimedSizeBytes: args.claimedSizeBytes,
    });
    return { outcome, reason: pre.message };
  }

  // --- 2) Fetch bytes -----------------------------------------------------
  let raw: Buffer;
  try {
    raw = await args.bytes.fetchBytes();
  } catch (err) {
    logger.warn("documents.ingest.fetch_failed", {
      clubId: args.clubId,
      sourceReferenceIdTail: args.sourceReferenceId.slice(-6),
      message: err instanceof Error ? err.message : String(err),
    });
    return {
      outcome: "REFUSED_CORRUPT",
      reason: "Failed to fetch attachment bytes from source.",
    };
  }
  if (raw.length !== args.claimedSizeBytes) {
    // Not fatal on its own, but the pipeline records the downloaded
    // size as authoritative. Log the discrepancy for observability.
    logger.info("documents.ingest.size_mismatch", {
      clubId: args.clubId,
      claimed: args.claimedSizeBytes,
      actual: raw.length,
    });
  }

  // --- 3) Signature check -------------------------------------------------
  try {
    assertContentMatchesMime(raw, pre.mime);
  } catch (err) {
    logger.warn("documents.ingest.signature_mismatch", {
      clubId: args.clubId,
      claimedMime: pre.mime,
      sourceReferenceIdTail: args.sourceReferenceId.slice(-6),
    });
    return {
      outcome: "REFUSED_CORRUPT",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  // --- 4) Fingerprint -----------------------------------------------------
  const sha256 = sha256Hex(raw);
  const byteLength = raw.length;

  // --- 5) Dedup ----------------------------------------------------------
  const existing = await prisma.ingestedDocument.findUnique({
    where: { clubId_sha256Hash: { clubId: args.clubId, sha256Hash: sha256 } },
    select: { id: true, storageBucket: true, storageKey: true, classification: true },
  });
  if (existing) {
    // The bytes match a doc we already stored — do not re-upload;
    // just record a fresh audit + optional evidence link.
    await prisma.ingestedDocumentAuditLog.create({
      data: {
        clubId: args.clubId,
        ingestedDocumentId: existing.id,
        action: "DUPLICATE_DETECTED",
        actorUserId: args.actorUserId ?? null,
        detailsJson: JSON.stringify({
          sourceKind: args.sourceKind,
          sourceReferenceId: args.sourceReferenceId,
          byteLength,
          claimedContentType: pre.mime,
        }),
      },
    });
    if (args.autoAttachTo) {
      await linkEvidence({
        clubId: args.clubId,
        ingestedDocumentId: existing.id,
        target: args.autoAttachTo,
        actorUserId: args.actorUserId,
      });
    }
    return {
      outcome: "STORED_DUPLICATE_LINKED",
      documentId: existing.id,
      sha256Hash: sha256,
      classification: existing.classification as IngestedDocumentClassification,
      storageBucket: existing.storageBucket,
      storageKey: existing.storageKey,
      byteLength,
    };
  }

  // --- 6) Store + persist -------------------------------------------------
  const storage = args.storageOverride ?? (await resolveDocumentStorage({ clubId: args.clubId }));
  const storageKey = storageKeyFor({ sha256Hash: sha256, receivedAt: args.receivedAt });
  try {
    await storage.put({ storageKey, body: raw, mimeType: pre.mime });
  } catch (err) {
    logger.warn("documents.ingest.storage_put_failed", {
      clubId: args.clubId,
      storageKeyTail: storageKey.slice(-16),
      message: err instanceof Error ? err.message : String(err),
    });
    throw new DocumentError("STORAGE_FAILURE", "Failed to persist bytes to storage.");
  }

  const classify = classifyDocument({
    filename: pre.sanitisedFilename,
    originalFilename: args.originalFilename,
    mimeType: pre.mime,
    emailSubject: args.classifySignals?.emailSubject ?? null,
    senderAddress: args.classifySignals?.senderAddress ?? null,
    emailBodyExcerpt: args.classifySignals?.emailBodyExcerpt ?? null,
  });

  const created = await prisma.ingestedDocument.create({
    data: {
      clubId: args.clubId,
      sourceKind: args.sourceKind,
      sourceReferenceId: args.sourceReferenceId,
      filename: pre.sanitisedFilename,
      originalFilename: args.originalFilename,
      mimeType: pre.mime,
      byteLength,
      sha256Hash: sha256,
      storageBucket: storage.bucket,
      storageKey,
      classification: classify.classification,
      classificationSource: "RULE",
      classificationRuleKey: `${classify.ruleKey}@v${CLASSIFY_RULES_VERSION}`,
      status: "STORED",
      receivedAt: args.receivedAt,
    },
    select: {
      id: true,
      storageBucket: true,
      storageKey: true,
      classification: true,
    },
  });

  await prisma.ingestedDocumentAuditLog.create({
    data: {
      clubId: args.clubId,
      ingestedDocumentId: created.id,
      action: "INGESTED",
      actorUserId: args.actorUserId ?? null,
      detailsJson: JSON.stringify({
        sourceKind: args.sourceKind,
        sourceReferenceId: args.sourceReferenceId,
        byteLength,
        classification: classify.classification,
        ruleKey: classify.ruleKey,
      }),
    },
  });

  if (args.autoAttachTo) {
    await linkEvidence({
      clubId: args.clubId,
      ingestedDocumentId: created.id,
      target: args.autoAttachTo,
      actorUserId: args.actorUserId,
    });
  }

  logger.info("documents.ingest.stored", {
    clubId: args.clubId,
    sourceKind: args.sourceKind,
    sourceReferenceIdTail: args.sourceReferenceId.slice(-6),
    documentIdTail: created.id.slice(-6),
    byteLength,
    classification: classify.classification,
    ruleKey: classify.ruleKey,
  });

  return {
    outcome: "STORED_NEW",
    documentId: created.id,
    sha256Hash: sha256,
    classification: created.classification as IngestedDocumentClassification,
    storageBucket: created.storageBucket,
    storageKey: created.storageKey,
    byteLength,
  };
}

// ---------------------------------------------------------------------------
// Evidence linkage
// ---------------------------------------------------------------------------
export interface LinkEvidenceArgs {
  clubId: string;
  ingestedDocumentId: string;
  target: {
    targetKind: IngestedDocumentEvidenceTargetKind;
    targetReferenceId: string;
    role?: IngestedDocumentEvidenceRole;
    reason?: string;
  };
  actorUserId?: string | null;
}

export async function linkEvidence(args: LinkEvidenceArgs): Promise<void> {
  const role = args.target.role ?? "EVIDENCE";
  // Cross-tenant guard: the target must exist within the same club.
  await assertTargetExistsForClub({
    clubId: args.clubId,
    kind: args.target.targetKind,
    referenceId: args.target.targetReferenceId,
  });

  // Idempotent — the unique key (doc, target, role) catches the second
  // insert; skipDuplicates: true keeps this quiet for legitimate reruns.
  await prisma.ingestedDocumentEvidenceLink.upsert({
    where: {
      ingestedDocumentId_targetKind_targetReferenceId_role: {
        ingestedDocumentId: args.ingestedDocumentId,
        targetKind: args.target.targetKind,
        targetReferenceId: args.target.targetReferenceId,
        role,
      },
    },
    create: {
      clubId: args.clubId,
      ingestedDocumentId: args.ingestedDocumentId,
      targetKind: args.target.targetKind,
      targetReferenceId: args.target.targetReferenceId,
      role,
      linkReason: args.target.reason ?? null,
      createdByUserId: args.actorUserId ?? null,
    },
    update: {},
  });
  await prisma.ingestedDocumentAuditLog.create({
    data: {
      clubId: args.clubId,
      ingestedDocumentId: args.ingestedDocumentId,
      action: "EVIDENCE_LINKED",
      actorUserId: args.actorUserId ?? null,
      detailsJson: JSON.stringify({
        targetKind: args.target.targetKind,
        targetReferenceId: args.target.targetReferenceId,
        role,
      }),
    },
  });
}

async function assertTargetExistsForClub(args: {
  clubId: string;
  kind: IngestedDocumentEvidenceTargetKind;
  referenceId: string;
}): Promise<void> {
  if (args.kind === "WORK_INTAKE_ITEM") {
    const count = await prisma.workIntakeItem.count({
      where: { id: args.referenceId, clubId: args.clubId },
    });
    if (count === 0) {
      throw new DocumentError(
        "TENANT_MISMATCH",
        `WORK_INTAKE_ITEM ${args.referenceId} not found for club ${args.clubId}.`,
      );
    }
    return;
  }
  if (args.kind === "AP_INVOICE") {
    const count = await prisma.aPInvoice.count({
      where: { id: args.referenceId, clubId: args.clubId },
    });
    if (count === 0) {
      throw new DocumentError(
        "TENANT_MISMATCH",
        `AP_INVOICE ${args.referenceId} not found for club ${args.clubId}.`,
      );
    }
    return;
  }
  if (args.kind === "VENDOR_STATEMENT_RECONCILIATION") {
    const count = await prisma.vendorStatementReconciliation.count({
      where: { id: args.referenceId, clubId: args.clubId },
    });
    if (count === 0) {
      throw new DocumentError(
        "TENANT_MISMATCH",
        `VENDOR_STATEMENT_RECONCILIATION ${args.referenceId} not found for club ${args.clubId}.`,
      );
    }
    return;
  }
  throw new DocumentError(
    "MISSING_INPUT",
    `Unsupported evidence targetKind ${args.kind}.`,
  );
}

// Convenience helper to filter the sanitised filename externally — kept
// exported so the API layer (Content-Disposition) can share the logic.
export { sanitiseFilename };
export type { SupportedMime };
