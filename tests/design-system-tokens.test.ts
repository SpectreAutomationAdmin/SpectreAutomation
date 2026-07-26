// Founder rule 2026-07-14 (Phase 1 UI Architecture) — Spectre Design
// Language token presence.
//
// Guarantees the token registry in `src/lib/design/tokens.ts` and the
// live token declarations in `src/app/globals.css` and Tailwind aliases in
// `tailwind.config.ts` do not drift. Renaming a token, forgetting to
// declare it, or removing it from the registry fails this suite.
//
// This is a source-contract test (grep-level assertions). It is not
// a visual regression test — the Playwright captures under
// `test-results/spectre-design-language/` cover that dimension.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { SPECTRE_TOKENS, listSpectreTokenNames, SPECTRE_TAILWIND_ALIASES } from "@/lib/design/tokens";

const REPO_ROOT = process.cwd();
const GLOBALS_CSS = fs.readFileSync(path.join(REPO_ROOT, "src/app/globals.css"), "utf8");
const TAILWIND_CONFIG = fs.readFileSync(path.join(REPO_ROOT, "tailwind.config.ts"), "utf8");
const DESIGN_LANGUAGE_DOC = fs.readFileSync(path.join(REPO_ROOT, "docs/design/Spectre Design Language.md"), "utf8");

describe("Spectre Design Language — token presence", () => {
  it("every registered --spectre-* token is declared in globals.css", () => {
    const names = listSpectreTokenNames();
    expect(names.length).toBeGreaterThan(40);
    for (const name of names) {
      expect(
        GLOBALS_CSS.includes(name + ":"),
        `Token ${name} must be declared in globals.css`,
      ).toBe(true);
    }
  });

  it("declares both a `:root` (light) block and a `[data-theme=\"dark\"]` block", () => {
    expect(GLOBALS_CSS).toMatch(/:root\s*\{/);
    expect(GLOBALS_CSS).toMatch(/\[data-theme="dark"\]\s*\{/);
  });

  it("the dark theme block overrides the semantic surface / text / border tokens (proves the two themes are distinct, not identical)", () => {
    // Grep for a distinctive dark-only value.
    expect(GLOBALS_CSS).toMatch(/--spectre-canvas:\s*#0f1012/);
    expect(GLOBALS_CSS).toMatch(/--spectre-text-primary:\s*#ececec/);
  });

  it("accent defaults to the platform primary (#2f5832) so a fresh render before the wrapper populates the real value still styles the shell correctly", () => {
    expect(GLOBALS_CSS).toMatch(/--spectre-accent:\s*#2f5832/);
  });

  it("every SPECTRE_TAILWIND_ALIASES entry appears in tailwind.config.ts (either quoted or as a bare property key)", () => {
    for (const alias of SPECTRE_TAILWIND_ALIASES) {
      const quoted = TAILWIND_CONFIG.includes(`"${alias}"`);
      const bareKey = new RegExp(`(^|[\\s,{])${alias}\\s*:`, "m").test(TAILWIND_CONFIG);
      expect(
        quoted || bareKey,
        `Tailwind alias "${alias}" must appear in tailwind.config.ts (either quoted or as a bare property key)`,
      ).toBe(true);
    }
  });

  it("the spacing scale ONLY declares the ten canonical values (4/8/12/16/24/32/40/48/64/96) — no drift", () => {
    const expected = ["4px", "8px", "12px", "16px", "24px", "32px", "40px", "48px", "64px", "96px"];
    for (const px of expected) {
      const key = SPECTRE_TOKENS.spacing;
      const anyDecl = Object.keys(key).find((k) => GLOBALS_CSS.match(new RegExp(`${k}:\\s*${px}\\b`)));
      expect(anyDecl, `Spacing value ${px} must be declared by exactly one --spectre-space-* token`).toBeTruthy();
    }
  });

  it("prefers-reduced-motion rule is scoped to `.spectre-*` only, never a bare `*` selector", () => {
    const reduced = GLOBALS_CSS.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]{0,300}/);
    expect(reduced, "prefers-reduced-motion block must exist for spectre-* scope").toBeTruthy();
    expect(reduced?.[0]).toMatch(/\[class\*=["']spectre-["']\]/);
    const bareStarInReduce = /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]{0,200}\*\s*\{/;
    expect(bareStarInReduce.test(GLOBALS_CSS)).toBe(false);
  });

  it("legacy `.card`, `.btn`, `.page-title`, `.table-base` classes are still declared unchanged so non-migrated pages keep their styling", () => {
    for (const cls of [".card", ".btn", ".page-title", ".table-base", ".section-title"]) {
      expect(GLOBALS_CSS).toMatch(new RegExp(`\\${cls}\\b`));
    }
  });

  it("legacy --color-bg / --color-ink variables are still declared and unchanged", () => {
    expect(GLOBALS_CSS).toMatch(/--color-bg:\s*#f8f5ef/);
    expect(GLOBALS_CSS).toMatch(/--color-ink:\s*#1a1f1a/);
  });

  it("the Design Language doc exists and references every top-level design vector", () => {
    expect(DESIGN_LANGUAGE_DOC).toMatch(/Colour System/i);
    expect(DESIGN_LANGUAGE_DOC).toMatch(/Typography/i);
    expect(DESIGN_LANGUAGE_DOC).toMatch(/Spacing/i);
    expect(DESIGN_LANGUAGE_DOC).toMatch(/Radius/i);
    expect(DESIGN_LANGUAGE_DOC).toMatch(/Shadows/i);
    expect(DESIGN_LANGUAGE_DOC).toMatch(/Motion/i);
    expect(DESIGN_LANGUAGE_DOC).toMatch(/Theme system/i);
    expect(DESIGN_LANGUAGE_DOC).toMatch(/Iconography/i);
  });
});
