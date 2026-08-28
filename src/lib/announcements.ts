// Announcements service (2026-08-27) — canonical tenant-scoped
// CRUD + publication-rule read paths for Announcement rows.
//
// Consumed by:
//   • Admin Settings CRUD component (`AnnouncementsEditor`)
//   • API routes under `/api/clubs/[id]/announcements/*`
//   • Employee Portal home (`page.tsx`) via listVisibleAnnouncements(...)
//
// Discipline mirrors EmployeePortalQuickLink — `settings:write` +
// `assertPostingAllowed` + `audit()`; tenant-scoped on every read
// and write. Sanitised body storage (plain-text; UI renders line
// breaks as <br>). No arbitrary HTML/script injection.

import { prisma } from "./prisma";
import { audit } from "./audit";
import { requirePermission, type Principal } from "./rbac";
import { assertPostingAllowed } from "./posting-guard";
import { ValidationError, NotFoundError } from "./errors";

// Uses the existing `ClubAnnouncement` Prisma model (extended in
// the 2026-08-27 hr2c_announcement migration to add isPublished,
// isPinned, sortOrder, createdByUserId, updatedByUserId).
const ENTITY = "ClubAnnouncement";

export const ANNOUNCEMENT_TITLE_MAX = 120;
export const ANNOUNCEMENT_BODY_MAX = 4000;
export const ANNOUNCEMENT_PREVIEW_MAX = 180;

export type AnnouncementAudience = "EMPLOYEE" | "MEMBER" | "BOTH";

const ALLOWED_AUDIENCES: ReadonlySet<AnnouncementAudience> = new Set([
  "EMPLOYEE", "MEMBER", "BOTH",
]);

