import { NextResponse, type NextRequest } from "next/server";
import { clearSession, getCurrentUser } from "@/lib/session";

// After clearing the session, send the user somewhere appropriate.
//
// - A signed-in MEMBER returns to the club's public home page (`/`). On a
//   white-label club host that's the Silver Springs landing site; the
//   member never sees the platform login chrome on sign-out.
// - Anyone else (staff, super-admin, or no role at all) returns to /login
//   so they can re-sign-in immediately.
//
// We resolve the role BEFORE calling `clearSession()` because the cookie is
// gone afterwards. We build the redirect from the actual `Host` header (or
// the middleware-stamped `x-spectre-host`) so the visitor stays on the
// hostname they signed in from — `req.url` in Next.js dev mode can carry
// the internal `localhost` origin rather than the public host.
async function handle(req: NextRequest) {
  const user = await getCurrentUser();
  const target = user?.role === "MEMBER" ? "/" : "/login";
  await clearSession();

  // Prefer the raw Host header — it includes the port (`:3000`), which the
  // middleware-stamped `x-spectre-host` deliberately strips for tenant lookup.
  const host = req.headers.get("host") ?? req.headers.get("x-spectre-host");
  if (host) {
    const fromUrl = (() => { try { return new URL(req.url).protocol.replace(":", ""); } catch { return "http"; } })();
    const proto = req.headers.get("x-forwarded-proto") ?? fromUrl;
    return NextResponse.redirect(`${proto}://${host}${target}`, { status: 303 });
  }
  return NextResponse.redirect(new URL(target, req.url), { status: 303 });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
