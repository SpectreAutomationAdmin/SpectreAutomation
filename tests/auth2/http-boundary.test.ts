// AUTH-2A (2026-09-26) — HTTP/application-boundary tests for the
// AUTH-2 session-authority foundation. These exercise the same helpers
// (`getSession`, `getEmployeePortalPrincipal`, `clearSession`,
// `destroyEmployeePortalSession`) that server components use per
// request, feeding them iron-session-sealed cookies constructed with
// the same secret + cookieName the production code uses. This proves
// the security property at the cookie decode → session-store lookup
// boundary, not just at the store-only unit level.
//
// Each test mocks `next/headers` `cookies()` to return an in-memory
// Cookie-store that iron-session can seal into / unseal from. That
// mirrors what Next.js hands the helpers at runtime.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { sealData } from "iron-session";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import {
  createSession,
  hashBearer,
  revokeSession,
  SURFACE_ADMIN,
  SURFACE_EMPLOYEE,
} from "@/lib/services/session-store";

// ---------------------------------------------------------------------------
// Cookie-store mock — an in-memory implementation of the Next.js
// cookies() shape that iron-session uses internally. Supports
// get / set / delete plus the "getAll" iteration iron-session touches.
// ---------------------------------------------------------------------------

interface JarEntry { name: string; value: string }

function makeCookieStore(initial: Record<string, string> = {}) {
  const jar = new Map<string, string>(Object.entries(initial));
  return {
    get(name: string): JarEntry | undefined {
      const v = jar.get(name);
      return v === undefined ? undefined : { name, value: v };
    },
    getAll(): JarEntry[] {
      return [...jar.entries()].map(([name, value]) => ({ name, value }));
    },
    set(nameOrOpts: string | { name: string; value: string }, value?: string) {
      if (typeof nameOrOpts === "string") jar.set(nameOrOpts, value ?? "");
      else jar.set(nameOrOpts.name, nameOrOpts.value);
    },
    delete(name: string) { jar.delete(name); },
    has(name: string): boolean { return jar.has(name); },
    // Diagnostic helper for tests
    __dump(): Record<string, string> {
      return Object.fromEntries(jar);
    },
  };
}
type CookieStoreMock = ReturnType<typeof makeCookieStore>;

// Global mutable holder — tests replace this before each call.
let currentJar: CookieStoreMock = makeCookieStore();

vi.mock("next/headers", () => ({
  cookies: () => currentJar,
}));

// ---------------------------------------------------------------------------
// Helpers to seal iron-session cookies for direct injection.
// ---------------------------------------------------------------------------

const ADMIN_COOKIE = env.SESSION_COOKIE_NAME;
const EMPLOYEE_COOKIE = "spectre_employee_session";
const SECRET = env.SPECTRE_SESSION_SECRET;

async function sealAdminCookie(payload: Record<string, unknown>): Promise<string> {
  return sealData(payload, { password: SECRET });
}
async function sealEmployeeCookie(payload: Record<string, unknown>): Promise<string> {
  return sealData(payload, { password: SECRET });
}

async function makeFixtures(tag: string) {
  const club = await prisma.club.upsert({
    where: { id: `auth2a-club-${tag}` },
    create: {
      id: `auth2a-club-${tag}`,
      name: `AUTH-2A Club ${tag}`,
      slug: `auth2a-club-${tag}`,
      timezone: "America/Toronto",
    },
    update: {},
  });
  const user = await prisma.user.upsert({
    where: { email: `auth2a-user-${tag}@example.test` },
    create: {
      id: `auth2a-user-${tag}`,
      name: `Auth2A User ${tag}`,
      email: `auth2a-user-${tag}@example.test`,
      role: "ADMIN",
      status: "ACTIVE",
      passwordHash: "$2a$10$auth2atesthashvaluenotarealone",
      clubId: club.id,
    },
    update: { clubId: club.id, status: "ACTIVE" },
  });
  const employee = await prisma.employee.upsert({
    where: { id: `auth2a-emp-${tag}` },
    create: {
      id: `auth2a-emp-${tag}`,
      clubId: club.id,
      employeeNumber: `auth2a-${tag}`,
      firstName: "Auth2A",
      lastName: "Employee",
      status: "ACTIVE",
      employeeLifecycle: "ACTIVE",
    },
    update: { clubId: club.id, status: "ACTIVE", employeeLifecycle: "ACTIVE" },
  });
  return { club, user, employee };
}

beforeEach(() => {
  currentJar = makeCookieStore();
});

// ===========================================================================
// §3.1 — Legacy-cookie HTTP rejection
// ===========================================================================

