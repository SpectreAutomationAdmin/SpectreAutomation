// Phase 8C — Tee-sheet engine.
//
// Core flow:
//   1. Admin creates a Course (with CourseHoles) and configures booking
//      windows / restrictions via ClubSetting scope=TEE_SHEET.
//   2. generateTeeSheet(date) creates a TeeSheet + TeeTime rows for the
//      day (e.g. every 10 minutes from 7am-5pm).
//   3. Members bookTeeTime() or enter lotteries.
//   4. Lottery draws (drawLottery) assign winners to tee times.
//   5. Cancellations + waitlist promotion.
//
// AR integration hooks: guest fees + no-show charges call the AR service
// via createCharge() (no direct balance mutation).

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned, tenantWhere } from "../services/tenant";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { getSetting } from "../enterprise/settings";

// ---------------------------------------------------------------------------
// Course CRUD
// ---------------------------------------------------------------------------
export const courseSchema = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(120),
  holes: z.number().int().min(1).max(36).default(18),
  parTotal: z.number().int().min(40).max(108).default(72),
  description: z.string().trim().max(2000).optional().nullable(),
});

export async function upsertCourse(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "lessons:manage"); // reuse lessons:manage as the tee-sheet write gate
  const parsed = courseSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;
  const course = await prisma.course.upsert({
    where: { clubId_code: { clubId, code: d.code } },
    update: { name: d.name, holes: d.holes, parTotal: d.parTotal, description: d.description ?? null },
    create: { clubId, code: d.code, name: d.name, holes: d.holes, parTotal: d.parTotal, description: d.description ?? null },
  });
  await audit(principal, { action: "teesheet.course.upsert", entityType: "Course", entityId: course.id, clubId, after: { code: d.code } });
  return course;
}

// ---------------------------------------------------------------------------
// Tee-sheet generation
// ---------------------------------------------------------------------------
export const generateSchema = z.object({
  courseCode: z.string(),
  sheetDate: z.string().or(z.date()),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  intervalMinutes: z.number().int().min(5).max(60).default(10),
  maxPlayers: z.number().int().min(1).max(8).default(4),
  startingTees: z.array(z.number().int().min(1).max(2)).default([1]),
  bookingOpensAt: z.string().or(z.date()).optional().nullable(),
  bookingClosesAt: z.string().or(z.date()).optional().nullable(),
});

export async function generateTeeSheet(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "lessons:manage");
  const parsed = generateSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;
  const course = await prisma.course.findUnique({ where: { clubId_code: { clubId, code: d.courseCode } } });
  if (!course) throw new NotFoundError("Course", d.courseCode);

  const sheetDate = new Date(d.sheetDate);
  sheetDate.setUTCHours(0, 0, 0, 0);

  const sheet = await prisma.teeSheet.upsert({
    where: { clubId_courseId_sheetDate: { clubId, courseId: course.id, sheetDate } },
    update: {
      bookingOpensAt: d.bookingOpensAt ? new Date(d.bookingOpensAt) : null,
      bookingClosesAt: d.bookingClosesAt ? new Date(d.bookingClosesAt) : null,
    },
    create: {
      clubId, courseId: course.id, sheetDate, status: "OPEN",
      bookingOpensAt: d.bookingOpensAt ? new Date(d.bookingOpensAt) : null,
      bookingClosesAt: d.bookingClosesAt ? new Date(d.bookingClosesAt) : null,
    },
  });

  const [startH, startM] = d.startTime.split(":").map(Number);
  const [endH, endM] = d.endTime.split(":").map(Number);
  const startMin = startH * 60 + startM;
  const endMin = endH * 60 + endM;

  let created = 0;
  for (let minutes = startMin; minutes < endMin; minutes += d.intervalMinutes) {
    const t = new Date(sheetDate);
    t.setUTCHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    for (const tee of d.startingTees) {
      const existing = await prisma.teeTime.findUnique({
        where: { teeSheetId_startTime_startingTee: { teeSheetId: sheet.id, startTime: t, startingTee: tee } },
      });
      if (existing) continue;
      await prisma.teeTime.create({
        data: {
          clubId, teeSheetId: sheet.id, startTime: t, startingTee: tee,
          intervalMinutes: d.intervalMinutes, maxPlayers: d.maxPlayers,
          status: "AVAILABLE",
        },
      });
      created++;
    }
  }
  await audit(principal, { action: "teesheet.generate", entityType: "TeeSheet", entityId: sheet.id, clubId, after: { sheetDate: sheetDate.toISOString(), created } });
  return { sheet, created };
}

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------
export const bookingSchema = z.object({
  teeTimeId: z.string(),
  primaryMemberId: z.string(),
  guestCount: z.number().int().min(0).max(4).default(0),
  cartRequested: z.number().int().min(0).max(4).default(0),
  guests: z.array(z.object({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
    email: z.string().email().optional().nullable(),
  })).default([]),
  additionalPlayers: z.array(z.object({
    memberId: z.string(),
  })).default([]),
});

