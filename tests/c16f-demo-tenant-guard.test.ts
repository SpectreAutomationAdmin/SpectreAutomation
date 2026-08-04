// Sprint 3 · Checkpoint 16F (2026-08-04) — hard-guard test for
// fixture generators. Fixture code MUST refuse to run against any
// club without isDemoTenant=true, and against any production
// environment / production DB, and without --apply.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { guardDemoTenant } from "@/lib/fixtures/demo-tenant-guard";

// Stub prisma with an in-memory club lookup.
const makePrisma = (clubs: Array<{ id: string; slug: string; name: string; isDemoTenant: boolean }>) => ({
  club: {
    findUnique: async (args: { where: { id: string } }) =>
      clubs.find((c) => c.id === args.where.id) ?? null,
  },
}) as any;

const REAL_EXIT = process.exit;

function catchExitCode(): { code: number | null; restore: () => void } {
  const captured: { code: number | null } = { code: null };
  const spy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    captured.code = code ?? 0;
    throw new Error(`__exit__${code ?? 0}`);
  }) as never);
  return {
    get code() { return captured.code; },
    restore: () => { spy.mockRestore(); },
  } as any;
}

describe("16F · demo-tenant guard hard-refuses fixture writes", () => {
  const priorEnv = { NODE_ENV: process.env.NODE_ENV, APP_URL: process.env.APP_URL, DATABASE_URL: process.env.DATABASE_URL };

  beforeEach(() => {
    Object.assign(process.env, priorEnv);
    process.env.NODE_ENV = "test";
    process.env.APP_URL = "https://staging.spectreautomation.com";
    process.env.DATABASE_URL = "postgresql://user:pw@staging-db.example.com:5432/spectre_staging";
  });

  it("refuses without --apply (dry-run must be default)", async () => {
    const exit = catchExitCode();
    await expect(
      guardDemoTenant({
        prisma: makePrisma([{ id: "c1", slug: "demo", name: "Demo", isDemoTenant: true }]),
        clubId: "c1", apply: false, callerName: "test-fixture",
      }),
    ).rejects.toThrow(/__exit__2/);
    expect(exit.code).toBe(2);
    exit.restore();
  });

  it("refuses when APP_URL indicates production", async () => {
    process.env.APP_URL = "https://spectreautomation.com";
    const exit = catchExitCode();
    await expect(
      guardDemoTenant({
        prisma: makePrisma([{ id: "c1", slug: "demo", name: "Demo", isDemoTenant: true }]),
        clubId: "c1", apply: true, callerName: "test-fixture",
      }),
    ).rejects.toThrow(/__exit__3/);
    expect(exit.code).toBe(3);
    exit.restore();
  });

  it("refuses when NODE_ENV is production", async () => {
    process.env.NODE_ENV = "production";
    const exit = catchExitCode();
    await expect(
      guardDemoTenant({
        prisma: makePrisma([{ id: "c1", slug: "demo", name: "Demo", isDemoTenant: true }]),
        clubId: "c1", apply: true, callerName: "test-fixture",
      }),
    ).rejects.toThrow(/__exit__3/);
    expect(exit.code).toBe(3);
    exit.restore();
  });

  it("refuses when DATABASE_URL host contains 'prod'", async () => {
    process.env.DATABASE_URL = "postgresql://u:p@prod-db.example.com:5432/spectre";
    const exit = catchExitCode();
    await expect(
      guardDemoTenant({
        prisma: makePrisma([{ id: "c1", slug: "demo", name: "Demo", isDemoTenant: true }]),
        clubId: "c1", apply: true, callerName: "test-fixture",
      }),
    ).rejects.toThrow(/__exit__4/);
    expect(exit.code).toBe(4);
    exit.restore();
  });

  it("refuses when target club not found", async () => {
    const exit = catchExitCode();
    await expect(
      guardDemoTenant({
        prisma: makePrisma([]),
        clubId: "does-not-exist", apply: true, callerName: "test-fixture",
      }),
    ).rejects.toThrow(/__exit__5/);
    expect(exit.code).toBe(5);
    exit.restore();
  });

  it("refuses when target club has isDemoTenant=false (founder-review tenant)", async () => {
    const exit = catchExitCode();
    await expect(
      guardDemoTenant({
        prisma: makePrisma([{ id: "cr", slug: "coulee-ridge", name: "Coulee Ridge", isDemoTenant: false }]),
        clubId: "cr", apply: true, callerName: "test-fixture",
      }),
    ).rejects.toThrow(/__exit__6/);
    expect(exit.code).toBe(6);
    exit.restore();
  });

  it("passes when club is a demo tenant AND all env conditions are met", async () => {
    const result = await guardDemoTenant({
      prisma: makePrisma([{ id: "demo1", slug: "demo-club", name: "Demo Club", isDemoTenant: true }]),
      clubId: "demo1", apply: true, callerName: "test-fixture",
    });
    expect(result.clubSlug).toBe("demo-club");
    expect(result.isDemoTenant).toBe(true);
  });
});
