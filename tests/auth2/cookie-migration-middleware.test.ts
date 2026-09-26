// AUTH-2B.2A regression — middleware must migrate the employee cookie
// from any stale Path="/employee" scope back to Path="/" when an
// authenticated user returns after the AUTH-2B.2 deploy without
// re-signing in. Without this migration, hero + avatar + quick-links
// + training video + pay-PDF all silently 404 because the browser
// never sends the /employee-scoped cookie on /api/**.

import { describe, it, expect } from "vitest";
import type { NextRequest, NextResponse } from "next/server";
import { middleware } from "@/middleware";

/** Extract all Set-Cookie header values from a NextResponse, split
 *  into per-cookie entries. Node's Headers.getSetCookie() is the
 *  standards-compliant accessor; older shims may only give the joined
 *  value, in which case we split on `, ` between attributes. */
function getSetCookies(res: NextResponse): string[] {
  const h = res.headers as unknown as { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const raw = res.headers.get("set-cookie");
  return raw ? raw.split(/, (?=[A-Za-z0-9_-]+=)/) : [];
}

function parseSetCookie(sc: string): {
  name: string; value: string; path: string | null;
  httpOnly: boolean; sameSite: string | null; maxAge: number | null; secure: boolean;
} {
  const parts = sc.split(";").map((p) => p.trim());
  const [nameEq, ...attrs] = parts;
  const eq = nameEq.indexOf("=");
  const name = nameEq.slice(0, eq);
  const value = nameEq.slice(eq + 1);
  let path: string | null = null;
  let httpOnly = false;
  let sameSite: string | null = null;
  let maxAge: number | null = null;
  let secure = false;
  for (const a of attrs) {
    const [k, ...rest] = a.split("=");
    const v = rest.join("=");
    if (/^path$/i.test(k)) path = v;
    else if (/^httponly$/i.test(k)) httpOnly = true;
    else if (/^samesite$/i.test(k)) sameSite = v.toLowerCase();
    else if (/^max-age$/i.test(k)) maxAge = Number(v);
    else if (/^secure$/i.test(k)) secure = true;
  }
  return { name, value, path, httpOnly, sameSite, maxAge, secure };
}

function makeRequest(
  pathname: string,
  cookies: Record<string, string> = {},
): NextRequest {
  const url = new URL(`https://staging.spectreautomation.com${pathname}`);
  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  // Minimal NextRequest shim — middleware only reads .nextUrl,
  // .cookies, .headers, .url in the branches we exercise.
  const cookieBag = new Map(Object.entries(cookies).map(([k, v]) => [k, { name: k, value: v }]));
  const req = {
    nextUrl: url,
    url: url.toString(),
    cookies: {
      get: (name: string) => cookieBag.get(name),
      has: (name: string) => cookieBag.has(name),
      getAll: () => [...cookieBag.values()],
      set: () => {}, delete: () => {},
      [Symbol.iterator]: () => cookieBag.values(),
    },
    headers: new Headers({
      host: "staging.spectreautomation.com",
      cookie: cookieHeader,
    }),
  } as unknown as NextRequest;
  return req;
}

describe("AUTH-2B.2A · employee cookie path migration", () => {
  it("emits Set-Cookie migration pair on /employee page requests carrying the cookie", () => {
    const res = middleware(makeRequest("/employee", { spectre_employee_session: "OPAQUE" }));
    const setCookies = getSetCookies(res).map(parseSetCookie);
    const named = setCookies.filter((c) => c.name === "spectre_employee_session");
    expect(named.length, `expected two migration Set-Cookie headers, saw ${JSON.stringify(named)}`).toBeGreaterThanOrEqual(2);
    const create = named.find((c) => c.path === "/" && c.value === "OPAQUE");
    const del = named.find((c) => c.path === "/employee" && c.value === "");
    expect(create, "Set-Cookie migration create at Path=/").toBeDefined();
    expect(del, "Set-Cookie migration delete at Path=/employee").toBeDefined();
    expect(create!.httpOnly).toBe(true);
    expect(create!.sameSite).toBe("lax");
    expect(create!.maxAge).toBe(60 * 60 * 24 * 7);
    expect(del!.maxAge).toBe(0);
  });

  it("emits NO Set-Cookie migration on requests outside /employee/**", () => {
    const res = middleware(makeRequest("/api/clubs/x/employee-portal-hero", { spectre_employee_session: "OPAQUE" }));
    const named = getSetCookies(res).map(parseSetCookie).filter((c) => c.name === "spectre_employee_session");
    // Migration only runs on /employee/** entry points; /api/** hits
    // rely on the cookie already being at Path="/". This keeps the
    // migration a bounded one-time surface, not a Set-Cookie on every
    // asset request.
    expect(named.length).toBe(0);
  });

  it("emits NO Set-Cookie when the request has no employee cookie", () => {
    // An unauthenticated /employee visit is redirected to /employee/login
    // by the auth gate. That redirect itself carries no migration Set-
    // Cookie because there is no cookie to migrate.
    const res = middleware(makeRequest("/employee"));
    const named = getSetCookies(res).map(parseSetCookie).filter((c) => c.name === "spectre_employee_session");
    expect(named.length).toBe(0);
  });

  it("migration is idempotent — subsequent requests emit the same headers with the same value", () => {
    const first = middleware(makeRequest("/employee/pay", { spectre_employee_session: "SAME_VALUE" }));
    const firstCreate = getSetCookies(first).map(parseSetCookie).find(
      (c) => c.name === "spectre_employee_session" && c.path === "/",
    );
    const second = middleware(makeRequest("/employee/pay", { spectre_employee_session: "SAME_VALUE" }));
    const secondCreate = getSetCookies(second).map(parseSetCookie).find(
      (c) => c.name === "spectre_employee_session" && c.path === "/",
    );
    expect(firstCreate?.value).toBe("SAME_VALUE");
    expect(secondCreate?.value).toBe("SAME_VALUE");
  });
});
