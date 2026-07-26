// Phase 11E — Tournament scoring (PWA member entry + admin correction).
//
// Members hold a TournamentScoreDraft per (round, registration). Drafts can be
// saved repeatedly with partial scores (offline-safe — PWA syncs when online).
// Submitting a draft transitions DRAFT → SUBMITTED. An admin accepts via
// `acceptDraft`, which writes individual TournamentScore rows + updates the
// leaderboard. Corrections are tracked in TournamentScoreCorrection for audit.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";

// ---------------------------------------------------------------------------
// Save a partial draft (mobile-friendly: PUT-style — overwrites the whole
// scores map).
// ---------------------------------------------------------------------------
export const draftSchema = z.object({
  tournamentId: z.string(),
  roundId: z.string(),
  registrationId: z.string(),
  scores: z.record(z.string(), z.number().int().min(1).max(20)),
});

export async function saveDraft(principal: Principal, raw: unknown) {
  const parsed = draftSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const d = parsed.data;
  const reg = await prisma.tournamentRegistration.findUnique({ where: { id: d.registrationId }, include: { tournament: true } });
  if (!reg) throw new NotFoundError("TournamentRegistration", d.registrationId);
  // Members can score their own registration; staff with lessons:manage at the
  // tournament's club can score on behalf of anyone.
  const isStaff = principal.memberships.some((m) =>
    (m.clubId === reg.clubId || m.clubId === null) &&
    ["SUPER_ADMIN", "CLUB_ADMIN", "GENERAL_MANAGER", "CONTROLLER"].includes(m.roleKey)
  );
  if (!isStaff && reg.memberId !== principal.memberId) throw new ForbiddenError("Cannot score on behalf of another member");
  const existing = await prisma.tournamentScoreDraft.findUnique({
    where: { roundId_registrationId: { roundId: d.roundId, registrationId: d.registrationId } },
  });
  if (existing && existing.status === "ACCEPTED") throw new ConflictError("Round score has already been accepted");
  const draft = existing
    ? await prisma.tournamentScoreDraft.update({
        where: { id: existing.id },
        data: { scoresJson: JSON.stringify(d.scores), status: "DRAFT" },
      })
    : await prisma.tournamentScoreDraft.create({
        data: {
          clubId: reg.clubId, tournamentId: d.tournamentId, roundId: d.roundId,
          registrationId: d.registrationId, scoresJson: JSON.stringify(d.scores), status: "DRAFT",
        },
      });
  return draft;
}

export async function submitDraft(principal: Principal, registrationId: string, roundId: string) {
  const draft = await prisma.tournamentScoreDraft.findUnique({
    where: { roundId_registrationId: { roundId, registrationId } },
  });
  if (!draft) throw new NotFoundError("TournamentScoreDraft", registrationId);
  const reg = await prisma.tournamentRegistration.findUnique({ where: { id: registrationId } });
  if (!reg) throw new NotFoundError("TournamentRegistration", registrationId);
  if (reg.memberId !== principal.memberId) {
    // Allow staff to submit on behalf if they have access.
    const isStaff = principal.memberships.some((m) => (m.clubId === reg.clubId || m.clubId === null) && ["SUPER_ADMIN", "CLUB_ADMIN", "GENERAL_MANAGER"].includes(m.roleKey));
    if (!isStaff) throw new ForbiddenError("Cannot submit another member's score");
  }
  if (draft.status === "ACCEPTED") throw new ConflictError("Already accepted");
  const updated = await prisma.tournamentScoreDraft.update({
    where: { id: draft.id },
    data: { status: "SUBMITTED", submittedAt: new Date(), submittedByUserId: principal.id },
  });
  await audit(principal, { action: "tournament.score.submit", entityType: "TournamentScoreDraft", entityId: draft.id, clubId: draft.clubId, after: { tournamentId: draft.tournamentId, roundId } });
  return updated;
}

// Admin accepts the draft — fans out into individual TournamentScore rows.
export async function acceptDraft(principal: Principal, draftId: string) {
  const draft = await prisma.tournamentScoreDraft.findUnique({ where: { id: draftId } });
  if (!draft) throw new NotFoundError("TournamentScoreDraft", draftId);
  requirePermission(principal, draft.clubId, "lessons:manage");
  if (draft.status === "ACCEPTED") return draft;
  if (draft.status !== "SUBMITTED") throw new ConflictError(`Cannot accept draft in ${draft.status}`);
  const scores = JSON.parse(draft.scoresJson) as Record<string, number>;
  const reg = await prisma.tournamentRegistration.findUnique({ where: { id: draft.registrationId } });
  // Write TournamentScore rows idempotently.
  for (const [hole, strokes] of Object.entries(scores)) {
    const holeNumber = parseInt(hole, 10);
    await prisma.tournamentScore.upsert({
      where: { roundId_registrationId_holeNumber: { roundId: draft.roundId, registrationId: draft.registrationId, holeNumber } },
      update: { strokes, recordedByUserId: principal.id, recordedAt: new Date() },
      create: {
        clubId: draft.clubId, tournamentId: draft.tournamentId, roundId: draft.roundId,
        registrationId: draft.registrationId, memberId: reg?.memberId ?? null,
        holeNumber, strokes, recordedByUserId: principal.id,
      },
    });
  }
  const updated = await prisma.tournamentScoreDraft.update({
    where: { id: draft.id },
    data: { status: "ACCEPTED", acceptedAt: new Date(), acceptedByUserId: principal.id },
  });
  // Recompute leaderboard.
  await updateLeaderboard(draft.clubId, draft.tournamentId, draft.registrationId);
  await audit(principal, { action: "tournament.score.accept", entityType: "TournamentScoreDraft", entityId: draft.id, clubId: draft.clubId });
  return updated;
}

