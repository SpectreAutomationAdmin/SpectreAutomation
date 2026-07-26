import { PublicClubLayout } from "@/components/club-public/PublicClubLayout";
import { MarketingEyebrow, PrimaryCTA, SecondaryCTA, ImagePanel } from "@/components/club-public/sections";

export default function TrackmanRangePage() {
  return (
    <PublicClubLayout>
      <section className="bg-club-green-900 text-club-cream">
        <div className="max-w-7xl mx-auto px-6 md:px-10 py-24 md:py-32">
          <MarketingEyebrow><span className="text-club-gold/90">The Trackman Range</span></MarketingEyebrow>
          <h1 className="mt-3 font-serif text-4xl md:text-5xl leading-tight max-w-3xl">
            Real golf, all year, on the world&rsquo;s best simulators.
          </h1>
          <p className="mt-5 max-w-2xl text-club-cream/85 text-lg leading-relaxed">
            Our Trackman bays are open year-round to members and accompanied guests.
            Play any course in Trackman&rsquo;s world catalogue, refine your swing
            with the same launch monitor used on tour, or run a coaching session
            with our teaching professional.
          </p>
          <div className="mt-10 flex flex-wrap gap-3">
            <PrimaryCTA href="/member-area">Reserve a bay</PrimaryCTA>
            <SecondaryCTA href="/contact">Ask a question</SecondaryCTA>
          </div>
        </div>
      </section>

      <section className="bg-club-cream">
        <div className="max-w-7xl mx-auto px-6 md:px-10 py-20">
          <div className="grid md:grid-cols-2 gap-12 items-center">
            <div>
              <h2 className="font-serif text-3xl md:text-4xl leading-tight">What you get in the bay.</h2>
              <ul className="mt-6 space-y-3 text-stone-700">
                <li className="flex gap-3"><span className="text-club-green-700">✦</span> Trackman 4 launch monitor — every shot measured</li>
                <li className="flex gap-3"><span className="text-club-green-700">✦</span> Library of championship courses</li>
                <li className="flex gap-3"><span className="text-club-green-700">✦</span> Practice modes for driver, irons, wedges, putting</li>
                <li className="flex gap-3"><span className="text-club-green-700">✦</span> Lesson recording for review with the pro</li>
              </ul>
            </div>
            <div><ImagePanel variant="trackman" /></div>
          </div>
        </div>
      </section>

      <section className="bg-white border-t border-club-stone">
        <div className="max-w-7xl mx-auto px-6 md:px-10 py-20 grid md:grid-cols-3 gap-8">
          <div>
            <MarketingEyebrow>Hours</MarketingEyebrow>
            <p className="mt-3 text-stone-700 leading-relaxed">
              Open daily from 7am to 11pm, year-round, for members and
              accompanied guests.
            </p>
          </div>
          <div>
            <MarketingEyebrow>Reservations</MarketingEyebrow>
            <p className="mt-3 text-stone-700 leading-relaxed">
              Members can reserve a bay through the Member Area. Walk-in play
              is welcome subject to availability.
            </p>
          </div>
          <div>
            <MarketingEyebrow>Coaching</MarketingEyebrow>
            <p className="mt-3 text-stone-700 leading-relaxed">
              Book a one-on-one or small-group session with the teaching pro
              for a focused, video-recorded lesson.
            </p>
          </div>
        </div>
      </section>
    </PublicClubLayout>
  );
}
