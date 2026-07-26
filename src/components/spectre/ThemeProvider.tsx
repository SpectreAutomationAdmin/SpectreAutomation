"use client";

// Spectre Design Language — client theme provider.
//
// Wraps any Spectre-mode subtree with theme state + toggling. The
// no-FOUC bootstrap script in `src/app/layout.tsx` has already stamped
// the correct `data-theme` before hydration; this component:
//
//   • initialises its React state from the same localStorage read
//     (so the toggle reflects the same value the bootstrap saw)
//   • listens for `prefers-color-scheme` changes when the user has
//     selected `"system"` and re-stamps `data-theme` on flip
//   • exposes `theme`, `resolvedTheme`, and `setTheme` via context

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  applySpectreTheme,
  readSpectreThemeChoice,
  resolveSpectreTheme,
  writeSpectreThemeChoice,
  type SpectreResolvedTheme,
  type SpectreThemeChoice,
} from "@/lib/design/theme";

type ThemeCtx = {
  theme: SpectreThemeChoice;
  resolvedTheme: SpectreResolvedTheme;
  setTheme: (choice: SpectreThemeChoice) => void;
};

const Ctx = createContext<ThemeCtx | null>(null);

export function useSpectreTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSpectreTheme must be used within <ThemeProvider>");
  return v;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Server + first render both start with "light" so the tree is
  // hydration-stable. The effect below reconciles with the value the
  // bootstrap script actually applied.
  const [theme, setThemeState] = useState<SpectreThemeChoice>("light");
  const [resolvedTheme, setResolvedTheme] = useState<SpectreResolvedTheme>("light");

  useEffect(() => {
    const c = readSpectreThemeChoice();
    setThemeState(c);
    setResolvedTheme(resolveSpectreTheme(c));
  }, []);

  // System-preference listener — only active while the user has
  // opted into "system". Uses `addEventListener` (not the deprecated
  // `addListener`).
  useEffect(() => {
    if (theme !== "system") return;
    if (typeof window === "undefined") return;
    const m = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      const next: SpectreResolvedTheme = m.matches ? "dark" : "light";
      setResolvedTheme(next);
      applySpectreTheme(next);
    };
    m.addEventListener("change", handler);
    return () => m.removeEventListener("change", handler);
  }, [theme]);

  const setTheme = useCallback((choice: SpectreThemeChoice) => {
    setThemeState(choice);
    writeSpectreThemeChoice(choice);
    const r = resolveSpectreTheme(choice);
    setResolvedTheme(r);
    applySpectreTheme(r);
  }, []);

  const value = useMemo<ThemeCtx>(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
