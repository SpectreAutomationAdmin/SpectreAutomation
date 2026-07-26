import { PublicClubLayout } from "@/components/club-public/PublicClubLayout";
import { MarketingEyebrow, PrimaryCTA, SecondaryCTA, ImagePanel } from "@/components/club-public/sections";

export default function EventsPage() {
  return (
    <PublicClubLayout>
      <section>
        <div className="max-w-7xl mx-auto px-6 md:px-10 py-24">
          <div className="grid md:grid-cols-2 gap-12 items-center">
            <div>
              <MarketingEyebrow>Catering &amp; Events</MarketingEyebrow>
              <h1 className="mt-3 font-serif text-4xl md:text-5xl leading-tight">
                A storied venue for the moments that matter most.
              </h1>
              <p className="mt-5 text-stone-600 leading-relaxed text-lg">
                For decades, we&rsquo;ve hosted weddings, anniversaries, milestone
                birthdays, corporate gatherings, and golf tournaments. Our
                events team has the experience and the calm temperament to make
                a complicated day feel simple.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <PrimaryCTA href="/events/request">Request an event</PrimaryCTA>
                <SecondaryCTA href="/contact">Speak with our team</SecondaryCTA>
              </div>
            </div>
            <div><ImagePanel variant="events" /></div>
          </div>
        </div>
      </section>

      <section className="bg-club-cream border-y border-club-stone">
        <div className="max-w-7xl mx-auto px-6 md:px-10 py-20">
          <MarketingEyebrow>Capacities</MarketingEyebrow>
          <h2 className="mt-3 font-serif text-3xl md:text-4xl">Spaces, sized for the occasion.</h2>
          <div className="mt-10 grid md:grid-cols-3 gap-6">
            {[
              { name: "The Ballroom", capacity: "180 seated · 240 cocktail", best: "Weddings, gala dinners, anniversaries." },
              { name: "The Terrace Room", capacity: "80 seated · 120 cocktail", best: "Rehearsal dinners, corporate luncheons." },
              { name: "The Lawn", capacity: "Ceremony for 150", best: "Outdoor ceremonies, May through September." },
              { name: "The Library", capacity: "30 seated · 50 cocktail", best: "Intimate gatherings, board meetings." },
              { name: "The Patio", capacity: "60 seated · 90 cocktail", best: "Sunset cocktails, casual dinners." },
              { name: "Tournaments", capacity: "Up to 144 players", best: "Full-course shotgun, custom prize structure." },
            ].map((s) => (
              <article key={s.name} className="bg-white border border-club-stone rounded-2xl p-6 shadow-card">
                <div className="font-serif text-xl text-club-ink">{s.name}</div>
                <div className="mt-1 text-xs uppercase tracking-wide text-club-green-700">{s.capacity}</div>
                <p className="mt-3 text-sm text-stone-600 leading-relaxed">{s.best}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section>
        <div className="max-w-7xl mx-auto px-6 md:px-10 py-20 grid md:grid-cols-2 gap-12 items-start">
          <div>
            <MarketingEyebrow>What&rsquo;s included</MarketingEyebrow>
            <h2 className="mt-3 font-serif text-3xl md:text-4xl leading-tight">
              An events team that has done this a thousand times.
            </h2>
            <ul className="mt-6 space-y-3 text-stone-700">
              <li className="flex gap-3"><span className="text-club-green-700">✦</span> A dedicated coordinator for your event</li>
              <li className="flex gap-3"><span className="text-club-green-700">✦</span> Custom seasonal menus &amp; tastings</li>
              <li className="flex gap-3"><span className="text-club-green-700">✦</span> Full bar service, sommelier on request</li>
              <li className="flex gap-3"><span className="text-club-green-700">✦</span> Linens, china, glassware, and silver included</li>
              <li className="flex gap-3"><span className="text-club-green-700">✦</span> Wedding ceremony coordination on the Lawn</li>
              <li className="flex gap-3"><span className="text-club-green-700">✦</span> AV + presentation support for corporate events</li>
            </ul>
          </div>
          <div className="rounded-2xl bg-club-green-50 border border-club-green-100 p-8">
            <div className="font-serif text-xl">Begin the conversation</div>
            <p className="mt-3 text-sm text-stone-700 leading-relaxed">
              The first step is the inquiry form. You&rsquo;ll hear from our events
              team within two business days to arrange a tour and a no-obligation
              walk-through of menus and dates.
            </p>
            <div className="mt-6">
              <PrimaryCTA href="/events/request">Request an event</PrimaryCTA>
            </div>
          </div>
        </div>
      </section>
    </PublicClubLayout>
  );
}
