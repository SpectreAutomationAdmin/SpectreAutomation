import Link from "next/link";
import { PublicClubLayout } from "@/components/club-public/PublicClubLayout";
import { MarketingEyebrow, PrimaryCTA, SecondaryCTA, ImagePanel } from "@/components/club-public/sections";

const CATEGORIES = [
  {
    name: "Full",
    short: "Unrestricted golf and clubhouse privileges for the principal member and immediate family.",
    bullets: ["Year-round course access", "Family clubhouse privileges", "Junior programs included", "Reciprocal play arrangements"],
  },
  {
    name: "Intermediate",
    short: "For younger professionals (typically under 40), with a graduated path to Full.",
    bullets: ["Year-round course access", "Reduced initiation fee", "Graduated dues schedule", "Mentorship from senior members"],
  },
  {
    name: "Social",
    short: "Clubhouse, dining, events, and Trackman privileges — without on-course play.",
    bullets: ["Clubhouse + dining", "Trackman simulator access", "Member events calendar", "Pro Shop privileges"],
  },
  {
    name: "Corporate",
    short: "A nominated principal plus designees — ideal for hosting clients and partners.",
    bullets: ["Up to four designees", "Business event use", "Corporate dining privileges", "Tournament hosting"],
  },
];

export default function MembershipPage() {
  return (
    <PublicClubLayout>
      {/* Hero */}
      <section className="bg-club-green-800 text-club-cream">
        <div className="max-w-7xl mx-auto px-6 md:px-10 py-24 md:py-32">
          <MarketingEyebrow><span className="text-club-gold">Membership</span></MarketingEyebrow>
          <h1 className="mt-3 font-serif text-4xl md:text-5xl leading-tight max-w-3xl">
            Membership at Silver Springs.
          </h1>
          <p className="mt-5 max-w-2xl text-club-cream/85 text-lg leading-relaxed">
            Membership is by invitation and sponsorship. We offer a small number of
            categories, each designed around the way our members actually use the
            club — golf, dining, events, and the people they share it with.
          </p>
          <div className="mt-10 flex flex-wrap gap-3">
            <Link href="/contact" className="inline-flex items-center justify-center rounded-md bg-club-cream text-club-green-800 px-6 py-3 text-sm font-medium hover:bg-white">
              Begin a conversation
            </Link>
            <Link href="/golf" className="inline-flex items-center justify-center rounded-md border border-club-cream/40 px-6 py-3 text-sm font-medium hover:bg-club-cream/10">
              See the course
            </Link>
          </div>
        </div>
      </section>

      {/* Categories */}
      <section className="bg-club-cream">
        <div className="max-w-7xl mx-auto px-6 md:px-10 py-20">
          <div className="max-w-3xl">
            <MarketingEyebrow>Categories</MarketingEyebrow>
            <h2 className="mt-3 font-serif text-3xl md:text-4xl">A category for every chapter.</h2>
            <p className="mt-4 text-stone-600 leading-relaxed">
              Each category carries a one-time initiation contribution and annual
              dues. Our membership team will walk you through the current schedule
              during your conversation.
            </p>
          </div>

          <div className="mt-12 grid md:grid-cols-2 gap-6">
            {CATEGORIES.map((c) => (
              <article key={c.name} className="bg-white border border-club-stone rounded-2xl p-8 shadow-card">
                <div className="font-serif text-2xl text-club-ink">{c.name}</div>
                <p className="mt-3 text-stone-600 leading-relaxed">{c.short}</p>
                <ul className="mt-5 space-y-2 text-sm text-stone-700">
                  {c.bullets.map((b) => (
                    <li key={b} className="flex gap-3"><span className="text-club-green-700">✦</span> {b}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* How to join */}
      <section className="bg-white border-y border-club-stone">
        <div className="max-w-7xl mx-auto px-6 md:px-10 py-20">
          <div className="grid md:grid-cols-2 gap-12 items-center">
            <div>
              <MarketingEyebrow>How to join</MarketingEyebrow>
              <h2 className="mt-3 font-serif text-3xl md:text-4xl leading-tight">
                A considered, personal process.
              </h2>
              <ol className="mt-6 space-y-5">
                {[
                  ["Conversation", "Reach out to our membership team. We'll meet with you, learn what draws you to the club, and answer your questions."],
                  ["Sponsorship", "Membership is by sponsorship — typically a member proposes you, with one or two seconders."],
                  ["Application", "We'll guide you through the application, household details, and any required references."],
                  ["Welcome", "Once approved, you'll be welcomed to the club with an orientation and a member-host pairing for your first season."],
                ].map(([k, v], i) => (
                  <li key={k} className="grid grid-cols-[2.5rem_1fr] gap-4">
                    <div className="h-10 w-10 rounded-full bg-club-green-700 text-club-cream flex items-center justify-center font-serif">{i + 1}</div>
                    <div>
                      <div className="font-serif text-lg text-club-ink">{k}</div>
                      <p className="mt-1 text-sm text-stone-600 leading-relaxed">{v}</p>
                    </div>
                  </li>
                ))}
              </ol>
              <div className="mt-8 flex flex-wrap gap-3">
                <PrimaryCTA href="/contact">Talk to membership</PrimaryCTA>
                <SecondaryCTA href="/golf">Tour the course</SecondaryCTA>
              </div>
            </div>
            <div><ImagePanel variant="clubhouse" /></div>
          </div>
        </div>
      </section>
    </PublicClubLayout>
  );
}
