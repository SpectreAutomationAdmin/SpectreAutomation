// PAY-1C/4 — central production-execution enablement gate.
//
// Every prerequisite refused independently. The composition is the
// core protection: a future adapter cannot execute merely because
// PAYMENTS_REAL_MONEY_ENABLED=true.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import {
  assertProductionExecutionAllowed,
  reportProductionGate,
} from "@/lib/payments/production-gate";
import {
  createConnection,
  activateConnection,
} from "@/lib/payments/provider/connection";
import {
  markConformancePassed,
  markSandboxAccepted,
  markProductionApproved,
} from "@/lib/payments/certification";

async function seedClubAndConnection(env: "SIMULATOR" | "SANDBOX" | "PRODUCTION", providerType = "MOCK_CDN_RAIL") {
  const club = await makeClub("PGATE " + Math.random().toString(36).slice(2));
  const admE = `adm-${Math.random().toString(36).slice(2)}@t.test`;
  await makeUser({ email: admE, role: "CLUB_ADMIN", clubId: club.id });
  const admin = await principalFor(admE);
  if (env === "PRODUCTION") {
    // Cannot create a PRODUCTION connection through createConnection
    // while real-money is off. Insert directly, mirroring PAY-1B.1
    // structural-refusal tests.
    const c = await db().paymentProviderConnection.create({
      data: {
        clubId: club.id, providerType, connectionReference: "prod-gate",
        environment: "PRODUCTION", status: "ACTIVE",
      },
    });
    await db().paymentProviderConnectionVersion.create({
      data: { connectionId: c.id, version: 1, credentialSecretRef: "kms:prod-injected", activatedAt: new Date() },
    });
    return { club, admin, connection: c };
  }
  const c = await createConnection(admin, {
    clubId: club.id, providerType, connectionReference: "sbx-gate",
    environment: env, credentialSecretRef: "kms:sbx",
  });
  await activateConnection(admin, c.id);
  return { club, admin, connection: c };
}

async function seedAuthorizedRun(clubId: string, providerType: string) {
  const c = db();
  const bankAcc = await c.account.create({
    data: {
      clubId,
      accountNumber: "10" + Math.floor(Math.random() * 1_000_000),
      name: "Bank", type: "ASSET", normalBalance: "DEBIT",
      isBankAccount: true, isCashAccount: true, isActive: true,
      allowManualPosting: false, accountRole: "CASH",
    },
  });
  const bank = await c.bankAccount.create({
    data: {
      clubId, institutionReference: "SIM",
      displayName: "Bank ***01", maskedIdentifier: "***01",
      currency: "CAD", status: "ACTIVE", glAccountId: bankAcc.id,
    },
  });
  const run = await c.paymentRun.create({
    data: {
      clubId, runNumber: "PR-" + Math.floor(Math.random() * 1_000_000),
      sourceType: "PAYROLL_BATCH", sourceId: null,
      fundingBankAccountId: bank.id, currency: "CAD",
      requestedExecutionDate: new Date("2026-12-30"),
      totalAmount: new Prisma.Decimal("100.00"),
      instructionCount: 0,
      status: "AUTHORIZED",
      paymentFingerprint: "pfp-v1-test-" + Math.random().toString(36).slice(2),
      createdByUserId: "user-1",
    },
  });
  await c.paymentAuthorization.create({
    data: {
      clubId, runId: run.id,
      authorizedByUserId: "controller",
      paymentFingerprint: run.paymentFingerprint!,
      snapshotJson: JSON.stringify({ ok: true }),
      status: "ACTIVE",
    },
  });
  return run;
}