export async function bookTeeTime(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "lessons:view"); // members + staff can book; we re-check below
  const parsed = bookingSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;

  const teeTime = await prisma.teeTime.findUnique({
    where: { id: d.teeTimeId },
    include: { teeSheet: true, bookings: { where: { status: "CONFIRMED" } }, players: true },
  });
  if (!teeTime) throw new NotFoundError("TeeTime", d.teeTimeId);
  if (teeTime.clubId !== clubId) throw new ConflictError("Cross-club tee time");
  if (teeTime.teeSheet.status !== "OPEN" || teeTime.status !== "AVAILABLE") {
    throw new ConflictError(`Tee time is ${teeTime.status} on ${teeTime.teeSheet.status} sheet`);
  }

  // Booking window check.
  const now = new Date();
  if (teeTime.teeSheet.bookingOpensAt && now < teeTime.teeSheet.bookingOpensAt) {
    throw new ConflictError(`Booking opens at ${teeTime.teeSheet.bookingOpensAt.toISOString()}`);
  }
  if (teeTime.teeSheet.bookingClosesAt && now > teeTime.teeSheet.bookingClosesAt) {
    throw new ConflictError(`Booking closed at ${teeTime.teeSheet.bookingClosesAt.toISOString()}`);
  }

  const member = await prisma.member.findUnique({ where: { id: d.primaryMemberId } });
  if (!member || member.clubId !== clubId) throw new ConflictError("Primary member not at this club");
  // Privilege suspension check.
  if (member.accessStatus === "TEE_SUSPENDED" || member.accessStatus === "FULL_SUSPENDED") {
    throw new ConflictError("Member tee-sheet privileges are suspended");
  }
  // Configurable max-guests-per-member via ClubSetting.
  const maxGuests = (await getSetting<number>(clubId, "TEE_SHEET", "max_guests_per_booking")) ?? 3;
  if (d.guestCount > maxGuests) {
    throw new ConflictError(`Guest count exceeds club max (${maxGuests})`);
  }

  const totalPlayers = 1 + d.additionalPlayers.length + d.guestCount;
  if (totalPlayers > teeTime.maxPlayers) {
    throw new ConflictError(`Group size ${totalPlayers} exceeds tee-time max ${teeTime.maxPlayers}`);
  }

  // Atomically book the tee time.
  return prisma.$transaction(async (tx) => {
    const booking = await tx.teeTimeBooking.create({
      data: {
        clubId, teeTimeId: teeTime.id,
        primaryMemberId: d.primaryMemberId,
        guestCount: d.guestCount, cartRequested: d.cartRequested,
        status: "CONFIRMED", bookingChannel: "MEMBER_PORTAL",
      },
    });
    // Primary player.
    await tx.teeTimePlayer.create({
      data: { clubId, teeTimeId: teeTime.id, bookingId: booking.id, memberId: d.primaryMemberId, playerOrder: 0 },
    });
    // Additional member players.
    for (let i = 0; i < d.additionalPlayers.length; i++) {
      await tx.teeTimePlayer.create({
        data: { clubId, teeTimeId: teeTime.id, bookingId: booking.id, memberId: d.additionalPlayers[i].memberId, playerOrder: i + 1 },
      });
    }
    // Guests.
    for (let i = 0; i < d.guests.length; i++) {
      const g = d.guests[i];
      const guest = await tx.teeTimeGuest.create({
        data: { clubId, bookingId: booking.id, firstName: g.firstName, lastName: g.lastName, email: g.email ?? null },
      });
      await tx.teeTimePlayer.create({
        data: { clubId, teeTimeId: teeTime.id, bookingId: booking.id, guestId: guest.id, playerOrder: d.additionalPlayers.length + 1 + i },
      });
    }
    await tx.teeTime.update({ where: { id: teeTime.id }, data: { status: "BOOKED" } });
    return booking;
  }).then(async (booking) => {
    await audit(principal, { action: "teesheet.book", entityType: "TeeTimeBooking", entityId: booking.id, clubId, after: { teeTimeId: teeTime.id, guestCount: d.guestCount } });
    return booking;
  });
}

