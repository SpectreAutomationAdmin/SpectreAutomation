// Sprint 3 Checkpoint 15D (2026-07-24) — Retrieval helpers for the
// ingested-document layer.
//
// Every entry point takes:
//   * clubId  — the ACTIVE club of the current principal
//   * documentId
// and enforces:
//   * the document belongs to that club
//   * the caller can see at least one evidence target the doc is
//     linked to (readable-through-linkage rule)
// then records an audit row.
//
// Storage keys, bucket names, and other operational secrets are NEVER
// returned to the caller. Only display metadata + (for preview /
// download) the raw bytes.

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability/logger";
import { DocumentError, type IngestedDocumentClassification } from "./types";
import { resolveDocumentStorage } from "./storage";
import type { DocumentStorageAdapter } from "./types";

export interface RetrievalContext {
  clubId: string;
  documentId: string;
  actorUserId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  storageOverride?: DocumentStorageAdapter;
}

export interface DocumentMetadata {
  id: string;
  filename: string;
  originalFilename: string;
  mimeType: string;
  byteLength: number;
  sha256Hash: string;
  classification: IngestedDocumentClassification;
  classificationRuleKey: string | null;
  receivedAt: string;
  ingestedAt: string;
  evidenceLinks: Array<{
    targetKind: string;
    targetReferenceId: string;
    role: string;
    linkReason: string | null;
    createdAt: string;
  }>;
}

export interface DocumentBytes {
  metadata: DocumentMetadata;
  bytes: Buffer;
}

// ---------------------------------------------------------------------------
// Authorization — a principal may see a document IFF (a) it belongs to
// the principal's active club AND (b) at least one of its evidence
// links points at a target the principal is allowed to read.
//
// This checkpoint supports WORK_INTAKE_ITEM only. Readability for
// WorkIntakeItem == exists in the same club. Later checkpoints tighten
// this to role-based read rules (e.g. mailboxVisibilityFilter).
// ---------------------------------------------------------------------------
async function loadReadable(ctx: RetrievalContext) {
  const doc = await prisma.ingestedDocument.findFirst({
    where: { id: ctx.documentId, clubId: ctx.clubId },
    include: {
      evidenceLinks: {
        select: {
          targetKind: true,
          targetReferenceId: true,
          role: true,
          linkReason: true,
          createdAt: true,
        },
      },
    },
  });
  if (!doc) {
    throw new DocumentError("NOT_FOUND", `Document ${ctx.documentId} not found for club ${ctx.clubId}.`);
  }
  // Verify at least one evidence link points at a target readable by the club.
  let readable = false;
  for (const link of doc.evidenceLinks) {
    if (link.targetKind === "WORK_INTAKE_ITEM") {
      const inClub = await prisma.workIntakeItem.count({
        where: { id: link.targetReferenceId, clubId: ctx.clubId },
      });
      if (inClub > 0) {
        readable = true;
        break;
      }
    }
  }
  if (!readable) {
    // An ingested document with zero readable evidence links is treated
    // as not-found — never leak that the row exists. The audit row on
    // ingest is enough to trace lifecycle.
    throw new DocumentError(
      "NOT_FOUND",
      `Document ${ctx.documentId} has no readable evidence for club ${ctx.clubId}.`,
    );
  }
  return doc;
}

function toMetadata(doc: Awaited<ReturnType<typeof loadReadable>>): DocumentMetadata {
  return {
    id: doc.id,
    filename: doc.filename,
    originalFilename: doc.originalFilename,
    mimeType: doc.mimeType,
    byteLength: doc.byteLength,
    sha256Hash: doc.sha256Hash,
    classification: doc.classification as IngestedDocumentClassification,
    classificationRuleKey: doc.classificationRuleKey ?? null,
    receivedAt: doc.receivedAt.toISOString(),
    ingestedAt: doc.ingestedAt.toISOString(),
    evidenceLinks: doc.evidenceLinks.map((l) => ({
      targetKind: l.targetKind,
      targetReferenceId: l.targetReferenceId,
      role: l.role,
      linkReason: l.linkReason,
      createdAt: l.createdAt.toISOString(),
    })),
  };
}

export async function getDocumentMetadata(ctx: RetrievalContext): Promise<DocumentMetadata> {
  const doc = await loadReadable(ctx);
  await prisma.ingestedDocumentAuditLog.create({
    data: {
      clubId: ctx.clubId,
      ingestedDocumentId: doc.id,
      action: "RETRIEVED_METADATA",
      actorUserId: ctx.actorUserId ?? null,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    },
  });
  return toMetadata(doc);
}

export async function getDocumentBytes(ctx: RetrievalContext, purpose: "PREVIEW" | "DOWNLOAD"): Promise<DocumentBytes> {
  const doc = await loadReadable(ctx);
  const storage = ctx.storageOverride ?? (await resolveDocumentStorage({ clubId: ctx.clubId }));
  const bytes = await storage.get({ storageKey: doc.storageKey });
  if (!bytes) {
    logger.warn("documents.retrieve.bytes_missing", {
      clubId: ctx.clubId,
      documentIdTail: doc.id.slice(-6),
      storageBucket: doc.storageBucket,
    });
    throw new DocumentError(
      "STORAGE_FAILURE",
      "Document bytes are missing from the storage backend.",
    );
  }
  await prisma.ingestedDocumentAuditLog.create({
    data: {
      clubId: ctx.clubId,
      ingestedDocumentId: doc.id,
      action: purpose === "PREVIEW" ? "RETRIEVED_PREVIEW" : "RETRIEVED_DOWNLOAD",
      actorUserId: ctx.actorUserId ?? null,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    },
  });
  return { metadata: toMetadata(doc), bytes };
}

// Loader for the Mission Control evidence panel. READ-ONLY. Returns the
// full document list for a given work-intake item, in reverse-chronological
// order (newest first).
export async function listDocumentsForWorkIntake(args: {
  clubId: string;
  workIntakeItemId: string;
}): Promise<DocumentMetadata[]> {
  const links = await prisma.ingestedDocumentEvidenceLink.findMany({
    where: {
      clubId: args.clubId,
      targetKind: "WORK_INTAKE_ITEM",
      targetReferenceId: args.workIntakeItemId,
    },
    include: {
      ingestedDocument: {
        include: {
          evidenceLinks: {
            select: {
              targetKind: true,
              targetReferenceId: true,
              role: true,
              linkReason: true,
              createdAt: true,
            },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });
  return links.map((l) => toMetadata(l.ingestedDocument));
}
