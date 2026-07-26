// Phase 2 — Settings Workspace Proof.
//
// Source-contract test that locks the /app/admin/settings migration
// against regression. This is NOT a visual regression test — the
// Playwright captures under `test-results/phase2-settings/` cover
// that dimension. This suite asserts:
//
//   • The page consumes the Design Language (spectre-*) primitives
//     rather than the legacy .card / .btn / .input / .page-title.
//   • Every original form field is preserved by name and default source.
//   • The server action still writes the same nine Club fields.
//   • The link out to /app/admin/settings/domains is preserved.
//   • The Product Language configuration-page grammar is present:
//     the page renders section headers, a subtitle, an inline save
//     status, and a primary save action.
//   • The read-only Operational settings block that displays raw
//     valueJson strings still exists.
//   • The AdminShell now routes /app/admin/settings (exact URL) into
//     Spectre chrome but leaves the sub-routes on the legacy chrome.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();

const PAGE_SRC = fs.readFileSync(
  path.join(REPO_ROOT, "src/app/app/admin/settings/page.tsx"),
  "utf8",
);
const CLIENT_SRC = fs.readFileSync(
  path.join(REPO_ROOT, "src/app/app/admin/settings/settings-client.tsx"),
  "utf8",
);
const ADMIN_SHELL_SRC = fs.readFileSync(
  path.join(REPO_ROOT, "src/components/admin/AdminShell.tsx"),
  "utf8",
);

describe("Phase 2 — /app/admin/settings adopts the Design Language", () => {
  it("does NOT use the legacy .card / .btn-primary / .input / .page-title / .table-base / .label classes", () => {
    // Guard against a partial migration where the page still leans on
    // legacy chrome. Any of these classes appearing anywhere in the
    // page source blocks acceptance.
    // Match legacy names ONLY when they appear as standalone class
    // tokens — never as substrings of a `spectre-*` class. A legacy
    // class is preceded by `"`, `\s`, or start-of-attribute, and
    // followed by `"`, `\s`, or end-of-attribute — never by `-`.
    for (const cls of ["card", "card-body", "btn", "btn-primary", "btn-secondary", "btn-danger", "btn-ghost", "input", "label", "page-title", "section-title", "table-base"]) {
      const re = new RegExp(`className\\s*=\\s*"[^"]*(?<![-\\w])${cls}(?![-\\w])[^"]*"`);
      expect(re.test(PAGE_SRC), `Legacy class "${cls}" present in page source`).toBe(false);
    }
  });

  it("consumes the Spectre design-language primitives", () => {
    expect(PAGE_SRC).toMatch(/\bspectre-input\b/);
    expect(PAGE_SRC).toMatch(/\bspectre-label\b/);
    expect(PAGE_SRC).toMatch(/\bspectre-help\b/);
    expect(PAGE_SRC).toMatch(/\bspectre-check\b/);
    expect(PAGE_SRC).toMatch(/\bspectre-btn\b/);
    expect(PAGE_SRC).toMatch(/\bspectre-btn--(?:primary|secondary)\b/);
    expect(PAGE_SRC).toMatch(/text-spectre-h1|text-spectre-h2/);
  });

  it("uses only Design-Language spacing tokens on the page shell", () => {
    // Spot-check: every gap/padding/margin at the section level
    // should use the `spectre-*` spacing alias, not raw pixel or
    // arbitrary Tailwind units.
    const suspects = PAGE_SRC.match(/(?:p-|py-|px-|gap-|mt-|mb-)\[?[0-9]+px?\]?/g) ?? [];
    expect(suspects, `Non-token spacing: ${suspects.join(", ")}`).toEqual([]);
  });
});

