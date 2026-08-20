// HR-2C (2026-08-20) — Club media (per-tenant asset store).
//
// Canonical service for the Employee Portal hero photograph and any
// future per-Club media asset. One row per (clubId, category) —
// replacement rotates the asset in place.
//
// Discipline:
//   - Every write requires `settings:write` at the target Club and
//     is audited.
//   - Bytes go through `resolveDocumentStorage({clubId})` (R2 in
//     staging/prod, local disk / memory in dev/test) using the
//     canonical `clubs/{clubId}/media/{sha256}` key convention.
//   - Reads never signed-URL; all delivery is proxied by
//     `/api/clubs/[id]/{category}/route.ts` handlers so tenant
//     isolation is end-to-end.
//   - Absence of a row is a legitimate state — the surface renders
//     its own branded fallback (Club.primaryColor).
//
// Not exported as a category enum in the DB layer — the category
// vocabulary is service-validated so we can add new categories
// (future: employeeHandbookHero, boardBrandingHeader) without a
// migration.

import { createHash } from "node:crypto";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertPostingAllowed } from "../posting-guard";
import { ValidationError, NotFoundError } from "../errors";
import { resolveDocumentStorage } from "../documents/storage";

/** Vocabulary of allowed categories. Service-validated at write
 *  time so admin routes never touch storage with a value outside
 *  this set. Add new categories here + the render surface. */
export const CLUB_MEDIA_CATEGORIES = [
  "employee_portal_hero",
] as const;
export type ClubMediaCategory = (typeof CLUB_MEDIA_CATEGORIES)[number];

export function isKnownClubMediaCategory(v: string): v is ClubMediaCategory {
  return (CLUB_MEDIA_CATEGORIES as readonly string[]).includes(v);
}

/** Photo constants — copied verbatim from the canonical
 *  `/api/hr/employees/[id]/profile-photo/route.ts` reference to keep
 *  MIME + size discipline uniform across the codebase. */
export const CLUB_MEDIA_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB
export const CLUB_MEDIA_ACCEPTED_IMAGE_MIME = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
  // heic/heif accepted for iPhone uploads; browsers may not render
  // but the upload path preserves whatever the Club chose.
  "image/heic",
  "image/heif",
]);

const ENTITY = "ClubMedia";

// ---------------------------------------------------------------------------
// Write — upload (or replace) a Club media asset.
// ---------------------------------------------------------------------------

export interface SetClubMediaInput {
  category: ClubMediaCategory;
  bytes: Buffer | Uint8Array;
  mimeType: string;
  displayName?: string | null;
}

/**
 * Canonical writer. Replaces any prior asset for the same
 * (clubId, category) — the unique constraint on that pair means we
 * upsert by category. Old bytes remain in storage (evidentiary /
 * cache) but the DB row + rendered image become the new asset.
 */
