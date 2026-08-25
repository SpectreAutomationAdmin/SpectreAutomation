// HR mobile-hotfix (2026-08-25) — Employee Portal Sign out defect.
//
// Founder-observed on staging v285: clicking Sign out in the portal
// user-menu dropdown did not sign the employee out. Root cause: the
// route handler at /employee/logout built its redirect URL with
// `new URL("/employee/login", req.url)`, and `req.url` on Next.js
// standalone behind Fly's proxy reported the internal bind host
// `localhost:3000`. The 303 `Location` came out as
// `https://localhost:3000/employee/login` — unreachable from the
// browser. Cookie deletion was present but the failed cross-origin
// navigation left the user stranded on the old page.
//
// This suite pins:
//   * Sign out button is a POST form to /employee/logout (not a
//     link, not a client-side redirect).
//   * The route handler at src/app/employee/logout/route.ts:
//       - is POST-only;
//       - calls destroyEmployeePortalSession() (canonical
//         iron-session invalidation);
//       - explicitly clears spectre_employee_session with Max-Age=0
//         on the outgoing response;
//       - builds the redirect Location from x-forwarded-host /
//         x-forwarded-proto or the request Host header — NOT from
//         req.url / req.nextUrl.origin (which returns localhost
//         behind the Fly proxy);
//       - returns HTTP 303.
//   * The layout guard at src/app/employee/(authed)/layout.tsx
//     already redirects an unauthenticated request to /employee/login
//     (this is the Back/Refresh defence — an invalidated cookie means
//     the next /employee GET goes straight to the login page).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest } from "next/server";

function src(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}
// Strip block + line comments so historical / narrative comments in
// the source can mention the OLD buggy code without tripping the
// negative regexes that pin the FIX.
function code(rel: string): string {
  return src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// ---------------------------------------------------------------------------
// Source-contract pins.
// ---------------------------------------------------------------------------

describe("HR mobile-hotfix · Sign out wiring", () => {
  const menu     = src("src/components/employee/EmployeePortalUserMenu.tsx");
  const route    = src("src/app/employee/logout/route.ts");
  // Comment-stripped copy — for negative regexes that must not match
  // historical narrative comments about the OLD buggy behaviour.
  const routeExe = code("src/app/employee/logout/route.ts");
  const layout   = src("src/app/employee/(authed)/layout.tsx");

  it("Sign out button is a POST form to /employee/logout — not a link, not a client redirect", () => {
    // The button MUST live inside a <form action="/employee/logout" method="post">.
    expect(menu).toMatch(/<form[^>]*action="\/employee\/logout"[^>]*method="post"/);
    // The button itself must be type=submit inside that form.
    expect(menu).toMatch(/data-testid="portal-user-menu-signout"[\s\S]{0,200}type="submit"|type="submit"[\s\S]{0,200}data-testid="portal-user-menu-signout"/);
    // NEGATIVE: the button must NOT navigate via onClick or a plain <a>
    // — that would bypass the server invalidation and leave a valid
    // cookie behind.
    const signOutBlock = menu.slice(menu.indexOf("portal-user-menu-signout") - 400, menu.indexOf("portal-user-menu-signout") + 400);
    expect(signOutBlock).not.toMatch(/<a\s/);
    expect(signOutBlock).not.toMatch(/router\.push|location\.href/);
  });

  it("route handler is POST-only + calls destroyEmployeePortalSession", () => {
    expect(route).toMatch(/export async function POST/);
    // No GET / PUT / DELETE handlers — Sign out must be a POST.
    expect(route).not.toMatch(/export async function GET|export async function PUT|export async function DELETE/);
    expect(route).toMatch(/destroyEmployeePortalSession/);
    // 303 See Other — required to convert POST into GET on the redirect.
    expect(route).toMatch(/303/);
  });

  it("route handler builds the redirect origin from proxy-forwarded headers — NOT from req.url", () => {
    // The bug: `new URL("/employee/login", req.url)` returned
    // `https://localhost:3000/...` on Fly. The fix consults
    // x-forwarded-host / x-forwarded-proto (or the raw Host header)
    // instead. Pin the fix so it cannot regress.
    expect(routeExe).toMatch(/x-forwarded-host/);
    expect(routeExe).toMatch(/x-forwarded-proto/);
    expect(routeExe).not.toMatch(/new URL\("\/employee\/login",\s*req\.url\)/);
    expect(routeExe).not.toMatch(/new URL\("\/employee\/login",\s*req\.nextUrl\.origin\)/);
  });

  it("route handler explicitly clears the portal cookie on the outgoing response (belt-and-suspenders)", () => {
    // Two independent invalidation paths — iron-session's next/headers
    // mutation AND an explicit res.cookies.set(..., {maxAge:0}). Both
    // MUST be present so cookie deletion is deterministic even if a
    // future Next.js version stops merging next/headers mutations into
    // a manually-constructed redirect Response.
    // The cookie name may be referenced as a literal OR as a module
    // constant (PORTAL_COOKIE). Accept either — but require that the
    // literal `"spectre_employee_session"` appear at least once so a
    // future rename cannot silently drift.
    expect(routeExe).toMatch(/"spectre_employee_session"/);
    expect(routeExe).toMatch(/res\.cookies\.set\(\s*(?:PORTAL_COOKIE|"spectre_employee_session")\s*,\s*""/);
    expect(routeExe).toMatch(/maxAge:\s*0/);
    // Same shape as the session cookie itself — HttpOnly + Path=/.
    expect(routeExe).toMatch(/httpOnly:\s*true/);
    expect(routeExe).toMatch(/path:\s*"\/"/);
    // secure gated on NODE_ENV=production so local dev still works.
    expect(routeExe).toMatch(/secure:\s*process\.env\.NODE_ENV === "production"/);
  });

  it("layout guard redirects an unauthenticated /employee request to /employee/login (Back/Refresh defence)", () => {
    // After logout the cookie is gone; the very next /employee GET
    // must land on /employee/login, not on the authenticated shell.
    expect(layout).toMatch(/if \(!principal\) redirect\("\/employee\/login"\)/);
  });
});

// ---------------------------------------------------------------------------
// Behavioural — invoke the route handler directly.
// ---------------------------------------------------------------------------

let destroyCalls = 0;
vi.mock("@/lib/employee-portal-session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/employee-portal-session")>(
    "@/lib/employee-portal-session",
  );
  return {
    ...actual,
    destroyEmployeePortalSession: async () => {
      destroyCalls += 1;
    },
  };
});