describe("Phase 2 — Settings functional preservation", () => {
  const FIELDS = ["name", "wordmark", "region", "salesTaxRegion", "address", "foundedYear", "primaryColor", "logoUrl", "whitelabelEnabled"] as const;

  for (const f of FIELDS) {
    it(`preserves the form field "${f}"`, () => {
      const re = new RegExp(`name=\\{?["\']${f}["\']\\}?`);
      expect(re.test(PAGE_SRC), `${f} input missing`).toBe(true);
    });
    it(`server action still reads formData.get("${f}") and writes it to prisma.club.update`, () => {
      const readRe = new RegExp(`formData\\.get\\(["\']${f}["\']\\)`);
      expect(readRe.test(PAGE_SRC), `${f} not read from formData`).toBe(true);
      // The field name must also appear in the data-object passed to
      // prisma.club.update — we grep for `${field}:` after `data:`.
      const dataMatch = PAGE_SRC.match(/prisma\.club\.update\([\s\S]{0,400}data:\s*\{([\s\S]{0,800})\}/);
      expect(dataMatch, "prisma.club.update call not found").toBeTruthy();
      const dataBlock = dataMatch![1];
      const inDataRe = new RegExp(`\\b${f}\\s*:`);
      expect(inDataRe.test(dataBlock), `${f} missing from prisma.club.update data`).toBe(true);
    });
  }

  it("still calls revalidatePath('/app/admin/settings') after a successful save", () => {
    expect(PAGE_SRC).toMatch(/revalidatePath\(["']\/app\/admin\/settings["']\)/);
  });

  it("preserves the link out to /app/admin/settings/domains", () => {
    expect(PAGE_SRC).toMatch(/href=["']\/app\/admin\/settings\/domains["']/);
  });

  it("preserves the link to the public application page (/clubs/{slug}/apply)", () => {
    expect(PAGE_SRC).toMatch(/\/clubs\/\$\{club\.slug\}\/apply/);
  });

  it("does not introduce a new permission gate on the top-level page (preservation)", () => {
    // The pre-migration behaviour only checked getCurrentUser().
    // If we added `hasPermission(...)` we'd be changing business
    // logic; assert we did not.
    expect(PAGE_SRC).not.toMatch(/hasPermission\s*\(/);
  });

  it("does not introduce autosave (explicit save preserved per the brief)", () => {
    // useDebouncedCallback / setInterval / setTimeout for autosave
    // would be evidence of an autosave path being introduced.
    expect(PAGE_SRC).not.toMatch(/setInterval\s*\(/);
    expect(CLIENT_SRC).not.toMatch(/setInterval\s*\(/);
    // useFormStatus is fine — it observes explicit-save pending.
  });

  it("does not render a fabricated audit / activity stream in the JSX", () => {
    // Strip line-level and block comments before searching so a
    // Product-Language reference in a code comment does not fail the
    // guard.
    const stripComments = (s: string) =>
      s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const pageBody = stripComments(PAGE_SRC);
    const clientBody = stripComments(CLIENT_SRC);
    for (const re of [/activity[- ]feed/i, /audit[- ]log/i, /change[- ]history/i, /operational feed/i, /Live · Refreshes/i]) {
      expect(re.test(pageBody), `Page renders "${re}"`).toBe(false);
      expect(re.test(clientBody), `Client renders "${re}"`).toBe(false);
    }
  });
});

describe("Phase 2 — Product Language configuration grammar", () => {
  it("renders three configuration sections (Club profile · Custom domains · Operational settings)", () => {
    expect(PAGE_SRC).toMatch(/title=["']Club profile["']/);
    expect(PAGE_SRC).toMatch(/title=["']Custom domains["']/);
    expect(PAGE_SRC).toMatch(/title=["']Operational settings["']/);
  });

  it("provides an inline save-state indicator (Product Language §12)", () => {
    expect(CLIENT_SRC).toMatch(/data-testid=["']settings-save-status["']/);
    expect(CLIENT_SRC).toMatch(/Unsaved changes/);
    expect(CLIENT_SRC).toMatch(/Saving/);
    expect(CLIENT_SRC).toMatch(/Saved at/);
    expect(CLIENT_SRC).toMatch(/Failed to save/);
  });

  it("verb + object primary action ('Save changes'), never a prohibited label", () => {
    expect(CLIENT_SRC).toMatch(/>\s*Save changes\s*</);
    // Product Language §5 anti-pattern verbs must not appear as button labels.
    expect(PAGE_SRC).not.toMatch(/>\s*(Manage|Submit|Proceed|Enter|Go|Continue)\s*</);
    expect(CLIENT_SRC).not.toMatch(/>\s*(Manage|Submit|Proceed|Enter|Go|Continue)\s*</);
  });

  it("relabels the domains link from 'Manage domains' to a verb+object", () => {
    // Preserve destination; just update the label to comply with §5.
    expect(PAGE_SRC).toMatch(/Open custom domains/);
    expect(PAGE_SRC).not.toMatch(/>\s*Manage domains\s*</);
  });

  it("club identity fields carry Impact/consequence helper text per §3.C", () => {
    // Every field renders with either `help` or the checkbox's help
    // slot. Spot-check the whitelabel toggle whose impact is
    // non-obvious.
    expect(PAGE_SRC).toMatch(/When enabled, the Spectre wordmark is hidden on this club's custom hostnames/);
  });

  it("does NOT use editorial vocabulary prohibited by §10", () => {
    // Product Language explicitly prohibits mastheads, Roman numeral
    // sections ("I ·", "II ·"), italic-serif conditions, "Volume XVIII"
    // treatments, "Statement of…" phrasing, "Morning brief".
    expect(PAGE_SRC).not.toMatch(/Volume\s+[IVX]+/i);
    expect(PAGE_SRC).not.toMatch(/^\s*[IVX]+\s+·/m);
    expect(PAGE_SRC).not.toMatch(/Statement of the Club/i);
    expect(PAGE_SRC).not.toMatch(/Morning Brief/i);
    expect(PAGE_SRC).not.toMatch(/Council Table/i);
    expect(PAGE_SRC).not.toMatch(/Command Cent(er|re)/i);
  });
});

describe("Phase 2 — AdminShell routes only /app/admin/settings into Spectre mode (not the sub-routes)", () => {
  it("adds /app/admin/settings to SPECTRE_MODE_PREFIXES", () => {
    expect(ADMIN_SHELL_SRC).toMatch(/SPECTRE_MODE_PREFIXES[\s\S]{0,300}\/app\/admin\/settings/);
  });

  it("declares /app/admin/settings as an EXACT-URL entry so sub-routes stay on the legacy chrome", () => {
    expect(ADMIN_SHELL_SRC).toMatch(/SPECTRE_MODE_EXACT_URLS[\s\S]{0,200}\/app\/admin\/settings/);
  });

  it("isSpectreModePath honours the EXACT-URL list", () => {
    expect(ADMIN_SHELL_SRC).toMatch(/isSpectreModePath[\s\S]{0,400}SPECTRE_MODE_EXACT_URLS/);
  });
});