export async function cancelBooking(principal: Principal, bookingId: string, reason?: string) {
  const booking = await prisma.teeTimeBooking.findUnique({ where: { id: bookingId }, include: { teeTime: true } });
  if (!booking) throw new NotFoundError("TeeTimeBooking", bookingId);
  assertTenantOwned(booking, principal);
  if (booking.status === "CANCELLED") return booking;
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.teeTimeBooking.update({
      where: { id: bookingId },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: reason ?? null },
    });
    // If no other CONFIRMED bookings remain, free the tee time.
    const remaining = await tx.teeTimeBooking.count({ where: { teeTimeId: booking.teeTimeId, status: "CONFIRMED" } });
    if (remaining === 0) {
      await tx.teeTime.update({ where: { id: booking.teeTimeId }, data: { status: "AVAILABLE" } });
    }
    return result;
  });
  await audit(principal, { action: "teesheet.cancel", entityType: "TeeTimeBooking", entityId: bookingId, clubId: booking.clubId, after: { status: "CANCELLED", reason } });
  return updated;
}

// ---------------------------------------------------------------------------
// Lottery
// ---------------------------------------------------------------------------
export const lotterySchema = z.object({
  teeSheetId: z.string(),
  name: z.string().trim().min(1).max(160),
  opensAt: z.string().or(z.date()),
  closesAt: z.string().or(z.date()),
  drawAt: z.string().or(z.date()),
  strategy: z.enum(["RANDOM", "PRIORITY_TENURE"]).default("RANDOM"),
});

export async function createLottery(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "lessons:manage");
  const parsed = lotterySchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;
  const sheet = await prisma.teeSheet.findUnique({ where: { id: d.teeSheetId } });
  if (!sheet || sheet.clubId !== clubId) throw new NotFoundError("TeeSheet", d.teeSheetId);
  const lottery = await prisma.teeLottery.create({
    data: {
      clubId, teeSheetId: d.teeSheetId, name: d.name,
      opensAt: new Date(d.opensAt), closesAt: new Date(d.closesAt), drawAt: new Date(d.drawAt),
      strategy: d.strategy, status: "OPEN",
    },
  });
  await audit(principal, { action: "teesheet.lottery.create", entityType: "TeeLottery", entityId: lottery.id, clubId, after: { name: d.name } });
  return lottery;
}

export async function enterLottery(principal: Principal, args: { lotteryId: string; memberId: string; preferredWindow?: string; groupSize?: number; priorityScore?: number }) {
  const lottery = await prisma.teeLottery.findUnique({ where: { id: args.lotteryId } });
  if (!lottery) throw new NotFoundError("TeeLottery", args.lotteryId);
  assertTenantOwned(lottery, principal);
  if (lottery.status !== "OPEN") throw new ConflictError(`Lottery is ${lottery.status}`);
  const member = await prisma.member.findUnique({ where: { id: args.memberId } });
  if (!member || member.clubId !== lottery.clubId) throw new ConflictError("Member not at this club");
  // Tee-suspension check.
  if (member.accessStatus === "TEE_SUSPENDED" || member.accessStatus === "FULL_SUSPENDED") {
    throw new ConflictError("Member tee-sheet privileges are suspended");
  }
  // Upsert so duplicate entries don't error.
  const entry = await prisma.teeLotteryEntry.upsert({
    where: { lotteryId_memberId: { lotteryId: args.lotteryId, memberId: args.memberId } },
    update: { preferredWindow: args.preferredWindow ?? null, groupSize: args.groupSize ?? 1, priorityScore: args.priorityScore ?? 0 },
    create: {
      clubId: lottery.clubId, lotteryId: args.lotteryId, memberId: args.memberId,
      preferredWindow: args.preferredWindow ?? null, groupSize: args.groupSize ?? 1, priorityScore: args.priorityScore ?? 0,
      status: "PENDING",
    },
  });
  return entry;
}