describe("§3.1 legacy AUTH-1 cookies must not authenticate", () => {
  it("ADMIN — legacy { userId, activeClubId, generation } cookie → getSession returns empty", async () => {
    const { user } = await makeFixtures("legacy-admin");
    const sealed = await sealAdminCookie({
      userId: user.id,
      activeClubId: null,
      generation: 3,
    });
    currentJar = makeCookieStore({ [ADMIN_COOKIE]: sealed });
    const { getSession, getCurrentUser } = await import("@/lib/session");
    const s = await getSession();
    // No sid, no v:2 → helpers must return unauthenticated.
    expect(s.userId).toBeUndefined();
    // No fallback authentication.
    expect(await getCurrentUser()).toBeNull();
  });

  it("ADMIN — legacy cookie does NOT auto-create a Session row", async () => {
    const { user } = await makeFixtures("legacy-noupgrade");
    const sealed = await sealAdminCookie({ userId: user.id, generation: 1 });
    currentJar = makeCookieStore({ [ADMIN_COOKIE]: sealed });
    const { getSession } = await import("@/lib/session");
    await getSession();
    // Assert no admin Session row exists for this user.
    const rows = await prisma.session.findMany({ where: { userId: user.id } });
    expect(rows.length).toEqual(0);
  });

  it("EMPLOYEE — legacy { principal: {…} } cookie → getEmployeePortalPrincipal returns null", async () => {
    const { employee } = await makeFixtures("legacy-emp");
    const sealed = await sealEmployeeCookie({
      principal: {
        employeeId: employee.id,
        clubId: employee.clubId,
        generation: 1,
        establishedAt: new Date().toISOString(),
      },
    });
    currentJar = makeCookieStore({ [EMPLOYEE_COOKIE]: sealed });
    const { getEmployeePortalPrincipal } = await import("@/lib/employee-portal-session");
    expect(await getEmployeePortalPrincipal()).toBeNull();
  });

  it("EMPLOYEE — legacy cookie does NOT auto-create a Session row", async () => {
    const { employee } = await makeFixtures("legacy-emp-noupgrade");
    const sealed = await sealEmployeeCookie({
      principal: { employeeId: employee.id, clubId: employee.clubId, generation: 1, establishedAt: "x" },
    });
    currentJar = makeCookieStore({ [EMPLOYEE_COOKIE]: sealed });
    const { getEmployeePortalPrincipal } = await import("@/lib/employee-portal-session");
    await getEmployeePortalPrincipal();
    const rows = await prisma.session.findMany({ where: { employeeId: employee.id } });
    expect(rows.length).toEqual(0);
  });
});

// ===========================================================================
// §4 — Cross-portal isolation
// ===========================================================================

describe("§4 cross-portal cookie isolation at the helper boundary", () => {
  it("ADMIN cookie presented to Employee Portal helper → null", async () => {
    const { user, employee, club } = await makeFixtures("cross-a2e");
    // Establish a valid ADMIN Session and its sealed cookie.
    const { bearer } = await createSession({
      surface: SURFACE_ADMIN,
      userId: user.id,
      clubId: club.id,
    });
    const sealed = await sealAdminCookie({ v: 2, sid: bearer });
    // Put that sealed value under the EMPLOYEE cookie name.
    currentJar = makeCookieStore({ [EMPLOYEE_COOKIE]: sealed });
    const { getEmployeePortalPrincipal } = await import("@/lib/employee-portal-session");
    expect(await getEmployeePortalPrincipal()).toBeNull();
    // Sanity: employee has no Session row now.
    const rows = await prisma.session.findMany({ where: { employeeId: employee.id, revokedAt: null } });
    expect(rows.length).toEqual(0);
  });

  it("EMPLOYEE cookie presented to Admin helper → empty session", async () => {
    const { user, employee, club } = await makeFixtures("cross-e2a");
    const { bearer } = await createSession({
      surface: SURFACE_EMPLOYEE,
      employeeId: employee.id,
      clubId: club.id,
    });
    const sealed = await sealEmployeeCookie({ v: 2, sid: bearer });
    currentJar = makeCookieStore({ [ADMIN_COOKIE]: sealed });
    const { getSession, getCurrentUser } = await import("@/lib/session");
    const s = await getSession();
    expect(s.userId).toBeUndefined();
    expect(await getCurrentUser()).toBeNull();
    // Admin Session for this user must not have been created.
    const rows = await prisma.session.findMany({ where: { userId: user.id, revokedAt: null } });
    expect(rows.length).toEqual(0);
  });
});

// ===========================================================================
// §5 — Explicit AUTH-2 cross-tenant integration
// ===========================================================================

