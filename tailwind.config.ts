import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // ================================================================
        // Spectre Design Language — Phase 1 Tailwind aliases
        //
        // Every alias reads from a `--spectre-*` CSS variable in
        // src/app/globals.css. Nothing here overwrites an existing
        // key: `club.*`, `stone`, `sand`, etc. remain untouched, so
        // every un-migrated surface (MRP, POS, member portal, other
        // admin routes) is unaffected.
        //
        // The design language authoritatively lives at
        // `docs/design/Spectre Design Language.md`.
        // ================================================================
        spectre: {
          canvas: {
            DEFAULT: "var(--spectre-canvas)",
            sunken: "var(--spectre-canvas-sunken)",
          },
          surface: {
            DEFAULT: "var(--spectre-surface)",
            hover: "var(--spectre-surface-hover)",
            elevated: "var(--spectre-surface-elevated)",
          },
          sidebar: "var(--spectre-sidebar)",
          topbar: "var(--spectre-topbar)",
          border: {
            hairline: "var(--spectre-border-hairline)",
            DEFAULT: "var(--spectre-border-default)",
            strong: "var(--spectre-border-strong)",
          },
          text: {
            primary: "var(--spectre-text-primary)",
            secondary: "var(--spectre-text-secondary)",
            muted: "var(--spectre-text-muted)",
            subtle: "var(--spectre-text-subtle)",
            inverse: "var(--spectre-text-inverse)",
          },
          status: {
            success: "var(--spectre-status-success)",
            warning: "var(--spectre-status-warning)",
            error: "var(--spectre-status-error)",
            info: "var(--spectre-status-info)",
          },
          accent: {
            DEFAULT: "var(--spectre-accent)",
            hover: "var(--spectre-accent-hover)",
            soft: "var(--spectre-accent-soft)",
            ring: "var(--spectre-accent-ring)",
          },
        },
        // Spectre premium private club palette (LEGACY — for MRP and every
        // pre-Phase-1 admin/member surface). Untouched.
        club: {
          green: {
            50: "#f1f6f1",
            100: "#dde9dd",
            200: "#bcd3bc",
            300: "#8eb38f",
            400: "#5d8d5f",
            500: "#3f7042",
            600: "#2f5832",
            700: "#284829",
            800: "#213a22",
            900: "#0f2410",
          },
          cream: "#f8f5ef",
          sand: "#ece5d3",
          stone: "#e7e3da",
          ink: "#1a1f1a",
          gold: {
            DEFAULT: "#b08a4a",
            700: "#6b5028",
          },
        },
      },
      fontFamily: {
        serif: ["Georgia", "Cambria", "Times New Roman", "Times", "serif"],
        sans: ["-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto", "Helvetica", "Arial", "sans-serif"],
        spectre: ["var(--font-inter)", "Inter", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        "spectre-mono": ["JetBrains Mono", "SF Mono", "ui-monospace", "monospace"],
      },
      boxShadow: {
        // legacy — used by .card and pre-Phase-1 admin surfaces
        card: "0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.04)",
        elevated: "0 2px 6px rgba(0,0,0,0.05), 0 12px 32px rgba(0,0,0,0.06)",
        // Spectre Design Language — read from CSS vars so dark theme
        // and per-club accent ring naturally flow through.
        "spectre-subtle": "var(--spectre-shadow-subtle)",
        "spectre-elevated": "var(--spectre-shadow-elevated)",
        "spectre-floating": "var(--spectre-shadow-floating)",
        "spectre-dialog": "var(--spectre-shadow-dialog)",
        "spectre-focus": "var(--spectre-shadow-focus)",
      },
      borderRadius: {
        "spectre-button": "var(--spectre-radius-button)",
        "spectre-input": "var(--spectre-radius-input)",
        "spectre-card": "var(--spectre-radius-card)",
        "spectre-panel": "var(--spectre-radius-panel)",
        "spectre-dialog": "var(--spectre-radius-dialog)",
        "spectre-table": "var(--spectre-radius-table)",
        "spectre-pill": "var(--spectre-radius-pill)",
      },
      spacing: {
        // The 4/8/12/16/24/32/40/48/64/96 scale exposed under the
        // spectre-* namespace so class users can opt into the design
        // language explicitly (e.g. `pt-spectre-8`). Default Tailwind
        // spacing (0/1/2/3/4/5/6/8/10/12/16/24) is unchanged so no
        // legacy surface is affected.
        "spectre-1": "4px",
        "spectre-2": "8px",
        "spectre-3": "12px",
        "spectre-4": "16px",
        "spectre-6": "24px",
        "spectre-8": "32px",
        "spectre-10": "40px",
        "spectre-12": "48px",
        "spectre-16": "64px",
        "spectre-24": "96px",
      },
      transitionDuration: {
        "spectre-fast": "120ms",
        "spectre-base": "160ms",
        "spectre-slow": "200ms",
      },
      transitionTimingFunction: {
        spectre: "cubic-bezier(0.4, 0, 0.2, 1)",
        "spectre-in-out": "cubic-bezier(0.4, 0, 0.6, 1)",
      },
      fontSize: {
        "spectre-display": ["var(--spectre-type-display-size)", { lineHeight: "var(--spectre-type-display-line)" }],
        "spectre-h1": ["var(--spectre-type-h1-size)", { lineHeight: "var(--spectre-type-h1-line)" }],
        "spectre-h2": ["var(--spectre-type-h2-size)", { lineHeight: "var(--spectre-type-h2-line)" }],
        "spectre-h3": ["var(--spectre-type-h3-size)", { lineHeight: "var(--spectre-type-h3-line)" }],
        "spectre-body": ["var(--spectre-type-body-size)", { lineHeight: "var(--spectre-type-body-line)" }],
        "spectre-body-sm": ["var(--spectre-type-body-sm-size)", { lineHeight: "var(--spectre-type-body-sm-line)" }],
        "spectre-caption": ["var(--spectre-type-caption-size)", { lineHeight: "var(--spectre-type-caption-line)" }],
        "spectre-label": ["var(--spectre-type-label-size)", { lineHeight: "var(--spectre-type-label-line)" }],
      },
    },
  },
  plugins: [],
};

export default config;