export interface AnnouncementView {
  id: string;
  clubId: string;
  audience: AnnouncementAudience;
  title: string;
  body: string;
  isPublished: boolean;
  publishedAt: Date | null;
  expiresAt: Date | null;
  isPinned: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

interface AnnouncementRow {
  id: string;
  clubId: string;
  audience: string;
  title: string;
  body: string;
  isPublished: boolean;
  publishedAt: Date | null;
  expiresAt: Date | null;
  isPinned: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

function projectRow(row: AnnouncementRow): AnnouncementView {
  return {
    id: row.id,
    clubId: row.clubId,
    audience: (ALLOWED_AUDIENCES.has(row.audience as AnnouncementAudience)
      ? (row.audience as AnnouncementAudience)
      : "EMPLOYEE"),
    title: row.title,
    body: row.body,
    isPublished: row.isPublished,
    publishedAt: row.publishedAt,
    expiresAt: row.expiresAt,
    isPinned: row.isPinned,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateTitle(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) throw new ValidationError([{ path: "title", message: "Title required" }]);
  if (trimmed.length > ANNOUNCEMENT_TITLE_MAX) {
    throw new ValidationError([
      { path: "title", message: `Title exceeds ${ANNOUNCEMENT_TITLE_MAX}-character limit` },
    ]);
  }
  return trimmed;
}

function validateBody(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) throw new ValidationError([{ path: "body", message: "Body required" }]);
  if (trimmed.length > ANNOUNCEMENT_BODY_MAX) {
    throw new ValidationError([
      { path: "body", message: `Body exceeds ${ANNOUNCEMENT_BODY_MAX}-character limit` },
    ]);
  }
  return trimmed;
}

function validateAudience(raw: string): AnnouncementAudience {
  if (!ALLOWED_AUDIENCES.has(raw as AnnouncementAudience)) {
    throw new ValidationError([
      { path: "audience", message: "audience must be EMPLOYEE, MEMBER, or BOTH" },
    ]);
  }
  return raw as AnnouncementAudience;
}

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

/** Admin-facing list — every announcement for the tenant, ordered
 *  pinned-first, newest published, then newest created. */
export async function listAnnouncements(clubId: string): Promise<AnnouncementView[]> {
  const rows = await prisma.clubAnnouncement.findMany({
    where: { clubId },
    orderBy: [
      { isPinned: "desc" },
      { publishedAt: "desc" },
      { createdAt: "desc" },
    ],
  });
  return rows.map(projectRow);
}

/** Employee/Member portal read path. Applies publication rules:
 *   • must be published
 *   • publishedAt <= now (or null → treated as immediately visible)
 *   • expiresAt IS NULL OR expiresAt > now
 *   • audience includes the requested surface
 *
 *  Consumers pass surface: "EMPLOYEE" → include EMPLOYEE and BOTH.
 *  surface: "MEMBER" → include MEMBER and BOTH.
 */
export async function listVisibleAnnouncements(
  clubId: string,
  surface: "EMPLOYEE" | "MEMBER",
  opts: { now?: Date; limit?: number } = {},
): Promise<AnnouncementView[]> {
  const now = opts.now ?? new Date();
  const rows = await prisma.clubAnnouncement.findMany({
    where: {
      clubId,
      isPublished: true,
      audience: { in: surface === "EMPLOYEE" ? ["EMPLOYEE", "BOTH"] : ["MEMBER", "BOTH"] },
      AND: [
        {
          OR: [
            { publishedAt: null },
            { publishedAt: { lte: now } },
          ],
        },
        {
          OR: [
            { expiresAt: null },
            { expiresAt: { gt: now } },
          ],
        },
      ],
    },
    orderBy: [
      { isPinned: "desc" },
      { publishedAt: "desc" },
      { createdAt: "desc" },
    ],
    take: opts.limit,
  });
  return rows.map(projectRow);
}

/** Body preview clamped to ~180 chars for the right-rail card. Full
 *  body is available on the detail view / admin edit. */
export function announcementPreview(body: string): string {
  const cleaned = body.replace(/\s+/g, " ").trim();
  if (cleaned.length <= ANNOUNCEMENT_PREVIEW_MAX) return cleaned;
  return cleaned.slice(0, ANNOUNCEMENT_PREVIEW_MAX - 1).trimEnd() + "…";
}

// ---------------------------------------------------------------------------
// Write paths
// ---------------------------------------------------------------------------

export interface CreateAnnouncementInput {
  audience: AnnouncementAudience;
  title: string;
  body: string;
  isPublished?: boolean;
  publishedAt?: Date | null;
  expiresAt?: Date | null;
  isPinned?: boolean;
}

export async function createAnnouncement(
  principal: Principal,
  clubId: string,
  input: CreateAnnouncementInput,
): Promise<AnnouncementView> {
  requirePermission(principal, clubId, "settings:write");
  await assertPostingAllowed(principal, clubId, "announcement.create", ENTITY, clubId);

  const audience = validateAudience(input.audience);
  const title = validateTitle(input.title);
  const body = validateBody(input.body);
  const isPublished = input.isPublished ?? false;
  const publishedAt = isPublished
    ? (input.publishedAt ?? new Date())
    : null;

  const row = await prisma.clubAnnouncement.create({
    data: {
      clubId,
      audience,
      title,
      body,
      isPublished,
      publishedAt,
      expiresAt: input.expiresAt ?? null,
      isPinned: input.isPinned ?? false,
      createdByUserId: principal.id,
      updatedByUserId: principal.id,
    },
  });
  await audit(principal, {
    action: "announcement.create",
    entityType: ENTITY,
    entityId: row.id,
    clubId,
    after: { audience, title, isPublished, publishedAt: publishedAt?.toISOString() ?? null },
  });
  return projectRow(row);
}

export interface UpdateAnnouncementInput {
  audience?: AnnouncementAudience;
  title?: string;
  body?: string;
  isPublished?: boolean;
  publishedAt?: Date | null;
  expiresAt?: Date | null;
  isPinned?: boolean;
}

export async function updateAnnouncement(
  principal: Principal,
  clubId: string,
  id: string,
  input: UpdateAnnouncementInput,
): Promise<AnnouncementView> {
  requirePermission(principal, clubId, "settings:write");
  await assertPostingAllowed(principal, clubId, "announcement.update", ENTITY, id);

  const row = await prisma.clubAnnouncement.findFirst({ where: { id, clubId } });
  if (!row) throw new NotFoundError(ENTITY, id);

  const patch: {
    audience?: string;
    title?: string;
    body?: string;
    isPublished?: boolean;
    publishedAt?: Date | null;
    expiresAt?: Date | null;
    isPinned?: boolean;
    updatedByUserId?: string;
  } = {
    updatedByUserId: principal.id,
  };
  if (input.audience !== undefined) patch.audience = validateAudience(input.audience);
  if (input.title !== undefined) patch.title = validateTitle(input.title);
  if (input.body !== undefined) patch.body = validateBody(input.body);
  if (input.isPublished !== undefined) {
    patch.isPublished = input.isPublished;
    if (input.isPublished && !row.isPublished && !input.publishedAt) {
      patch.publishedAt = new Date();
    }
    if (!input.isPublished) {
      patch.publishedAt = null;
    }
  }
  if (input.publishedAt !== undefined) patch.publishedAt = input.publishedAt;
  if (input.expiresAt !== undefined) patch.expiresAt = input.expiresAt;
  if (input.isPinned !== undefined) patch.isPinned = input.isPinned;

  const updated = await prisma.clubAnnouncement.update({
    where: { id: row.id },
    data: patch,
  });
  await audit(principal, {
    action: "announcement.update",
    entityType: ENTITY,
    entityId: updated.id,
    clubId,
    before: {
      audience: row.audience,
      title: row.title,
      isPublished: row.isPublished,
      isPinned: row.isPinned,
    },
    after: {
      audience: updated.audience,
      title: updated.title,
      isPublished: updated.isPublished,
      isPinned: updated.isPinned,
    },
  });
  return projectRow(updated);
}

export async function deleteAnnouncement(
  principal: Principal,
  clubId: string,
  id: string,
): Promise<void> {
  requirePermission(principal, clubId, "settings:write");
  await assertPostingAllowed(principal, clubId, "announcement.delete", ENTITY, id);

  const row = await prisma.clubAnnouncement.findFirst({ where: { id, clubId } });
  if (!row) throw new NotFoundError(ENTITY, id);
  await prisma.clubAnnouncement.delete({ where: { id: row.id } });
  await audit(principal, {
    action: "announcement.delete",
    entityType: ENTITY,
    entityId: row.id,
    clubId,
    before: { audience: row.audience, title: row.title, isPublished: row.isPublished },
    after: null,
  });
}
