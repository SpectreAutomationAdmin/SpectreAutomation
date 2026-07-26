import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { lessonService } from "@/lib/ops";
import { isAppError } from "@/lib/errors";
import { Badge } from "@/components/Badge";
import { fmtMoney } from "@/lib/accounting/format";
import { formatDate } from "@/lib/finance";

async function bookAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try {
    await lessonService.createBooking(p, clubId, {
      memberId: String(formData.get("memberId") ?? ""),
      lessonTypeId: String(formData.get("lessonTypeId") ?? ""),
      instructorId: String(formData.get("instructorId") ?? ""),
      scheduledAt: String(formData.get("scheduledAt") ?? ""),
    });
  } catch (err) { if (isAppError(err)) redirect(`/app/admin/ops/lessons?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/ops/lessons");
}

async function instructorConfirmAction(bookingId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await lessonService.instructorConfirm(p, bookingId); }
  catch (err) { if (isAppError(err)) redirect(`/app/admin/ops/lessons?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/ops/lessons");
}

async function approveAction(bookingId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await lessonService.headProApprove(p, bookingId); }
  catch (err) { if (isAppError(err)) redirect(`/app/admin/ops/lessons?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/ops/lessons");
}

export default async function LessonsPage({ searchParams }: { searchParams: { error?: string } }) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "lessons:view")) redirect("/app/admin");
  const canManage = hasPermission(p, clubId, "lessons:manage");
  const canApprove = hasPermission(p, clubId, "lessons:approve");

  const [bookings, payables, instructors, members, lessonTypes] = await Promise.all([
    prisma.lessonBooking.findMany({ where: { clubId }, include: { member: true, instructor: true, lessonType: true }, orderBy: { scheduledAt: "desc" }, take: 50 }),
    prisma.lessonPayable.findMany({ where: { clubId, status: "ACCRUED" }, include: { instructor: true, booking: true }, orderBy: { accruedAt: "asc" } }),
    prisma.golfProfessional.findMany({ where: { clubId, isActive: true }, orderBy: { lastName: "asc" } }),
    prisma.member.findMany({ where: { clubId, status: { in: ["ACTIVE", "ONBOARDING"] } }, orderBy: { lastName: "asc" }, take: 100 }),
    prisma.lessonType.findMany({ where: { clubId, isActive: true }, orderBy: { name: "asc" } }),
  ]);

  return (
    <div>
      <h1 className="page-title">Lessons</h1>
      <p className="mt-1 text-stone-500">Bookings, instructor confirmation, Head Pro approval, and accrued payables.</p>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Bookings</div>
          <table className="table-base">
            <thead><tr><th>Number</th><th>Member</th><th>Instructor</th><th>Type</th><th>When</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {bookings.length === 0 && <tr><td colSpan={7} className="px-4 py-6 text-center text-stone-500">No bookings yet.</td></tr>}
              {bookings.map((b) => (
                <tr key={b.id}>
                  <td className="font-mono text-xs">{b.bookingNumber}</td>
                  <td>{b.member.firstName} {b.member.lastName}</td>
                  <td>{b.instructor.firstName} {b.instructor.lastName}</td>
                  <td className="text-xs text-stone-500">{b.lessonType.name}</td>
                  <td>{formatDate(b.scheduledAt)}</td>
                  <td><Badge status={b.status} /></td>
                  <td className="text-right text-xs space-x-2">
                    {canManage && b.status === "SCHEDULED" && (
                      <form action={instructorConfirmAction.bind(null, b.id)} className="inline">
                        <button className="text-club-green-700 hover:underline">Mark complete</button>
                      </form>
                    )}
                    {canApprove && b.status === "INSTRUCTOR_CONFIRMED" && (
                      <form action={approveAction.bind(null, b.id)} className="inline">
                        <button className="text-club-green-700 hover:underline">Head Pro approve</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {canManage && (
          <form action={bookAction} className="card card-body h-fit space-y-3">
            <h2 className="section-title text-lg">New booking</h2>
            <div>
              <label className="label">Member</label>
              <select className="select" name="memberId" required>
                <option value="">— Select —</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.firstName} {m.lastName}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Instructor</label>
              <select className="select" name="instructorId" required>
                <option value="">— Select —</option>
                {instructors.map((i) => <option key={i.id} value={i.id}>{i.firstName} {i.lastName}{i.isHeadPro ? " (Head Pro)" : ""}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Lesson type</label>
              <select className="select" name="lessonTypeId" required>
                <option value="">— Select —</option>
                {lessonTypes.map((t) => <option key={t.id} value={t.id}>{t.name} (${t.memberPrice.toString()})</option>)}
              </select>
            </div>
            <div>
              <label className="label">Scheduled at</label>
              <input className="input" type="datetime-local" name="scheduledAt" required />
            </div>
            <button className="btn btn-primary">Book</button>
          </form>
        )}
      </div>

      <div className="mt-8 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">Accrued instructor payables ({payables.length})</div>
        <table className="table-base">
          <thead><tr><th>Instructor</th><th>Booking</th><th>Accrued</th><th className="text-right">Amount</th></tr></thead>
          <tbody>
            {payables.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-stone-500">No outstanding payables.</td></tr>}
            {payables.map((p) => (
              <tr key={p.id}>
                <td>{p.instructor.firstName} {p.instructor.lastName}</td>
                <td className="font-mono text-xs">{p.booking.bookingNumber}</td>
                <td>{formatDate(p.accruedAt)}</td>
                <td className="text-right tabular-nums">{fmtMoney(p.amount as unknown as number)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-6 text-xs text-stone-500">
        On Head Pro approval: member is charged at the lesson type's member price → DR AR (1110) / CR Lesson Revenue. Instructor pay accrues to Accrued Lesson Payable (2060) and is settled later via an AP invoice to the instructor's payout vendor.
      </div>
    </div>
  );
}
