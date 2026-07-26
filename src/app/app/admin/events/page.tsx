import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getActiveClubId } from "@/lib/active-club";
import { Badge } from "@/components/Badge";
import { formatCurrency, formatDate } from "@/lib/finance";

async function createEventAction(clubId: string, formData: FormData) {
  "use server";
  await prisma.clubEvent.create({
    data: {
      clubId,
      title: String(formData.get("title") ?? "").trim(),
      description: String(formData.get("description") ?? "").trim(),
      eventDate: new Date(String(formData.get("eventDate"))),
      capacity: parseInt(String(formData.get("capacity") ?? "0"), 10) || 0,
      price: Number(formData.get("price") ?? 0) || 0,
      status: "PUBLISHED",
    },
  });
  revalidatePath("/app/admin/events");
}

async function cancelEventAction(id: string) {
  "use server";
  await prisma.clubEvent.update({ where: { id }, data: { status: "CANCELLED" } });
  revalidatePath("/app/admin/events");
}

export default async function AdminEventsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);

  const events = await prisma.clubEvent.findMany({
    where: { clubId },
    orderBy: { eventDate: "asc" },
    include: { registrations: { include: { member: true } } },
  });

  return (
    <div>
      <h1 className="page-title">Events</h1>
      <p className="mt-1 text-stone-500">Create and manage member events.</p>

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          {events.map((e) => (
            <div key={e.id} className="card overflow-hidden">
              <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between gap-3">
                <div>
                  <div className="font-serif text-lg">{e.title}</div>
                  <div className="text-xs text-stone-500">{formatDate(e.eventDate)} · capacity {e.capacity} · {e.price > 0 ? formatCurrency(e.price) : "Complimentary"}</div>
                </div>
                <div className="flex items-center gap-3">
                  <Badge status={e.status} />
                  {e.status !== "CANCELLED" && (
                    <form action={cancelEventAction.bind(null, e.id)}>
                      <button className="text-xs text-red-600 hover:underline">Cancel</button>
                    </form>
                  )}
                </div>
              </div>
              <div className="card-body">
                <p className="text-sm text-stone-600">{e.description}</p>
                <div className="mt-4">
                  <div className="text-xs uppercase tracking-wide text-stone-500">Registrations ({e.registrations.length})</div>
                  {e.registrations.length === 0 ? (
                    <div className="text-sm text-stone-500 mt-1">No registrations yet.</div>
                  ) : (
                    <ul className="mt-2 space-y-1 text-sm">
                      {e.registrations.map((r) => (
                        <li key={r.id} className="flex items-center justify-between">
                          <Link href={`/app/admin/members/${r.memberId}`} className="hover:text-club-green-700">{r.member.firstName} {r.member.lastName}</Link>
                          <span className="text-stone-500">{r.numberOfGuests} guest{r.numberOfGuests === 1 ? "" : "s"} · {formatCurrency(r.amountCharged)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          ))}
          {events.length === 0 && <div className="text-stone-500">No events yet.</div>}
        </div>

        <form action={createEventAction.bind(null, clubId)} className="card card-body h-fit">
          <h2 className="section-title text-lg">Create an event</h2>
          <div className="mt-4 space-y-3">
            <div>
              <label className="label">Title</label>
              <input className="input" name="title" required />
            </div>
            <div>
              <label className="label">Description</label>
              <textarea className="textarea" name="description" rows={3} required />
            </div>
            <div>
              <label className="label">Date</label>
              <input className="input" name="eventDate" type="datetime-local" required />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Capacity</label>
                <input className="input" name="capacity" type="number" defaultValue={60} />
              </div>
              <div>
                <label className="label">Price</label>
                <input className="input" name="price" type="number" defaultValue={0} step={0.01} />
              </div>
            </div>
          </div>
          <button className="btn btn-primary mt-4">Create event</button>
        </form>
      </div>
    </div>
  );
}
