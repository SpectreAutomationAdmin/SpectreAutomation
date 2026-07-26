// Phase 12C — Tournament score draft conflict detection + reconciliation.
//
// Wraps the Phase 11 scoring service with optimistic concurrency. Members'
// PWA clients post the `expectedVersion` they read; if the server's current
// version differs, we record a TournamentScoreConflict and surface a
// reconciliation prompt in the UI.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";

export type ConflictDecision = "KEPT_SERVER" | "KEPT_CLIENT" | "MERGED" | "DISMISSED";

// Save with optimistic concurrency. If `expectedVersion` doesn't match the
// current row, returns { conflict: <id> } without overwriting. Caller then
// drives the reconciliation flow via resolveConflict().
export const saveSchema = z.object({
  tournamentId: z.string(),
  roundId: z.string(),
  registrationId: z.string(),
  scores: z.record(z.string(), z.number().int().min(1).max(20)),
  expectedVersion: z.number().int().min(0).optional(),
  editorLabel: z.string().trim().max(120).optional(),
});

export async function saveDraftVersioned(principal: Principal, raw: unknown) {
  const parsed = saveSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const d = parsed.data;
  const reg = await prisma.tournamentRegistration.findUnique({ where: { id: d.registrationId }, include: { tournament: true } });
  if (!reg) throw new NotFoundError("TournamentRegistration", d.registrationId);
  // Same permission gate as the Phase 11 service.
  const isStaff = principal.memberships.some((m) => (m.clubId === reg.clubId || m.clubId === null) && ["SUPER_ADMIN", "CLUB_ADMIN", "GENERAL_MANAGER", "CONTROLLER"].includes(m.roleKey));
  if (!isStaff && reg.memberId !== principal.memberId) throw new ForbiddenError("Cannot score on behalf of another member");

  const existing = await prisma.tournamentScoreDraft.findUnique({
    where: { roundId_registrationId: { roundId: d.roundId, registrationId: d.registrationId } },
  });
  if (existing && existing.status === "ACCEPTED") {
    throw new ConflictError("Round score has already been accepted");
  }

  // Conflict path: client supplied an expectedVersion that doesn't match.
  if (existing && d.expectedVersion !== undefined && d.expectedVersion !== existing.version) {
    const conflict = await prisma.tournamentScoreConflict.create({
      data: {
        clubId: reg.clubId, draftId: existing.id,
        clientVersion: d.expectedVersion, serverVersion: existing.version,
        clientScoresJson: JSON.stringify(d.scores),
        serverScoresJson: existing.scoresJson,
        resolution: "PENDING",
      },
    });
    await audit(principal, {
      action: "tournament.score.conflict", entityType: "TournamentScoreDraft", entityId: existing.id, clubId: reg.clubId,
      after: { clientVersion: d.expectedVersion, serverVersion: existing.version },
    });
    return { conflict, draft: existing };
  }

  // No conflict — apply the write and bump the version.
  const draft = existing
    ? await prisma.tournamentScoreDraft.update({
        where: { id: existing.id },
        data: {
          scoresJson: JSON.stringify(d.scores), status: "DRAFT",
          version: { increment: 1 },
          lastEditorUserId: principal.id,
          lastEditorLabel: d.editorLabel ?? null,
        },
      })
    : await prisma.tournamentScoreDraft.create({
        data: {
          clubId: reg.clubId, tournamentId: d.tournamentId, roundId: d.roundId,
          registrationId: d.registrationId, scoresJson: JSON.stringify(d.scores), status: "DRAFT",
          version: 1, lastEditorUserId: principal.id, lastEditorLabel: d.editorLabel ?? null,
        },
      });
  return { draft, conflict: null };
}

// Caller picks a side: keep server, keep client, or merge (later phase).
export const resolveSchema = z.object({
  conflictId: z.string(),
  decision: z.enum(["KEPT_SERVER", "KEPT_CLIENT", "MERGED", "DISMISSED"]),
  mergedScores: z.record(z.string(), z.number().int().min(1).max(20)).optional(),
});

export async function resolveConflict(principal: Principal, raw: unknown) {
  const parsed = resolveSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const d = parsed.data;
  const conflict = await prisma.tournamentScoreConflict.findUnique({
    where: { id: d.conflictId }, include: { draft: true },
  });
  if (!conflict) throw new NotFoundError("TournamentScoreConflict", d.conflictId);
  if (conflict.resolution !== "PENDING") throw new ConflictError(`Conflict already ${conflict.resolution}`);
  requirePermission(principal, conflict.clubId, "lessons:view");

  if (d.decision === "KEPT_CLIENT") {
    await prisma.tournamentScoreDraft.update({
      where: { id: conflict.draftId },
      data: {
        scoresJson: conflict.clientScoresJson,
        version: { increment: 1 },
        lastEditorUserId: principal.id,
      },
    });
  } else if (d.decision === "MERGED" && d.mergedScores) {
    await prisma.tournamentScoreDraft.update({
      where: { id: conflict.draftId },
      data: {
        scoresJson: JSON.stringify(d.mergedScores),
        version: { increment: 1 },
        lastEditorUserId: principal.id,
      },
    });
  }
  // KEPT_SERVER and DISMISSED leave the draft as-is.

  const resolved = await prisma.tournamentScoreConflict.update({
    where: { id: d.conflictId },
    data: { resolution: d.decision, resolvedAt: new Date(), resolvedByUserId: principal.id },
  });
  await audit(principal, {
    action: "tournament.score.conflict.resolve",
    entityType: "TournamentScoreConflict", entityId: d.conflictId,
    clubId: conflict.clubId, after: { decision: d.decision },
  });
  return resolved;
}

export async function listOpenConflicts(principal: Principal, clubId: string) {
  requirePermission(principal, clubId, "lessons:view");
  return prisma.tournamentScoreConflict.findMany({
    where: { clubId, resolution: "PENDING" },
    include: { draft: true },
    orderBy: { detectedAt: "desc" },
    take: 50,
  });
}
