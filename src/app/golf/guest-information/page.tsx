import { PublicClubLayout } from "@/components/club-public/PublicClubLayout";
import { MarketingEyebrow, SecondaryCTA } from "@/components/club-public/sections";

export default function GuestInformationPage() {
  return (
    <PublicClubLayout>
      <section className="bg-club-cream">
        <div className="max-w-7xl mx-auto px-6 md:px-10 py-24">
          <MarketingEyebrow>Guest information</MarketingEyebrow>
          <h1 className="mt-3 font-serif text-4xl md:text-5xl leading-tight max-w-3xl">
            For our members&rsquo; guests &amp; visiting players.
          </h1>
          <p className="mt-5 max-w-2xl text-stone-600 leading-relaxed text-lg">
            We are a private club. Play is for members and their accompanied
            guests. The notes below help everyone enjoy a relaxed visit.
          </p>
        </div>
      </section>

      <section className="bg-white border-y border-club-stone">
        <div className="max-w-7xl mx-auto px-6 md:px-10 py-20 grid md:grid-cols-2 gap-12">
          <div>
            <MarketingEyebrow>Dress code</MarketingEyebrow>
            <h2 className="mt-3 font-serif text-2xl">On the course</h2>
            <ul className="mt-4 space-y-2 text-stone-700 text-sm">
              <li>• Collared golf shirts or mock turtlenecks</li>
              <li>• Tailored shorts (above the knee) or golf trousers</li>
              <li>• Soft-spike or spikeless golf shoes only</li>
              <li>• Hats off in the clubhouse</li>
            </ul>
            <h2 className="mt-8 font-serif text-2xl">In the clubhouse</h2>
            <ul className="mt-4 space-y-2 text-stone-700 text-sm">
              <li>• Smart casual minimum: collared shirts and tailored trousers</li>
              <li>• No denim or athletic wear in the main dining rooms</li>
              <li>• The grill room is intentionally relaxed — golf attire welcome</li>
            </ul>
          </div>
          <div>
            <MarketingEyebrow>Pace of play</MarketingEyebrow>
            <h2 className="mt-3 font-serif text-2xl">Our standard</h2>
            <p className="mt-4 text-stone-700 leading-relaxed">
              We hold every group, member or guest, to a 4-hour-15 round. Marshals
              are friendly but firm. If your group falls more than half a hole
              behind, please wave the group behind through.
            </p>
            <h2 className="mt-8 font-serif text-2xl">On the day</h2>
            <ul className="mt-4 space-y-2 text-stone-700 text-sm">
              <li>• Arrive 30 minutes before your tee time</li>
              <li>• The bag drop is staffed during all daylight hours</li>
              <li>• Mobile phones on silent throughout the property</li>
              <li>• Tipping is at the discretion of your hosting member</li>
            </ul>
          </div>
        </div>
      </section>

      <section>
        <div className="max-w-7xl mx-auto px-6 md:px-10 py-20">
          <div className="rounded-2xl bg-club-green-50 border border-club-green-100 p-10 md:p-14 flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
            <div className="max-w-xl">
              <h2 className="font-serif text-2xl md:text-3xl text-club-ink">Hosting a guest?</h2>
              <p className="mt-3 text-stone-700 leading-relaxed">
                Members may sponsor up to three guests per round. Please book
                guest play through the Member Area or with our Pro Shop staff.
              </p>
            </div>
            <SecondaryCTA href="/member-area">Member Area</SecondaryCTA>
          </div>
        </div>
      </section>
    </PublicClubLayout>
  );
}
