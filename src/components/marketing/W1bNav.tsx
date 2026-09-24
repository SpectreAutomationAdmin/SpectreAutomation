"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const LINKS = [
  { label: "Product",    href: "#mission-control" },
  { label: "Platform",   href: "#connected" },
  { label: "Philosophy", href: "#philosophy" },
  { label: "Company",    href: "#final" },
];

export function W1bNav() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  return (
    <>
      <header className="w1b-nav">
        <div className="w1b-container">
          <div className="w1b-nav-inner">
            <Link href="/" className="w1b-nav-wordmark" aria-label="Spectre Automation home">
              SPECTRE / AUTOMATION
            </Link>
            <nav aria-label="Main">
              <ul className="w1b-nav-links">
                {LINKS.map((l) => (
                  <li key={l.href}><a href={l.href}>{l.label}</a></li>
                ))}
              </ul>
            </nav>
            <div className="w1b-nav-actions">
              <a href="/login" className="w1b-nav-login">Log in</a>
              <a href="mailto:hello@spectreautomation.com?subject=Spectre%20Demonstration"
                 className="w1b-nav-cta">Request a Demonstration</a>
            </div>
            <button type="button" className="w1b-nav-menu"
                    onClick={() => setOpen((v) => !v)}
                    aria-expanded={open}
                    aria-label="Open menu">
              {open ? "Close" : "Menu"}
            </button>
          </div>
        </div>
      </header>
      {open && (
        <div
          role="dialog" aria-modal="true"
          style={{
            position: "fixed", inset: 0, zIndex: 39,
            background: "var(--w1b-dark)", color: "var(--w1b-white)",
            paddingTop: "5rem",
          }}
        >
          <div className="w1b-container">
            <ul style={{ listStyle: "none", margin: 0, padding: 0, borderTop: "1px solid var(--w1b-rule)" }}>
              {LINKS.map((l) => (
                <li key={l.href} style={{ borderBottom: "1px solid var(--w1b-rule)" }}>
                  <a href={l.href} onClick={() => setOpen(false)}
                     style={{
                       display: "block", paddingBlock: "1.4rem",
                       color: "var(--w1b-white)",
                       fontFamily: "var(--w1b-serif)",
                       fontSize: "1.75rem", textDecoration: "none",
                     }}>{l.label}</a>
                </li>
              ))}
            </ul>
            <div style={{ marginTop: "2rem", display: "flex", flexDirection: "column", gap: "1rem", alignItems: "flex-start" }}>
              <a href="mailto:hello@spectreautomation.com?subject=Spectre%20Demonstration"
                 onClick={() => setOpen(false)}
                 className="w1b-pill-cta">
                Request a Demonstration
              </a>
              <a href="/login"
                 onClick={() => setOpen(false)}
                 className="w1b-nav-login"
                 style={{ fontSize: "1rem" }}>
                Log in to Spectre
              </a>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
