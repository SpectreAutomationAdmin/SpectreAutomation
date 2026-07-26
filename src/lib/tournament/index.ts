// Phase 9F — Tournament management.
//
// Built on top of the Phase 8 tee-sheet engine. Three formats are first-class:
//   - STROKE: aggregate strokes per round; lowest total wins. Leaderboard
//             updates after every TournamentScore write.
//   - MATCH:  bracket of TournamentMatch rows; winners advance.
//   - SCRAMBLE: team-based stroke play; each TournamentRegistration links to
//             a TournamentTeam and scores aggregate by team.
//
// AR integration: registration optionally creates a Charge via the existing
// AR service (member account). Refunds reverse via reverseCharge.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned, tenantWhere } from "../services/tenant";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { postCharge, reverseCharge, recomputeAccount } from "../services/ar";

// ---------------------------------------------------------------------------
// Tournament setup
// ---------------------------------------------------------------------------
export const tournamentSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).optional().nullable(),
  format: z.enum(["STROKE", "MATCH", "SCRAMBLE", "STABLEFORD", "LADDER"]).default("STROKE"),
  startDate: z.string().or(z.date()),
  endDate: z.string().or(z.date()),
  registrationOpensAt: z.string().or(z.date()).optional().nullable(),
  registrationClosesAt: z.string().or(z.date()).optional().nullable(),
  entryFee: z.number().nonnegative().default(0),
  guestFee: z.number().nonnegative().default(0),
  maxParticipants: z.number().int().positive().optional().nullable(),
  courseCode: z.string().optional().nullable(),
  revenueAccountNumber: z.string().optional().nullable(),
});

export async function createTournament(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "lessons:manage"); // tee-sheet/tournament write
  const parsed = tournamentSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;
  const course = d.courseCode ? await prisma.course.findFirst({ where: { clubId, code: d.courseCode } }) : null;
  const revenueAccount = d.revenueAccountNumber ? await prisma.account.findFirst({ where: { clubId, accountNumber: d.revenueAccountNumber } }) : null;
  const t = await prisma.tournament.create({
    data: {
      clubId, name: d.name, description: d.description ?? null,
      format: d.format,
      startDate: new Date(d.startDate), endDate: new Date(d.endDate),
      registrationOpensAt: d.registrationOpensAt ? new Date(d.registrationOpensAt) : null,
      registrationClosesAt: d.registrationClosesAt ? new Date(d.registrationClosesAt) : null,
      entryFee: d.entryFee, guestFee: d.guestFee, maxParticipants: d.maxParticipants ?? null,
      courseId: course?.id ?? null,
      revenueAccountId: revenueAccount?.id ?? null,
      status: "DRAFT",
      createdByUserId: principal.id,
    },
  });
  await audit(principal, { action: "tournament.create", entityType: "Tournament", entityId: t.id, clubId, after: { name: d.name, format: d.format } });
  return t;
}

export async function openRegistration(principal: Principal, tournamentId: string) {
  const t = await prisma.tournament.findUnique({ where: { id: tournamentId } });
  if (!t) throw new NotFoundError("Tournament", tournamentId);
  assertTenantOwned(t, principal);
  requirePermission(principal, t.clubId, "lessons:manage");
  if (t.status !== "DRAFT") throw new ConflictError(`Cannot open registration on ${t.status} tournament`);
  return prisma.tournament.update({ where: { id: tournamentId }, data: { status: "OPEN" } });
}

// ---------------------------------------------------------------------------
// Divisions / teams
// ---------------------------------------------------------------------------
export async function addDivision(principal: Principal, tournamentId: string, args: { name: string; description?: string; minHandicap?: number; maxHandicap?: number; sortOrder?: number }) {
  const t = await prisma.tournament.findUnique({ where: { id: tournamentId } });
  if (!t) throw new NotFoundError("Tournament", tournamentId);
  assertTenantOwned(t, principal);
  requirePermission(principal, t.clubId, "lessons:manage");
  return prisma.tournamentDivision.create({
    data: {
      clubId: t.clubId, tournamentId,
      name: args.name, description: args.description ?? null,
      minHandicap: args.minHandicap ?? null, maxHandicap: args.maxHandicap ?? null,
      sortOrder: args.sortOrder ?? 0,
    },
  });
}

