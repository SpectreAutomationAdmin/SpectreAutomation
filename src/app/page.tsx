import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getActiveBranding } from "@/lib/branding";

// Root page resolves branding from the request Host header via
// getActiveBranding() and reads from Prisma. It must run per-request;
// Next.js's default static prerender path hits Prisma at build time
// and fails against a placeholder DATABASE_URL.
export const dynamic = "force-dynamic";
import { PublicClubLayout } from "@/components/club-public/PublicClubLayout";
import { HeroCarousel } from "@/components/club-public/HeroCarousel";
import {
  MarketingEyebrow, SectionHeading, TwoColumn,
  PrimaryCTA, SecondaryCTA, Testimonial, PillarCard,
} from "@/components/club-public/sections";

export default async function Root() {
  const branding = await getActiveBranding();
  if (branding.mode === "unknown") redirect("/unknown-domain");
  if (branding.mode === "club") return <ClubHome />;
  return <PlatformHome />;
}

// ---------------------------------------------------------------------------
// Club mode — public Silver Springs home.
// ---------------------------------------------------------------------------
async function ClubHome() {
  return (
    <PublicClubLayout>
      <HeroSlideshow />
      <Pillars />
      <CourseSection />
      <ClubhouseSection />
      <EventsSection />
      <BelongingSection />
      <TestimonialsSection />
      <CalloutFooter />
    </PublicClubLayout>
  );
}

// Server-side wrapper: loads the resolved club's wordmark/year/region from
// the DB on the request, then hands them to the client carousel component.
async function HeroSlideshow() {
  const branding = await getActiveBranding();
  const club = branding.clubId
    ? await prisma.club.findUnique({
        where: { id: branding.clubId },
        select: { wordmark: true, name: true, foundedYear: true, region: true },
      })
    : null;
  const wordmark = club?.wordmark ?? club?.name ?? branding.displayName;
  return <HeroCarousel wordmark={wordmark} foundedYear={club?.foundedYear ?? null} region={club?.region ?? null} />;
}

function Pillars() {
  return (
    <section className="bg-club-cream">
      <div className="max-w-7xl mx-auto px-6 md:px-10 py-20">
        <div className="grid md:grid-cols-3 gap-6">
          <PillarCard
            eyebrow="The Course"
            title="Eighteen holes of quiet excellence."
            body="A traditional parkland layout, immaculately maintained, with thoughtful pace-of-play and a championship pedigree."
            href="/golf"
            cta="See the course"
          />
          <PillarCard
            eyebrow="The Clubhouse"
            title="A second home for members and guests."
            body="Refined dining, a relaxed grill, locker rooms, and the kind of quiet corners where good conversation happens."
            href="/clubhouse"
            cta="Visit the clubhouse"
          />
          <PillarCard
            eyebrow="Events"
            title="Weddings, banquets, and private gatherings."
            body="A storied venue for the moments that matter most — supported by an experienced events team and a flexible banquet space."
            href="/events"
            cta="Host an event"
          />
        </div>
      </div>
    </section>
  );
}

function CourseSection() {
  return (
    <section className="bg-white border-y border-club-stone">
      <div className="max-w-7xl mx-auto px-6 md:px-10 py-24">
        <TwoColumn variant="fairway">
          <MarketingEyebrow>A premier private golf club</MarketingEyebrow>
          <h3 className="mt-3 font-serif text-3xl md:text-4xl leading-tight">
            A course that rewards patience, shot-making, and a love of the game.
          </h3>
          <p className="mt-5 text-stone-600 leading-relaxed">
            Mature trees, undulating greens, and a routing that flows naturally with
            the land. We keep the course in tournament-ready condition all season
            and welcome members and their guests to play it at a relaxed,
            considerate pace.
          </p>
          <ul className="mt-6 space-y-2 text-sm text-stone-700">
            <li className="flex gap-3"><span className="text-club-green-700">✦</span> 18-hole championship layout</li>
            <li className="flex gap-3"><span className="text-club-green-700">✦</span> Year-round Trackman simulator bays</li>
            <li className="flex gap-3"><span className="text-club-green-700">✦</span> Practice green, chipping area, and driving range</li>
            <li className="flex gap-3"><span className="text-club-green-700">✦</span> Member tournaments + competitive event calendar</li>
          </ul>
          <div className="mt-8 flex flex-wrap gap-3">
            <PrimaryCTA href="/golf">Course details</PrimaryCTA>
            <SecondaryCTA href="/golf/trackman-range">The Trackman Range</SecondaryCTA>
          </div>
        </TwoColumn>
      </div>
    </section>
  );
}

