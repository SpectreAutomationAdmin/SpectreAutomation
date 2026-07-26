// Lesson booking + Pro payable service.
//
// Workflow (solves the "honour system" issue):
//   1. createBooking         - Member books with an instructor at a scheduled time.
//   2. instructorConfirm     - Instructor marks lesson complete (no money moves yet).
//   3. headProApprove        - Head Pro approves → member is charged + payable accrues.
//
// On approval we run two ledger writes via the adapter:
//   - Charge member's AR    : DR AR (1110) / CR Lesson Revenue (4400)
//   - Accrue instructor pay : DR Lesson Instructor Cost / CR Accrued Lesson Payable (2060)

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { tenantWhere, assertTenantOwned } from "../services/tenant";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { toMoney } from "../accounting/decimal";
import { createPostedFromAdapter } from "../accounting/journal";

const DEFAULT_AR_CONTROL = "1110";
const DEFAULT_LESSON_PAYABLE = "2060";

async function nextBookingNumber(clubId: string): Promise<string> {
  const year = new Date().getFullYear();
  const count = await prisma.lessonBooking.count({ where: { clubId, createdAt: { gte: new Date(year, 0, 1) } } });
  return `LSN-${year}-${(count + 1).toString().padStart(5, "0")}`;
}

export const lessonTypeSchema = z.object({
  key: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(200),
  durationMinutes: z.number().int().min(15).max(480).default(60),
  memberPrice: z.number().nonnegative().default(0),
  instructorPayPerLesson: z.number().nonnegative().default(0),
  revenueAccountNumber: z.string().optional().nullable(),
  instructorExpenseAccountNumber: z.string().optional().nullable(),
  isGroup: z.boolean().default(false),
});

export async function createLessonType(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "lessons:manage");
  const parsed = lessonTypeSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;
  const revenue = d.revenueAccountNumber ? await prisma.account.findFirst({ where: { clubId, accountNumber: d.revenueAccountNumber } }) : null;
  const expense = d.instructorExpenseAccountNumber ? await prisma.account.findFirst({ where: { clubId, accountNumber: d.instructorExpenseAccountNumber } }) : null;
  return prisma.lessonType.create({
    data: {
      clubId, key: d.key, name: d.name,
      durationMinutes: d.durationMinutes,
      memberPrice: d.memberPrice,
      instructorPayPerLesson: d.instructorPayPerLesson,
      revenueAccountId: revenue?.id ?? null,
      instructorExpenseAccountId: expense?.id ?? null,
      isGroup: d.isGroup,
    },
  });
}

export const bookingSchema = z.object({
  memberId: z.string(),
  lessonTypeId: z.string(),
  instructorId: z.string(),
  scheduledAt: z.string().or(z.date()),
  durationMinutes: z.number().int().min(15).max(480).optional(),
  notes: z.string().trim().max(1000).optional().nullable(),
});

export async function createBooking(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "lessons:manage");
  const parsed = bookingSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;
  const lessonType = await prisma.lessonType.findUnique({ where: { id: d.lessonTypeId } });
  if (!lessonType || lessonType.clubId !== clubId) throw new NotFoundError("LessonType", d.lessonTypeId);
  const instructor = await prisma.golfProfessional.findUnique({ where: { id: d.instructorId } });
  if (!instructor || instructor.clubId !== clubId) throw new NotFoundError("GolfProfessional", d.instructorId);
  const member = await prisma.member.findUnique({ where: { id: d.memberId } });
  if (!member || member.clubId !== clubId) throw new NotFoundError("Member", d.memberId);

  const bookingNumber = await nextBookingNumber(clubId);
  const booking = await prisma.lessonBooking.create({
    data: {
      clubId, bookingNumber,
      memberId: d.memberId,
      lessonTypeId: d.lessonTypeId,
      instructorId: d.instructorId,
      scheduledAt: new Date(d.scheduledAt),
      durationMinutes: d.durationMinutes ?? lessonType.durationMinutes,
      status: "SCHEDULED",
      notes: d.notes ?? null,
      createdByUserId: principal.id,
    },
  });
  await audit(principal, { action: "lesson.booking.create", entityType: "LessonBooking", entityId: booking.id, clubId, after: { bookingNumber } });
  return booking;
}

export async function instructorConfirm(principal: Principal, bookingId: string) {
  const booking = await prisma.lessonBooking.findUnique({ where: { id: bookingId } });
  assertTenantOwned(booking, principal);
  requirePermission(principal, booking.clubId, "lessons:manage");
  if (booking.status === "INSTRUCTOR_CONFIRMED" || booking.status === "COMPLETED") return booking;
  if (booking.status !== "SCHEDULED") throw new ConflictError(`Lesson is ${booking.status}`);
  const updated = await prisma.lessonBooking.update({
    where: { id: bookingId },
    data: { status: "INSTRUCTOR_CONFIRMED", instructorConfirmedAt: new Date() },
  });
  await audit(principal, { action: "lesson.instructor_confirm", entityType: "LessonBooking", entityId: bookingId, clubId: booking.clubId, after: { status: "INSTRUCTOR_CONFIRMED" } });
  return updated;
}

