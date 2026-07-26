"use client";

// Spectre Design Language — application shell (Phase 1).
//
// Reads NEUTRAL from the token block in globals.css. The shell is a
// flat canvas with a sidebar column on the left, a top bar spanning
// the main column, and the workspace flush beneath. The workspace
// does NOT float; it sits inside the shell, its edges defined by
// sidebar + top bar. See `docs/design/Spectre Design Language.md` §5.
//
// The ThemeProvider is mounted here so any Spectre-mode subtree can
// use `useSpectreTheme()`. The no-FOUC bootstrap script in
// `src/app/layout.tsx` has already stamped `data-theme` on <html>
// before the provider hydrates.

import type { CSSProperties, ReactNode } from "react";
import { ThemeProvider } from "./ThemeProvider";

export function SpectreShell({
  sidebar,
  topbar,
  supportBanner,
  clubAccentStyle,
  children,
}: {
  sidebar: ReactNode;
  topbar: ReactNode;
  supportBanner?: ReactNode | null;
  clubAccentStyle?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <ThemeProvider>
      <div
        data-testid="spectre-shell"
        className="spectre-shell flex"
        style={clubAccentStyle}
      >
        {sidebar}
        <div className="flex-1 flex flex-col min-w-0">
          {topbar}
          {supportBanner}
          <main className="flex-1 min-w-0">
            <div className="spectre-workspace">{children}</div>
          </main>
        </div>
      </div>
    </ThemeProvider>
  );
}
