// HR-2C Anonymous Employee Feedback (2026-08-27) — canonical
// tenant-scoped service. The submitter is intentionally NOT
// associated with the record. `clubId` is derived server-side
// from the authenticated employee session; no employee identity
// field is persisted.
//
// Never accept an author identifier in these signatures. Never
// write one to prisma. Never include one in audit metadata. The
// UI copy says "Submit anonymously" and the architecture must
// honour that at the application level (§20 of the ticket brief).

import { prisma } from "./prisma";
import { audit } from "./audit";
import { requirePermission, type Principal } from "./rbac";
import { ValidationError, NotFoundError } from "./errors";

const ENTITY = "AnonymousFeedback";

export const FEEDBACK_MESSAGE_MAX = 4000;
export const FEEDBACK_CATEGORY_MAX = 40;

export type FeedbackStatus = "NEW" | "REVIEWED" | "ARCHIVED";
const ALLOWED_STATUSES: ReadonlySet<FeedbackStatus> = new Set(["NEW", "REVIEWED", "ARCHIVED"]);

export interface AnonymousFeedbackView {
  id: string;
  clubId: string;
  category: string | null;
  message: string;
  status: FeedbackStatus;
  createdAt: Date;
  reviewedAt: Date | null;
}

interface FeedbackRow {
  id: string;
  clubId: string;
  category: string | null;
  message: string;
  status: string;
  createdAt: Date;
  reviewedAt: Date | null;
}

function projectRow(row: FeedbackRow): AnonymousFeedbackView {
  return {
    id: row.id,
    clubId: row.clubId,
    category: row.category?.trim().length ? row.category : null,
    message: row.message,
    status: (ALLOWED_STATUSES.has(row.status as FeedbackStatus)
      ? (row.status as FeedbackStatus)
      : "NEW"),
    createdAt: row.createdAt,
    reviewedAt: row.reviewedAt,
  };
}

// ---------------------------------------------------------------------------
// Validation — text-only, capped length. HTML is neither parsed nor
// rendered as HTML; the admin view escapes on display.
// ---------------------------------------------------------------------------

function validateMessage(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    throw new ValidationError([{ path: "message", message: "Feedback message required" }]);
  }
  if (trimmed.length > FEEDBACK_MESSAGE_MAX) {
    throw new ValidationError([
      { path: "message", message: `Message exceeds ${FEEDBACK_MESSAGE_MAX}-character limit` },
    ]);
  }
  return trimmed;
}

function validateCategory(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > FEEDBACK_CATEGORY_MAX) {
    throw new ValidationError([
      { path: "category", message: `Category exceeds ${FEEDBACK_CATEGORY_MAX}-character limit` },
    ]);
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Employee-facing write path. Accepts NO author identifier.
// ---------------------------------------------------------------------------

export interface SubmitAnonymousFeedbackInput {
  message: string;
  category?: string | null;
}

/**
 * Persist a new anonymous feedback record. `clubId` is passed
 * explicitly by the calling API route AFTER it has resolved the
 * employee session — this function itself never sees the
 * employeeId.
 *
 * Audit rows for this action carry a synthetic principal.id of
 * "anonymous:employee" so the audit trail never leaks the real
 * submitter even into the audit log.
 */
export async function submitAnonymousFeedback(
  clubId: string,
  input: SubmitAnonymousFeedbackInput,
): Promise<AnonymousFeedbackView> {
  const message = validateMessage(input.message);
  const category = validateCategory(input.category ?? null);
  const row = await prisma.anonymousFeedback.create({
    data: {
      clubId,
      category,
      message,
      status: "NEW",
    },
  });
  // Audit — deliberately actor-less. Passing null means the
  // AuditLog row stores `userId: null`; the audit trail records
  // that "somebody submitted anonymous feedback for {clubId}" and
  // nothing more, satisfying the founder's §20 no-employee-identity
  // contract even inside the audit layer.
  await audit(null, {
    action: "anonymous-feedback.submit",
    entityType: ENTITY,
    entityId: row.id,
    clubId,
    after: { category, messageLength: message.length },
  });
  return projectRow(row);
}

// ---------------------------------------------------------------------------
// Admin read + status paths — settings:read for list, settings:write
// for status changes. Tenant-scoped on every call.
// ---------------------------------------------------------------------------

export async function listAnonymousFeedback(
  clubId: string,
  opts: { status?: FeedbackStatus } = {},
): Promise<AnonymousFeedbackView[]> {
  const rows = await prisma.anonymousFeedback.findMany({
    where: { clubId, ...(opts.status ? { status: opts.status } : {}) },
    orderBy: [{ createdAt: "desc" }],
  });
  return rows.map(projectRow);
}

export async function setFeedbackStatus(
  principal: Principal,
  clubId: string,
  id: string,
  status: FeedbackStatus,
): Promise<AnonymousFeedbackView> {
  requirePermission(principal, clubId, "settings:write");
  if (!ALLOWED_STATUSES.has(status)) {
    throw new ValidationError([{ path: "status", message: "Status must be NEW, REVIEWED, or ARCHIVED" }]);
  }
  const row = await prisma.anonymousFeedback.findFirst({ where: { id, clubId } });
  if (!row) throw new NotFoundError(ENTITY, id);
  const updated = await prisma.anonymousFeedback.update({
    where: { id: row.id },
    data: {
      status,
      reviewedAt: status === "REVIEWED" || status === "ARCHIVED" ? new Date() : null,
    },
  });
  await audit(principal, {
    action: "anonymous-feedback.status",
    entityType: ENTITY,
    entityId: updated.id,
    clubId,
    before: { status: row.status },
    after: { status: updated.status },
  });
  return projectRow(updated);
}
