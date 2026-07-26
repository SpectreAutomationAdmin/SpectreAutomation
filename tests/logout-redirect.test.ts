// Verify the /api/logout redirect target is role-aware:
//
//   - signed-in MEMBER → "/"  (so on a club host they land back on the
//     Silver Springs public home, never on /login chrome)
//   - any other role / anonymous → "/login"

import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "@/app/api/logout/route";

// Mock the session module. We don't exercise iron-session here — the
// route's only behaviour we care about is the redirect target.
vi.mock("@/lib/session", () => ({
  clearSession: vi.fn(async () => {}),
  getCurrentUser: vi.fn(),
}));

const session = await import("@/lib/session");

function makeReq(url = "https://silver-springs.localtest.me/api/logout", hostHeader?: string) {
  // Minimal NextRequest stand-in — the handler reads `req.url` and the
  // request headers (`x-spectre-host` / `host`) when building the redirect
  // target.
  const headers = new Headers();
  const u = new URL(url);
  headers.set("host", hostHeader ?? u.host);
  return { url, headers } as unknown as Parameters<typeof GET>[0];
}

describe("/api/logout redirect target", () => {
  beforeEach(() => {
    (session.clearSession as ReturnType<typeof vi.fn>).mockClear();
    (session.getCurrentUser as ReturnType<typeof vi.fn>).mockReset();
  });

  it("signed-in MEMBER → '/' on the same host", async () => {
    (session.getCurrentUser as ReturnType<typeof vi.fn>).mockResolvedValue({ role: "MEMBER", id: "u1" });
    const res = await GET(makeReq("https://silver-springs.localtest.me/api/logout"));
    expect(res.headers.get("location")).toBe("https://silver-springs.localtest.me/");
    expect(res.status).toBe(303);
    expect(session.clearSession).toHaveBeenCalled();
  });

  it("signed-in CLUB_ADMIN → '/login'", async () => {
    (session.getCurrentUser as ReturnType<typeof vi.fn>).mockResolvedValue({ role: "CLUB_ADMIN", id: "u2" });
    const res = await GET(makeReq("https://admin.silver-springs.localtest.me/api/logout"));
    expect(res.headers.get("location")).toBe("https://admin.silver-springs.localtest.me/login");
  });

  it("signed-in SUPER_ADMIN → '/login'", async () => {
    (session.getCurrentUser as ReturnType<typeof vi.fn>).mockResolvedValue({ role: "SUPER_ADMIN", id: "u3" });
    const res = await GET(makeReq("http://localhost:3000/api/logout"));
    expect(res.headers.get("location")).toBe("http://localhost:3000/login");
  });

  it("anonymous (no session) → '/login'", async () => {
    (session.getCurrentUser as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await GET(makeReq("http://silver-springs.localtest.me/api/logout"));
    expect(res.headers.get("location")).toBe("http://silver-springs.localtest.me/login");
  });

  it("the session is cleared before the redirect (every path)", async () => {
    (session.getCurrentUser as ReturnType<typeof vi.fn>).mockResolvedValue({ role: "MEMBER", id: "u" });
    await GET(makeReq());
    expect(session.clearSession).toHaveBeenCalledTimes(1);
  });
});