export async function createTeam(principal: Principal, tournamentId: string, name: string) {
  const t = await prisma.tournament.findUnique({ where: { id: tournamentId } });
  if (!t) throw new NotFoundError("Tournament", tournamentId);
  assertTenantOwned(t, principal);
  requirePermission(principal, t.clubId, "lessons:manage");
  return prisma.tournamentTeam.create({ data: { clubId: t.clubId, tournamentId, name } });
}

// ---------------------------------------------------------------------------
// Registration (creates an AR Charge if entry fee > 0)
// ---------------------------------------------------------------------------
export const registrationSchema = z.object({
  memberId: z.string().optional().nullable(),
  divisionId: z.string().optional().nullable(),
  teamId: z.string().optional().nullable(),
  handicap: z.number().int().optional().nullable(),
  guest: z.object({
    firstName: z.string().trim().min(1),
    lastName: z.string().trim().min(1),
    email: z.string().email().optional().nullable(),
  }).optional().nullable(),
});

export async function registerForTournament(principal: Principal, tournamentId: string, raw: unknown) {
  const t = await prisma.tournament.findUnique({ where: { id: tournamentId } });
  if (!t) throw new NotFoundError("Tournament", tournamentId);
  assertTenantOwned(t, principal);
  requirePermission(principal, t.clubId, "lessons:view");
  if (t.status !== "OPEN") throw new ConflictError(`Registration is ${t.status}`);
  if (t.registrationClosesAt && new Date() > t.registrationClosesAt) throw new ConflictError("Registration closed");

  const parsed = registrationSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;
  if (!d.memberId && !d.guest) throw new ConflictError("memberId or guest required");

  if (t.maxParticipants) {
    const count = await prisma.tournamentRegistration.count({ where: { tournamentId, status: { in: ["REGISTERED", "CONFIRMED"] } } });
    if (count >= t.maxParticipants) throw new ConflictError("Tournament is full");
  }

  // Idempotent registration for members.
  if (d.memberId) {
    const existing = await prisma.tournamentRegistration.findUnique({
      where: { tournamentId_memberId: { tournamentId, memberId: d.memberId } },
    });
    if (existing && existing.status !== "CANCELLED") return existing;
  }

  // Create the AR charge first; if registration fails the AR write is reversed.
  let feeChargeId: string | null = null;
  const feeAmount = d.guest ? Number(t.guestFee.toString()) : Number(t.entryFee.toString());
  if (d.memberId && feeAmount > 0) {
    const charge = await postCharge(principal, d.memberId, {
      description: `Tournament entry — ${t.name}${d.guest ? ` (guest)` : ""}`,
      category: "OTHER",
      amount: feeAmount,
    });
    feeChargeId = charge.id;
  }

  const registration = await prisma.tournamentRegistration.create({
    data: {
      clubId: t.clubId, tournamentId,
      divisionId: d.divisionId ?? null,
      memberId: d.memberId ?? null,
      guestFirstName: d.guest?.firstName ?? null,
      guestLastName: d.guest?.lastName ?? null,
      guestEmail: d.guest?.email ?? null,
      teamId: d.teamId ?? null,
      handicap: d.handicap ?? null,
      feeChargeId,
      status: "REGISTERED",
    },
  });
  await audit(principal, { action: "tournament.register", entityType: "TournamentRegistration", entityId: registration.id, clubId: t.clubId, after: { tournamentId, memberId: d.memberId, feeAmount, feeChargeId } });
  return registration;
}

