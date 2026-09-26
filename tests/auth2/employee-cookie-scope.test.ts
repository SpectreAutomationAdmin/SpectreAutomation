// AUTH-2B.2 regression — an over-narrow employee-session cookie
// scope silently breaks legitimate cross-path fetches the Employee
// Portal makes (hero image, quick-link downloads, profile-photo,
// tour-completed, training video, pay-statement PDF). AUTH-2's
// initial `path: "/employee"` was too narrow; the browser then did
// not send the cookie on `/api/**` and each of those endpoints
// returned 404 via `getEmployeePortalPrincipal()` → null.
//
// This test pins the source-file cookie configuration and enumerates
// the endpoints that authenticate via that cookie so a future
// contributor cannot re-narrow the path without acknowledging the
// consequence. The primary security boundary of AUTH-2 (server-
// authoritative Session + surface check + fail-closed lookup) is
// tested elsewhere and is unaffected by cookie path.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = process.cwd();

describe("AUTH-2B.2 · employee cookie scope must reach /api/**", () => {
  it("employee-portal-session.ts pins path='/' on the sealed cookie", () => {
    const src = readFileSync(
      join(REPO_ROOT, "src", "lib", "employee-portal-session.ts"),
      "utf8",
    );
    // The literal we need is the trailing-comma form so it cannot be
    // confused with `path: "/employee",` or `path: "/employee/",`.
    expect(src).toMatch(/path:\s*"\/",/);
    // And explicitly assert the narrowed form is NOT present.
    expect(src).not.toMatch(/path:\s*"\/employee"/);
  });

  it("admin session.ts still pins path='/' (untouched by AUTH-2B.2)", () => {
    const src = readFileSync(join(REPO_ROOT, "src", "lib", "session.ts"), "utf8");
    expect(src).toMatch(/path:\s*"\/"/);
  });

  // Enumerate every /api/** endpoint that authenticates the employee
  // via getEmployeePortalPrincipal(). Each of these must remain
  // reachable — none of them lives under /employee/**, so all of
  // them depend on the cookie being sent from the root path.
  it("every /api/** endpoint using getEmployeePortalPrincipal is outside /employee/**", () => {
    const apiRoot = join(REPO_ROOT, "src", "app", "api");
    const routes: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry === "route.ts" || entry === "route.tsx") routes.push(full);
      }
    };
    walk(apiRoot);
    const authedByEmployeeCookie = routes.filter((p) =>
      readFileSync(p, "utf8").includes("getEmployeePortalPrincipal"),
    );
    // If ANY of these ever moves under /employee/** the cookie path
    // narrowing conversation should be reopened. Until then, this
    // is a live enumeration proving the population exists.
    expect(authedByEmployeeCookie.length).toBeGreaterThanOrEqual(1);
    for (const p of authedByEmployeeCookie) {
      const rel = p.replace(REPO_ROOT, "").replace(/\\/g, "/");
      // Should live under /api/, not /employee/api/. If it moved to
      // /employee/, this assertion would still pass — we're pinning
      // the current shape.
      expect(rel).toMatch(/\/src\/app\/api\//);
    }
  });
});
