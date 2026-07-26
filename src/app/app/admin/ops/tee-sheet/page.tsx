import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { isAppError } from "@/lib/errors";
import { upsertCourse, generateTeeSheet, listTeeSheets, createLottery, drawLottery } from "@/lib/teesheet";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

async function createCourseAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try {
    await upsertCourse(p, clubId, {
      code: String(formData.get("code") ?? ""),
      name: String(formData.get("name") ?? ""),
      holes: Number(formData.get("holes") ?? 18),
    });
  } catch (err) { if (isAppError(err)) redirect(`/app/admin/ops/tee-sheet?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/ops/tee-sheet");
}

async function generateAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try {
    await generateTeeSheet(p, clubId, {
      courseCode: String(formData.get("courseCode") ?? ""),
      sheetDate: String(formData.get("sheetDate") ?? ""),
      startTime: String(formData.get("startTime") ?? "07:00"),
      endTime: String(formData.get("endTime") ?? "17:00"),
      intervalMinutes: Number(formData.get("intervalMinutes") ?? 10),
      maxPlayers: Number(formData.get("maxPlayers") ?? 4),
    });
  } catch (err) { if (isAppError(err)) redirect(`/app/admin/ops/tee-sheet?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/ops/tee-sheet");
}

async function createLotteryAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try {
    await createLottery(p, clubId, {
      teeSheetId: String(formData.get("teeSheetId") ?? ""),
      name: String(formData.get("name") ?? ""),
      opensAt: String(formData.get("opensAt") ?? ""),
      closesAt: String(formData.get("closesAt") ?? ""),
      drawAt: String(formData.get("drawAt") ?? ""),
    });
  } catch (err) { if (isAppError(err)) redirect(`/app/admin/ops/tee-sheet?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/ops/tee-sheet");
}

async function drawAction(lotteryId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await drawLottery(p, lotteryId); }
  catch (err) { if (isAppError(err)) redirect(`/app/admin/ops/tee-sheet?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/ops/tee-sheet");
}

export default async function TeeSheetPage({ searchParams }: { searchParams: { error?: string } }) {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "lessons:view")) redirect("/app/admin");
  const canManage = hasPermission(p, clubId, "lessons:manage");

  const [courses, sheets, lotteries] = await Promise.all([
    prisma.course.findMany({ where: { clubId, isActive: true }, orderBy: { name: "asc" } }),
    listTeeSheets(p, clubId),
    prisma.teeLottery.findMany({ where: { clubId }, orderBy: { drawAt: "desc" }, take: 10, include: { entries: true, teeSheet: { include: { course: true } } } }),
  ]);

  return (
    <div>
      <Link href="/app/admin/ops" className="text-sm text-stone-500 hover:text-club-ink">← Operations</Link>
      <h1 className="mt-3 page-title">Tee Sheet</h1>
      <p className="mt-1 text-stone-500">Configure courses, generate tee times, run lotteries, and track bookings.</p>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Tee sheets ({sheets.length})</div>
          <table className="table-base">
            <thead><tr><th>Date</th><th>Course</th><th>Status</th><th>Times</th><th>Booked</th></tr></thead>
            <tbody>
              {sheets.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-stone-500">No tee sheets yet.</td></tr>}
              {sheets.map((s) => {
                const booked = s.times.filter((t) => t.status === "BOOKED").length;
                return (
                  <tr key={s.id}>
                    <td className="text-xs">{formatDate(s.sheetDate)}</td>
                    <td>{s.course.name}</td>
                    <td><Badge status={s.status} /></td>
                    <td className="text-xs">{s.times.length}</td>
                    <td className="text-xs">{booked} / {s.times.length}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="space-y-4">
          {canManage && (
            <form action={createCourseAction} className="card card-body space-y-3">
              <h2 className="section-title text-lg">New course</h2>
              <div><label className="label">Code</label><input className="input font-mono" name="code" placeholder="MAIN-18" required /></div>
              <div><label className="label">Name</label><input className="input" name="name" required /></div>
              <div><label className="label">Holes</label><input className="input" type="number" name="holes" defaultValue={18} /></div>
              <button className="btn btn-primary">Save course</button>
            </form>
          )}
          {canManage && courses.length > 0 && (
            <form action={generateAction} className="card card-body space-y-3">
              <h2 className="section-title text-lg">Generate tee sheet</h2>
              <div>
                <label className="label">Course</label>
                <select className="select" name="courseCode" required>
                  {courses.map((c) => <option key={c.id} value={c.code}>{c.name}</option>)}
                </select>
              </div>
              <div><label className="label">Date</label><input className="input" type="date" name="sheetDate" required defaultValue={new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)} /></div>
              <div className="grid grid-cols-2 gap-2">
                <div><label className="label">Start</label><input className="input" name="startTime" defaultValue="07:00" /></div>
                <div><label className="label">End</label><input className="input" name="endTime" defaultValue="17:00" /></div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div><label className="label">Interval (min)</label><input className="input" type="number" name="intervalMinutes" defaultValue={10} /></div>
                <div><label className="label">Max players</label><input className="input" type="number" name="maxPlayers" defaultValue={4} /></div>
              </div>
              <button className="btn btn-primary">Generate</button>
            </form>
          )}
        </div>
      </div>

      {canManage && sheets.length > 0 && (
        <div className="mt-8 grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 card overflow-hidden">
            <div className="px-6 py-4 border-b border-stone-200 font-medium">Recent lotteries</div>
            <table className="table-base">
              <thead><tr><th>Name</th><th>Date</th><th>Status</th><th>Entries</th><th>Draw at</th><th></th></tr></thead>
              <tbody>
                {lotteries.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-stone-500">No lotteries yet.</td></tr>}
                {lotteries.map((l) => (
                  <tr key={l.id}>
                    <td>{l.name}</td>
                    <td className="text-xs">{formatDate(l.teeSheet.sheetDate)} · {l.teeSheet.course.name}</td>
                    <td><Badge status={l.status} /></td>
                    <td className="text-xs">{l.entries.length}</td>
                    <td className="text-xs">{formatDate(l.drawAt)}</td>
                    <td className="text-right text-xs">
                      {l.status === "OPEN" && (
                        <form action={drawAction.bind(null, l.id)} className="inline"><button className="text-club-green-700 hover:underline">Run draw</button></form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <form action={createLotteryAction} className="card card-body space-y-3">
            <h2 className="section-title text-lg">New lottery</h2>
            <div>
              <label className="label">Tee sheet</label>
              <select className="select" name="teeSheetId" required>
                {sheets.map((s) => <option key={s.id} value={s.id}>{s.course.name} · {formatDate(s.sheetDate)}</option>)}
              </select>
            </div>
            <div><label className="label">Name</label><input className="input" name="name" placeholder="Saturday morning lottery" required /></div>
            <div><label className="label">Opens</label><input className="input" type="datetime-local" name="opensAt" required /></div>
            <div><label className="label">Closes</label><input className="input" type="datetime-local" name="closesAt" required /></div>
            <div><label className="label">Draw at</label><input className="input" type="datetime-local" name="drawAt" required /></div>
            <button className="btn btn-primary">Create lottery</button>
          </form>
        </div>
      )}
    </div>
  );
}
