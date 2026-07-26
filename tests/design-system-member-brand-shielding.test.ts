// Founder rule (existing memory) — Members must never see the
// "Spectre" wordmark; the product is white-labelled per club.
//
// Slice 1 adds admin-side Spectre chrome, so this regression guard
// executes the memory rule: no file under `/app/member/**` embeds
// the Spectre wordmark or mounts the admin-side SpectreShell /
// SpectreSidebar / SpectreTopBar components.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const MEMBER_ROOT = path.join(REPO_ROOT, "src/app/app/member");

function walkTs(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTs(p, acc);
    else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(p);
  }
  return acc;
}

describe("Slice 1 member-brand-shielding regression", () => {
  const memberFiles = walkTs(MEMBER_ROOT);

  it("member portal has files to protect", () => {
    expect(memberFiles.length).toBeGreaterThan(0);
  });

  for (const file of memberFiles) {
    const rel = path.relative(REPO_ROOT, file).replace(/\\/g, "/");

    it(`${rel} does NOT render the "Spectre" wordmark`, () => {
      const src = fs.readFileSync(file, "utf8");
      // Match "Spectre" as user-visible text inside JSX (excluding
      // comments, imports, and identifier references). We look for
      // any occurrence of the standalone word outside common code
      // contexts (import paths and JSDoc-style comments).
      const withoutImports = src
        .replace(/import [^;]+;/g, "")
        .replace(/from ["'][^"']*["']/g, "")
        .replace(/\/\/[^\n]*/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      // The founder's brand-shielding rule: no visible wordmark.
      // "Spectre" appearing in code identifiers (e.g. an admin-only
      // import, a Spectre* component name) inside a `member/**` file
      // is ALSO forbidden — the shell components are admin-only and
      // must not be mounted here.
      expect(
        /\bSpectre\b/.test(withoutImports),
        `${rel} references "Spectre" outside of imports/comments — member portal is white-labelled per club`,
      ).toBe(false);
    });

    it(`${rel} does NOT mount SpectreShell / SpectreSidebar / SpectreTopBar`, () => {
      const src = fs.readFileSync(file, "utf8");
      expect(src).not.toMatch(/<SpectreShell\b/);
      expect(src).not.toMatch(/<SpectreSidebar\b/);
      expect(src).not.toMatch(/<SpectreTopBar\b/);
    });
  }

  it("Member Sidebar variant continues to hide the wordmark (regression on existing behaviour)", () => {
    const sidebar = fs.readFileSync(
      path.join(REPO_ROOT, "src/components/Sidebar.tsx"),
      "utf8",
    );
    // The member branch must not render a "Spectre" label.
    const memberBranch = sidebar.match(/if \(kind === ["']member["']\)[\s\S]{0,600}return[\s\S]{0,600}<\/aside>/);
    expect(memberBranch, "member sidebar branch must be present").toBeTruthy();
    expect(memberBranch![0]).not.toMatch(/>\s*Spectre\s*</);
  });
});
