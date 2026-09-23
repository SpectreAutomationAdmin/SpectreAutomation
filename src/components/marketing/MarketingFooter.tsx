// WEB-1 §23 — Marketing footer.
//
// Restrained. Wordmark + short link columns + closing brand line. All
// external links point to homepage anchors so no destination is broken.

import Link from "next/link";
import { Wordmark } from "./Wordmark";

const YEAR = new Date().getFullYear();

const GROUPS = [
  {
    title: "Product",
    links: [
      { label: "Mission Control", href: "#mission-control" },
      { label: "Work Intake",     href: "#work-intake" },
      { label: "Intelligence",    href: "#intelligence" },
      { label: "Connected Club",  href: "#connected" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "Philosophy",  href: "#disappear" },
      { label: "Vision",      href: "#final" },
      { label: "Contact",     href: "#final" },
    ],
  },
  {
    title: "Practice",
    links: [
      { label: "Security",  href: "#final" },
      { label: "Privacy",   href: "#final" },
    ],
  },
];

export function MarketingFooter() {
  return (
    <footer className="mkt-surface-slate-deep mkt-grain-dark" style={{ "--mkt-grain-alpha": 0.05 } as React.CSSProperties}>
      <div className="mkt-container" style={{ paddingBlock: "clamp(3.5rem, 6vw, 5.5rem)" }}>
        <div className="mkt-footer-grid">
          <div>
            <Link href="/" aria-label="Spectre Automation home">
              <Wordmark />
            </Link>
            <p className="mkt-body mt-6" style={{ color: "#B5B0A2", maxWidth: "22em" }}>
              Built for the people who run exceptional clubs.
            </p>
          </div>
          {GROUPS.map((g) => (
            <div key={g.title}>
              <div
                className="mkt-eyebrow"
                style={{ color: "#8C8A83", marginBottom: "1.25rem" }}
              >
                {g.title}
              </div>
              <ul className="flex flex-col gap-3">
                {g.links.map((l) => (
                  <li key={l.label}>
                    <a
                      href={l.href}
                      className="mkt-body"
                      style={{ color: "#D9D3C2", fontSize: "0.92rem" }}
                    >
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div
          className="mt-16 pt-8 flex flex-col md:flex-row md:items-center md:justify-between gap-4"
          style={{ borderTop: "1px solid var(--mkt-rule-dark)" }}
        >
          <p className="mkt-body" style={{ color: "#8C8A83", fontSize: "0.82rem", margin: 0 }}>
            © {YEAR} Spectre Automation — The Operating System for Private Clubs.
          </p>
          <p className="mkt-body" style={{ color: "#8C8A83", fontSize: "0.82rem", margin: 0, fontStyle: "italic" }}>
            <span style={{ fontFamily: "var(--mkt-serif)" }}>Software should disappear into the work.</span>
          </p>
        </div>
      </div>
    </footer>
  );
}
