// Phase 6E — Document intelligence.
//
// A unified Document store with folders, tags, versions, retention, and an
// append-only DocumentAuditLog. Existing scattered attachments (MemberDocument,
// JournalAttachment, etc.) remain on their original tables; new uploads should
// go through this service to benefit from versioning + retention.

import { z } from "zod";
import { randomBytes } from "crypto";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, hasPermission, type Principal } from "../rbac";
import { assertTenantOwned, tenantWhere } from "../services/tenant";
import { ConflictError, NotFoundError, ValidationError } from "../errors";

// ---------------------------------------------------------------------------
// Storage adapter (seam). Defaults to a no-op that records the storageKey.
// ---------------------------------------------------------------------------
export interface StorageAdapter {
  put(args: { clubId: string; storageKey: string; body: Buffer | string; mimeType?: string }): Promise<void>;
  get(args: { clubId: string; storageKey: string }): Promise<Buffer | string | null>;
  delete(args: { clubId: string; storageKey: string }): Promise<void>;
}

export const memoryStorageAdapter: StorageAdapter = (() => {
  const blobs = new Map<string, Buffer | string>();
  return {
    async put({ clubId, storageKey, body }) { blobs.set(`${clubId}:${storageKey}`, body); },
    async get({ clubId, storageKey }) { return blobs.get(`${clubId}:${storageKey}`) ?? null; },
    async delete({ clubId, storageKey }) { blobs.delete(`${clubId}:${storageKey}`); },
  };
})();

export let activeStorage: StorageAdapter = memoryStorageAdapter;
export function setStorageAdapter(adapter: StorageAdapter) { activeStorage = adapter; }
// Per-club override: when a club has a configured STORAGE integration, callers
// can resolve it via this hook. Falls back to activeStorage for tests/dev.
export async function resolveStorageAdapter(clubId: string): Promise<StorageAdapter> {
  const { selectStorageAdapter } = await import("../integrations/storage");
  return selectStorageAdapter(clubId, activeStorage);
}

// ---------------------------------------------------------------------------
// Folder helpers — materialized path keeps queries cheap.
// ---------------------------------------------------------------------------
export async function ensureFolder(principal: Principal, clubId: string, path: string): Promise<string> {
  // Idempotent: walks the path, upserting each segment.
  requirePermission(principal, clubId, "documents:write");
  const segments = path.split("/").filter(Boolean);
  let parentId: string | null = null;
  let acc = "";
  for (const segment of segments) {
    acc = `${acc}/${segment}`;
    const folder: { id: string } = await prisma.documentFolder.upsert({
      where: { clubId_path: { clubId, path: acc } },
      update: {},
      create: { clubId, parentId, path: acc, name: segment, createdByUserId: principal.id },
    });
    parentId = folder.id;
  }
  return parentId!;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------
export const documentSchema = z.object({
  name: z.string().trim().min(1).max(260),
  description: z.string().trim().max(2000).optional().nullable(),
  mimeType: z.string().trim().max(120).optional().nullable(),
  sizeBytes: z.number().int().min(0).default(0),
  folderPath: z.string().trim().optional().nullable(),
  body: z.string().optional().nullable(), // for inline/test uploads; production uses presigned URLs
  memberId: z.string().optional().nullable(),
  vendorId: z.string().optional().nullable(),
  apInvoiceId: z.string().optional().nullable(),
  journalEntryId: z.string().optional().nullable(),
  assetId: z.string().optional().nullable(),
  privateEventId: z.string().optional().nullable(),
  payrollRunId: z.string().optional().nullable(),
  financingAgreementId: z.string().optional().nullable(),
  reportingPackageId: z.string().optional().nullable(),
  auditRequestId: z.string().optional().nullable(),
  retentionPolicyKey: z.string().optional().nullable(),
  tagKeys: z.array(z.string()).default([]),
  searchText: z.string().trim().max(20000).optional().nullable(),
});

export async function uploadDocument(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "documents:write");
  const parsed = documentSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;
  const folderId = d.folderPath ? await ensureFolder(principal, clubId, d.folderPath) : null;
  const retentionPolicy = d.retentionPolicyKey ? await prisma.documentRetentionPolicy.findUnique({ where: { clubId_key: { clubId, key: d.retentionPolicyKey } } }) : null;
  const retainedUntil = retentionPolicy ? new Date(Date.now() + retentionPolicy.retentionDays * 86400000) : null;
  const storageKey = `doc/${randomBytes(8).toString("hex")}`;
  if (d.body != null) {
    await activeStorage.put({ clubId, storageKey, body: d.body, mimeType: d.mimeType ?? undefined });
  }
  const doc = await prisma.document.create({
    data: {
      clubId, folderId, name: d.name, description: d.description ?? null,
      mimeType: d.mimeType ?? null, sizeBytes: d.sizeBytes,
      storageKey, status: "ACTIVE",
      retentionPolicyId: retentionPolicy?.id ?? null, retainedUntil,
      memberId: d.memberId ?? null, vendorId: d.vendorId ?? null,
      apInvoiceId: d.apInvoiceId ?? null, journalEntryId: d.journalEntryId ?? null,
      assetId: d.assetId ?? null, privateEventId: d.privateEventId ?? null,
      payrollRunId: d.payrollRunId ?? null, financingAgreementId: d.financingAgreementId ?? null,
      reportingPackageId: d.reportingPackageId ?? null, auditRequestId: d.auditRequestId ?? null,
      searchText: d.searchText ?? null,
      uploadedByUserId: principal.id,
    },
  });
  // Initial version v1.
  await prisma.documentVersion.create({
    data: { clubId, documentId: doc.id, versionNumber: 1, storageKey, sizeBytes: d.sizeBytes, uploadedByUserId: principal.id },
  });
  for (const tagKey of d.tagKeys) {
    const tag = await prisma.documentTag.upsert({
      where: { clubId_key: { clubId, key: tagKey } },
      update: {},
      create: { clubId, key: tagKey, label: tagKey },
    });
    await prisma.documentTagJoin.create({ data: { documentId: doc.id, tagId: tag.id } });
  }
  await prisma.documentAuditLog.create({
    data: { clubId, documentId: doc.id, action: "UPLOAD", actorUserId: principal.id },
  });
  await audit(principal, { action: "document.upload", entityType: "Document", entityId: doc.id, clubId, after: { name: d.name, sizeBytes: d.sizeBytes } });
  return doc;
}

