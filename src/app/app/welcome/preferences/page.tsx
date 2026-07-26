import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";

const DEFAULT_WIDGETS_BY_PREF: Record<string, string[]> = {
  interestedGolf: ["UPCOMING_TEE_TIMES", "WEATHER", "DRIVING_RANGE_CAMERA"],
  interestedDining: ["RESTAURANT_RECENT"],
  interestedEvents: ["UPCOMING_EVENTS"],
  interestedLeagues: ["LEAGUES"],
  interestedPracticeFacilities: ["LESSON_BOOKING"],
  wantsProShopOffers: ["PRO_SHOP_RECENT"],
  wantsTeeTimeAlerts: ["UPCOMING_TEE_TIMES"],
};

const ALWAYS_ON = ["WELCOME", "ACCOUNT_BALANCE", "PAYMENT_METHOD_STATUS"];

async function savePreferencesAction(memberId: string, formData: FormData) {
  "use server";

  const member = await prisma.member.findUnique({ where: { id: memberId } });
  if (!member) throw new Error("Member not found");

  const flags = {
    interestedGolf: formData.get("interestedGolf") === "on",
    interestedDining: formData.get("interestedDining") === "on",
    interestedEvents: formData.get("interestedEvents") === "on",
    interestedLeagues: formData.get("interestedLeagues") === "on",
    interestedPracticeFacilities: formData.get("interestedPracticeFacilities") === "on",
    wantsProShopOffers: formData.get("wantsProShopOffers") === "on",
    wantsTeeTimeAlerts: formData.get("wantsTeeTimeAlerts") === "on",
  };

  await prisma.memberPreference.upsert({
    where: { memberId },
    create: { clubId: member.clubId, memberId, ...flags },
    update: flags,
  });

  // Reset & seed default widgets for this member based on the new preferences.
  await prisma.dashboardWidget.deleteMany({ where: { memberId } });
  const widgets = new Set<string>(ALWAYS_ON);
  for (const [pref, val] of Object.entries(flags)) {
    if (val) (DEFAULT_WIDGETS_BY_PREF[pref] ?? []).forEach((w) => widgets.add(w));
  }
  let order = 0;
  await prisma.dashboardWidget.createMany({
    data: Array.from(widgets).map((widgetType) => ({
      clubId: member.clubId,
      memberId,
      widgetType,
      enabled: true,
      sortOrder: order++,
    })),
  });

  if (member.status === "ONBOARDING") {
    await prisma.member.update({ where: { id: memberId }, data: { status: "ACTIVE" } });
  }

  redirect(`/app/member?welcomeMember=${memberId}`);
}

const PREFS: Array<{ key: string; title: string; subtitle: string }> = [
  { key: "interestedGolf", title: "Golf", subtitle: "Tee times, the course, the camera" },
  { key: "interestedDining", title: "Dining", subtitle: "Reservations, dining-room news" },
  { key: "interestedEvents", title: "Club Events", subtitle: "Member-Guest, parties, tournaments" },
  { key: "interestedLeagues", title: "Leagues", subtitle: "Mens & Ladies, mixers, juniors" },
  { key: "interestedPracticeFacilities", title: "Practice Facilities", subtitle: "Lessons, range, short game" },
  { key: "wantsProShopOffers", title: "Pro Shop Offers", subtitle: "New arrivals, promotions" },
  { key: "wantsTeeTimeAlerts", title: "Tee Time Alerts", subtitle: "Last-minute openings, weather windows" },
];

export default async function PreferencesPage({ searchParams }: { searchParams: { welcomeMember?: string } }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const memberId = searchParams.welcomeMember ?? user.memberId ?? null;
  if (!memberId) redirect("/app/member");

  const action = savePreferencesAction.bind(null, memberId);

  return (
    <div className="text-white">
      <div className="max-w-5xl mx-auto px-8 py-16">
        <div className="text-xs uppercase tracking-[0.4em] text-club-green-200">A few quick questions</div>
        <h1 className="mt-3 font-serif text-4xl">What are you most looking forward to?</h1>
        <p className="mt-3 text-club-green-100 max-w-2xl">
          We&rsquo;ll personalize your Member Hub so the things that matter to you are always front and centre.
        </p>

        <form action={action} className="mt-10">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {PREFS.map((p) => (
              <label key={p.key} className="group cursor-pointer">
                <input type="checkbox" name={p.key} className="peer hidden" />
                <div className="rounded-xl border border-club-green-700 bg-club-green-800/60 p-5 transition peer-checked:bg-club-gold/10 peer-checked:border-club-gold peer-checked:ring-2 peer-checked:ring-club-gold/40 hover:border-club-green-500">
                  <div className="font-serif text-xl text-white">{p.title}</div>
                  <div className="mt-1 text-sm text-club-green-200">{p.subtitle}</div>
                </div>
              </label>
            ))}
          </div>

          <div className="mt-10 flex justify-between items-center">
            <Link href={`/app/member?welcomeMember=${memberId}`} className="text-sm text-club-green-200 hover:text-white">Skip for now</Link>
            <button type="submit" className="rounded-full bg-club-gold text-club-ink font-medium px-8 py-3 hover:bg-amber-300">
              Save and continue →
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
