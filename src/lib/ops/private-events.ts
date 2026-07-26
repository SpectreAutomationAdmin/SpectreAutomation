// Private events service.
//
// Booking lifecycle: INQUIRY → DRAFT → CONFIRMED → IN_PROGRESS → COMPLETED → (CANCELLED)
//
// Deposit recognition:
//   - Deposit received   : DR Cash (1010) / CR Private Event Deposits (2230)  [liability]
//   - Final billing      : DR 2230 + DR AR (1110) for any extra owed
//                          CR Event Revenue
//
// The "final billing" recognizes revenue at event-completion time and reverses
// the deposit liability. Member or non-member is handled the same way (AR is
// only DR'd if memberId is set; otherwise the deposit fully covers the bill).

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { tenantWhere, assertTenantOwned } from "../services/tenant";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { toMoney, sumMoney } from "../accounting/decimal";
import { createPostedFromAdapter } from "../accounting/journal";
import { findPeriodForDate } from "../accounting/periods";

const DEFAULT_DEPOSIT_LIABILITY = "2230";
const DEFAULT_BANK = "1010";
const DEFAULT_REVENUE = "4210"; // F&B Banquets/Events
const DEFAULT_AR_CONTROL = "1110";

// --- Inquiry ----------------------------------------------------------------
export const inquirySchema = z.object({
  inquirerName: z.string().trim().min(1).max(200),
  inquirerEmail: z.string().email().max(254).optional().or(z.literal("")).transform((v) => v && v.length ? v.toLowerCase() : null),
  inquirerPhone: z.string().trim().max(40).optional().or(z.literal("")).transform((v) => v && v.length ? v : null),
  preferredDate: z.string().optional(),
  headCount: z.number().int().positive().optional(),
  message: z.string().trim().max(4000).optional().or(z.literal("")).transform((v) => v && v.length ? v : null),
});

export async function createInquiry(clubId: string, raw: unknown) {
  const parsed = inquirySchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const inquiry = await prisma.privateEventInquiry.create({
    data: {
      clubId,
      inquirerName: parsed.data.inquirerName,
      inquirerEmail: parsed.data.inquirerEmail,
      inquirerPhone: parsed.data.inquirerPhone,
      preferredDate: parsed.data.preferredDate ? new Date(parsed.data.preferredDate) : null,
      headCount: parsed.data.headCount ?? null,
      message: parsed.data.message,
      status: "NEW",
    },
  });
  await audit(null, { action: "private_event.inquiry.create", entityType: "PrivateEventInquiry", entityId: inquiry.id, clubId, after: inquiry });
  return inquiry;
}

// --- Booking ----------------------------------------------------------------
async function nextBookingNumber(clubId: string): Promise<string> {
  const year = new Date().getFullYear();
  const count = await prisma.privateEventBooking.count({ where: { clubId, createdAt: { gte: new Date(year, 0, 1) } } });
  return `PE-${year}-${(count + 1).toString().padStart(4, "0")}`;
}

export const bookingCreateSchema = z.object({
  inquiryId: z.string().optional().nullable(),
  memberId: z.string().optional().nullable(),
  customerName: z.string().trim().min(1).max(200),
  customerEmail: z.string().email().max(254).optional().or(z.literal("")).transform((v) => v && v.length ? v.toLowerCase() : null),
  customerPhone: z.string().trim().max(40).optional().or(z.literal("")).transform((v) => v && v.length ? v : null),
  eventName: z.string().trim().min(1).max(200),
  eventStart: z.string().or(z.date()),
  eventEnd: z.string().or(z.date()),
  headCount: z.number().int().nonnegative().default(0),
  depositAmount: z.number().nonnegative().default(0),
  totalAmount: z.number().nonnegative().default(0),
  notes: z.string().trim().max(4000).optional().or(z.literal("")).transform((v) => v && v.length ? v : null),
});