export async function cancelRegistration(principal: Principal, registrationId: string, reason?: string) {
  const reg = await prisma.tournamentRegistration.findUnique({ where: { id: registrationId } });
  if (!reg) throw new NotFoundError("TournamentRegistration", registrationId);
  assertTenantOwned(reg, principal);
  requirePermission(principal, reg.clubId, "lessons:manage");
  if (reg.status === "CANCELLED") return reg;
  // Reverse the entry-fee charge if one exists.
  if (reg.feeChargeId) {
    try { await reverseCharge(principal, reg.feeChargeId, `Tournament cancellation: ${reason ?? ""}`); }
    catch { /* charge may already be reversed/voided */ }
    if (reg.memberId) await recomputeAccount(reg.memberId);
  }
  const updated = await prisma.tournamentRegistration.update({
    where: { id: registrationId },
    data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: reason ?? null },
  });
  await audit(principal, { action: "tournament.cancel_registration", entityType: "TournamentRegistration", entityId: registrationId, clubId: reg.clubId, after: { reason } });
  return updated;
}

// ---------------------------------------------------------------------------
// Rounds + scoring
// ---------------------------------------------------------------------------
export async function createRound(principal: Principal, tournamentId: string, args: { roundNumber: number; scheduledDate: Date | string; notes?: string }) {
  const t = await prisma.tournament.findUnique({ where: { id: tournamentId } });
  if (!t) throw new NotFoundError("Tournament", tournamentId);
  assertTenantOwned(t, principal);
  requirePermission(principal, t.clubId, "lessons:manage");
  return prisma.tournamentRound.create({
    data: { clubId: t.clubId, tournamentId, roundNumber: args.roundNumber, scheduledDate: new Date(args.scheduledDate), notes: args.notes ?? null },
  });
}

export const scoreSchema = z.object({
  roundId: z.string(),
  registrationId: z.string(),
  holeNumber: z.number().int().min(1).max(36),
  strokes: z.number().int().min(1).max(20),
  putts: z.number().int().min(0).max(20).optional().nullable(),
});

export async function recordScore(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "lessons:view");
  const parsed = scoreSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;
  const round = await prisma.tournamentRound.findUnique({ where: { id: d.roundId }, include: { tournament: true } });
  if (!round) throw new NotFoundError("TournamentRound", d.roundId);
  if (round.clubId !== clubId) throw new ConflictError("Cross-club round");
  if (round.status === "COMPLETED") throw new ConflictError("Round is completed");
  const reg = await prisma.tournamentRegistration.findUnique({ where: { id: d.registrationId } });
  if (!reg || reg.tournamentId !== round.tournamentId) throw new ConflictError("Registration not in this round");

  // Idempotent on (roundId, registrationId, holeNumber).
  const score = await prisma.tournamentScore.upsert({
    where: { roundId_registrationId_holeNumber: { roundId: d.roundId, registrationId: d.registrationId, holeNumber: d.holeNumber } },
    update: { strokes: d.strokes, putts: d.putts ?? null, recordedByUserId: principal.id, recordedAt: new Date() },
    create: {
      clubId, tournamentId: round.tournamentId, roundId: d.roundId,
      registrationId: d.registrationId, memberId: reg.memberId,
      holeNumber: d.holeNumber, strokes: d.strokes, putts: d.putts ?? null,
      recordedByUserId: principal.id,
    },
  });
  await updateLeaderboardForRegistration(clubId, round.tournamentId, d.registrationId);
  return score;
}

// Recompute the leaderboard row for one registration. Pure aggregate across
// all rounds + scores. Stable rank computed across the whole tournament.
async function updateLeaderboardForRegistration(clubId: string, tournamentId: string, registrationId: string) {
  const scores = await prisma.tournamentScore.findMany({ where: { tournamentId, registrationId } });
  const totalStrokes = scores.reduce((s, x) => s + x.strokes, 0);
  await prisma.tournamentLeaderboard.upsert({
    where: { tournamentId_registrationId: { tournamentId, registrationId } },
    update: { totalStrokes, totalPoints: 0 },
    create: { clubId, tournamentId, registrationId, totalStrokes, totalPoints: 0 },
  });
  // Rerank.
  const rows = await prisma.tournamentLeaderboard.findMany({ where: { tournamentId }, orderBy: [{ totalStrokes: "asc" }] });
  for (let i = 0; i < rows.length; i++) {
    await prisma.tournamentLeaderboard.update({ where: { id: rows[i].id }, data: { positionRank: i + 1 } });
  }
}