export async function drawLottery(principal: Principal, lotteryId: string) {
  const lottery = await prisma.teeLottery.findUnique({
    where: { id: lotteryId },
    include: { entries: { where: { status: "PENDING" } }, teeSheet: { include: { times: { where: { status: "AVAILABLE" }, orderBy: { startTime: "asc" } } } } },
  });
  if (!lottery) throw new NotFoundError("TeeLottery", lotteryId);
  assertTenantOwned(lottery, principal);
  requirePermission(principal, lottery.clubId, "lessons:manage");
  if (lottery.status !== "OPEN") throw new ConflictError(`Lottery is ${lottery.status}`);

  await prisma.teeLottery.update({ where: { id: lotteryId }, data: { status: "DRAWING" } });

  // Order entries by strategy.
  const entries = [...lottery.entries].sort((a, b) => {
    if (lottery.strategy === "PRIORITY_TENURE") return b.priorityScore - a.priorityScore;
    // RANDOM: stable shuffle.
    return Math.random() - 0.5;
  });

  // Available tee times in order.
  const available = [...lottery.teeSheet.times];

  let assigned = 0;
  for (const entry of entries) {
    if (available.length === 0) break;
    const tee = available.shift()!;
    // Create a CONFIRMED booking on behalf of the member.
    await prisma.$transaction(async (tx) => {
      const booking = await tx.teeTimeBooking.create({
        data: {
          clubId: lottery.clubId, teeTimeId: tee.id,
          primaryMemberId: entry.memberId, guestCount: Math.max(0, entry.groupSize - 1),
          status: "CONFIRMED", bookingChannel: "LOTTERY",
        },
      });
      await tx.teeTimePlayer.create({
        data: { clubId: lottery.clubId, teeTimeId: tee.id, bookingId: booking.id, memberId: entry.memberId, playerOrder: 0 },
      });
      await tx.teeTime.update({ where: { id: tee.id }, data: { status: "BOOKED" } });
      await tx.teeLotteryEntry.update({
        where: { id: entry.id },
        data: { status: "ASSIGNED", assignedTeeTimeId: tee.id },
      });
    });
    assigned++;
  }

  const updated = await prisma.teeLottery.update({
    where: { id: lotteryId },
    data: { status: "DRAWN", drawnAt: new Date() },
  });
  await audit(principal, { action: "teesheet.lottery.draw", entityType: "TeeLottery", entityId: lotteryId, clubId: lottery.clubId, after: { assigned, total: entries.length } });
  return { lottery: updated, assigned };
}

// ---------------------------------------------------------------------------
// Suspend / restore tee privileges
// ---------------------------------------------------------------------------
export async function suspendTeePrivileges(principal: Principal, memberId: string, reason?: string) {
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  if (!member) throw new NotFoundError("Member", memberId);
  requirePermission(principal, member.clubId, "members:suspend");
  await prisma.member.update({ where: { id: memberId }, data: { accessStatus: "TEE_SUSPENDED" } });
  await audit(principal, { action: "teesheet.suspend", entityType: "Member", entityId: memberId, clubId: member.clubId, after: { accessStatus: "TEE_SUSPENDED", reason } });
}

export async function restoreTeePrivileges(principal: Principal, memberId: string) {
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  if (!member) throw new NotFoundError("Member", memberId);
  requirePermission(principal, member.clubId, "members:suspend");
  await prisma.member.update({ where: { id: memberId }, data: { accessStatus: "FULL_ACCESS" } });
  await audit(principal, { action: "teesheet.restore", entityType: "Member", entityId: memberId, clubId: member.clubId, after: { accessStatus: "FULL_ACCESS" } });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export async function listTeeSheets(principal: Principal, clubId: string, opts?: { from?: Date; to?: Date }) {
  requirePermission(principal, clubId, "lessons:view");
  return prisma.teeSheet.findMany({
    where: {
      ...tenantWhere(principal, clubId),
      ...(opts?.from || opts?.to
        ? { sheetDate: { ...(opts?.from ? { gte: opts.from } : {}), ...(opts?.to ? { lte: opts.to } : {}) } }
        : {}),
    },
    include: { course: true, times: { include: { bookings: { where: { status: "CONFIRMED" } }, players: true } } },
    orderBy: { sheetDate: "asc" },
  });
}

export async function listBookingsForMember(principal: Principal, clubId: string, memberId: string) {
  requirePermission(principal, clubId, "lessons:view");
  return prisma.teeTimeBooking.findMany({
    where: { clubId, primaryMemberId: memberId },
    include: { teeTime: { include: { teeSheet: { include: { course: true } } } } },
    orderBy: { bookedAt: "desc" },
    take: 50,
  });
}

function zerr(err: z.ZodError) {
  return new ValidationError(err.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
}
