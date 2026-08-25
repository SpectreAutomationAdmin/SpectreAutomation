// HR-2B.5 §7 — Employee Portal logout endpoint.
//
// POST-only. Invalidates the spectre_employee_session cookie
// server-side, explicitly clears it on the outgoing response, and
// redirects the browser back to the login page on the ORIGINAL public
// origin the client requested.
//
// HR mobile-hotfix (2026-08-25) — Fly staging Sign out defect.
// The founder observed that clicking Sign out on
// staging.spectreautomation.com "did not successfully sign the employee
// out of the portal". Root cause: the previous implementation built the
// redirect URL with `new URL("/employee/login", req.url)`. On Next.js
// standalone behind Fly's proxy, `req.url` reports the internal bind
// host (`localhost:3000`), so the response `Location` came out as
// `https://localhost:3000/employee/login` — unreachable from the
// browser. The cookie deletion Set-Cookie WAS present, but the failed
// cross-origin navigation left the user visually stranded on the old
// page and made Sign out look like a no-op.
//
// Fix: read the origin from the request's Host / x-forwarded-host +
// x-forwarded-proto headers, which reflect what the browser actually
// requested. Also set the cookie deletion directly on the outgoing
// response — belt-and-suspenders on top of destroyEmployeePortalSession
// so the invalidation does not depend on the framework merging
// next/headers cookie mutations across Next.js versions.

import { NextResponse, type NextRequest } from "next/server";
import { destroyEmployeePortalSession } from "@/lib/employee-portal-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PORTAL_COOKIE = "spectre_employee_session";

function resolvePublicOrigin(req: NextRequest): string {
  const proto =
    req.headers.get("x-forwarded-proto")
    ?? req.nextUrl.protocol.replace(":", "")
    ?? "https";
  const host =
    req.headers.get("x-forwarded-host")
    ?? req.headers.get("host")
    ?? req.nextUrl.host;
  return `${proto}://${host}`;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // 1. Invalidate the session server-side (iron-session cookie delete
  //    via next/headers).
  await destroyEmployeePortalSession();

  // 2. Redirect to the login page ON THE ORIGINAL PUBLIC ORIGIN.
  const loginUrl = `${resolvePublicOrigin(req)}/employee/login`;
  const res = NextResponse.redirect(loginUrl, 303);

  // 3. Explicitly clear the cookie on the outgoing response — this is
  //    deterministic regardless of whether Next.js merges next/headers
  //    cookie mutations into a redirect Response. Same cookie shape
  //    as SESSION_OPTIONS in src/lib/employee-portal-session.ts.
  //
  //    Deletion is expressed with BOTH `maxAge: 0` and
  //    `expires: <past>` so the browser deletes regardless of which
  //    attribute it prefers to parse (Next.js's serialisation dropped
  //    Max-Age in one staging shape; keeping Expires as a belt makes
  //    the deletion resilient to that class of quirk). HttpOnly +
  //    SameSite carry through so the deletion cookie matches the
  //    original SESSION_OPTIONS shape.
  res.cookies.set(PORTAL_COOKIE, "", {
    maxAge: 0,
    expires: new Date(0),
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });

  return res;
}