async function updateLeaderboard(clubId: string, tournamentId: string, registrationId: string) {
  const scores = await prisma.tournamentScore.findMany({ where: { tournamentId, registrationId } });
  const totalStrokes = scores.reduce((s, x) => s + x.strokes, 0);
  await prisma.tournamentLeaderboard.upsert({
    where: { tournamentId_registrationId: { tournamentId, registrationId } },
    update: { totalStrokes },
    create: { clubId, tournamentId, registrationId, totalStrokes },
  });
  const rows = await prisma.tournamentLeaderboard.findMany({ where: { tournamentId }, orderBy: { totalStrokes: "asc" } });
  for (let i = 0; i < rows.length; i++) {
    await prisma.tournamentLeaderboard.update({ where: { id: rows[i].id }, data: { positionRank: i + 1 } });
  }
}

// Admin correction — overrides a single hole and records audit trail.
export const correctionSchema = z.object({
  tournamentId: z.string(),
  roundId: z.string(),
  registrationId: z.string(),
  holeNumber: z.number().int().min(1).max(36),
  strokes: z.number().int().min(1).max(20),
  reason: z.string().trim().min(1).max(500),
});

export async function correctScore(principal: Principal, raw: unknown) {
  const parsed = correctionSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const d = parsed.data;
  const reg = await prisma.tournamentRegistration.findUnique({ where: { id: d.registrationId } });
  if (!reg) throw new NotFoundError("TournamentRegistration", d.registrationId);
  requirePermission(principal, reg.clubId, "lessons:manage");
  const before = await prisma.tournamentScore.findUnique({
    where: { roundId_registrationId_holeNumber: { roundId: d.roundId, registrationId: d.registrationId, holeNumber: d.holeNumber } },
  });
  const after = await prisma.tournamentScore.upsert({
    where: { roundId_registrationId_holeNumber: { roundId: d.roundId, registrationId: d.registrationId, holeNumber: d.holeNumber } },
    update: { strokes: d.strokes, recordedByUserId: principal.id, recordedAt: new Date() },
    create: {
      clubId: reg.clubId, tournamentId: d.tournamentId, roundId: d.roundId,
      registrationId: d.registrationId, memberId: reg.memberId,
      holeNumber: d.holeNumber, strokes: d.strokes, recordedByUserId: principal.id,
    },
  });
  await prisma.tournamentScoreCorrection.create({
    data: {
      clubId: reg.clubId, tournamentId: d.tournamentId, roundId: d.roundId, registrationId: d.registrationId,
      holeNumber: d.holeNumber,
      beforeStrokes: before?.strokes ?? null, afterStrokes: d.strokes,
      reason: d.reason, byUserId: principal.id,
    },
  });
  await updateLeaderboard(reg.clubId, d.tournamentId, d.registrationId);
  await audit(principal, { action: "tournament.score.correct", entityType: "TournamentScore", entityId: after.id, clubId: reg.clubId, before: before ? { strokes: before.strokes } : null, after: { strokes: d.strokes, reason: d.reason } });
  return after;
}

// Member-facing reads
export async function getDraft(principal: Principal, registrationId: string, roundId: string) {
  const reg = await prisma.tournamentRegistration.findUnique({ where: { id: registrationId } });
  if (!reg) return null;
  if (reg.memberId !== principal.memberId) {
    const isStaff = principal.memberships.some((m) => (m.clubId === reg.clubId || m.clubId === null) && ["SUPER_ADMIN", "CLUB_ADMIN", "GENERAL_MANAGER", "CONTROLLER"].includes(m.roleKey));
    if (!isStaff) throw new ForbiddenError("Not your registration");
  }
  return prisma.tournamentScoreDraft.findUnique({
    where: { roundId_registrationId: { roundId, registrationId } },
  });
}

export async function listSubmittedDrafts(principal: Principal, clubId: string) {
  requirePermission(principal, clubId, "lessons:manage");
  return prisma.tournamentScoreDraft.findMany({
    where: { clubId, status: "SUBMITTED" },
    orderBy: { submittedAt: "asc" },
  });
}
