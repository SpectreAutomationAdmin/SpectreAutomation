// HR-2A (2026-08-16) — Source-contract pins for the People module.
//
// Locks the invariants HR-1 established, projected forward to the
// new UI + API files:
//   • No `principal.role` / `.roleKey ===` role checks — every
//     gate must be a permission key.
//   • No direct `prisma.employee.update` / `.create` from any
//     route file. Direct `findMany` in the page loader IS allowed
//     (matches the repo's tenant-safe list-query convention).
//   • The Directory + Profile page loaders never import a reveal
//     API (`revealSin`, `revealBankAccount`, `revealTaxProfile`).
//   • The updated Member profile page permission-gates the
//     reciprocal Employee link on `hr:directory:view`.

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");

// -- small helpers ------------------------------------------------------------

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (st.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx"))) out.push(full);
  }
  return out;
}

function readAllFiles(paths: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of paths) m.set(p, readFileSync(p, "utf-8"));
  return m;
}

// -- targets ------------------------------------------------------------------
const PEOPLE_PAGES_DIR = join(REPO_ROOT, "src", "app", "app", "admin", "people");
const PEOPLE_API_DIR = join(REPO_ROOT, "src", "app", "api", "people");
const MEMBER_PROFILE = join(REPO_ROOT, "src", "app", "app", "admin", "members", "[id]", "page.tsx");

// -- guards -------------------------------------------------------------------

describe("HR-2A · source-contract pins", () => {
  it("no role-based branch (principal.role / .roleKey ===) in People pages or APIs", () => {
    const files = [...walk(PEOPLE_PAGES_DIR), ...walk(PEOPLE_API_DIR)];
    const banned = [/principal\.role\b/, /\.role\s*===/, /\.roleKey\s*===/, /roleKey\s*===\s*["']/];
    const violations: string[] = [];
    for (const [file, src] of readAllFiles(files).entries()) {
      for (const pat of banned) {
        if (pat.test(src)) violations.push(`${file} matches ${pat}`);
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("no direct prisma.employee.update / .create in People API routes", () => {
    const files = walk(PEOPLE_API_DIR);
    const banned = [/prisma\.employee\.update\b/, /prisma\.employee\.create\b/, /prisma\.employmentPeriod\.create\b/];
    const violations: string[] = [];
    for (const [file, src] of readAllFiles(files).entries()) {
      for (const pat of banned) {
        if (pat.test(src)) violations.push(`${file} matches ${pat}`);
      }
    }
    expect(
      violations,
      `People API routes must route mutations through canonical services (src/lib/hr/**):\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("no reveal API imports in Directory / Profile page loaders", () => {
    const files = walk(PEOPLE_PAGES_DIR);
    const banned = [/\brevealSin\b/, /\brevealBankAccount\b/, /\brevealTaxProfile\b/];
    const violations: string[] = [];
    for (const [file, src] of readAllFiles(files).entries()) {
      for (const pat of banned) {
        if (pat.test(src)) violations.push(`${file} matches ${pat}`);
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("Member profile: reciprocal Employee link is permission-gated on hr:directory:view", () => {
    const src = readFileSync(MEMBER_PROFILE, "utf-8");
    // The page must include both the permission-key literal and
    // the hr directory-view check symbol (either via hasPermission
    // or the permission key literal appearing in the render
    // conditional).
    expect(src).toMatch(/hr:directory:view/);
    // A permission-gated render implies at least one hasPermission
    // call somewhere in the file — the sanity check keeps the
    // page from silently regressing into an always-on link.
    expect(src).toMatch(/hasPermission\s*\(/);
  });

  it("employees POST route uses canonical HR services", () => {
    const route = readFileSync(
      join(REPO_ROOT, "src", "app", "api", "people", "employees", "route.ts"),
      "utf-8",
    );
    // Positive controls — the route must delegate to the canonical
    // services rather than assembling Prisma writes inline.
    expect(route).toMatch(/from\s+["']@\/lib\/hr\/employees["']/);
    expect(route).toMatch(/createEmployee\s*\(/);
    expect(route).toMatch(/openEmploymentPeriod\s*\(/);
    expect(route).toMatch(/createSession\s*\(/);
  });

  it("invitation POST route never returns rawToken in the response body (grep pin)", () => {
    const route = readFileSync(
      join(REPO_ROOT, "src", "app", "api", "people", "employees", "[id]", "invitation", "route.ts"),
      "utf-8",
    );
    // Assert the route never assembles a body containing rawToken:
    // any `NextResponse.json({...rawToken...})` or `{rawToken:` in
    // the source would surface here. The dev-stderr `console.error`
    // is allowed — the pin only fires on JSON body construction.
    // Extract every NextResponse.json({...}) invocation and grep
    // each for `rawToken`.
    const responseBodies = route.match(/NextResponse\.json\s*\(\s*\{[\s\S]*?\}/g) ?? [];
    for (const body of responseBodies) {
      expect(body).not.toMatch(/rawToken/);
    }
    // Also — the file MUST call transitionSession with -> INVITED
    // (that's the only authorised path to issue an invitation).
    expect(route).toMatch(/transitionSession\s*\([\s\S]*?["']INVITED["']/);
  });
});
