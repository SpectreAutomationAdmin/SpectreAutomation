// AP-ORB-3 (2026-10-15) — Orb Fidelity Lab (staging-only route).
//
// Standalone, isolated page that renders the official
// `thinking-orbs` React component in its native 64 px size with
// its own internal animation lifecycle.  No Vendor field, no
// portal, no choreography, no Spectre-specific orb styling, no
// reveal, no speed manipulation.
//
// Purpose: prove Spectre can render the authoritative orb
// faithfully, as a precondition to any further orb work.  Per
// directive §9 — stop condition: once this lab reproduces the
// original Libraries.dev Solving orb, do not integrate it into
// the Vendor field, do not alter its speed, do not add
// deceleration, do not animate text, do not extend to other
// fields.
//
// Isolation choices documented in the body comments below.

import Link from "next/link";
import OrbFidelityLabClient from "@/components/work-intake/review/OrbFidelityLabClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Orb Fidelity Lab" };

export default function OrbFidelityLabPage() {
  return (
    <div className="orb-fidelity-root" data-testid="orb-fidelity-root">
      <div className="orb-fidelity-page">
        <div className="orb-fidelity-breadcrumb">
          <Link href="/app/admin/work-intake">← Back to Work Intake</Link>
        </div>
        <h1 className="orb-fidelity-title">Orb Fidelity Lab</h1>
        <p className="orb-fidelity-caption">
          Direct render of the official <code>thinking-orbs</code> React
          component at its documented defaults.  No portal, no
          choreography, no speed manipulation, no Spectre-specific
          styling.  The orbs animate using the package's own internal
          clock.
        </p>

        <OrbFidelityLabClient />

        <aside className="orb-fidelity-notes">
          <ul>
            <li>
              Reference:{" "}
              <a href="https://libraries.dev/orbs" target="_blank" rel="noreferrer noopener">
                libraries.dev/orbs
              </a>
            </li>
            <li>
              Source:{" "}
              <a
                href="https://github.com/Jakubantalik/Libraries.dev/tree/main/packages/thinking-orbs"
                target="_blank"
                rel="noreferrer noopener"
              >
                Jakubantalik/Libraries.dev — packages/thinking-orbs
              </a>
            </li>
            <li>Installed version: <code>thinking-orbs@0.3.2</code></li>
            <li>
              API note: the current published 0.3.2 package uses{" "}
              <code>theme</code> (<code>"auto" | "light" | "dark"</code>),
              not the legacy <code>dark</code> boolean prop.
            </li>
          </ul>
        </aside>
      </div>
    </div>
  );
}
