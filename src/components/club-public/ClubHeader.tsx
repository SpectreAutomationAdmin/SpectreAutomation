import Link from "next/link";

// Nav model. Children render as a hover/click submenu on desktop and as
// nested `<details>` rows on mobile.
export type NavItem = {
  href: string;
  label: string;
  children?: NavItem[];
};

const NAV: NavItem[] = [
  { href: "/", label: "Home" },
  { href: "/membership", label: "Membership" },
  {
    href: "/golf", label: "Golf",
    children: [
      { href: "/golf/trackman-range", label: "The Trackman Range" },
      { href: "/golf/guest-information", label: "Guest Information" },
    ],
  },
  { href: "/clubhouse", label: "Clubhouse" },
  {
    href: "/events", label: "Catering & Events",
    children: [{ href: "/events/request", label: "Event Request Form" }],
  },
  { href: "/contact", label: "Contact" },
];

export function ClubHeader({ wordmark, foundedYear }: { wordmark: string; foundedYear?: number | null }) {
  return (
    <header className="sticky top-0 z-40 bg-club-cream/95 backdrop-blur border-b border-club-stone">
      <div className="max-w-7xl mx-auto px-6 md:px-10 py-5 flex items-center justify-between gap-6">
        <Link href="/" className="flex flex-col leading-tight" aria-label="Home">
          {foundedYear ? (
            <span className="text-[11px] uppercase tracking-[0.35em] text-club-gold">Est. {foundedYear}</span>
          ) : null}
          <span className="font-serif text-2xl md:text-[1.6rem] text-club-ink">{wordmark}</span>
        </Link>

        {/* Desktop nav */}
        <nav className="hidden lg:flex items-center gap-8" aria-label="Primary">
          {NAV.map((item) => (
            item.children ? (
              <div key={item.href} className="group relative">
                <Link href={item.href} className="text-sm tracking-wide text-club-ink hover:text-club-green-700 transition-colors">
                  {item.label}
                </Link>
                <div className="invisible opacity-0 group-hover:visible group-hover:opacity-100 transition-opacity absolute left-0 top-full pt-3 z-50">
                  <ul className="bg-white border border-club-stone shadow-elevated rounded-md py-2 min-w-[14rem]">
                    {item.children.map((child) => (
                      <li key={child.href}>
                        <Link
                          href={child.href}
                          className="block px-4 py-2 text-sm text-club-ink hover:bg-club-green-50 hover:text-club-green-700"
                        >
                          {child.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : (
              <Link
                key={item.href}
                href={item.href}
                className="text-sm tracking-wide text-club-ink hover:text-club-green-700 transition-colors"
              >
                {item.label}
              </Link>
            )
          ))}
          <Link
            href="/member-area"
            className="ml-2 inline-flex items-center rounded-full border border-club-green-700 px-4 py-1.5 text-sm text-club-green-700 hover:bg-club-green-700 hover:text-white transition-colors"
          >
            Member Area
          </Link>
        </nav>

        {/* Mobile menu (CSS-only via <details>) */}
        <details className="lg:hidden relative">
          <summary className="list-none cursor-pointer text-club-ink p-2 -m-2" aria-label="Open menu">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </summary>
          <div className="fixed left-0 right-0 top-[64px] bg-club-cream border-b border-club-stone shadow-elevated">
            <ul className="max-w-7xl mx-auto px-6 py-4 space-y-2">
              {NAV.map((item) => (
                <li key={item.href}>
                  {item.children ? (
                    <details>
                      <summary className="flex items-center justify-between py-2 cursor-pointer font-serif text-lg text-club-ink list-none">
                        <span>{item.label}</span>
                        <span className="text-club-green-700 text-sm">+</span>
                      </summary>
                      <ul className="pl-3 mt-1 space-y-1 border-l border-club-stone">
                        <li>
                          <Link href={item.href} className="block py-1 text-sm text-club-ink hover:text-club-green-700">
                            Overview
                          </Link>
                        </li>
                        {item.children.map((child) => (
                          <li key={child.href}>
                            <Link href={child.href} className="block py-1 text-sm text-club-ink hover:text-club-green-700">
                              {child.label}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : (
                    <Link href={item.href} className="block py-2 font-serif text-lg text-club-ink hover:text-club-green-700">
                      {item.label}
                    </Link>
                  )}
                </li>
              ))}
              <li className="pt-2 border-t border-club-stone">
                <Link
                  href="/member-area"
                  className="block text-center rounded-full border border-club-green-700 px-4 py-2 text-sm text-club-green-700"
                >
                  Member Area
                </Link>
              </li>
            </ul>
          </div>
        </details>
      </div>
    </header>
  );
}