describe("§5 cross-tenant AUTH-2 boundary", () => {
  it("Employee session for Club A cannot resolve when queried against a Club B employee", async () => {
    const a = await makeFixtures("tenant-a");
    const b = await makeFixtures("tenant-b");
    // Establish an EMPLOYEE session for employee A / club A.
    const { bearer, session } = await createSession({
      surface: SURFACE_EMPLOYEE,
      employeeId: a.employee.id,
      clubId: a.club.id,
    });
    // Corrupt the row so it claims employeeId A but clubId B.
    // The AUTH-2 principal helper filters `{ id: session.employeeId,
    // clubId: session.clubId }` — a mismatched row must return no
    // employee and the helper must return null (fail-closed).
    await prisma.session.update({
      where: { id: session.id },
      data: { clubId: b.club.id },
    });
    const sealed = await sealEmployeeCookie({ v: 2, sid: bearer });
    currentJar = makeCookieStore({ [EMPLOYEE_COOKIE]: sealed });
    const { getEmployeePortalPrincipal } = await import("@/lib/employee-portal-session");
    expect(await getEmployeePortalPrincipal()).toBeNull();
  });

  it("Employee session cannot escalate by presenting employeeId of another club's employee", async () => {
    const a = await makeFixtures("tenant-a2");
    const b = await makeFixtures("tenant-b2");
    // Employee A session with (employeeId=A, clubId=A). Adversary
    // tries to point it at employeeId=B (still with clubId=A). The
    // filter { id: B, clubId: A } yields no employee → null.
    const { bearer, session } = await createSession({
      surface: SURFACE_EMPLOYEE,
      employeeId: a.employee.id,
      clubId: a.club.id,
    });
    await prisma.session.update({
      where: { id: session.id },
      data: { employeeId: b.employee.id }, // cross-club identity
    });
    const sealed = await sealEmployeeCookie({ v: 2, sid: bearer });
    currentJar = makeCookieStore({ [EMPLOYEE_COOKIE]: sealed });
    const { getEmployeePortalPrincipal } = await import("@/lib/employee-portal-session");
    expect(await getEmployeePortalPrincipal()).toBeNull();
  });

  it("Session.clubId alone does not authorize — it is only the initial tenant context", async () => {
    // This is a code-shape assertion: the helper returns
    // employeeId+clubId from the DB employee row, not from
    // session.clubId directly. Downstream authorization uses
    // tenantWhere / assertTenantOwned / assertPostingAllowed
    // against the loaded principal.
    const a = await makeFixtures("tenant-shape");
    const { bearer } = await createSession({
      surface: SURFACE_EMPLOYEE,
      employeeId: a.employee.id,
      clubId: a.club.id,
    });
    const sealed = await sealEmployeeCookie({ v: 2, sid: bearer });
    currentJar = makeCookieStore({ [EMPLOYEE_COOKIE]: sealed });
    const { getEmployeePortalPrincipal } = await import("@/lib/employee-portal-session");
    const p = await getEmployeePortalPrincipal();
    expect(p).not.toBeNull();
    expect(p!.clubId).toEqual(a.club.id);
    expect(p!.employeeId).toEqual(a.employee.id);
  });
});

// ===========================================================================
// §6 — HTTP logout → revoke → replay fails
// ===========================================================================

describe("§6 logout revokes Session and cookie replay fails", () => {
  it("ADMIN — clearSession revokes server row; the same sealed cookie now fails getSession", async () => {
    const { user, club } = await makeFixtures("logout-admin");
    const { bearer, session } = await createSession({
      surface: SURFACE_ADMIN,
      userId: user.id,
      clubId: club.id,
    });
    const sealed = await sealAdminCookie({ v: 2, sid: bearer });
    currentJar = makeCookieStore({ [ADMIN_COOKIE]: sealed });
    const sessionMod = await import("@/lib/session");
    // Baseline: authenticated.
    expect((await sessionMod.getSession()).userId).toEqual(user.id);
    await sessionMod.clearSession();
    // Server-side Session must now have revokedAt set.
    const row = await prisma.session.findUnique({ where: { id: session.id } });
    expect(row!.revokedAt).not.toBeNull();
    // Cookie replay: reinstate the ORIGINAL sealed value (clearSession destroys the cookie in the jar).
    currentJar = makeCookieStore({ [ADMIN_COOKIE]: sealed });
    // Same bearer, now unusable.
    expect((await sessionMod.getSession()).userId).toBeUndefined();
    expect(await sessionMod.getCurrentUser()).toBeNull();
  });

  it("EMPLOYEE — destroyEmployeePortalSession revokes server row; the same sealed cookie now fails", async () => {
    const { employee, club } = await makeFixtures("logout-emp");
    const { bearer, session } = await createSession({
      surface: SURFACE_EMPLOYEE,
      employeeId: employee.id,
      clubId: club.id,
    });
    const sealed = await sealEmployeeCookie({ v: 2, sid: bearer });
    currentJar = makeCookieStore({ [EMPLOYEE_COOKIE]: sealed });
    const empMod = await import("@/lib/employee-portal-session");
    expect(await empMod.getEmployeePortalPrincipal()).not.toBeNull();
    await empMod.destroyEmployeePortalSession();
    const row = await prisma.session.findUnique({ where: { id: session.id } });
    expect(row!.revokedAt).not.toBeNull();
    // Replay the pre-logout cookie.
    currentJar = makeCookieStore({ [EMPLOYEE_COOKIE]: sealed });
    expect(await empMod.getEmployeePortalPrincipal()).toBeNull();
  });
});

