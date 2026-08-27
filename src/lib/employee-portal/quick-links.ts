// Employee Portal Quick Links (2026-08-27) — canonical service for
// tenant-configured Quick Links. Consumed by:
//
//   • Admin Settings (`HeroFramingEditor`'s neighbor CRUD UI)
//   • The API routes under
//     `/api/clubs/[id]/employee-portal-quick-links/*`
//   • The Employee Portal page (`page.tsx`) — server-side reads
//     both desktop and mobile Quick Links from `listQuickLinks(...)`.
//
// Discipline: mirrors ClubMedia — `settings:write` +
// `assertPostingAllowed` + `audit()`. Tenant-scoped on every read
// and write. Files stream through `resolveDocumentStorage({clubId})`
// under the canonical `clubs/{clubId}/quick-links/{id}/{sha256}` key.

import { createHash } from "node:crypto";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertPostingAllowed } from "../posting-guard";
import { ValidationError, NotFoundError } from "../errors";
import { resolveDocumentStorage } from "../documents/storage";

export const QUICK_LINK_MAX_COUNT = 10;
export const QUICK_LINK_LABEL_MAX = 80;
export const QUICK_LINK_FILE_MAX_BYTES = 20 * 1024 * 1024; // 20 MiB
export const QUICK_LINK_ACCEPTED_FILE_MIME = new Set<string>([
  "application/pdf",
]);

const ENTITY = "EmployeePortalQuickLink";

export type QuickLinkDestinationType = "url" | "file";

export interface QuickLinkView {
  id: string;
  label: string;
  destinationType: QuickLinkDestinationType;
  url: string | null;
  hasFile: boolean;
  fileOriginalName: string | null;
  sortOrder: number;
  isActive: boolean;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Validation — URL scheme allow-list. External `https:` and Spectre-
// internal absolute paths that begin with `/` are the only permitted
// forms. Blocks `javascript:`, `data:`, `file:`, `mailto:*` unless
// explicitly extended, and every arbitrary custom scheme.
// ---------------------------------------------------------------------------
export function validateQuickLinkUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new ValidationError([{ path: "url", message: "URL required" }]);
  if (trimmed.length > 2048) {
    throw new ValidationError([{ path: "url", message: "URL exceeds 2048-character limit" }]);
  }
  if (trimmed.startsWith("/")) {
    return trimmed;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ValidationError([{ path: "url", message: "Invalid URL" }]);
  }
  if (parsed.protocol !== "https:") {
    throw new ValidationError([{ path: "url", message: "Only https:// or /internal paths are allowed" }]);
  }
  return parsed.toString();
}

function validateLabel(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) throw new ValidationError([{ path: "label", message: "Label required" }]);
  if (trimmed.length > QUICK_LINK_LABEL_MAX) {
    throw new ValidationError([{ path: "label", message: `Label exceeds ${QUICK_LINK_LABEL_MAX}-character limit` }]);
  }
  return trimmed;
}