export async function createBooking(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "events:private:manage");
  const parsed = bookingCreateSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;
  const revenueAccount = await prisma.account.findFirst({ where: { clubId, accountNumber: DEFAULT_REVENUE } });
  const deferredAccount = await prisma.account.findFirst({ where: { clubId, accountNumber: DEFAULT_DEPOSIT_LIABILITY } });
  const bookingNumber = await nextBookingNumber(clubId);
  const booking = await prisma.privateEventBooking.create({
    data: {
      clubId,
      bookingNumber,
      inquiryId: d.inquiryId ?? null,
      memberId: d.memberId ?? null,
      customerName: d.customerName,
      customerEmail: d.customerEmail,
      customerPhone: d.customerPhone,
      eventName: d.eventName,
      eventStart: new Date(d.eventStart),
      eventEnd: new Date(d.eventEnd),
      headCount: d.headCount,
      depositAmount: d.depositAmount,
      totalAmount: d.totalAmount,
      notes: d.notes,
      revenueAccountId: revenueAccount?.id ?? null,
      deferredRevenueAccountId: deferredAccount?.id ?? null,
      status: "DRAFT",
      createdByUserId: principal.id,
    },
  });
  await audit(principal, { action: "private_event.booking.create", entityType: "PrivateEventBooking", entityId: booking.id, clubId, after: { bookingNumber } });
  return booking;
}

export async function confirmBooking(principal: Principal, bookingId: string) {
  const booking = await prisma.privateEventBooking.findUnique({ where: { id: bookingId } });
  assertTenantOwned(booking, principal);
  requirePermission(principal, booking.clubId, "events:private:manage");
  if (booking.status !== "DRAFT") throw new ConflictError(`Booking is ${booking.status}`);
  const updated = await prisma.privateEventBooking.update({ where: { id: bookingId }, data: { status: "CONFIRMED" } });
  await audit(principal, { action: "private_event.booking.confirm", entityType: "PrivateEventBooking", entityId: bookingId, clubId: booking.clubId, before: { status: "DRAFT" }, after: { status: "CONFIRMED" } });
  return updated;
}

// --- Deposit posting --------------------------------------------------------
export const depositSchema = z.object({
  amount: z.number().positive(),
  method: z.enum(["EFT", "CC", "CHEQUE", "CASH", "OTHER"]).default("EFT"),
  receivedDate: z.string().or(z.date()).optional(),
});

// Records a deposit + posts: DR Cash / CR Private Event Deposits (liability).
export async function postDeposit(principal: Principal, bookingId: string, raw: unknown) {
  const booking = await prisma.privateEventBooking.findUnique({ where: { id: bookingId } });
  assertTenantOwned(booking, principal);
  requirePermission(principal, booking.clubId, "events:private:manage");
  const parsed = depositSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;
  const receivedDate = d.receivedDate ? new Date(d.receivedDate) : new Date();
  if (!(await findPeriodForDate(booking.clubId, receivedDate))) {
    throw new ConflictError("No fiscal period for deposit date");
  }
  const journal = await createPostedFromAdapter(
    principal, booking.clubId,
    {
      entryDate: receivedDate,
      description: `Private event deposit · ${booking.bookingNumber} · ${booking.eventName}`,
      lines: [
        { accountNumber: DEFAULT_BANK, debit: d.amount.toFixed(2), description: "Deposit received" },
        { accountNumber: DEFAULT_DEPOSIT_LIABILITY, credit: d.amount.toFixed(2), description: "Deferred" },
      ],
    },
    { source: "RECURRING", sourceEntityType: "PrivateEventDeposit", sourceEntityId: `${bookingId}:deposit:${Date.now()}` }
  );
  const deposit = await prisma.privateEventDeposit.create({
    data: {
      clubId: booking.clubId, bookingId, amount: d.amount,
      method: d.method, receivedDate, status: "RECEIVED",
      postedJournalEntryId: journal.id, createdByUserId: principal.id,
    },
  });
  await prisma.privateEventBooking.update({
    where: { id: bookingId },
    data: { depositPaidAmount: { increment: d.amount } },
  });
  await audit(principal, { action: "private_event.deposit.post", entityType: "PrivateEventDeposit", entityId: deposit.id, clubId: booking.clubId, after: { amount: d.amount, journalEntryId: journal.id } });
  return deposit;
}

