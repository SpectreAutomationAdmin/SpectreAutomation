import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { Source_Serif_4, Inter } from "next/font/google";
import "./globals.css";
import { getActiveBranding } from "@/lib/branding";

// Editorial display serif for the Executive Reporting Theme. Loaded
// once at the root so the font is cached across navigations; resolved
// only inside [data-report-theme="executive"] via globals.css so the
// rest of the project (POS, member portal, operational admin) keeps
// the Georgia fallback unchanged. See the Saguaro comparison audit
// (test-results/cmp-*.png) for the prestige-serif gap this closes.
const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  style: ["normal", "italic"],
  variable: "--font-source-serif-4",
  display: "swap",
});

// Inter — the Spectre Design Language primary sans (see
// docs/design/Spectre Design Language.md §3). Exposed via the
// `--font-inter` CSS variable so `.spectre-shell` (and any downstream
// `spectre-*` class) picks it up. Loaded here so it caches across
// navigations. Weights match the type-scale weights used in
// components (400 body, 500 nav/data, 600 headings/labels).
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-inter",
  display: "swap",
});

// Per-host metadata. On a Silver Springs club domain we render the club's
// wordmark in the browser tab and Apple PWA chrome — never "Spectre". On the
// platform host we keep the Spectre identity.
export async function generateMetadata(): Promise<Metadata> {
  let title = "Spectre Automation";
  let description = "The operating system for private golf and country clubs.";
  let appName = "Spectre";
  try {
    const branding = await getActiveBranding();
    if (branding.mode === "club") {
      const wm = branding.wordmark || branding.displayName;
      title = `${wm} Golf & Country Club`;
      description = `${wm} — a premier private golf and country club.`;
      appName = wm;
    }
  } catch {
    // Branding lookup can fail outside a request context (build time);
    // fall back to platform defaults silently.
  }
  return {
    title,
    description,
    manifest: "/manifest.json",
    appleWebApp: { capable: true, statusBarStyle: "default", title: appName },
    icons: {
      icon: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
      apple: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
    },
  };
}

export const viewport: Viewport = {
  themeColor: "#2f5832",
  width: "device-width",
  initialScale: 1,
};

// No-FOUC theme bootstrap. Reads the user's saved Spectre theme
// preference from localStorage (or falls back to `prefers-color-scheme`
// when they've selected the `system` option, or to `light` when
// nothing is stored) and stamps `data-theme` onto `<html>` BEFORE
// React hydrates. Without this, the app renders in the default light
// theme first, then the client-side ThemeProvider swaps to the
// user's real preference — producing a visible flash. The script is
// small, synchronous, and runs once per page load.
//
// The script only stamps the attribute when a real preference is
// stored; unset users continue to see the light default (which is
// the token block at `:root` in globals.css). System-preference
// tracking runs INSIDE the ThemeProvider once React is up, so this
// script does not need a matchMedia listener.
const THEME_BOOTSTRAP_JS = `
  (function () {
    try {
      var t = localStorage.getItem('spectre-theme');
      if (t === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
      } else if (t === 'system') {
        var m = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
        if (m && m.matches) document.documentElement.setAttribute('data-theme', 'dark');
      }
      // 'light' or unset → default (:root tokens apply, no attribute needed)
    } catch (_) { /* localStorage may be unavailable — silent fallback to light */ }
  })();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sourceSerif.variable} ${inter.variable}`}>
      <head>
        <script
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_JS }}
        />
      </head>
      <body>
        {children}
        <Script id="sw-register" strategy="afterInteractive">
          {/*
            Sprint 1 acceptance correction — service worker is
            registered in PRODUCTION only.

            The SW at `/public/sw.js` uses a cache-first strategy for
            `/_next/static/*`. In production this is correct because
            Next.js hashes every static-chunk URL with a content hash,
            so a new build produces a new URL — cache-first fetches
            the new chunk on first request and never re-serves the
            stale one.

            In development, Next.js does NOT hash the same URLs
            (`webpack.js`, `main-app.js`, etc. stay stable across
            recompiles), so cache-first serves stale bundles
            indefinitely and forces developers to Ctrl+Shift+R after
            every CSS or client-component edit. Gating registration
            on NODE_ENV removes the confusion at zero production
            cost — production users still get the SW (offline
            resilience, push notifications) exactly as before.

            If a user's browser has a leftover SW from a previous
            dev session, the inline `unregister` block cleans it up
            on the next visit so the fix is retroactive.
          */}
          {process.env.NODE_ENV === "production"
            ? `
                if ("serviceWorker" in navigator) {
                  window.addEventListener("load", () => {
                    navigator.serviceWorker.register("/sw.js").catch(() => {});
                  });
                }
              `
            : `
                if ("serviceWorker" in navigator && navigator.serviceWorker.getRegistrations) {
                  navigator.serviceWorker.getRegistrations().then((regs) => {
                    for (const r of regs) r.unregister();
                  }).catch(() => {});
                }
              `}
        </Script>
      </body>
    </html>
  );
}
