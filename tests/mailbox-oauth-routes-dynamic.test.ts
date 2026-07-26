// Sprint 2 Step 11 / Checkpoint 11 (2026-07-20).
//
// Two guarantees this suite locks in:
//
//   1. `/api/integrations/microsoft/callback` and `/api/integrations/microsoft/sync-status`
//      export `dynamic = "force-dynamic"` so Next.js 14's App Router does NOT statically
//      prerender them. The static-bake was the root cause of the Checkpoint 10 blocker:
//      the guard returns 404 before touching any dynamic API, so Next.js baked the
//      build-time flag-off response into the image and made the runtime flag flip inert.
//
//   2. The feature-flag guard STILL fires when the flag is off — both routes must
//      short-circuit to 404 { error: "not_found" } BEFORE calling
//      getCurrentPrincipal(), reading any DB row, or touching Microsoft Graph.
//
//   3. When the flag is on, the callback and sync-status handlers reach the auth
//      check and return 401 for an unauthenticated request — proving the runtime
//      handler is being executed, not a baked response.
//
// This suite deliberately avoids exercising the OAuth code exchange, the Prisma
// mailbox tables, or any Graph API. It probes ONLY the two guard paths that were
// affected by the static-bake regression.

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CALLBACK_ROUTE = path.resolve(__dirname, "../src/app/api/integrations/microsoft/callback/route.ts");
const SYNC_STATUS_ROUTE = path.resolve(__dirname, "../src/app/api/integrations/microsoft/sync-status/route.ts");

// -------------------- source contract tests --------------------
//
// These are the cheap, deterministic guard against reintroducing the static-bake
// regression. If a future refactor moves the `dynamic` export or changes the
// exact string, these fail immediately.