// --- Final billing ---------------------------------------------------------
// Recognises revenue and clears the deposit liability. If the booking has a
// memberId, any remaining balance lands on the member AR control (1110);
// otherwise it must be zero — the deposit must fully cover the bill.
export async function postFinalBilling(principal: Principal, bookingId: string) {
  const booking = await prisma.privateEventBooking.findUnique({ where: { id: bookingId } });
  assertTenantOwned(booking, principal);
  requirePermission(principal, booking.clubId, "events:private:manage");
  if (booking.status === "COMPLETED") return booking;
  if (booking.status !== "CONFIRMED" && booking.status !== "IN_PROGRESS") {
    throw new ConflictError(`Booking is ${booking.status} — only CONFIRMED/IN_PROGRESS bookings can be billed`);
  }
  const total = Number(booking.totalAmount.toString());
  const depositPaid = Number(booking.depositPaidAmount.toString());
  if (total <= 0) throw new ConflictError("Booking total must be positive");

  const remaining = Math.round((total - depositPaid) * 100) / 100;
  const date = new Date();
  if (!(await findPeriodForDate(booking.clubId, date))) {
    throw new ConflictError("No fiscal period for billing date");
  }
  type Line = { accountNumber: string; debit?: string; credit?: string; description?: string | null };
  const lines: Line[] = [];
  if (depositPaid > 0) lines.push({ accountNumber: DEFAULT_DEPOSIT_LIABILITY, debit: depositPaid.toFixed(2), description: "Recognize deposit" });
  if (remaining > 0) {
    if (!booking.memberId) throw new ConflictError("Outstanding balance requires a member — non-members must be fully prepaid");
    lines.push({ accountNumber: DEFAULT_AR_CONTROL, debit: remaining.toFixed(2), description: "Outstanding to member" });
  }
  // Revenue CR for the total.
  lines.push({ accountNumber: DEFAULT_REVENUE, credit: total.toFixed(2), description: booking.eventName });

  const journal = await createPostedFromAdapter(
    principal, booking.clubId,
    { entryDate: date, description: `Private event billing · ${booking.bookingNumber}`, lines },
    { source: "RECURRING", sourceEntityType: "PrivateEventBooking", sourceEntityId: booking.id }
  );
  const updated = await prisma.privateEventBooking.update({
    where: { id: bookingId },
    data: { status: "COMPLETED", finalPostedJournalEntryId: journal.id },
  });
  await audit(principal, { action: "private_event.booking.bill", entityType: "PrivateEventBooking", entityId: bookingId, clubId: booking.clubId, after: { total, journalEntryId: journal.id } });
  return updated;
}

// --- Reads ------------------------------------------------------------------
export async function listBookings(principal: Principal, clubId: string, opts?: { status?: string }) {
  return prisma.privateEventBooking.findMany({
    where: { ...tenantWhere(principal, clubId), ...(opts?.status ? { status: opts.status } : {}) },
    include: { deposits: true, member: true },
    orderBy: { eventStart: "desc" },
    take: 100,
  });
}

export async function getBooking(principal: Principal, bookingId: string) {
  const b = await prisma.privateEventBooking.findUnique({
    where: { id: bookingId },
    include: { deposits: { orderBy: { receivedDate: "asc" } }, menuSelections: true, barSelections: true, addOns: true, inquiry: true, member: true, finalPostedJournalEntry: true },
  });
  if (!b) throw new NotFoundError("PrivateEventBooking", bookingId);
  assertTenantOwned(b, principal);
  return b;
}

function zerr(err: z.ZodError) {
  return new ValidationError(err.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
}
// Imports used inside the file but reported as unused otherwise.
void Prisma; void toMoney; void sumMoney;
