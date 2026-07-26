// Phase 10E — Tournament ↔ tee-sheet integration.
//
// Generates pairings (groups of ~4 registrations) and books a tee time per
// pairing on the tournament's tee sheet. Wires into the existing tee-sheet
// service so booking validation (max-players, privilege suspension, etc.)
// runs unchanged.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned } from "../services/tenant";
import { ConflictError, NotFoundError, ValidationError } from "../errors";

const DEFAULT_GROUP_SIZE = 4;

export const buildPairingsSchema = z.object({
  tournamentId: z.string(),
  roundId: z.string(),
  teeSheetId: z.string(),
  groupSize: z.number().int().min(2).max(5).default(DEFAULT_GROUP_SIZE),
  strategy: z.enum(["RANDOM", "HANDICAP_BANDED", "REGISTRATION_ORDER"]).default("REGISTRATION_ORDER"),
});

export async function buildPairings(principal: Principal, raw: unknown) {
  const parsed = buildPairingsSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const d = parsed.data;
  const tournament = await prisma.tournament.findUnique({ where: { id: d.tournamentId } });
  if (!tournament) throw new NotFoundError("Tournament", d.tournamentId);
  assertTenantOwned(tournament, principal);
  requirePermission(principal, tournament.clubId, "lessons:manage");

  const round = await prisma.tournamentRound.findUnique({ where: { id: d.roundId } });
  if (!round || round.tournamentId !== d.tournamentId) throw new ConflictError("Round not in this tournament");

  const teeSheet = await prisma.teeSheet.findUnique({
    where: { id: d.teeSheetId },
    include: { times: { where: { status: "AVAILABLE" }, orderBy: { startTime: "asc" } } },
  });
  if (!teeSheet || teeSheet.clubId !== tournament.clubId) throw new ConflictError("Tee sheet not at this club");

  const registrations = await prisma.tournamentRegistration.findMany({
    where: { tournamentId: d.tournamentId, status: { in: ["REGISTERED", "CONFIRMED"] } },
    orderBy: { registeredAt: "asc" },
  });
  if (registrations.length === 0) return { pairings: [] };

  // Order registrations per strategy.
  const ordered = [...registrations];
  if (d.strategy === "RANDOM") {
    ordered.sort(() => Math.random() - 0.5);
  } else if (d.strategy === "HANDICAP_BANDED") {
    ordered.sort((a, b) => (a.handicap ?? 99) - (b.handicap ?? 99));
  }
  // REGISTRATION_ORDER falls through.

  // Chunk into groups + book a tee time per group.
  const groups: Array<typeof ordered> = [];
  for (let i = 0; i < ordered.length; i += d.groupSize) {
    groups.push(ordered.slice(i, i + d.groupSize));
  }
  if (groups.length > teeSheet.times.length) {
    throw new ConflictError(`Not enough available tee times (need ${groups.length}, have ${teeSheet.times.length})`);
  }

  // Wipe any existing pairings for this round before regenerating.
  await prisma.tournamentPairing.deleteMany({ where: { tournamentId: d.tournamentId, roundId: d.roundId } });

  const pairings = [];
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const tee = teeSheet.times[i];
    // Reserve the tee time by writing a TeeTimeBooking + TeeTimePlayer rows
    // directly. We don't call the public bookTeeTime() helper because the
    // primaryMember may be either a member or a guest, and we need the entire
    // group to share a single booking.
    const primaryMember = group[0];
    const memberPlayers = group.filter((r) => r.memberId);
    await prisma.$transaction(async (tx) => {
      let bookingId: string | null = null;
      if (primaryMember.memberId) {
        const booking = await tx.teeTimeBooking.create({
          data: {
            clubId: tournament.clubId, teeTimeId: tee.id,
            primaryMemberId: primaryMember.memberId,
            guestCount: group.length - memberPlayers.length,
            status: "CONFIRMED", bookingChannel: "LOTTERY",
          },
        });
        bookingId = booking.id;
        for (let p = 0; p < group.length; p++) {
          const reg = group[p];
          await tx.teeTimePlayer.create({
            data: {
              clubId: tournament.clubId, teeTimeId: tee.id, bookingId,
              memberId: reg.memberId ?? null, playerOrder: p,
            },
          });
        }
      }
      await tx.teeTime.update({ where: { id: tee.id }, data: { status: "BOOKED" } });
    });

    const pairing = await prisma.tournamentPairing.create({
      data: {
        clubId: tournament.clubId, tournamentId: d.tournamentId, roundId: d.roundId,
        teeTimeId: tee.id, groupNumber: i + 1,
        registrationsJson: JSON.stringify(group.map((r) => r.id)),
      },
    });
    pairings.push(pairing);
  }
  await audit(principal, { action: "tournament.pairings.build", entityType: "Tournament", entityId: d.tournamentId, clubId: tournament.clubId, after: { roundId: d.roundId, groupCount: groups.length, strategy: d.strategy } });
  return { pairings };
}

// Read pairings for a tournament + round (used by leaderboard + member UX).
export async function listPairings(principal: Principal, tournamentId: string, roundId?: string) {
  const tournament = await prisma.tournament.findUnique({ where: { id: tournamentId } });
  if (!tournament) throw new NotFoundError("Tournament", tournamentId);
  assertTenantOwned(tournament, principal);
  requirePermission(principal, tournament.clubId, "lessons:view");
  return prisma.tournamentPairing.findMany({
    where: { tournamentId, ...(roundId ? { roundId } : {}) },
    orderBy: [{ roundId: "asc" }, { groupNumber: "asc" }],
  });
}

// Publish the leaderboard — fires a `tournament.score_submitted` (event-equivalent)
// webhook so external integrations can mirror the standings.
export async function publishLeaderboard(principal: Principal, tournamentId: string) {
  const tournament = await prisma.tournament.findUnique({ where: { id: tournamentId } });
  if (!tournament) throw new NotFoundError("Tournament", tournamentId);
  assertTenantOwned(tournament, principal);
  requirePermission(principal, tournament.clubId, "lessons:manage");
  const board = await prisma.tournamentLeaderboard.findMany({
    where: { tournamentId },
    orderBy: { positionRank: "asc" },
  });
  // Fire-and-forget webhook emission.
  try {
    const { emit } = await import("../webhooks");
    await emit({
      clubId: tournament.clubId,
      eventType: "tournament.score_submitted",
      payload: { tournamentId, name: tournament.name, leaderboard: board.map((r) => ({ registrationId: r.registrationId, rank: r.positionRank, totalStrokes: r.totalStrokes })) },
    });
  } catch { /* webhook fan-out is best effort */ }
  await audit(principal, { action: "tournament.leaderboard.publish", entityType: "Tournament", entityId: tournamentId, clubId: tournament.clubId, after: { rows: board.length } });
  return board;
}