// eslint-disable-next-line import/first
import { POST as logoutPOST } from "@/app/employee/logout/route";

function req(opts: {
  host?: string;
  xForwardedHost?: string | null;
  xForwardedProto?: string | null;
  cookie?: string | null;
} = {}) {
  const headers = new Headers();
  headers.set("host", opts.host ?? "staging.spectreautomation.com");
  if (opts.xForwardedHost !== null) {
    headers.set("x-forwarded-host", opts.xForwardedHost ?? "staging.spectreautomation.com");
  }
  if (opts.xForwardedProto !== null) {
    headers.set("x-forwarded-proto", opts.xForwardedProto ?? "https");
  }
  if (opts.cookie) headers.set("cookie", opts.cookie);
  // The URL host here mimics the Fly-internal bind (localhost:3000);
  // the fix must not use it for the redirect Location.
  return new NextRequest("http://localhost:3000/employee/logout", {
    method: "POST",
    headers,
  });
}

describe("HR mobile-hotfix · Sign out — behavioural", () => {
  beforeEach(() => { destroyCalls = 0; });

  it("returns 303 + Location on the ORIGINAL public origin (Fly-proxy case)", async () => {
    const res = await logoutPOST(req({
      xForwardedHost: "staging.spectreautomation.com",
      xForwardedProto: "https",
    }));
    expect(res.status).toBe(303);
    const loc = res.headers.get("location");
    expect(loc).toBe("https://staging.spectreautomation.com/employee/login");
    // Regression pin — must NEVER redirect to localhost:3000.
    expect(loc).not.toContain("localhost");
  });

  it("falls back to the request Host header when x-forwarded-host is absent", async () => {
    const res = await logoutPOST(req({
      host: "staging.spectreautomation.com",
      xForwardedHost: null,
      xForwardedProto: "https",
    }));
    expect(res.headers.get("location")).toBe("https://staging.spectreautomation.com/employee/login");
  });

  it("invalidates the session server-side (calls destroyEmployeePortalSession)", async () => {
    await logoutPOST(req());
    expect(destroyCalls).toBe(1);
  });

  it("clears spectre_employee_session via Set-Cookie with Max-Age=0", async () => {
    const res = await logoutPOST(req());
    const setCookies = res.headers.getSetCookie
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie") ?? ""];
    const portalCookie = setCookies.find((c) => c.startsWith("spectre_employee_session="));
    expect(portalCookie, "response must set-cookie the portal session name").toBeDefined();
    // Empty value + Max-Age=0 is the browser-canonical delete instruction.
    expect(portalCookie).toMatch(/spectre_employee_session=;/);
    expect(portalCookie!.toLowerCase()).toContain("max-age=0");
    expect(portalCookie!.toLowerCase()).toContain("path=/");
    expect(portalCookie!.toLowerCase()).toContain("httponly");
    expect(portalCookie!.toLowerCase()).toContain("samesite=lax");
  });

  it("does NOT touch other cookies — the admin session name is not in the response Set-Cookie", async () => {
    const res = await logoutPOST(req({ cookie: "spectre_session=adminX; spectre_employee_session=employeeY" }));
    const setCookies = res.headers.getSetCookie
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie") ?? ""];
    for (const c of setCookies) {
      // Only the portal cookie is set; the admin cookie name must not
      // appear at all in outgoing Set-Cookie headers.
      expect(c.startsWith("spectre_session=")).toBe(false);
    }
  });

  it("is idempotent — repeated logout calls succeed without throwing", async () => {
    const r1 = await logoutPOST(req());
    const r2 = await logoutPOST(req());
    const r3 = await logoutPOST(req());
    expect(r1.status).toBe(303);
    expect(r2.status).toBe(303);
    expect(r3.status).toBe(303);
    expect(destroyCalls).toBe(3);
  });
});