function ClubhouseSection() {
  return (
    <section>
      <div className="max-w-7xl mx-auto px-6 md:px-10 py-24">
        <TwoColumn imageSide="right" variant="clubhouse">
          <MarketingEyebrow>Clubhouse &amp; dining</MarketingEyebrow>
          <h3 className="mt-3 font-serif text-3xl md:text-4xl leading-tight">
            Where rounds end and evenings begin.
          </h3>
          <p className="mt-5 text-stone-600 leading-relaxed">
            A warm, considered clubhouse with three distinct dining rooms, a
            relaxed grill, and a quiet library lounge. Open year-round to members
            and their accompanied guests. Menus change with the season.
          </p>
          <div className="mt-8">
            <SecondaryCTA href="/clubhouse">Explore the clubhouse</SecondaryCTA>
          </div>
        </TwoColumn>
      </div>
    </section>
  );
}

function EventsSection() {
  return (
    <section className="bg-club-sand/40 border-y border-club-stone">
      <div className="max-w-7xl mx-auto px-6 md:px-10 py-24">
        <TwoColumn variant="events">
          <MarketingEyebrow>Catering &amp; private events</MarketingEyebrow>
          <h3 className="mt-3 font-serif text-3xl md:text-4xl leading-tight">
            For the moments that matter most.
          </h3>
          <p className="mt-5 text-stone-600 leading-relaxed">
            From intimate dinners to ceremonies on the lawn, our events team has
            been hosting weddings, banquets, and corporate gatherings for decades.
            Send us a note and we&rsquo;ll be in touch within the week.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <PrimaryCTA href="/events/request">Request an event</PrimaryCTA>
            <SecondaryCTA href="/events">View venue details</SecondaryCTA>
          </div>
        </TwoColumn>
      </div>
    </section>
  );
}

