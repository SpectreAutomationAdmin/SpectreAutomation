// HR-2C §1-5 — Hero image UI surface source-contract.
//
// Live behaviour (upload + render on staging) covered by the Playwright
// spec in Slice C1. These pins guard the source shape so the invariants
// can't silently regress.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function src(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("HR-2C · Employee Portal hero image surface", () => {
  const hero = src("src/components/employee/EmployeePortalHero.tsx");
  const home = src("src/app/employee/(authed)/page.tsx");
  const route = src("src/app/api/clubs/[id]/employee-portal-hero/route.ts");
  const service = src("src/lib/club/media.ts");
  const uploader = src("src/app/app/admin/settings/HeroImageUploader.tsx");
  const settings = src("src/app/app/admin/settings/page.tsx");

  it("hero component uses the branded gradient fallback (never a hardcoded photo)", () => {
    expect(hero).toMatch(/linear-gradient\(135deg.+brand.+darken\(brand/);
    // No hardcoded external image / no fetch to a specific golf photo.
    expect(hero).not.toMatch(/couleeridge|couleeridge\.jpg|silversprings/i);
    expect(hero).not.toMatch(/https?:\/\/(?:images|photo|cdn)/i);
  });

  it("hero image URL uses the same-origin proxy route (never a signed URL)", () => {
    expect(hero).toMatch(/\/api\/clubs\/\$\{clubId\}\/employee-portal-hero/);
    expect(hero).not.toMatch(/X-Amz-Signature|Signature=|expires=/i);
  });

  it("hero component NEVER renders the word 'Spectre' [[feedback_member_brand_shielding]]", () => {
    // Strip comments so we only inspect user-visible JSX.
    const stripped = hero.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/Spectre/);
  });

  it("Home page passes hero props (clubId, version, hasImage, primaryColor, greetingName, positionName)", () => {
    expect(home).toMatch(/<EmployeePortalHero[\s\S]{0,500}clubId=\{principal\.clubId\}[\s\S]{0,500}hasImage=\{heroMedia !== null\}/);
    expect(home).toMatch(/getClubMedia\(principal\.clubId, "employee_portal_hero"\)/);
  });

  it("proxy route accepts either an admin settings:read or a same-club employee-portal principal", () => {
    expect(route).toMatch(/getEmployeePortalPrincipal/);
    expect(route).toMatch(/employeePortal\.clubId === clubId/);
    expect(route).toMatch(/hasPermission\(admin, clubId, "settings:read"\)/);
  });

  it("proxy route uses same-404 shape for every deny (no enumeration signal)", () => {
    expect(route).toMatch(/const NOT_FOUND = \(\) => NextResponse\.json/);
    expect(route).toMatch(/status: 404/);
    // POST + DELETE gate on settings:write with same 404 shape.
    expect(route).toMatch(/if \(!hasPermission\(principal, clubId, "settings:write"\)\) return NOT_FOUND/);
  });

  it("service uses canonical resolveDocumentStorage + clubs/{clubId}/media/... key convention", () => {
    expect(service).toMatch(/resolveDocumentStorage\(\{ clubId \}\)/);
    expect(service).toMatch(/storageKey = `clubs\/\$\{clubId\}\/media\/\$\{input\.category\}\/\$\{sha256\}`/);
    // No isolated storage adapter.
    expect(service).not.toMatch(/new S3Client\(/);
    expect(service).not.toMatch(/new PutObjectCommand\(/);
  });

  it("service requires settings:write + assertPostingAllowed on every write", () => {
    expect(service).toMatch(/requirePermission\(principal, clubId, "settings:write"\)/);
    expect(service).toMatch(/assertPostingAllowed\(principal, clubId, "club\.media\.update"/);
  });

  it("upsert semantics — one row per (clubId, category), replacement rotates in place", () => {
    expect(service).toMatch(/where: \{ clubId_category: \{ clubId, category: input\.category \} \}/);
    // Prisma schema has @@unique([clubId, category]) — confirmed by the
    // compound-key access above; nothing here can create duplicate rows.
  });

  it("admin uploader is a client component posting multipart form to the proxy route", () => {
    expect(uploader).toMatch(/^"use client";/m);
    expect(uploader).toMatch(/method: "POST"[\s\S]{0,50}body: fd/);
    expect(uploader).toMatch(/\/api\/clubs\/\$\{clubId\}\/employee-portal-hero/);
    expect(uploader).toMatch(/data-testid="hero-uploader"/);
    // Drop-zone + native file picker; no third-party uploader library.
    expect(uploader).toMatch(/onDrop=\{/);
    expect(uploader).toMatch(/data-testid="hero-uploader-input"/);
  });

  it("settings page wires the uploader with the current media state", () => {
    expect(settings).toMatch(/import HeroImageUploader/);
    expect(settings).toMatch(/getClubMedia\(clubId, "employee_portal_hero"\)/);
    expect(settings).toMatch(/<HeroImageUploader[\s\S]{0,300}initiallyHasImage=\{heroMedia !== null\}/);
  });
});