export async function getDocument(principal: Principal, documentId: string) {
  const doc = await prisma.document.findUnique({ where: { id: documentId } });
  if (!doc) throw new NotFoundError("Document", documentId);
  assertTenantOwned(doc, principal);
  requirePermission(principal, doc.clubId, "documents:read");
  await prisma.documentAuditLog.create({
    data: { clubId: doc.clubId, documentId, action: "VIEW", actorUserId: principal.id },
  });
  return doc;
}

export async function downloadDocument(principal: Principal, documentId: string) {
  const doc = await getDocument(principal, documentId);
  if (doc.status !== "ACTIVE") throw new ConflictError(`Document is ${doc.status}`);
  const body = doc.storageKey ? await activeStorage.get({ clubId: doc.clubId, storageKey: doc.storageKey }) : null;
  await prisma.documentAuditLog.create({
    data: { clubId: doc.clubId, documentId, action: "DOWNLOAD", actorUserId: principal.id },
  });
  return { document: doc, body };
}

export async function uploadVersion(principal: Principal, documentId: string, args: { storageKey?: string; sizeBytes: number; body?: string; notes?: string }) {
  const doc = await prisma.document.findUnique({ where: { id: documentId }, include: { versions: { orderBy: { versionNumber: "desc" }, take: 1 } } });
  assertTenantOwned(doc, principal);
  requirePermission(principal, doc.clubId, "documents:write");
  const nextVersion = (doc.versions[0]?.versionNumber ?? 0) + 1;
  const storageKey = args.storageKey ?? `doc/${randomBytes(8).toString("hex")}`;
  if (args.body != null) {
    await activeStorage.put({ clubId: doc.clubId, storageKey, body: args.body });
  }
  const v = await prisma.documentVersion.create({
    data: { clubId: doc.clubId, documentId, versionNumber: nextVersion, storageKey, sizeBytes: args.sizeBytes, uploadedByUserId: principal.id, notes: args.notes ?? null },
  });
  await prisma.document.update({ where: { id: documentId }, data: { storageKey, sizeBytes: args.sizeBytes, updatedAt: new Date() } });
  await audit(principal, { action: "document.version.create", entityType: "DocumentVersion", entityId: v.id, clubId: doc.clubId, after: { documentId, versionNumber: nextVersion } });
  return v;
}

export async function softDeleteDocument(principal: Principal, documentId: string) {
  const doc = await prisma.document.findUnique({ where: { id: documentId } });
  assertTenantOwned(doc, principal);
  requirePermission(principal, doc.clubId, "documents:delete");
  const updated = await prisma.document.update({
    where: { id: documentId },
    data: { status: "DELETED", isSoftDeleted: true, deletedAt: new Date() },
  });
  await prisma.documentAuditLog.create({
    data: { clubId: doc.clubId, documentId, action: "DELETE", actorUserId: principal.id },
  });
  await audit(principal, { action: "document.delete", entityType: "Document", entityId: documentId, clubId: doc.clubId, after: { status: "DELETED" } });
  return updated;
}