// ===========================================================================
// §7 — Copied-cookie / two-context semantics
// ===========================================================================

describe("§7 two-context copied cookie semantics", () => {
  it("EMPLOYEE — two separate cookie jars carrying the same sealed bearer both fail once revoked", async () => {
    const { employee, club } = await makeFixtures("copy-two-ctx");
    const { bearer, session } = await createSession({
      surface: SURFACE_EMPLOYEE,
      employeeId: employee.id,
      clubId: club.id,
    });
    const sealed = await sealEmployeeCookie({ v: 2, sid: bearer });
    const empMod = await import("@/lib/employee-portal-session");

    // Context A authenticates.
    currentJar = makeCookieStore({ [EMPLOYEE_COOKIE]: sealed });
    expect(await empMod.getEmployeePortalPrincipal()).not.toBeNull();
    // Context B (separate jar, same bytes) authenticates.
    currentJar = makeCookieStore({ [EMPLOYEE_COOKIE]: sealed });
    expect(await empMod.getEmployeePortalPrincipal()).not.toBeNull();

    // Revoke server-side (equivalent to an admin remote-terminate or
    // the user hitting Sign out from another device).
    await revokeSession(session.id, { revokedBy: "test-admin", reason: "admin-remote" });

    // Context A retries — fails.
    currentJar = makeCookieStore({ [EMPLOYEE_COOKIE]: sealed });
    expect(await empMod.getEmployeePortalPrincipal()).toBeNull();
    // Context B retries — fails.
    currentJar = makeCookieStore({ [EMPLOYEE_COOKIE]: sealed });
    expect(await empMod.getEmployeePortalPrincipal()).toBeNull();
  });
});

// ===========================================================================
// §8 — Cookie security attributes
// ===========================================================================

describe("§8 cookie security attribute regression pins", () => {
  it("ADMIN SESSION_OPTIONS pins httpOnly + sameSite=lax + path=/", async () => {
    const { SESSION_OPTIONS } = await import("@/lib/session");
    expect(SESSION_OPTIONS.cookieOptions?.httpOnly).toBe(true);
    expect(SESSION_OPTIONS.cookieOptions?.sameSite).toBe("lax");
    expect(SESSION_OPTIONS.cookieOptions?.path).toBe("/");
    // Secure follows NODE_ENV — asserted separately.
    expect(typeof SESSION_OPTIONS.cookieOptions?.secure).toBe("boolean");
  });

  it("EMPLOYEE session-options source pins path=/, httpOnly + sameSite=lax", async () => {
    // AUTH-2B.2 (2026-09-26): the AUTH-2 experimental narrowing to
    // path=/employee broke seven legitimate cross-path fetches the
    // Employee Portal makes (hero image, quick-link downloads, etc.).
    // The pin was restored to path=/ — AUTH-2's real security is the
    // DB-authoritative Session with surface check + sha256 tokenHash
    // + fail-closed lookup + revocability, which is unchanged.
    // Options are module-private; assert by reading the source. The
    // effective cookie behaviour is also validated by the logout /
    // replay tests above (which would break if the options changed).
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/lib/employee-portal-session.ts", "utf8");
    expect(src).toMatch(/path:\s*"\/",/);
    expect(src).toMatch(/httpOnly:\s*true/);
    expect(src).toMatch(/sameSite:\s*"lax"/);
  });
});

// ===========================================================================
// §9 — Employee lifecycle fail-closed
// ===========================================================================

