import { PublicClubLayout } from "@/components/club-public/PublicClubLayout";
import { MarketingEyebrow, PrimaryCTA, SecondaryCTA, ImagePanel } from "@/components/club-public/sections";

const SPACES = [
  { name: "The Main Dining Room", desc: "A refined room for special occasions and Sunday brunch. Seasonal menu, full bar, member-only after-dinner library." },
  { name: "The Grill Room", desc: "Relaxed all-day dining for members coming off the course. Burgers, salads, and a chef's daily." },
  { name: "The Library Lounge", desc: "Quiet corners for a coffee, a card game, or a meeting. Sandwiches and small bites served all day." },
  { name: "The Patio", desc: "Open from late spring through autumn. Long-table dinners, twilight cocktails, and the best sunset on property." },
  { name: "Locker Rooms", desc: "Comfortable, considered, and quiet. Individual lockers, shower facilities, and a small lounge in each." },
  { name: "Member Bar", desc: "After-round and after-work hours. A short, curated whisky and wine list and a fireplace that earns its keep." },
];

export default function ClubhousePage() {
  return (
    <PublicClubLayout>
      <section>
        <div className="max-w-7xl mx-auto px-6 md:px-10 py-24">
          <div className="grid md:grid-cols-2 gap-12 items-center">
            <div>
              <MarketingEyebrow>The Clubhouse</MarketingEyebrow>
              <h1 className="mt-3 font-serif text-4xl md:text-5xl leading-tight">
                A second home for members and their families.
              </h1>
              <p className="mt-5 text-stone-600 leading-relaxed text-lg">
                Built in 1981 and renovated with care over the decades, our
                clubhouse is open year-round to members and accompanied guests.
                Three dining rooms, a relaxed grill, two lounges, the locker
                rooms, and a patio that lives up to its reputation.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <PrimaryCTA href="/membership">Become a Member</PrimaryCTA>
                <SecondaryCTA href="/events">Host an event</SecondaryCTA>
              </div>
            </div>
            <div><ImagePanel variant="clubhouse" /></div>
          </div>
        </div>
      </section>

      <section className="bg-club-cream border-y border-club-stone">
        <div className="max-w-7xl mx-auto px-6 md:px-10 py-20">
          <MarketingEyebrow>Spaces</MarketingEyebrow>
          <h2 className="mt-3 font-serif text-3xl md:text-4xl">Rooms, made well, for different moments.</h2>
          <div className="mt-12 grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {SPACES.map((s) => (
              <div key={s.name} className="bg-white border border-club-stone rounded-2xl p-6 shadow-card">
                <div className="font-serif text-xl text-club-ink">{s.name}</div>
                <p className="mt-3 text-sm text-stone-600 leading-relaxed">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section>
        <div className="max-w-7xl mx-auto px-6 md:px-10 py-20 grid md:grid-cols-2 gap-12 items-start">
          <div>
            <MarketingEyebrow>Dining</MarketingEyebrow>
            <h2 className="mt-3 font-serif text-3xl md:text-4xl leading-tight">
              A menu that follows the seasons.
            </h2>
            <p className="mt-5 text-stone-600 leading-relaxed">
              Our chef writes a new menu each quarter, drawing from local
              producers and the things that taste best at that moment in the
              year. The grill room is open every day the course is open; the
              main dining room is open Wednesday through Sunday.
            </p>
          </div>
          <div className="rounded-2xl bg-club-green-50 border border-club-green-100 p-8">
            <div className="font-serif text-xl">Hours of operation</div>
            <dl className="mt-4 grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-stone-600">Grill Room</dt><dd className="text-club-ink text-right">7am – 9pm daily (season)</dd>
              <dt className="text-stone-600">Main Dining</dt><dd className="text-club-ink text-right">Wed – Sun, 5:30pm – 9:30pm</dd>
              <dt className="text-stone-600">Library Lounge</dt><dd className="text-club-ink text-right">9am – 11pm daily</dd>
              <dt className="text-stone-600">Patio</dt><dd className="text-club-ink text-right">May – September</dd>
            </dl>
          </div>
        </div>
      </section>
    </PublicClubLayout>
  );
}