function BelongingSection() {
  return (
    <section>
      <div className="max-w-7xl mx-auto px-6 md:px-10 py-24">
        <div className="grid md:grid-cols-2 gap-12 items-start">
          <SectionHeading
            eyebrow="Belonging"
            title={<>A private club is, above all, its people.</>}
            lede="Membership is by invitation and sponsorship. Categories accommodate the way families and individuals actually use the club — from young professionals to long-tenured members."
          />
          <div className="space-y-5 text-stone-600 leading-relaxed">
            <p>
              We have welcomed three generations of members through these doors.
              The culture is warm, the standards are high, and the friendships
              are the kind that last for decades.
            </p>
            <p>
              If you&rsquo;re curious about joining, the best place to start is a
              conversation with our membership team.
            </p>
            <div className="pt-2">
              <PrimaryCTA href="/membership">Membership inquiries</PrimaryCTA>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function TestimonialsSection() {
  return (
    <section className="bg-club-green-50/60 border-y border-club-stone">
      <div className="max-w-7xl mx-auto px-6 md:px-10 py-24">
        <div className="max-w-3xl">
          <MarketingEyebrow>Member stories</MarketingEyebrow>
          <h3 className="mt-3 font-serif text-3xl md:text-4xl leading-tight">In our members&rsquo; words.</h3>
        </div>
        <div className="mt-10 grid md:grid-cols-3 gap-6">
          <Testimonial
            quote="We joined three decades ago for the course. We've stayed for the people. Every milestone our family has marked, we've marked here."
            name="Margaret & John H."
            tenure="Members since 1996"
          />
          <Testimonial
            quote="The course is beautifully kept and the pace of play is what I'd want anywhere I tee it up. The kids' programs are first-rate too."
            name="Daniel R."
            tenure="Member since 2014"
          />
          <Testimonial
            quote="What I appreciate most is the quiet — no pretension, no fuss. Just a club that knows exactly what it is."
            name="Sarah P."
            tenure="Member since 2008"
          />
        </div>
      </div>
    </section>
  );
}

function CalloutFooter() {
  return (
    <section>
      <div className="max-w-7xl mx-auto px-6 md:px-10 py-24">
        <div className="rounded-2xl bg-club-green-800 text-club-cream p-12 md:p-16 flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
          <div className="max-w-xl">
            <div className="text-[11px] uppercase tracking-[0.35em] text-club-gold/80">Visit Silver Springs</div>
            <h3 className="mt-3 font-serif text-3xl md:text-4xl leading-tight">
              Come for a round. Stay for the rest.
            </h3>
            <p className="mt-3 text-club-cream/80">
              Members may sponsor a guest at any time. Prospective members are
              invited to begin a conversation with our membership team.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/contact"
              className="inline-flex items-center justify-center rounded-md bg-club-cream text-club-green-800 px-6 py-3 text-sm font-medium hover:bg-white"
            >
              Contact us
            </Link>
            <Link
              href="/membership"
              className="inline-flex items-center justify-center rounded-md border border-club-cream/40 text-club-cream px-6 py-3 text-sm font-medium hover:bg-club-cream/10"
            >
              Become a Member
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Platform mode — Spectre marketing (kept verbatim from prior version).
// ---------------------------------------------------------------------------
async function PlatformHome() {
  const demoClub = await prisma.club.findFirst({ orderBy: { createdAt: "asc" } });
  return (
    <main className="min-h-screen bg-club-cream text-club-ink">
      <nav className="px-8 py-6 flex items-center justify-between max-w-7xl mx-auto">
        <div>
          <div className="text-xs uppercase tracking-[0.3em] text-club-green-700">Spectre</div>
          <div className="font-serif text-2xl">Spectre Automation</div>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/login" className="btn btn-ghost">Sign in</Link>
          <Link href="/login" className="btn btn-primary">Request a Demo</Link>
        </div>
      </nav>

      <section className="px-8 pt-12 pb-24 max-w-7xl mx-auto">
        <div className="max-w-3xl">
          <div className="text-xs uppercase tracking-[0.3em] text-club-green-700">For Private Clubs</div>
          <h1 className="mt-4 font-serif text-5xl md:text-6xl leading-tight text-club-ink">
            The operating system for private golf and country clubs.
          </h1>
          <p className="mt-6 text-lg text-stone-600 max-w-2xl">
            Spectre unifies member onboarding, accounts receivable, collections, financing, events, and the member experience —
            in a single, beautifully crafted platform purpose-built for premium clubs.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/login" className="btn btn-primary px-6 py-3 text-base">Sign in</Link>
            {demoClub && (
              <Link href={`/clubs/${demoClub.slug}/apply`} className="btn btn-secondary px-6 py-3 text-base">
                View Demo Club
              </Link>
            )}
          </div>
        </div>
      </section>

      <section className="bg-white border-y border-stone-200">
        <div className="px-8 py-20 max-w-7xl mx-auto">
          <div className="max-w-2xl">
            <div className="text-xs uppercase tracking-[0.3em] text-club-green-700">Platform</div>
            <h2 className="mt-3 font-serif text-3xl md:text-4xl">Everything your club runs on, in one place.</h2>
          </div>
          <div className="mt-14 grid md:grid-cols-2 lg:grid-cols-4 gap-6">
            <FeatureCard title="Magical Member Onboarding" body="From application to welcome timeline — a thoughtful, premium first impression for every new member." />
            <FeatureCard title="Member AR & Collections" body="Modern accounts receivable with member-friendly aging, automated dunning, and warm collection workflows." />
            <FeatureCard title="Finance & Admin Dashboard" body="A controller-grade view of AR, financing receivables, failed payments, and month-to-date activity." />
            <FeatureCard title="Club-Branded Member Hub" body="A polished, personalized member portal for accounts, events, tee times, and amenities." />
          </div>
        </div>
      </section>

      <footer className="px-8 py-10 max-w-7xl mx-auto flex items-center justify-between text-sm text-stone-500">
        <div>© {new Date().getFullYear()} Spectre Automation</div>
        <div>Demo build — for evaluation only</div>
      </footer>
    </main>
  );
}

function FeatureCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-stone-200 p-6 bg-club-cream/40">
      <div className="h-10 w-10 rounded-md bg-club-green-700 text-white flex items-center justify-center font-serif text-lg">S</div>
      <div className="mt-5 font-serif text-xl text-club-ink">{title}</div>
      <p className="mt-2 text-sm text-stone-600 leading-relaxed">{body}</p>
    </div>
  );
}
