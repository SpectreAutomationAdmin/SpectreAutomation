// HR-2B.1 (2026-08-18) — Employee-facing HR layout.
//
// The /hr/* routes are for INVITED EMPLOYEES, not Spectre admins.
// This layout intentionally renders NO admin sidebar, NO Mission
// Control chrome, NO administrative navigation, NO Spectre wordmark
// — only the Club's identity. Spectre appears (if at all) as a subtle
// "Powered by Spectre" footer per the HR-2B white-label principle.
//
// Individual /hr/* pages resolve Club branding via getActiveBranding()
// (or from the invitation itself) and render their own club-branded
// header. This layout only sets the theming ground (background, font,
// max-width discipline) — deliberately spartan.

import type { ReactNode } from "react";

export default function HrEmployeeLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-stone-50 text-stone-900">
      {children}
      <footer className="mt-16 pb-8 text-center text-[10px] uppercase tracking-[0.25em] text-stone-400">
        Powered by Spectre
      </footer>
    </div>
  );
}
