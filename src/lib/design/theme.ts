// Spectre Design Language — theme utility.
//
// Three user options:
//   • "light"  — force the light theme (default when nothing is stored)
//   • "dark"   — force the dark theme
//   • "system" — follow the OS `prefers-color-scheme` media query
//
// Persistence: `localStorage[spectre-theme]`. Server-rendered HTML
// carries no `data-theme` attribute; the `THEME_BOOTSTRAP_JS` script
// in `src/app/layout.tsx` stamps it during the browser's very first
// paint. Once React hydrates, `ThemeProvider` takes over and manages
// the attribute + storage on user toggles.
//
// The theme system operates ENTIRELY on `<html data-theme="dark">`
// (no class swap, no body attribute). This keeps the surface API
// small and lets the CSS in `globals.css` express the whole dark
// theme through a single `[data-theme="dark"] { … }` block that
// overrides the `:root` semantic tokens.

export const SPECTRE_THEME_STORAGE_KEY = "spectre-theme" as const;

export type SpectreThemeChoice = "light" | "dark" | "system";
export type SpectreResolvedTheme = "light" | "dark";

/** Read the user's saved preference. Falls back to "light" when the
 *  storage is unavailable OR the stored value is invalid. */
export function readSpectreThemeChoice(): SpectreThemeChoice {
  if (typeof window === "undefined") return "light";
  try {
    const v = window.localStorage.getItem(SPECTRE_THEME_STORAGE_KEY);
    if (v === "dark" || v === "light" || v === "system") return v;
  } catch { /* localStorage disabled */ }
  return "light";
}

/** Persist a preference. Silently no-ops when storage is unavailable. */
export function writeSpectreThemeChoice(choice: SpectreThemeChoice): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SPECTRE_THEME_STORAGE_KEY, choice);
  } catch { /* silent */ }
}

/** Resolve the choice to an actually-applied theme. `"system"` reads
 *  `prefers-color-scheme`; everything else is a literal pass-through. */
export function resolveSpectreTheme(
  choice: SpectreThemeChoice,
): SpectreResolvedTheme {
  if (choice === "system") {
    if (typeof window === "undefined") return "light";
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return choice;
}

/** Stamp the resolved theme onto `<html>`. Dark stamps `data-theme`;
 *  light removes the attribute so `:root` (the light default) applies. */
export function applySpectreTheme(resolved: SpectreResolvedTheme): void {
  if (typeof document === "undefined") return;
  const el = document.documentElement;
  if (resolved === "dark") {
    el.setAttribute("data-theme", "dark");
  } else {
    el.removeAttribute("data-theme");
  }
}
