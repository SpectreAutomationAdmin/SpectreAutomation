"use client";

// WEB-1 §22 — Marketing navigation.
//
// Restrained, editorial navigation. Wordmark + four intent-oriented links
// (Product, Platform, Philosophy, Company) + a single CTA. Links map to
// homepage anchors so nothing is broken; separate product pages arrive in
// later WEB slices. Mobile: full-height sheet accessible via a hamburger.

import Link from "next/link";
import { useEffect, useState } from "react";
import { Wordmark } from "./Wordmark";

const NAV_LINKS = [
  { label: "Product",    href: "#mission-control" },
  { label: "Platform",   href: "#connected" },
  { label: "Philosophy", href: "#disappear" },
  { label: "Company",    href: "#final" },
];

export function MarketingNav() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (open) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  return (
    <>
      <header
        className={`fixed inset-x-0 top-0 z-40 transition-[background,border-color,backdrop-filter] duration-300`}
        style={{
          background: scrolled ? "rgba(244, 239, 227, 0.85)" : "transparent",
          borderBottom: scrolled ? "1px solid rgba(26,30,26,0.08)" : "1px solid transparent",
          backdropFilter: scrolled ? "saturate(140%) blur(8px)" : "none",
        }}
      >
        <div className="mkt-container flex items-center justify-between" style={{ paddingBlock: "1.15rem" }}>
          <Link href="/" aria-label="Spectre Automation home">
            <Wordmark />
          </Link>
          <nav className="hidden md:flex items-center" aria-label="Main">
            <ul className="flex items-center gap-8">
              {NAV_LINKS.map((l) => (
                <li key={l.href}>
                  <a
                    href={l.href}
                    className="mkt-body"
                    style={{ color: "var(--mkt-text)", fontSize: "0.86rem", letterSpacing: "0.02em" }}
                  >
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <div className="hidden md:flex items-center">
            <a href="#final" className="mkt-cta mkt-cta-primary" style={{ padding: "0.6rem 1.1rem", fontSize: "0.82rem" }}>
              Request a Demonstration
            </a>
          </div>
          <button
            type="button"
            className="md:hidden"
            aria-expanded={open}
            aria-label="Open menu"
            onClick={() => setOpen((v) => !v)}
            style={{
              background: "transparent",
              border: "1px solid var(--mkt-rule-strong)",
              padding: "0.5rem 0.85rem",
              borderRadius: "2px",
              color: "var(--mkt-text)",
              fontFamily: "var(--mkt-sans)",
              fontSize: "0.75rem",
              letterSpacing: "0.14em",
              textTransform: "uppercase",
            }}
          >
            {open ? "Close" : "Menu"}
          </button>
        </div>
      </header>

      {/* Mobile sheet */}
      {open && (
        <div
          className="md:hidden fixed inset-0 z-30"
          style={{ background: "var(--mkt-ivory)", paddingTop: "4.5rem" }}
          role="dialog"
          aria-modal="true"
          aria-label="Site navigation"
        >
          <div className="mkt-container" style={{ paddingBlock: "2rem" }}>
            <nav aria-label="Main">
              <ul className="flex flex-col gap-0" style={{ borderTop: "1px solid var(--mkt-rule)" }}>
                {NAV_LINKS.map((l) => (
                  <li key={l.href} style={{ borderBottom: "1px solid var(--mkt-rule)" }}>
                    <a
                      href={l.href}
                      onClick={() => setOpen(false)}
                      className="mkt-subhead block"
                      style={{ paddingBlock: "1.4rem", color: "var(--mkt-text)" }}
                    >
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
              <a
                href="#final"
                onClick={() => setOpen(false)}
                className="mkt-cta mkt-cta-primary mt-8"
                style={{ display: "inline-flex" }}
              >
                Request a Demonstration
              </a>
            </nav>
          </div>
        </div>
      )}
    </>
  );
}
