import { PublicClubLayout } from "@/components/club-public/PublicClubLayout";
import { MarketingEyebrow, PrimaryCTA, SecondaryCTA, ImagePanel } from "@/components/club-public/sections";

export default function GolfPage() {
  return (
    <PublicClubLayout>
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-club-green-800 via-club-green-600 to-club-green-300" aria-hidden="true" />
        <div className="absolute inset-0 bg-gradient-to-t from-club-green-900/60 to-transparent" aria-hidden="true" />
        <div className="relative max-w-7xl mx-auto px-6 md:px-10 py-24 md:py-32 text-club-cream">
          <MarketingEyebrow><span className="text-club-gold/90">Golf</span></MarketingEyebrow>
          <h1 className="mt-3 font-serif text-4xl md:text-5xl leading-tight max-w-3xl">
            A course shaped by the land, kept in tournament condition.
          </h1>
          <p className="mt-5 max-w-2xl text-club-cream/90 text-lg leading-relaxed">
            Eighteen holes that ask honest questions of every player. Mature trees,
            naturally undulating terrain, and greens that reward thoughtful course
            management.
          </p>
        </div>
      </section>

      {/* Numbers */}
      <section className="bg-club-cream">
        <div className="max-w-7xl mx-auto px-6 md:px-10 py-16 grid grid-cols-2 md:grid-cols-4 gap-6">
          {[
            ["18", "holes"],
            ["72", "par"],
            ["6,800+", "yards from the back tees"],
            ["bent grass", "fairways & greens"],
          ].map(([n, k]) => (
            <div key={k} className="rounded-2xl bg-white border border-club-stone p-6">
              <div className="font-serif text-4xl text-club-green-800">{n}</div>
              <div className="mt-2 text-xs uppercase tracking-wide text-stone-500">{k}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Practice */}
      <section className="bg-white border-y border-club-stone">
        <div className="max-w-7xl mx-auto px-6 md:px-10 py-20">
          <div className="grid md:grid-cols-2 gap-12 items-center">
            <div><ImagePanel variant="course" /></div>
            <div>
              <MarketingEyebrow>Practice facilities</MarketingEyebrow>
              <h2 className="mt-3 font-serif text-3xl md:text-4xl leading-tight">
                A full short game and range complex.
              </h2>
              <ul className="mt-6 space-y-3 text-stone-700">
                <li className="flex gap-3"><span className="text-club-green-700">✦</span> Grass tee driving range with target greens</li>
                <li className="flex gap-3"><span className="text-club-green-700">✦</span> Short-game area with bunker and chipping green</li>
                <li className="flex gap-3"><span className="text-club-green-700">✦</span> Two-tier putting green</li>
                <li className="flex gap-3"><span className="text-club-green-700">✦</span> Year-round Trackman simulator bays</li>
              </ul>
              <div className="mt-8 flex flex-wrap gap-3">
                <PrimaryCTA href="/golf/trackman-range">The Trackman Range</PrimaryCTA>
                <SecondaryCTA href="/golf/guest-information">Guest information</SecondaryCTA>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Member play */}
      <section>
        <div className="max-w-7xl mx-auto px-6 md:px-10 py-20">
          <div className="grid md:grid-cols-2 gap-12 items-start">
            <div>
              <MarketingEyebrow>Member play</MarketingEyebrow>
              <h2 className="mt-3 font-serif text-3xl md:text-4xl leading-tight">
                A relaxed, considerate pace.
              </h2>
              <p className="mt-5 text-stone-600 leading-relaxed">
                We hold our members to a 4-hour-15 pace and ask the same of any
                accompanied guests. Tee times open weekly. The competitive
                calendar runs from late spring through fall, with member-guest,
                club championship, and an evening twilight league.
              </p>
            </div>
            <div className="rounded-2xl bg-club-green-50 border border-club-green-100 p-8">
              <div className="font-serif text-xl text-club-ink">Signature events</div>
              <ul className="mt-4 space-y-3 text-sm text-stone-700">
                <li className="flex justify-between border-b border-club-green-100 pb-2">
                  <span>Member-Guest Invitational</span>
                  <span className="text-stone-500">Early summer</span>
                </li>
                <li className="flex justify-between border-b border-club-green-100 pb-2">
                  <span>Club Championship</span>
                  <span className="text-stone-500">Late summer</span>
                </li>
                <li className="flex justify-between border-b border-club-green-100 pb-2">
                  <span>Twilight League</span>
                  <span className="text-stone-500">Weekly</span>
                </li>
                <li className="flex justify-between">
                  <span>Junior Camps</span>
                  <span className="text-stone-500">Summer</span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>
    </PublicClubLayout>
  );
}