export async function restoreDocument(principal: Principal, documentId: string) {
  const doc = await prisma.document.findUnique({ where: { id: documentId } });
  assertTenantOwned(doc, principal);
  requirePermission(principal, doc.clubId, "documents:delete");
  const updated = await prisma.document.update({
    where: { id: documentId },
    data: { status: "ACTIVE", isSoftDeleted: false, deletedAt: null },
  });
  await prisma.documentAuditLog.create({
    data: { clubId: doc.clubId, documentId, action: "RESTORE", actorUserId: principal.id },
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Sharing — generate a time-limited signed-URL token.
// ---------------------------------------------------------------------------
export async function shareDocument(principal: Principal, documentId: string, args: { expiresInHours?: number; canDownload?: boolean }) {
  const doc = await prisma.document.findUnique({ where: { id: documentId } });
  assertTenantOwned(doc, principal);
  requirePermission(principal, doc.clubId, "documents:write");
  const token = randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + (args.expiresInHours ?? 24) * 3600000);
  const access = await prisma.documentAccess.create({
    data: {
      clubId: doc.clubId, documentId, kind: "LINK",
      signedUrlToken: token, expiresAt, canDownload: args.canDownload ?? true,
      grantedByUserId: principal.id,
    },
  });
  await prisma.documentAuditLog.create({
    data: { clubId: doc.clubId, documentId, action: "SHARE", actorUserId: principal.id },
  });
  return access;
}

// ---------------------------------------------------------------------------
// Search / list
// ---------------------------------------------------------------------------
export async function searchDocuments(principal: Principal, clubId: string, args: { query?: string; tagKeys?: string[]; folderPath?: string; entityType?: string; entityId?: string }) {
  requirePermission(principal, clubId, "documents:read");
  const where: Record<string, unknown> = { ...tenantWhere(principal, clubId), status: "ACTIVE" };
  if (args.query) {
    const q = args.query.toLowerCase();
    Object.assign(where, { OR: [
      { name: { contains: q } },
      { description: { contains: q } },
      { searchText: { contains: q } },
    ] });
  }
  if (args.folderPath) {
    const folder = await prisma.documentFolder.findUnique({ where: { clubId_path: { clubId, path: args.folderPath } } });
    if (folder) Object.assign(where, { folderId: folder.id });
  }
  if (args.entityType && args.entityId) {
    const field = entityTypeToField(args.entityType);
    if (field) Object.assign(where, { [field]: args.entityId });
  }
  let docs = await prisma.document.findMany({
    where,
    include: { folder: true, tags: { include: { tag: true } } },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });
  if (args.tagKeys && args.tagKeys.length > 0) {
    const keys = new Set(args.tagKeys);
    docs = docs.filter((d) => d.tags.some((t) => keys.has(t.tag.key)));
  }
  return docs;
}

function entityTypeToField(entityType: string): string | null {
  switch (entityType) {
    case "Member": return "memberId";
    case "Vendor": return "vendorId";
    case "APInvoice": return "apInvoiceId";
    case "JournalEntry": return "journalEntryId";
    case "CapitalAsset": return "assetId";
    case "PrivateEventBooking": return "privateEventId";
    case "PayrollRun": return "payrollRunId";
    case "FinancingAgreement": return "financingAgreementId";
    case "ReportingPackage": return "reportingPackageId";
    case "AuditRequest": return "auditRequestId";
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Retention policy
// ---------------------------------------------------------------------------
export const retentionSchema = z.object({
  key: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(160),
  retentionDays: z.number().int().min(1).max(36500),
  scope: z.string().default("ALL"),
  description: z.string().trim().max(2000).optional().nullable(),
});

export async function upsertRetentionPolicy(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "settings:write");
  const parsed = retentionSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;
  return prisma.documentRetentionPolicy.upsert({
    where: { clubId_key: { clubId, key: d.key } },
    update: { name: d.name, retentionDays: d.retentionDays, scope: d.scope, description: d.description ?? null },
    create: { clubId, key: d.key, name: d.name, retentionDays: d.retentionDays, scope: d.scope, description: d.description ?? null },
  });
}

function zerr(err: z.ZodError) {
  return new ValidationError(err.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
}

void hasPermission;
