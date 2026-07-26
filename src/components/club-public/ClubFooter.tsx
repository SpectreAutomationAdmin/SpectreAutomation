import Link from "next/link";

export function ClubFooter({
  wordmark,
  address,
  foundedYear,
}: {
  wordmark: string;
  address?: string | null;
  foundedYear?: number | null;
}) {
  const year = new Date().getFullYear();
  return (
    <footer className="bg-club-green-800 text-club-cream/80 mt-24">
      <div className="max-w-7xl mx-auto px-6 md:px-10 py-16 grid md:grid-cols-4 gap-10">
        <div className="md:col-span-2">
          {foundedYear ? (
            <div className="text-[11px] uppercase tracking-[0.35em] text-club-gold/80">Est. {foundedYear}</div>
          ) : null}
          <div className="mt-2 font-serif text-3xl text-club-cream">{wordmark}</div>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-club-cream/70">
            A premier private golf and country club. Where tradition, hospitality,
            and a beautifully kept course come together for the people who call us home.
          </p>
        </div>

        <div>
          <div className="text-[11px] uppercase tracking-[0.25em] text-club-gold/80">Visit</div>
          <address className="not-italic mt-3 text-sm leading-relaxed text-club-cream/80">
            {address ? address.split(",").map((line, i) => <div key={i}>{line.trim()}</div>) : null}
          </address>
          <Link href="/contact" className="mt-4 inline-block text-sm text-club-cream hover:text-white border-b border-club-cream/40">
            Hours &amp; directions
          </Link>
        </div>

        <div>
          <div className="text-[11px] uppercase tracking-[0.25em] text-club-gold/80">Explore</div>
          <ul className="mt-3 space-y-2 text-sm">
            <li><Link href="/membership" className="hover:text-white">Membership</Link></li>
            <li><Link href="/golf" className="hover:text-white">Golf</Link></li>
            <li><Link href="/clubhouse" className="hover:text-white">Clubhouse</Link></li>
            <li><Link href="/events" className="hover:text-white">Catering &amp; Events</Link></li>
            <li><Link href="/member-area" className="hover:text-white">Member Area</Link></li>
          </ul>
        </div>
      </div>

      <div className="border-t border-club-cream/10">
        <div className="max-w-7xl mx-auto px-6 md:px-10 py-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-2 text-xs text-club-cream/60">
          <div>© {year} {wordmark} Golf &amp; Country Club. All rights reserved.</div>
          <div className="flex gap-4">
            <Link href="/membership" className="hover:text-white">Membership</Link>
            <Link href="/contact" className="hover:text-white">Contact</Link>
            <Link href="/member-area" className="hover:text-white">Member Area</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