// Head Pro approves: posts AR charge to member + accrues payable to instructor.
// This is the ONLY path that creates the LessonPayable row — solves the
// "honour system" issue.
export async function headProApprove(principal: Principal, bookingId: string) {
  const booking = await prisma.lessonBooking.findUnique({
    where: { id: bookingId },
    include: { member: { include: { account: true } }, lessonType: { include: { revenueAccount: true, instructorExpenseAccount: true } }, instructor: true },
  });
  assertTenantOwned(booking, principal);
  requirePermission(principal, booking.clubId, "lessons:approve");
  if (booking.status === "COMPLETED") return booking;
  if (booking.status !== "INSTRUCTOR_CONFIRMED") {
    throw new ConflictError("Booking must be INSTRUCTOR_CONFIRMED before Head Pro approval");
  }
  if (!booking.member.account) throw new ConflictError("Member has no AR account");

  const memberPrice = Number(booking.lessonType.memberPrice.toString());
  const instructorPay = Number(booking.lessonType.instructorPayPerLesson.toString());
  const revenueAccountNumber = booking.lessonType.revenueAccount?.accountNumber ?? "4400"; // Lesson Revenue
  const expenseAccountNumber = booking.lessonType.instructorExpenseAccount?.accountNumber ?? "6100"; // Pro Shop wages default

  const date = new Date();
  const charge = await prisma.charge.create({
    data: {
      clubId: booking.clubId,
      memberId: booking.memberId,
      accountId: booking.member.account.id,
      description: `Lesson · ${booking.lessonType.name} with ${booking.instructor.firstName} ${booking.instructor.lastName}`,
      category: "OTHER",
      amount: memberPrice,
      transactionDate: date,
      dueDate: date,
      status: "POSTED",
      postedByUserId: principal.id,
    },
  });

  // Member-side AR JE (separate from instructor accrual so each has its own audit/source).
  const arJournal = memberPrice > 0
    ? await createPostedFromAdapter(
        principal, booking.clubId,
        {
          entryDate: date,
          description: `Lesson charge · ${booking.bookingNumber} · ${booking.member.firstName} ${booking.member.lastName}`,
          lines: [
            { accountNumber: DEFAULT_AR_CONTROL, debit: memberPrice.toFixed(2), description: "Member AR", memberId: booking.memberId },
            { accountNumber: revenueAccountNumber, credit: memberPrice.toFixed(2), description: "Lesson revenue" },
          ],
        },
        { source: "RECURRING", sourceEntityType: "LessonBookingCharge", sourceEntityId: booking.id }
      )
    : null;

  // Instructor-side accrual JE.
  const accrualJournal = instructorPay > 0
    ? await createPostedFromAdapter(
        principal, booking.clubId,
        {
          entryDate: date,
          description: `Lesson payable accrual · ${booking.bookingNumber} · ${booking.instructor.firstName} ${booking.instructor.lastName}`,
          lines: [
            { accountNumber: expenseAccountNumber, debit: instructorPay.toFixed(2), description: "Instructor cost" },
            { accountNumber: DEFAULT_LESSON_PAYABLE, credit: instructorPay.toFixed(2), description: "Accrued payable" },
          ],
        },
        { source: "RECURRING", sourceEntityType: "LessonBookingAccrual", sourceEntityId: booking.id }
      )
    : null;

  if (instructorPay > 0) {
    await prisma.lessonPayable.create({
      data: {
        clubId: booking.clubId,
        bookingId: booking.id,
        instructorId: booking.instructorId,
        amount: instructorPay,
        status: "ACCRUED",
        createdByUserId: principal.id,
      },
    });
  }

  // Recompute member account.
  const { recomputeAccount } = await import("../services/ar");
  await recomputeAccount(booking.memberId);

  const updated = await prisma.lessonBooking.update({
    where: { id: bookingId },
    data: {
      status: "COMPLETED",
      completedAt: date,
      headProApprovedAt: date,
      headProApprovedByUserId: principal.id,
      memberChargeId: charge.id,
      accrualJournalEntryId: accrualJournal?.id ?? null,
    },
  });
  await audit(principal, { action: "lesson.head_pro_approve", entityType: "LessonBooking", entityId: bookingId, clubId: booking.clubId, after: { status: "COMPLETED", memberPrice, instructorPay, arJournalId: arJournal?.id, accrualJournalId: accrualJournal?.id } });
  return updated;
}

export async function cancelBooking(principal: Principal, bookingId: string, reason: string) {
  const booking = await prisma.lessonBooking.findUnique({ where: { id: bookingId } });
  assertTenantOwned(booking, principal);
  requirePermission(principal, booking.clubId, "lessons:manage");
  if (booking.status === "COMPLETED") {
    throw new ConflictError("Cannot cancel a completed lesson — use refund flow instead");
  }
  const updated = await prisma.lessonBooking.update({ where: { id: bookingId }, data: { status: "CANCELLED", cancellationReason: reason } });
  await audit(principal, { action: "lesson.cancel", entityType: "LessonBooking", entityId: bookingId, clubId: booking.clubId, before: { status: booking.status }, after: { status: "CANCELLED" }, meta: { reason } });
  return updated;
}

export async function listBookings(principal: Principal, clubId: string, opts?: { status?: string }) {
  return prisma.lessonBooking.findMany({
    where: { ...tenantWhere(principal, clubId), ...(opts?.status ? { status: opts.status } : {}) },
    include: { member: true, instructor: true, lessonType: true },
    orderBy: { scheduledAt: "desc" },
    take: 100,
  });
}

export async function listOutstandingPayables(principal: Principal, clubId: string) {
  return prisma.lessonPayable.findMany({
    where: { ...tenantWhere(principal, clubId), status: "ACCRUED" },
    include: { instructor: true, booking: true },
    orderBy: { accruedAt: "asc" },
  });
}

function zerr(err: z.ZodError) {
  return new ValidationError(err.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
}
void toMoney;