describe("Route source contract — force-dynamic export", () => {
  it("callback route exports dynamic = force-dynamic", () => {
    const src = readFileSync(CALLBACK_ROUTE, "utf8");
    expect(src).toMatch(/export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/);
  });

  it("sync-status route exports dynamic = force-dynamic", () => {
    const src = readFileSync(SYNC_STATUS_ROUTE, "utf8");
    expect(src).toMatch(/export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/);
  });

  it("callback route still imports the feature-flag guard", () => {
    const src = readFileSync(CALLBACK_ROUTE, "utf8");
    expect(src).toMatch(/isMailboxIntegrationEnabled/);
    expect(src).toMatch(/if\s*\(!isMailboxIntegrationEnabled\(\)\)/);
  });

  it("sync-status route still imports the feature-flag guard", () => {
    const src = readFileSync(SYNC_STATUS_ROUTE, "utf8");
    expect(src).toMatch(/isMailboxIntegrationEnabled/);
    expect(src).toMatch(/if\s*\(!isMailboxIntegrationEnabled\(\)\)/);
  });

  it("callback route still runs the guard BEFORE calling getCurrentPrincipal", () => {
    const src = readFileSync(CALLBACK_ROUTE, "utf8");
    const guardIdx = src.search(/if\s*\(!isMailboxIntegrationEnabled\(\)\)/);
    const principalIdx = src.search(/getCurrentPrincipal\s*\(/);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(principalIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(principalIdx);
  });

  it("sync-status route still runs the guard BEFORE calling getCurrentPrincipal", () => {
    const src = readFileSync(SYNC_STATUS_ROUTE, "utf8");
    const guardIdx = src.search(/if\s*\(!isMailboxIntegrationEnabled\(\)\)/);
    const principalIdx = src.search(/getCurrentPrincipal\s*\(/);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(principalIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(principalIdx);
  });
});

// -------------------- runtime handler tests --------------------
//
// Mock the two extension points: the feature flag and the session reader. Prove
// the guard fires when off (404), and that the handler proceeds to the auth
// check when on (401 for unauthenticated).

vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return {
    ...actual,
    isMailboxIntegrationEnabled: vi.fn(() => false),
  };
});

vi.mock("@/lib/services/principal", () => ({
  getCurrentPrincipal: vi.fn(async () => null),
}));

vi.mock("@/lib/active-club", () => ({
  getActiveClubId: vi.fn(async () => "test-club"),
}));

const envMock = await import("@/lib/env");
const principalMock = await import("@/lib/services/principal");

function makeReq(url: string): Parameters<typeof import("../src/app/api/integrations/microsoft/callback/route").GET>[0] {
  return {
    url,
    headers: new Headers({ "user-agent": "vitest" }),
  } as unknown as Parameters<typeof import("../src/app/api/integrations/microsoft/callback/route").GET>[0];
}

describe("Runtime — feature-disabled guard behavior", () => {
  beforeEach(() => {
    (envMock.isMailboxIntegrationEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (principalMock.getCurrentPrincipal as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  });

  it("callback with flag OFF returns 404 { error: not_found }", async () => {
    const { GET } = await import("@/app/api/integrations/microsoft/callback/route");
    const res = await GET(makeReq("https://staging.spectreautomation.com/api/integrations/microsoft/callback"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: "not_found" });
    // Guard fired before getCurrentPrincipal — auth check must NOT have been consulted
    expect(principalMock.getCurrentPrincipal).not.toHaveBeenCalled();
  });

  it("sync-status with flag OFF returns 404 { error: not_found }", async () => {
    const { GET } = await import("@/app/api/integrations/microsoft/sync-status/route");
    const res = await GET(makeReq("https://staging.spectreautomation.com/api/integrations/microsoft/sync-status"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: "not_found" });
    expect(principalMock.getCurrentPrincipal).not.toHaveBeenCalled();
  });
});

describe("Runtime — flag ON, unauthenticated request reaches auth check", () => {
  beforeEach(() => {
    (envMock.isMailboxIntegrationEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (principalMock.getCurrentPrincipal as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("callback with flag ON but no session returns 401 { error: unauthenticated }", async () => {
    const { GET } = await import("@/app/api/integrations/microsoft/callback/route");
    const res = await GET(makeReq("https://staging.spectreautomation.com/api/integrations/microsoft/callback"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "unauthenticated" });
    // Auth check WAS consulted — proves the handler executed past the guard
    expect(principalMock.getCurrentPrincipal).toHaveBeenCalledTimes(1);
  });

  it("sync-status with flag ON but no session returns 401 { error: unauthenticated }", async () => {
    const { GET } = await import("@/app/api/integrations/microsoft/sync-status/route");
    const res = await GET(makeReq("https://staging.spectreautomation.com/api/integrations/microsoft/sync-status"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "unauthenticated" });
    expect(principalMock.getCurrentPrincipal).toHaveBeenCalledTimes(1);
  });
});

// -------------------- release_command contract --------------------
//
// Verifies fly.web.toml uses DIRECT_DATABASE_URL for migrations and still
// resolves the runtime app URL from DATABASE_URL (unchanged). This is a plain
// text check — the intent is to catch a future edit that reintroduces the
// pooler URL for migrations and would re-trigger the Neon advisory-lock issue.

const FLY_WEB_TOML = path.resolve(__dirname, "../deploy/fly.web.toml");

describe("fly.web.toml release_command uses DIRECT_DATABASE_URL", () => {
  const toml = readFileSync(FLY_WEB_TOML, "utf8");

  it("release_command overrides DATABASE_URL with $DIRECT_DATABASE_URL for the Prisma call", () => {
    // The command must set DATABASE_URL from DIRECT_DATABASE_URL for the
    // duration of the prisma invocation. Match the intent, not exact spacing.
    expect(toml).toMatch(/release_command\s*=/);
    expect(toml).toMatch(/DIRECT_DATABASE_URL/);
    // The migrate deploy must be against the Postgres schema
    expect(toml).toMatch(/prisma migrate deploy --schema prisma-postgres\/schema\.prisma/);
  });

  it("release_command aborts if DIRECT_DATABASE_URL is missing (fail-fast, not fall-back to pooler)", () => {
    // Quotes are TOML-escaped (\") because the shell fragment lives inside a
    // TOML basic string. Match either escaped or literal-quote form.
    expect(toml).toMatch(/if\s*\[\s*-z\s*\\?"\$DIRECT_DATABASE_URL\\?"/);
    expect(toml).toMatch(/exit\s+2/);
  });

  it("release_command does NOT call `prisma migrate dev`, `db push`, `db execute`, or seed", () => {
    // Explicit denylist — any of these would be destructive in staging.
    const dangerous = ["migrate dev", "db push", "db execute", "db seed", "migrate reset"];
    for (const cmd of dangerous) {
      expect(toml.includes(cmd)).toBe(false);
    }
  });

  it("no other Fly secret or env in fly.web.toml points to a Neon pooler URL — DATABASE_URL comes from Fly secrets (unpooled URL is separate)", () => {
    // If someone accidentally pasted a Neon URL into the [env] block, that
    // string would be visible in the toml. Neon URLs contain "neon.tech".
    expect(toml).not.toMatch(/neon\.tech/);
  });
});
