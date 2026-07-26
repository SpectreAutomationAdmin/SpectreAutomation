// Sprint 2 Checkpoint 12C (2026-07-21).
//
// Locks in the canonical-origin redirect fix on the Microsoft OAuth callback.
//
// What broke and why: on Fly, `NextRequest.url` presents as the container's
// internal listen origin (http://localhost:3000/...), so
// `new URL(returnPath, new URL(req.url).origin)` produced a redirect to
// `http://localhost:3000/...` — unreachable from the user's browser.
//
// What the fix does: every browser-facing redirect in the callback now uses
// `new URL(pathAndQuery, env.APP_URL)` via a `canonicalRedirect` helper.
// env.APP_URL is Zod-validated at boot and is not request-controlled, so it
// cannot be poisoned by spoofed x-forwarded-host / Host headers.
//
// This suite exercises the runtime handler with a mocked
// `finaliseConnection`, mocked session (unauthenticated + authenticated),
// and mocked feature-flag. It never talks to Microsoft, Prisma, or KMS.

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -----------------------------------------------------------------------------
// Mocks — mount BEFORE importing the route
// -----------------------------------------------------------------------------

vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return {
    ...actual,
    isMailboxIntegrationEnabled: vi.fn(() => true),
    env: {
      ...actual.env,
      APP_URL: "https://staging.spectreautomation.com",
    },
  };
});

vi.mock("@/lib/services/principal", () => ({
  getCurrentPrincipal: vi.fn(async () => ({
    id: "u_test",
    activeClubId: "c_test",
    role: "CLUB_ADMIN",
    memberships: [{ clubId: "c_test", roleKey: "CLUB_ADMIN" }],
  })),
}));

vi.mock("@/lib/active-club", () => ({
  getActiveClubId: vi.fn(async () => "c_test"),
}));

vi.mock("@/lib/mailbox/connect", () => ({
  finaliseConnection: vi.fn(),
}));

const connectMock = await import("@/lib/mailbox/connect");
const finaliseConnection = connectMock.finaliseConnection as ReturnType<typeof vi.fn>;

// Route imports must come AFTER the mocks
const { GET } = await import("@/app/api/integrations/microsoft/callback/route");
import { MailboxFlowError, MAILBOX_ERROR_CODE } from "@/lib/mailbox/errors";

// -----------------------------------------------------------------------------
// Helpers — construct a NextRequest-like object with a specific incoming URL
// and optional host-injection headers.
// -----------------------------------------------------------------------------
function makeReq(
  incomingUrl: string,
  extraHeaders: Record<string, string> = {},
): Parameters<typeof GET>[0] {
  const headers = new Headers({
    "user-agent": "vitest",
    ...extraHeaders,
  });
  return { url: incomingUrl, headers } as unknown as Parameters<typeof GET>[0];
}

const CANONICAL_ORIGIN = "https://staging.spectreautomation.com";
const INTERNAL_URL = "http://localhost:3000/api/integrations/microsoft/callback?state=s1&code=c1";

// -----------------------------------------------------------------------------
// Source-contract tests (regression guards for the fix itself)
// -----------------------------------------------------------------------------

const ROUTE_SRC = readFileSync(
  path.resolve(__dirname, "../src/app/api/integrations/microsoft/callback/route.ts"),
  "utf8",
);

