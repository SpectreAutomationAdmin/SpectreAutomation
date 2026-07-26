// Founder rule 2026-07-14 v1.0 (Slice 1) — no hardcoded tenant identity.
//
// The `--spectre-club-accent*` CSS variables MUST be populated at
// request time from the ACTUAL `Club.primaryColor` field. This suite
// proves the tokens helper does the right thing for a real hex, is
// tolerant of missing / malformed input, and never leaks a
// Silver-Springs-specific value into the reusable components.

import { describe, expect, it } from "vitest";
import { buildSpectreClubAccentStyle } from "@/lib/design/tokens";
import fs from "node:fs";
import path from "node:path";

describe("v1.0 club-accent — data-driven, no hardcoded tenant identity", () => {
  it("builds the full accent-token block from a valid hex primaryColor", () => {
    const style = buildSpectreClubAccentStyle("#2f5832") as Record<string, string>;
    expect(style).toBeDefined();
    expect(style["--spectre-accent"]).toBe("#2f5832");
    // Derived tokens must all be present.
    expect(style["--spectre-accent-hover"]).toMatch(/^rgb\(/);
    expect(style["--spectre-accent-soft"]).toMatch(/^rgba\(/);
    expect(style["--spectre-accent-ring"]).toMatch(/^rgba\(/);
  });

  it("varies output when the primary colour varies (proves no hardcoding)", () => {
    const green = buildSpectreClubAccentStyle("#2f5832") as Record<string, string>;
    const navy = buildSpectreClubAccentStyle("#1a3a7a") as Record<string, string>;
    const burgundy = buildSpectreClubAccentStyle("#7a1a2a") as Record<string, string>;
    // Every distinct input yields a distinct output.
    expect(green["--spectre-accent"]).not.toBe(navy["--spectre-accent"]);
    expect(navy["--spectre-accent"]).not.toBe(burgundy["--spectre-accent"]);
    expect(green["--spectre-accent-ring"]).not.toBe(navy["--spectre-accent-ring"]);
  });

  it("returns undefined for null / undefined input so the shell wrapper falls back to the token defaults", () => {
    expect(buildSpectreClubAccentStyle(null)).toBeUndefined();
    expect(buildSpectreClubAccentStyle(undefined)).toBeUndefined();
    expect(buildSpectreClubAccentStyle("")).toBeUndefined();
  });

  it("returns undefined for malformed hex so the shell wrapper falls back to the token defaults", () => {
    expect(buildSpectreClubAccentStyle("not-a-color")).toBeUndefined();
    expect(buildSpectreClubAccentStyle("#abc")).toBeUndefined();
    expect(buildSpectreClubAccentStyle("rgb(1,2,3)")).toBeUndefined();
  });

  it("no `spectre-*` primitive in src/components/spectre/** hardcodes Silver-Springs-specific strings", () => {
    // Slice 1a-flagship KPI / identity primitives were removed when
    // the dashboard was reverted to legacy chrome; the guard now
    // sweeps the whole `src/components/spectre/**` tree so any FUTURE
    // primitive that leaks a tenant name / city / founding year fails
    // before it ships.
    const dir = path.resolve(process.cwd(), "src/components/spectre");
    const files = fs.readdirSync(dir, { recursive: true }) as string[];
    for (const rel of files) {
      if (!rel.endsWith(".tsx") && !rel.endsWith(".ts")) continue;
      const full = path.join(dir, rel);
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      const src = fs.readFileSync(full, "utf8");
      expect(src, `${rel} references Silver Springs literally`).not.toMatch(/Silver\s*Springs/i);
      expect(src, `${rel} hardcodes Calgary`).not.toMatch(/Calgary/i);
      expect(src, `${rel} hardcodes a specific founding year`).not.toMatch(/Est\.\s+19\d\d/);
      expect(src, `${rel} hardcodes Alberta`).not.toMatch(/Alberta/i);
      expect(src, `${rel} hardcodes a dollar figure`).not.toMatch(/\$[0-9,]{3,}/);
    }
  });

  it("Admin layout inlines the club-accent style AND reads primaryColor from getActiveBranding()", () => {
    const p = path.resolve(process.cwd(), "src/app/app/admin/layout.tsx");
    const src = fs.readFileSync(p, "utf8");
    expect(src).toMatch(/buildSpectreClubAccentStyle\s*\(\s*branding\.primaryColor\s*\)/);
    expect(src).toMatch(/spectreClubAccentStyle=\{spectreClubAccentStyle\}/);
    // Guard: the layout must NOT set inline style on <body> — the root
    // layout owns that element.
    expect(src).not.toMatch(/<body[^>]*style=/);
  });
});
