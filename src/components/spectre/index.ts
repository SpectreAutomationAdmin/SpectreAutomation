// Spectre Design Language — Phase 1 barrel export.
//
// Shell + theme system + icon set. Component primitives (Button,
// Input, Card, etc.) are consumed inside the gallery from
// `src/components/spectre/gallery/*` — they are not yet stabilised
// as a general-purpose library because the gallery is the review
// artifact, not a production API.
//
// Boundary tests fail if any file under a protected surface imports
// from this module.

export { SpectreShell } from "./SpectreShell";
export { SpectreSidebar } from "./SpectreSidebar";
export { SpectreTopBar } from "./SpectreTopBar";
export { ThemeProvider, useSpectreTheme } from "./ThemeProvider";
export * from "./icons";