describe("PAY-1C/4 · production execution gate", () => {
  const origRm = process.env.PAYMENTS_REAL_MONEY_ENABLED;
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => {
    await resetDb(); await seedRbac();
    if (origRm === undefined) delete process.env.PAYMENTS_REAL_MONEY_ENABLED;
    else process.env.PAYMENTS_REAL_MONEY_ENABLED = origRm;
  });

  it("REAL_MONEY_DISABLED — refuses even when everything else is in place", async () => {
    delete process.env.PAYMENTS_REAL_MONEY_ENABLED;
    const { club, connection } = await seedClubAndConnection("PRODUCTION");
    const run = await seedAuthorizedRun(club.id, "MOCK_CDN_RAIL");
    await expect(
      assertProductionExecutionAllowed({
        clubId: club.id, providerType: "MOCK_CDN_RAIL",
        connectionId: connection.id, runId: run.id,
      }),
    ).rejects.toThrow(/REAL_MONEY_DISABLED/);
  });

  it("SIMULATOR_NOT_PRODUCTION_ELIGIBLE — refuses simulator adapter regardless of flags", async () => {
    process.env.PAYMENTS_REAL_MONEY_ENABLED = "true";
    const { club, connection } = await seedClubAndConnection("SIMULATOR", "SIMULATOR");
    const run = await seedAuthorizedRun(club.id, "SIMULATOR");
    await expect(
      assertProductionExecutionAllowed({
        clubId: club.id, providerType: "SIMULATOR",
        connectionId: connection.id, runId: run.id,
      }),
    ).rejects.toThrow(/SIMULATOR_NOT_PRODUCTION_ELIGIBLE/);
  });

  it("ADAPTER_NOT_APPROVED — refuses when the adapter is not PRODUCTION_APPROVED", async () => {
    process.env.PAYMENTS_REAL_MONEY_ENABLED = "true";
    const { club, connection } = await seedClubAndConnection("PRODUCTION");
    const run = await seedAuthorizedRun(club.id, "MOCK_CDN_RAIL");
    await expect(
      assertProductionExecutionAllowed({
        clubId: club.id, providerType: "MOCK_CDN_RAIL",
        connectionId: connection.id, runId: run.id,
      }),
    ).rejects.toThrow(/ADAPTER_NOT_APPROVED/);
  });

  it("CONNECTION_ENVIRONMENT_MISMATCH — refuses when connection is not PRODUCTION", async () => {
    process.env.PAYMENTS_REAL_MONEY_ENABLED = "true";
    await markConformancePassed("MOCK_CDN_RAIL", 30);
    await markSandboxAccepted("MOCK_CDN_RAIL", { name: "s" });
    await markProductionApproved("MOCK_CDN_RAIL", "founder");
    const { club, connection } = await seedClubAndConnection("SANDBOX");
    const run = await seedAuthorizedRun(club.id, "MOCK_CDN_RAIL");
    await expect(
      assertProductionExecutionAllowed({
        clubId: club.id, providerType: "MOCK_CDN_RAIL",
        connectionId: connection.id, runId: run.id,
      }),
    ).rejects.toThrow(/CONNECTION_ENVIRONMENT_MISMATCH/);
  });

  it("AUTHORIZATION_MISSING — refuses when the run has no active authorization", async () => {
    process.env.PAYMENTS_REAL_MONEY_ENABLED = "true";
    await markConformancePassed("MOCK_CDN_RAIL", 30);
    await markSandboxAccepted("MOCK_CDN_RAIL", { name: "s" });
    await markProductionApproved("MOCK_CDN_RAIL", "founder");
    const { club, connection } = await seedClubAndConnection("PRODUCTION");
    // Seed a run WITHOUT authorization.
    const c = db();
    const bankAcc = await c.account.create({
      data: {
        clubId: club.id,
        accountNumber: "10" + Math.floor(Math.random() * 1_000_000),
        name: "B", type: "ASSET", normalBalance: "DEBIT",
        isBankAccount: true, isCashAccount: true, isActive: true,
        allowManualPosting: false, accountRole: "CASH",
      },
    });
    const bank = await c.bankAccount.create({
      data: {
        clubId: club.id, institutionReference: "SIM",
        displayName: "B***", maskedIdentifier: "***01",
        currency: "CAD", status: "ACTIVE", glAccountId: bankAcc.id,
      },
    });
    const run = await c.paymentRun.create({
      data: {
        clubId: club.id, runNumber: "PR-NOA-" + Math.floor(Math.random() * 100000),
        sourceType: "PAYROLL_BATCH", fundingBankAccountId: bank.id, currency: "CAD",
        requestedExecutionDate: new Date("2026-12-30"),
        totalAmount: new Prisma.Decimal("100.00"),
        status: "AUTHORIZED",
        createdByUserId: "user-x",
      },
    });
    await expect(
      assertProductionExecutionAllowed({
        clubId: club.id, providerType: "MOCK_CDN_RAIL",
        connectionId: connection.id, runId: run.id,
      }),
    ).rejects.toThrow(/AUTHORIZATION_MISSING/);
  });

  it("reportProductionGate lists every failing reason without throwing", async () => {
    delete process.env.PAYMENTS_REAL_MONEY_ENABLED;
    const { club, connection } = await seedClubAndConnection("SANDBOX");
    const run = await seedAuthorizedRun(club.id, "MOCK_CDN_RAIL");
    const report = await reportProductionGate({
      clubId: club.id, providerType: "MOCK_CDN_RAIL",
      connectionId: connection.id, runId: run.id,
    });
    expect(report.overall).toBe("REFUSED");
    expect(report.reasons).toContain("REAL_MONEY_DISABLED");
    expect(report.reasons).toContain("ADAPTER_NOT_APPROVED");
    expect(report.reasons).toContain("CONNECTION_ENVIRONMENT_MISMATCH");
  });
});
