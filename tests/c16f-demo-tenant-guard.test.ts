// Sprint 3 · Checkpoint 16F revised (2026-08-04) — hard-guard test.
//
// The guard enforces:
//   * --apply flag required
//   * NODE_ENV != production
//   * APP_URL not production
//   * DATABASE_URL host doesn't contain "prod"
//   * club exists
//   * writeClass matches stagingDataMode:
//       - SYNTHETIC_OPERATIONAL requires stagingDataMode=SYNTHETIC_DEMO
//       - REGRESSION_DOCUMENT allows FOUNDER_REVIEW or REGRESSION

import { describe, expect, it, vi, beforeEach } from "vitest";
import { guardDemoTenant } from "@/lib/fixtures/demo-tenant-guard";

interface FakeClub { id: string; slug: string; name: string; isDemoTenant: boolean; stagingDataMode: string; }

const makePrisma = (clubs: FakeClub[]) => ({
  club: {
    findUnique: async (args: { where: { id: string } }) =>
      clubs.find((c) => c.id === args.where.id) ?? null,
  },
}) as any;

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

const CR: FakeClub = { id: "cr", slug: "coulee-ridge", name: "Coulee Ridge", isDemoTenant: true, stagingDataMode: "FOUNDER_REVIEW" };
const DEV: FakeClub = { id: "dev", slug: "dev-synthetic", name: "Dev Synthetic", isDemoTenant: true, stagingDataMode: "SYNTHETIC_DEMO" };
const REG: FakeClub = { id: "reg", slug: "reg", name: "Reg", isDemoTenant: true, stagingDataMode: "REGRESSION" };

describe("16F revised · demo-tenant guard", () => {
  const priorEnv = { NODE_ENV: process.env.NODE_ENV, APP_URL: process.env.APP_URL, DATABASE_URL: process.env.DATABASE_URL };

  beforeEach(() => {
    Object.assign(process.env, priorEnv);
    (process.env as any).NODE_ENV = "test";
    process.env.APP_URL = "https://staging.spectreautomation.com";
    process.env.DATABASE_URL = "postgresql://user:pw@staging-db.example.com:5432/spectre_staging";
  });

  it("refuses without --apply (dry-run must be default)", async () => {
    const exit = catchExitCode();
    await expect(
      guardDemoTenant({
        prisma: makePrisma([DEV]), clubId: "dev", apply: false,
        callerName: "test", writeClass: "SYNTHETIC_OPERATIONAL",
      }),
    ).rejects.toThrow(/__exit__2/);
    expect(exit.code).toBe(2);
    exit.restore();
  });

  it("refuses production APP_URL", async () => {
    process.env.APP_URL = "https://spectreautomation.com";
    const exit = catchExitCode();
    await expect(
      guardDemoTenant({
        prisma: makePrisma([DEV]), clubId: "dev", apply: true,
        callerName: "test", writeClass: "SYNTHETIC_OPERATIONAL",
      }),
    ).rejects.toThrow(/__exit__3/);
    exit.restore();
  });

  it("refuses NODE_ENV=production", async () => {
    (process.env as any).NODE_ENV = "production";
    const exit = catchExitCode();
    await expect(
      guardDemoTenant({
        prisma: makePrisma([DEV]), clubId: "dev", apply: true,
        callerName: "test", writeClass: "SYNTHETIC_OPERATIONAL",
      }),
    ).rejects.toThrow(/__exit__3/);
    exit.restore();
  });

  it("refuses DATABASE_URL with prod host", async () => {
    process.env.DATABASE_URL = "postgresql://u:p@prod-db.example.com:5432/spectre";
    const exit = catchExitCode();
    await expect(
      guardDemoTenant({
        prisma: makePrisma([DEV]), clubId: "dev", apply: true,
        callerName: "test", writeClass: "SYNTHETIC_OPERATIONAL",
      }),
    ).rejects.toThrow(/__exit__4/);
    exit.restore();
  });

  it("refuses missing club", async () => {
    const exit = catchExitCode();
    await expect(
      guardDemoTenant({
        prisma: makePrisma([]), clubId: "missing", apply: true,
        callerName: "test", writeClass: "REGRESSION_DOCUMENT",
      }),
    ).rejects.toThrow(/__exit__5/);
    exit.restore();
  });

  it("REFUSES synthetic-operational writes on FOUNDER_REVIEW (Coulee Ridge)", async () => {
    // The critical rule: synthetic operational fixtures may NEVER
    // land on the founder-review tenant.
    const exit = catchExitCode();
    await expect(
      guardDemoTenant({
        prisma: makePrisma([CR]), clubId: "cr", apply: true,
        callerName: "c15h-founder-fixture", writeClass: "SYNTHETIC_OPERATIONAL",
      }),
    ).rejects.toThrow(/__exit__6/);
    expect(exit.code).toBe(6);
    exit.restore();
  });

  it("REFUSES synthetic-operational writes on REGRESSION-mode clubs", async () => {
    const exit = catchExitCode();
    await expect(
      guardDemoTenant({
        prisma: makePrisma([REG]), clubId: "reg", apply: true,
        callerName: "test", writeClass: "SYNTHETIC_OPERATIONAL",
      }),
    ).rejects.toThrow(/__exit__6/);
    exit.restore();
  });

  it("ALLOWS synthetic-operational writes on SYNTHETIC_DEMO (dev / disposable DB)", async () => {
    const result = await guardDemoTenant({
      prisma: makePrisma([DEV]), clubId: "dev", apply: true,
      callerName: "c15h-founder-fixture", writeClass: "SYNTHETIC_OPERATIONAL",
    });
    expect(result.stagingDataMode).toBe("SYNTHETIC_DEMO");
  });

  it("ALLOWS regression-document writes on FOUNDER_REVIEW (Coulee Ridge)", async () => {
    // The founder-review tenant is where regression PDFs live —
    // they must be storable there so the benchmark runner can
    // evaluate them without needing a second tenant.
    const result = await guardDemoTenant({
      prisma: makePrisma([CR]), clubId: "cr", apply: true,
      callerName: "regression-ingest", writeClass: "REGRESSION_DOCUMENT",
    });
    expect(result.stagingDataMode).toBe("FOUNDER_REVIEW");
    expect(result.clubSlug).toBe("coulee-ridge");
  });

  it("ALLOWS regression-document writes on REGRESSION-mode clubs", async () => {
    const result = await guardDemoTenant({
      prisma: makePrisma([REG]), clubId: "reg", apply: true,
      callerName: "regression-ingest", writeClass: "REGRESSION_DOCUMENT",
    });
    expect(result.stagingDataMode).toBe("REGRESSION");
  });
});