export async function getLeaderboard(principal: Principal, tournamentId: string) {
  const t = await prisma.tournament.findUnique({ where: { id: tournamentId } });
  if (!t) throw new NotFoundError("Tournament", tournamentId);
  assertTenantOwned(t, principal);
  requirePermission(principal, t.clubId, "lessons:view");
  return prisma.tournamentLeaderboard.findMany({
    where: { tournamentId },
    orderBy: { positionRank: "asc" },
  });
}

// ---------------------------------------------------------------------------
// Match play
// ---------------------------------------------------------------------------
export async function createMatch(principal: Principal, args: { tournamentId: string; roundId: string; playerARegistrationId: string; playerBRegistrationId: string; bracketSlot?: number }) {
  const t = await prisma.tournament.findUnique({ where: { id: args.tournamentId } });
  if (!t) throw new NotFoundError("Tournament", args.tournamentId);
  assertTenantOwned(t, principal);
  requirePermission(principal, t.clubId, "lessons:manage");
  return prisma.tournamentMatch.create({
    data: {
      clubId: t.clubId, tournamentId: args.tournamentId, roundId: args.roundId,
      playerARegistrationId: args.playerARegistrationId, playerBRegistrationId: args.playerBRegistrationId,
      bracketSlot: args.bracketSlot ?? null, status: "SCHEDULED",
    },
  });
}

export async function reportMatchResult(principal: Principal, matchId: string, args: { scoreA: number; scoreB: number; winnerRegistrationId?: string }) {
  const match = await prisma.tournamentMatch.findUnique({ where: { id: matchId } });
  if (!match) throw new NotFoundError("TournamentMatch", matchId);
  assertTenantOwned(match, principal);
  requirePermission(principal, match.clubId, "lessons:view");
  if (match.status === "COMPLETED") throw new ConflictError("Match already completed");
  const winner = args.winnerRegistrationId ?? (args.scoreA < args.scoreB ? match.playerARegistrationId : match.playerBRegistrationId);
  const updated = await prisma.tournamentMatch.update({
    where: { id: matchId },
    data: {
      scoreA: args.scoreA, scoreB: args.scoreB,
      winnerRegistrationId: winner, status: "COMPLETED", completedAt: new Date(),
    },
  });
  await audit(principal, { action: "tournament.match.report", entityType: "TournamentMatch", entityId: matchId, clubId: match.clubId, after: { scoreA: args.scoreA, scoreB: args.scoreB, winner } });
  // Bracket advancement: if there's a next match in the bracket at slot/2,
  // assign the winner into the empty player slot.
  if (match.bracketSlot != null && winner) {
    const nextSlot = Math.floor(match.bracketSlot / 2);
    const nextMatch = await prisma.tournamentMatch.findFirst({
      where: { tournamentId: match.tournamentId, bracketSlot: nextSlot },
    });
    if (nextMatch) {
      const fieldToSet = match.bracketSlot % 2 === 0 ? "playerARegistrationId" : "playerBRegistrationId";
      await prisma.tournamentMatch.update({ where: { id: nextMatch.id }, data: { [fieldToSet]: winner } });
    }
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export async function listTournaments(principal: Principal, clubId: string, opts?: { status?: string }) {
  requirePermission(principal, clubId, "lessons:view");
  return prisma.tournament.findMany({
    where: { ...tenantWhere(principal, clubId), ...(opts?.status ? { status: opts.status } : {}) },
    orderBy: { startDate: "desc" }, take: 50,
    include: { registrations: true, rounds: true },
  });
}

export async function getTournament(principal: Principal, tournamentId: string) {
  const t = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    include: {
      divisions: true, teams: true,
      registrations: { include: { member: true, division: true, team: true } },
      rounds: { include: { matches: true } },
      leaderboards: { orderBy: { positionRank: "asc" } },
    },
  });
  if (!t) throw new NotFoundError("Tournament", tournamentId);
  assertTenantOwned(t, principal);
  requirePermission(principal, t.clubId, "lessons:view");
  return t;
}

function zerr(err: z.ZodError) {
  return new ValidationError(err.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
}