describe("Callback source contract", () => {
  it("no url.origin reference remains in the file", () => {
    expect(ROUTE_SRC).not.toMatch(/url\.origin/);
  });

  it("canonicalRedirect helper uses env.APP_URL as the base", () => {
    expect(ROUTE_SRC).toMatch(/function canonicalRedirect[\s\S]*?new URL\(pathAndQuery, env\.APP_URL\)/);
  });

  it("every NextResponse.redirect call flows through canonicalRedirect", () => {
    // Count redirects and canonicalRedirect uses — they must match.
    const redirects = (ROUTE_SRC.match(/NextResponse\.redirect\(/g) || []).length;
    const canonicalCalls = (ROUTE_SRC.match(/canonicalRedirect\(/g) || []).length;
    // Every redirect is fed a URL produced by canonicalRedirect. The helper
    // is called once per redirect (plus once for its own definition).
    expect(redirects).toBeGreaterThanOrEqual(3);
    expect(canonicalCalls).toBe(redirects + 1);
  });
});

// -----------------------------------------------------------------------------
// Runtime tests: success path, error paths, host-header injection
// -----------------------------------------------------------------------------

describe("Successful callback → canonical redirect", () => {
  beforeEach(() => {
    finaliseConnection.mockResolvedValue({
      returnPath: "/app/user/settings/connected-accounts",
      mailboxConnectionId: "mc_test_abc123",
    });
  });
  afterEach(() => vi.clearAllMocks());

  it("redirects to https://staging.spectreautomation.com/... even when req.url is http://localhost:3000/...", async () => {
    const res = await GET(makeReq(INTERNAL_URL));
    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    const u = new URL(location);
    expect(u.origin).toBe(CANONICAL_ORIGIN);
    expect(u.pathname).toBe("/app/user/settings/connected-accounts");
    expect(u.searchParams.get("mailbox")).toBe("connected");
    expect(u.searchParams.get("cx")).toBe("mc_test_abc123");
  });

  it("redirect NEVER contains http://localhost:3000 origin", async () => {
    const res = await GET(makeReq(INTERNAL_URL));
    const location = res.headers.get("location")!;
    expect(location).not.toMatch(/^http:\/\/localhost/);
    expect(location).not.toMatch(/^http:\/\/127\.0\.0\.1/);
    expect(location).not.toMatch(/^http:\/\/0\.0\.0\.0/);
  });

  it("redirect NEVER contains OAuth code, state, access token, refresh token, or ciphertext", async () => {
    const res = await GET(makeReq(
      "http://localhost:3000/api/integrations/microsoft/callback?state=SECRET_STATE&code=SECRET_CODE",
    ));
    const location = res.headers.get("location")!;
    expect(location).not.toContain("SECRET_STATE");
    expect(location).not.toContain("SECRET_CODE");
    expect(location).not.toContain("code=");
    expect(location).not.toContain("state=");
    expect(location).not.toContain("access_token");
    expect(location).not.toContain("refresh_token");
    expect(location).not.toContain("enc:aws:");
    // Only expected params on success
    const u = new URL(location);
    const paramNames = [...u.searchParams.keys()].sort();
    expect(paramNames).toEqual(["cx", "mailbox"]);
  });
});

describe("MailboxFlowError → canonical error redirect", () => {
  afterEach(() => vi.clearAllMocks());

  it("EXPIRED transaction → canonical /app/user/settings?mailbox=error&error=OAUTH_STATE_EXPIRED", async () => {
    finaliseConnection.mockRejectedValue(new MailboxFlowError(MAILBOX_ERROR_CODE.OAUTH_STATE_EXPIRED));
    const res = await GET(makeReq(INTERNAL_URL));
    expect(res.status).toBe(302);
    const u = new URL(res.headers.get("location")!);
    expect(u.origin).toBe(CANONICAL_ORIGIN);
    expect(u.pathname).toBe("/app/user/settings");
    expect(u.searchParams.get("mailbox")).toBe("error");
    expect(u.searchParams.get("error")).toBe(MAILBOX_ERROR_CODE.OAUTH_STATE_EXPIRED);
  });

  it("UNKNOWN state → canonical redirect", async () => {
    finaliseConnection.mockRejectedValue(new MailboxFlowError(MAILBOX_ERROR_CODE.OAUTH_STATE_UNKNOWN));
    const res = await GET(makeReq(INTERNAL_URL));
    const u = new URL(res.headers.get("location")!);
    expect(u.origin).toBe(CANONICAL_ORIGIN);
  });

  it("Microsoft user-denial → canonical redirect (OAUTH_DENIED_BY_USER)", async () => {
    finaliseConnection.mockRejectedValue(new MailboxFlowError(MAILBOX_ERROR_CODE.OAUTH_DENIED_BY_USER));
    const res = await GET(makeReq(INTERNAL_URL));
    const u = new URL(res.headers.get("location")!);
    expect(u.origin).toBe(CANONICAL_ORIGIN);
  });

  it("Issuer invalid → canonical redirect", async () => {
    finaliseConnection.mockRejectedValue(new MailboxFlowError(MAILBOX_ERROR_CODE.OAUTH_ISSUER_INVALID));
    const res = await GET(makeReq(INTERNAL_URL));
    const u = new URL(res.headers.get("location")!);
    expect(u.origin).toBe(CANONICAL_ORIGIN);
  });

  it("Unknown non-MailboxFlowError → canonical fallback /app/user/settings?error=INTERNAL_ERROR", async () => {
    finaliseConnection.mockRejectedValue(new Error("something totally unexpected"));
    const res = await GET(makeReq(INTERNAL_URL));
    const u = new URL(res.headers.get("location")!);
    expect(u.origin).toBe(CANONICAL_ORIGIN);
    expect(u.pathname).toBe("/app/user/settings");
    expect(u.searchParams.get("error")).toBe(MAILBOX_ERROR_CODE.INTERNAL_ERROR);
  });
});

describe("Host-header / open-redirect resistance", () => {
  beforeEach(() => {
    finaliseConnection.mockResolvedValue({
      returnPath: "/app/user/settings/connected-accounts",
      mailboxConnectionId: "mc_test_hostinj",
    });
  });
  afterEach(() => vi.clearAllMocks());

  it("spoofed x-forwarded-host header cannot influence the redirect origin", async () => {
    const res = await GET(
      makeReq(INTERNAL_URL, {
        "x-forwarded-host": "evil.example.com",
        "x-forwarded-proto": "http",
      }),
    );
    const u = new URL(res.headers.get("location")!);
    expect(u.origin).toBe(CANONICAL_ORIGIN);
    expect(u.hostname).not.toBe("evil.example.com");
  });

  it("spoofed Host header cannot influence the redirect origin", async () => {
    const res = await GET(
      makeReq(INTERNAL_URL, {
        host: "evil.example.com",
      }),
    );
    const u = new URL(res.headers.get("location")!);
    expect(u.origin).toBe(CANONICAL_ORIGIN);
    expect(u.hostname).not.toBe("evil.example.com");
  });

  it("attacker-supplied incoming URL cannot influence redirect origin", async () => {
    const res = await GET(makeReq("http://evil.example.com/api/integrations/microsoft/callback?state=s&code=c"));
    const u = new URL(res.headers.get("location")!);
    expect(u.origin).toBe(CANONICAL_ORIGIN);
    expect(u.hostname).not.toBe("evil.example.com");
  });
});

describe("APP_URL edge cases", () => {
  afterEach(() => vi.clearAllMocks());

  it("APP_URL WITH trailing slash produces the same canonical redirect as without", async () => {
    finaliseConnection.mockResolvedValue({
      returnPath: "/app/user/settings/connected-accounts",
      mailboxConnectionId: "mc_slash_test",
    });
    // Directly test the URL constructor semantics we rely on
    const withSlash = new URL("/app/user/settings/connected-accounts", "https://staging.spectreautomation.com/");
    const withoutSlash = new URL("/app/user/settings/connected-accounts", "https://staging.spectreautomation.com");
    expect(withSlash.toString()).toBe(withoutSlash.toString());
    expect(withSlash.toString()).toBe("https://staging.spectreautomation.com/app/user/settings/connected-accounts");
  });

  it("no double slashes are introduced in the redirect path", async () => {
    finaliseConnection.mockResolvedValue({
      returnPath: "/app/user/settings/connected-accounts",
      mailboxConnectionId: "mc_ds_test",
    });
    const res = await GET(makeReq(INTERNAL_URL));
    const location = res.headers.get("location")!;
    // Only // that should ever appear is the scheme's //
    const withoutScheme = location.replace(/^https?:\/\//, "");
    expect(withoutScheme).not.toMatch(/\/\//);
  });

  it("HTTPS is preserved (never downgraded to http)", async () => {
    finaliseConnection.mockResolvedValue({
      returnPath: "/app/user/settings/connected-accounts",
      mailboxConnectionId: "mc_https_test",
    });
    const res = await GET(makeReq(INTERNAL_URL));
    expect(res.headers.get("location")!).toMatch(/^https:\/\//);
  });
});
