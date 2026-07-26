// Founder rule 2026-07-14 v1.0 (Slice 1) — Spectre Design System boundary.
//
// The Monthly Reporting Package (in ALL its forms), the POS surface,
// and the Member Portal are protected surfaces during Slice 1. This
// suite asserts that:
//
//   • No file under any protected path imports from
//     `@/lib/design/tokens` or `@/components/spectre` (or any file
//     under `src/components/spectre/**`).
//   • No file under any protected path applies a `spectre-*` CSS
//     class in JSX (className attribute).
//
// If a future slice legitimately migrates one of these surfaces, that
// slice must be explicit — either by removing the surface from the
// protected list here (with founder approval) or by narrowing the
// path list to allow a specific component through.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();

// Protected surfaces — the routes the founder identified during
// Slice 1 planning. If any of these ever imports from the design
// system, the surface has silently entered a redesign that the
// founder did not approve.
const PROTECTED_PATHS: ReadonlyArray<string> = [
  // Monthly Reporting Package — the board document itself.
  "src/app/app/admin/reporting",
  // Monthly Reporting Package — the launcher + archive that the
  // founder called out as ALSO part of the protected package.
  "src/app/app/admin/governance/monthly-package",
  // Monthly Reporting Package — the frozen packages hub.
  "src/app/app/admin/governance/packages",
  // POS surface — under a separate feature freeze. POS-shared
  // components live inside `src/app/app/admin/ops/pos/**` in this
  // repo (no separate `src/components/pos` directory today), so the
  // single-route protection covers both the pages and their local
  // components.
  "src/app/app/admin/ops/pos",
  // Member Portal — Phase 3 target, must not shift visually in Slice 1.
  "src/app/app/member",
];

const FORBIDDEN_IMPORTS: ReadonlyArray<RegExp> = [
  /from ["']@\/lib\/design\/tokens["']/,
  /from ["']@\/components\/spectre(?:\/[^"']*)?["']/,
  /from ["']\.\.?\/.*\/lib\/design\/tokens["']/,
  /from ["']\.\.?\/.*\/components\/spectre(?:\/[^"']*)?["']/,
];

// Any use of the spectre-* namespace in a className string on a
// protected surface should also fail — even without an import (e.g.
// arbitrary Tailwind attributes).
const FORBIDDEN_CLASS_MARKER = /\bspectre-[a-z0-9-]+/;

function walkTs(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTs(p, acc);
    else if (/\.(ts|tsx|css|scss)$/.test(entry.name)) acc.push(p);
  }
  return acc;
}

describe("v1.0 Spectre Design System — boundary (Slice 1 protected surfaces)", () => {
  for (const rel of PROTECTED_PATHS) {
    describe(`protected surface: ${rel}`, () => {
      const abs = path.join(REPO_ROOT, rel);
      const files = walkTs(abs);

      it(`has at least one file to protect (guards against a rename silently disabling this suite)`, () => {
        expect(files.length).toBeGreaterThan(0);
      });

      for (const file of files) {
        const relFile = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
        it(`${relFile} does not import from the Spectre Design System`, () => {
          const src = fs.readFileSync(file, "utf8");
          for (const pattern of FORBIDDEN_IMPORTS) {
            expect(
              pattern.test(src),
              `${relFile} matches forbidden import ${pattern} — protected surface must not consume the design system in Slice 1`,
            ).toBe(false);
          }
        });

        it(`${relFile} does not apply a spectre-* CSS class`, () => {
          const src = fs.readFileSync(file, "utf8");
          // Only fail when the marker appears INSIDE a className / class
          // attribute value or a CSS selector. A comment that references
          // `spectre-*` for documentation is allowed.
          const classNameHits = Array.from(
            src.matchAll(/(?:className|class)=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g),
          )
            .flatMap((m) => [m[1], m[2], m[3]])
            .filter(Boolean) as string[];
          for (const val of classNameHits) {
            expect(
              FORBIDDEN_CLASS_MARKER.test(val),
              `${relFile} carries "spectre-*" class in className: "${val}"`,
            ).toBe(false);
          }
          // Also check plain CSS selectors (files ending in .css).
          if (file.endsWith(".css") || file.endsWith(".scss")) {
            expect(
              FORBIDDEN_CLASS_MARKER.test(src),
              `${relFile} contains a spectre-* CSS selector`,
            ).toBe(false);
          }
        });
      }
    });
  }
});