function projectRow(row: {
  id: string;
  label: string;
  destinationType: string;
  url: string | null;
  storageKey: string | null;
  fileOriginalName: string | null;
  sortOrder: number;
  isActive: boolean;
  updatedAt: Date;
}): QuickLinkView {
  return {
    id: row.id,
    label: row.label,
    destinationType: row.destinationType as QuickLinkDestinationType,
    url: row.url,
    hasFile: row.storageKey !== null,
    fileOriginalName: row.fileOriginalName,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Read paths — tenant-scoped list. Employee Portal uses `active`,
// Admin Settings uses the full list.
// ---------------------------------------------------------------------------
export async function listQuickLinks(
  clubId: string,
  opts: { activeOnly?: boolean } = {},
): Promise<QuickLinkView[]> {
  const rows = await prisma.employeePortalQuickLink.findMany({
    where: { clubId, ...(opts.activeOnly ? { isActive: true } : {}) },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(projectRow);
}

export async function getQuickLink(clubId: string, id: string) {
  return prisma.employeePortalQuickLink.findFirst({
    where: { id, clubId },
  });
}

// ---------------------------------------------------------------------------
// Write paths — create / update / reorder / delete.
// ---------------------------------------------------------------------------

export interface CreateQuickLinkInput {
  label: string;
  destinationType: QuickLinkDestinationType;
  url?: string | null;
  isActive?: boolean;
}

export async function createQuickLink(
  principal: Principal,
  clubId: string,
  input: CreateQuickLinkInput,
): Promise<QuickLinkView> {
  requirePermission(principal, clubId, "settings:write");
  await assertPostingAllowed(principal, clubId, "employee-portal.quick-link.create", ENTITY, clubId);

  const count = await prisma.employeePortalQuickLink.count({ where: { clubId } });
  if (count >= QUICK_LINK_MAX_COUNT) {
    throw new ValidationError([
      { path: "quickLinks", message: `Maximum ${QUICK_LINK_MAX_COUNT} Quick Links per Club.` },
    ]);
  }

  const label = validateLabel(input.label);
  let url: string | null = null;
  if (input.destinationType === "url") {
    if (!input.url) throw new ValidationError([{ path: "url", message: "URL required for url destination" }]);
    url = validateQuickLinkUrl(input.url);
  } else if (input.destinationType !== "file") {
    throw new ValidationError([{ path: "destinationType", message: "Must be 'url' or 'file'" }]);
  }

  const maxSort = await prisma.employeePortalQuickLink.aggregate({
    where: { clubId },
    _max: { sortOrder: true },
  });
  const sortOrder = (maxSort._max.sortOrder ?? -1) + 1;

  const row = await prisma.employeePortalQuickLink.create({
    data: {
      clubId,
      label,
      destinationType: input.destinationType,
      url,
      sortOrder,
      isActive: input.isActive ?? true,
      createdByUserId: principal.id,
      updatedByUserId: principal.id,
    },
  });
  await audit(principal, {
    action: "employee-portal.quick-link.create",
    entityType: ENTITY,
    entityId: row.id,
    clubId,
    after: { label: row.label, destinationType: row.destinationType, url: row.url },
  });
  return projectRow(row);
}

export interface UpdateQuickLinkInput {
  label?: string;
  destinationType?: QuickLinkDestinationType;
  url?: string | null;
  isActive?: boolean;
}

export async function updateQuickLink(
  principal: Principal,
  clubId: string,
  id: string,
  input: UpdateQuickLinkInput,
): Promise<QuickLinkView> {
  requirePermission(principal, clubId, "settings:write");
  await assertPostingAllowed(principal, clubId, "employee-portal.quick-link.update", ENTITY, id);

  const row = await prisma.employeePortalQuickLink.findFirst({ where: { id, clubId } });
  if (!row) throw new NotFoundError(ENTITY, id);

  const patch: Record<string, string | number | boolean | null | Date> = {
    updatedByUserId: principal.id,
  };
  if (input.label !== undefined) patch.label = validateLabel(input.label);
  if (input.destinationType) {
    if (input.destinationType !== "url" && input.destinationType !== "file") {
      throw new ValidationError([{ path: "destinationType", message: "Must be 'url' or 'file'" }]);
    }
    patch.destinationType = input.destinationType;
    // Changing type clears the OTHER destination so no ambiguous
    // rows exist — the founder brief calls this out explicitly.
    if (input.destinationType === "url") {
      patch.storageKey = null;
      patch.fileMimeType = null;
      patch.fileSizeBytes = null;
      patch.fileOriginalName = null;
    } else {
      patch.url = null;
    }
  }
  if (input.url !== undefined) {
    if (input.url === null || input.url === "") {
      patch.url = null;
    } else {
      patch.url = validateQuickLinkUrl(input.url);
    }
  }
  if (input.isActive !== undefined) patch.isActive = input.isActive;

  const updated = await prisma.employeePortalQuickLink.update({
    where: { id: row.id },
    data: patch as never,
  });
  await audit(principal, {
    action: "employee-portal.quick-link.update",
    entityType: ENTITY,
    entityId: updated.id,
    clubId,
    before: { label: row.label, destinationType: row.destinationType, url: row.url, isActive: row.isActive },
    after: { label: updated.label, destinationType: updated.destinationType, url: updated.url, isActive: updated.isActive },
  });
  return projectRow(updated);
}

export async function reorderQuickLinks(
  principal: Principal,
  clubId: string,
  orderedIds: string[],
): Promise<QuickLinkView[]> {
  requirePermission(principal, clubId, "settings:write");
  await assertPostingAllowed(principal, clubId, "employee-portal.quick-link.reorder", ENTITY, clubId);

  const existing = await prisma.employeePortalQuickLink.findMany({
    where: { clubId },
    select: { id: true },
  });
  const owned = new Set(existing.map((r) => r.id));
  const seen = new Set<string>();
  for (const id of orderedIds) {
    if (!owned.has(id)) {
      throw new ValidationError([{ path: "orderedIds", message: `Unknown or cross-tenant id: ${id}` }]);
    }
    if (seen.has(id)) {
      throw new ValidationError([{ path: "orderedIds", message: "Duplicate id" }]);
    }
    seen.add(id);
  }
  await prisma.$transaction(
    orderedIds.map((id, index) =>
      prisma.employeePortalQuickLink.update({
        where: { id },
        data: { sortOrder: index, updatedByUserId: principal.id },
      }),
    ),
  );
  await audit(principal, {
    action: "employee-portal.quick-link.reorder",
    entityType: ENTITY,
    entityId: clubId,
    clubId,
    after: { orderedIds },
  });
  return listQuickLinks(clubId);
}

export async function deleteQuickLink(
  principal: Principal,
  clubId: string,
  id: string,
): Promise<void> {
  requirePermission(principal, clubId, "settings:write");
  await assertPostingAllowed(principal, clubId, "employee-portal.quick-link.delete", ENTITY, id);

  const row = await prisma.employeePortalQuickLink.findFirst({ where: { id, clubId } });
  if (!row) throw new NotFoundError(ENTITY, id);
  await prisma.employeePortalQuickLink.delete({ where: { id: row.id } });
  await audit(principal, {
    action: "employee-portal.quick-link.delete",
    entityType: ENTITY,
    entityId: row.id,
    clubId,
    before: { label: row.label, destinationType: row.destinationType, url: row.url },
    after: null,
  });
}

// ---------------------------------------------------------------------------
// File upload/read — PDF-only for now. Bytes stream through the
// canonical documents storage adapter, tenant-scoped, and are keyed
// by the row id + sha256 so replacements are content-addressed.
// ---------------------------------------------------------------------------
export interface AttachQuickLinkFileInput {
  bytes: Buffer | Uint8Array;
  mimeType: string;
  originalName: string;
}

export async function attachQuickLinkFile(
  principal: Principal,
  clubId: string,
  id: string,
  input: AttachQuickLinkFileInput,
): Promise<QuickLinkView> {
  requirePermission(principal, clubId, "settings:write");
  await assertPostingAllowed(principal, clubId, "employee-portal.quick-link.attach-file", ENTITY, id);

  const row = await prisma.employeePortalQuickLink.findFirst({ where: { id, clubId } });
  if (!row) throw new NotFoundError(ENTITY, id);

  const mimeType = (input.mimeType ?? "").toLowerCase();
  if (!QUICK_LINK_ACCEPTED_FILE_MIME.has(mimeType)) {
    throw new ValidationError([{ path: "mimeType", message: "Only PDF files are supported for Quick Link destinations." }]);
  }
  const buf = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes);
  if (buf.length === 0) {
    throw new ValidationError([{ path: "bytes", message: "File is empty." }]);
  }
  if (buf.length > QUICK_LINK_FILE_MAX_BYTES) {
    throw new ValidationError([
      { path: "bytes", message: `File exceeds ${Math.round(QUICK_LINK_FILE_MAX_BYTES / (1024 * 1024))} MiB limit.` },
    ]);
  }
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const storageKey = `clubs/${clubId}/quick-links/${row.id}/${sha256}`;
  const storage = await resolveDocumentStorage({ clubId });
  await storage.put({ storageKey, body: buf, mimeType });

  const updated = await prisma.employeePortalQuickLink.update({
    where: { id: row.id },
    data: {
      destinationType: "file",
      storageKey,
      fileMimeType: mimeType,
      fileSizeBytes: buf.length,
      fileOriginalName: input.originalName || "quick-link.pdf",
      url: null,
      updatedByUserId: principal.id,
    },
  });
  await audit(principal, {
    action: "employee-portal.quick-link.attach-file",
    entityType: ENTITY,
    entityId: row.id,
    clubId,
    before: { destinationType: row.destinationType, storageKey: row.storageKey },
    after: {
      destinationType: updated.destinationType,
      fileOriginalName: updated.fileOriginalName,
      fileSizeBytes: updated.fileSizeBytes,
      mimeType: updated.fileMimeType,
    },
  });
  return projectRow(updated);
}

export async function readQuickLinkFile(
  clubId: string,
  id: string,
): Promise<{ bytes: Buffer; mimeType: string; originalName: string } | null> {
  const row = await prisma.employeePortalQuickLink.findFirst({ where: { id, clubId } });
  if (!row || !row.storageKey || !row.fileMimeType) return null;
  const storage = await resolveDocumentStorage({ clubId });
  const bytes = await storage.get({ storageKey: row.storageKey });
  if (!bytes) return null;
  return {
    bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
    mimeType: row.fileMimeType,
    originalName: row.fileOriginalName ?? "quick-link.pdf",
  };
}