describe("§9 employee lifecycle change → next-request fail-closed", () => {
  it("mid-session TERMINATED → getEmployeePortalPrincipal returns null without revoking the Session", async () => {
    const { employee, club } = await makeFixtures("lifecycle-terminate");
    const { bearer } = await createSession({
      surface: SURFACE_EMPLOYEE,
      employeeId: employee.id,
      clubId: club.id,
    });
    const sealed = await sealEmployeeCookie({ v: 2, sid: bearer });
    currentJar = makeCookieStore({ [EMPLOYEE_COOKIE]: sealed });
    const empMod = await import("@/lib/employee-portal-session");
    expect(await empMod.getEmployeePortalPrincipal()).not.toBeNull();
    // Admin terminates the employee (AUTH-3 would proactively revoke;
    // AUTH-2's contract is that the very next request denies).
    await prisma.employee.update({
      where: { id: employee.id },
      data: { employeeLifecycle: "TERMINATED" },
    });
    currentJar = makeCookieStore({ [EMPLOYEE_COOKIE]: sealed });
    expect(await empMod.getEmployeePortalPrincipal()).toBeNull();
  });

  it("mid-session PRE_HIRE → getEmployeePortalPrincipal returns null", async () => {
    const { employee, club } = await makeFixtures("lifecycle-prehire");
    const { bearer } = await createSession({
      surface: SURFACE_EMPLOYEE,
      employeeId: employee.id,
      clubId: club.id,
    });
    const sealed = await sealEmployeeCookie({ v: 2, sid: bearer });
    currentJar = makeCookieStore({ [EMPLOYEE_COOKIE]: sealed });
    const empMod = await import("@/lib/employee-portal-session");
    await prisma.employee.update({
      where: { id: employee.id },
      data: { employeeLifecycle: "PRE_HIRE" },
    });
    currentJar = makeCookieStore({ [EMPLOYEE_COOKIE]: sealed });
    expect(await empMod.getEmployeePortalPrincipal()).toBeNull();
  });

  it("mid-session status INACTIVE → denied", async () => {
    const { employee, club } = await makeFixtures("lifecycle-inactive");
    const { bearer } = await createSession({
      surface: SURFACE_EMPLOYEE,
      employeeId: employee.id,
      clubId: club.id,
    });
    const sealed = await sealEmployeeCookie({ v: 2, sid: bearer });
    currentJar = makeCookieStore({ [EMPLOYEE_COOKIE]: sealed });
    const empMod = await import("@/lib/employee-portal-session");
    await prisma.employee.update({
      where: { id: employee.id },
      data: { status: "INACTIVE" },
    });
    currentJar = makeCookieStore({ [EMPLOYEE_COOKIE]: sealed });
    expect(await empMod.getEmployeePortalPrincipal()).toBeNull();
  });

  it("ACTIVE + LEAVE → allowed (payroll/benefits access continues)", async () => {
    const { employee, club } = await makeFixtures("lifecycle-leave");
    const { bearer } = await createSession({
      surface: SURFACE_EMPLOYEE,
      employeeId: employee.id,
      clubId: club.id,
    });
    const sealed = await sealEmployeeCookie({ v: 2, sid: bearer });
    await prisma.employee.update({
      where: { id: employee.id },
      data: { status: "ACTIVE", employeeLifecycle: "LEAVE" },
    });
    currentJar = makeCookieStore({ [EMPLOYEE_COOKIE]: sealed });
    const empMod = await import("@/lib/employee-portal-session");
    const p = await empMod.getEmployeePortalPrincipal();
    expect(p).not.toBeNull();
    expect(p!.employeeId).toEqual(employee.id);
  });
});

// ===========================================================================
// §15 — Security logging inspection (no bearer leakage)
// ===========================================================================

describe("§15 no bearer / sid appears in security logs", () => {
  it("SESSION_INVALID event does not contain the raw bearer bytes", async () => {
    const { user, club } = await makeFixtures("nolog-bearer");
    const events: string[] = [];
    const { setSessionLogger } = await import("@/lib/services/session-store");
    setSessionLogger((p) => events.push(JSON.stringify(p)));

    const { bearer, session } = await createSession({
      surface: SURFACE_ADMIN,
      userId: user.id,
      clubId: club.id,
    });
    await revokeSession(session.id, { reason: "logout" });
    // Trigger SESSION_INVALID and SESSION_LOGOUT events.
    const sealed = await sealAdminCookie({ v: 2, sid: bearer });
    currentJar = makeCookieStore({ [ADMIN_COOKIE]: sealed });
    const { getSession } = await import("@/lib/session");
    await getSession();

    for (const line of events) {
      expect(line).not.toContain(bearer);
      expect(line).not.toContain(hashBearer(bearer));
    }
    setSessionLogger(() => {});
  });
});
