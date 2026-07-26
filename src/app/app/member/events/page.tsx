import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getActiveMember } from "@/lib/active-member";
import { Badge } from "@/components/Badge";
import { formatCurrency, formatDate } from "@/lib/finance";

async function registerAction(memberId: string, eventId: string, formData: FormData) {
  "use server";
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  const event = await prisma.clubEvent.findUnique({ where: { id: eventId } });
  if (!member || !event) throw new Error("Not found");
  const guests = Math.max(0, parseInt(String(formData.get("guests") ?? "0"), 10) || 0);
  await prisma.eventRegistration.create({
    data: {
      clubId: member.clubId,
      eventId,
      memberId,
      status: "REGISTERED",
      numberOfGuests: guests,
      amountCharged: event.price * (1 + guests),
    },
  });
  revalidatePath("/app/member/events");
}

export default async function MemberEventsPage({ searchParams }: { searchParams: { welcomeMember?: string } }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const member = await getActiveMember(user, searchParams.welcomeMember);
  if (!member) redirect(user.role === "MEMBER" ? "/login" : "/app/admin");

  const events = await prisma.clubEvent.findMany({
    where: { clubId: member.clubId, status: "PUBLISHED" },
    orderBy: { eventDate: "asc" },
    include: { registrations: { where: { memberId: member.id } } },
  });

  return (
    <div>
      <h1 className="page-title">Club Events</h1>
      <p className="mt-1 text-stone-500">Upcoming gatherings at the club.</p>

      <div className="mt-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {events.map((e) => {
          const registered = e.registrations.length > 0;
          const action = registerAction.bind(null, member.id, e.id);
          return (
            <div key={e.id} className="card overflow-hidden">
              <div className="bg-club-green-700 h-2" />
              <div className="card-body">
                <div className="text-xs uppercase tracking-wide text-stone-500">{formatDate(e.eventDate)}</div>
                <h3 className="mt-1 font-serif text-xl">{e.title}</h3>
                <p className="mt-2 text-sm text-stone-600">{e.description}</p>
                <div className="mt-4 flex items-center justify-between">
                  <div className="text-sm">{e.price > 0 ? formatCurrency(e.price) : <span className="text-stone-500">Complimentary</span>}</div>
                  {registered ? (
                    <Badge status="REGISTERED" label="You're in" />
                  ) : (
                    <form action={action} className="flex items-center gap-2">
                      <input className="input w-20" type="number" name="guests" min={0} max={6} defaultValue={0} aria-label="Guests" />
                      <button className="btn btn-primary text-sm">Register</button>
                    </form>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {events.length === 0 && (
          <div className="md:col-span-3 text-stone-500">No upcoming events.</div>
        )}
      </div>
    </div>
  );
}