export async function setClubMedia(
  principal: Principal,
  clubId: string,
  input: SetClubMediaInput,
): Promise<{ id: string; category: string; storageKey: string; uploadedAt: Date }> {
  requirePermission(principal, clubId, "settings:write");
  await assertPostingAllowed(principal, clubId, "club.media.update", ENTITY, clubId);

  if (!isKnownClubMediaCategory(input.category)) {
    throw new ValidationError([
      { path: "category", message: `must be one of ${CLUB_MEDIA_CATEGORIES.join(", ")}` },
    ]);
  }
  const mimeType = (input.mimeType || "").toLowerCase();
  if (!CLUB_MEDIA_ACCEPTED_IMAGE_MIME.has(mimeType)) {
    throw new ValidationError([
      { path: "mimeType", message: "Image must be JPEG, PNG, WEBP, HEIC, or HEIF." },
    ]);
  }
  const buf = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes);
  if (buf.length === 0) {
    throw new ValidationError([{ path: "bytes", message: "Image file is empty." }]);
  }
  if (buf.length > CLUB_MEDIA_MAX_BYTES) {
    throw new ValidationError([
      { path: "bytes", message: `Image exceeds ${Math.round(CLUB_MEDIA_MAX_BYTES / (1024 * 1024))} MiB limit.` },
    ]);
  }

  const sha256 = createHash("sha256").update(buf).digest("hex");
  const storageKey = `clubs/${clubId}/media/${input.category}/${sha256}`;

  const storage = await resolveDocumentStorage({ clubId });
  await storage.put({ storageKey, body: buf, mimeType });

  const priorRow = await prisma.clubMedia.findFirst({
    where: { clubId, category: input.category },
    select: { id: true, sha256: true },
  });

  const row = await prisma.clubMedia.upsert({
    where: { clubId_category: { clubId, category: input.category } },
    create: {
      clubId,
      category: input.category,
      storageKey,
      mimeType,
      sizeBytes: buf.length,
      sha256,
      displayName: input.displayName ?? null,
      uploadedByUserId: principal.id,
    },
    update: {
      storageKey,
      mimeType,
      sizeBytes: buf.length,
      sha256,
      displayName: input.displayName ?? null,
      uploadedByUserId: principal.id,
      uploadedAt: new Date(),
    },
  });

  await audit(principal, {
    action: "club.media.update",
    entityType: ENTITY,
    entityId: row.id,
    clubId,
    before: priorRow ? { sha256: priorRow.sha256 } : null,
    after: {
      category: row.category,
      sha256: row.sha256,
      sizeBytes: row.sizeBytes,
      mimeType: row.mimeType,
    },
  });

  return { id: row.id, category: row.category, storageKey: row.storageKey, uploadedAt: row.uploadedAt };
}

// ---------------------------------------------------------------------------
// Delete — remove the Club's asset for a category.
// ---------------------------------------------------------------------------

export async function clearClubMedia(
  principal: Principal,
  clubId: string,
  category: ClubMediaCategory,
): Promise<{ cleared: boolean }> {
  requirePermission(principal, clubId, "settings:write");
  await assertPostingAllowed(principal, clubId, "club.media.delete", ENTITY, clubId);

  const existing = await prisma.clubMedia.findFirst({
    where: { clubId, category },
    select: { id: true, sha256: true },
  });
  if (!existing) return { cleared: false };
  await prisma.clubMedia.delete({ where: { id: existing.id } });
  await audit(principal, {
    action: "club.media.delete",
    entityType: ENTITY,
    entityId: existing.id,
    clubId,
    before: { sha256: existing.sha256, category },
    after: null,
  });
  return { cleared: true };
}

// ---------------------------------------------------------------------------
// Read — untyped tenant-scoped read used by the proxy route and portal
// server components.
// ---------------------------------------------------------------------------

/** Return the current media row for (clubId, category), or null. Does
 *  NOT return bytes — callers stream via `readClubMediaBytes`. */
export async function getClubMedia(
  clubId: string,
  category: ClubMediaCategory,
): Promise<
  | {
      id: string;
      category: string;
      storageKey: string;
      mimeType: string;
      sizeBytes: number;
      sha256: string;
      uploadedAt: Date;
    }
  | null
> {
  return prisma.clubMedia.findFirst({
    where: { clubId, category },
    select: {
      id: true,
      category: true,
      storageKey: true,
      mimeType: true,
      sizeBytes: true,
      sha256: true,
      uploadedAt: true,
    },
  });
}

/** Read the raw bytes for a Club media asset. Tenant-scoped by clubId
 *  — the proxy route computes clubId from the URL's `[id]` param AND
 *  validates the caller has read access to that club. Never expose
 *  this at the DB layer directly. */
export async function readClubMediaBytes(
  clubId: string,
  category: ClubMediaCategory,
): Promise<{ bytes: Buffer; mimeType: string; sha256: string } | null> {
  const row = await getClubMedia(clubId, category);
  if (!row) return null;
  if (!isKnownClubMediaCategory(row.category)) {
    throw new NotFoundError(ENTITY, `${clubId}:${category}`);
  }
  const storage = await resolveDocumentStorage({ clubId });
  const bytes = await storage.get({ storageKey: row.storageKey });
  if (!bytes) return null;
  return { bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), mimeType: row.mimeType, sha256: row.sha256 };
}
