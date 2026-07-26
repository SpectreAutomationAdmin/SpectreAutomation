// Founder rule 2026-06-30 v14.4 — flash-cookie cleanup pattern.
//
// The imports page renders in a Server Component, which Next.js
// forbids from mutating cookies. The v14.3 shipment inadvertently
// left `cookies().delete(...)` calls in the render body — they
// throw at request time with:
//
//   "Cookies can only be modified in a Server Action or Route Handler."
//
// This suite locks in the split fix:
//
//   1. page.tsx READS the flash cookies but never DELETES them.
//   2. FlashClear.tsx is a "use client" component that fires a
//      POST after mount.
//   3. The Route Handler at /clear-flash IS a valid cookie-
//      mutation context and calls cookies().delete(...).

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const PAGE = path.resolve(process.cwd(), "src/app/app/admin/imports/page.tsx");
const CLEAR = path.resolve(process.cwd(), "src/app/app/admin/imports/FlashClear.tsx");
const ROUTE = path.resolve(process.cwd(), "src/app/app/admin/imports/clear-flash/route.ts");

describe("v14.4 — flash-cookie cleanup: no cookie mutation in Server Component render", () => {
  it("page.tsx reads flash cookies but does NOT delete them (the crash)", () => {
    const src = fs.readFileSync(PAGE, "utf8");
    // Read is still allowed.
    expect(src).toMatch(/cookies\(\)\.get\("spectre_import_error"\)/);
    expect(src).toMatch(/cookies\(\)\.get\("spectre_import_notice"\)/);
    // Delete calls are gone — this is what was crashing.
    expect(src).not.toMatch(/cookies\(\)\.delete\(/);
  });

  it("page.tsx mounts <FlashClear/> when either flash cookie is present", () => {
    const src = fs.readFileSync(PAGE, "utf8");
    expect(src).toMatch(/import \{ FlashClear \} from "\.\/FlashClear"/);
    // Guard on `(error || notice)` so we don't fire the cleanup
    // POST on every idle visit.
    expect(src).toMatch(/\(error \|\| notice\) && <FlashClear/);
  });
});

describe("v14.4 — FlashClear client component", () => {
  it("declares 'use client' + fires POST /app/admin/imports/clear-flash on mount", () => {
    const src = fs.readFileSync(CLEAR, "utf8");
    expect(src).toMatch(/^"use client"/);
    expect(src).toMatch(/useEffect\(\(\) => \{/);
    expect(src).toMatch(/fetch\("\/app\/admin\/imports\/clear-flash", \{[\s\S]*method: "POST"/);
  });

  it("returns null (side-effect only, no DOM)", () => {
    const src = fs.readFileSync(CLEAR, "utf8");
    expect(src).toMatch(/return null;/);
  });

  it("swallows fetch failures so a network hiccup doesn't break the page", () => {
    const src = fs.readFileSync(CLEAR, "utf8");
    expect(src).toMatch(/\.catch\(\(\) => \{[\s\S]*?\}\)/);
  });
});

describe("v14.4 — /clear-flash Route Handler", () => {
  it("exports POST + deletes BOTH flash cookies (spectre_import_error + spectre_import_notice)", () => {
    const src = fs.readFileSync(ROUTE, "utf8");
    expect(src).toMatch(/import \{ cookies \} from "next\/headers"/);
    expect(src).toMatch(/export async function POST\(\)/);
    expect(src).toMatch(/"spectre_import_error"/);
    expect(src).toMatch(/"spectre_import_notice"/);
    expect(src).toMatch(/\.delete\(/);
    // Returns a JSON success payload so the client can inspect it if needed.
    expect(src).toMatch(/NextResponse\.json/);
  });

  it("runtime behaviour: POST() successfully deletes both cookies + returns 200 JSON", async () => {
    // Import the route handler and stub next/headers with an in-
    // memory cookie jar. This exercises the delete-cookies path
    // in a valid mutation context (Route Handler).
    const jar = new Map<string, string>([
      ["spectre_import_error", "boom"],
      ["spectre_import_notice", "ok"],
    ]);
    const deleted: string[] = [];
    const cookieStub = {
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      delete: (name: string) => { jar.delete(name); deleted.push(name); },
    };
    const { vi } = await import("vitest");
    vi.doMock("next/headers", () => ({ cookies: () => cookieStub }));
    // Re-import so the mock takes effect.
    const routeMod = await import("@/app/app/admin/imports/clear-flash/route");
    const res = await routeMod.POST();
    // Both flash cookies were cleared.
    expect(deleted).toContain("spectre_import_error");
    expect(deleted).toContain("spectre_import_notice");
    expect(jar.has("spectre_import_error")).toBe(false);
    expect(jar.has("spectre_import_notice")).toBe(false);
    // Response body reports the count.
    const body = await res.json();
    expect(body).toEqual({ cleared: 2 });
    vi.doUnmock("next/headers");
  });
});
