// PAY-1B.1 — connection status controls + production-attack structural refusal.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import {
  createConnection, activateConnection, setConnectionStatus,
  resolveActiveConnection, assertEnvironmentAllowed,
} from "@/lib/payments/provider/connection";
import { assertConnectionUsable, recordHealthSample } from "@/lib/payments/provider/health";

async function seed() {
  const club = await makeClub("PB1 " + Math.random().toString(36).slice(2));
  const admE = `adm-${Math.random().toString(36).slice(2)}@t.test`;
  await makeUser({ email: admE, role: "CLUB_ADMIN", clubId: club.id });
  const admin = await principalFor(admE);
  return { club, admin };
}

describe("PAY-1B.1 · connection status controls", () => {
  const origRm = process.env.PAYMENTS_REAL_MONEY_ENABLED;
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => {
    await resetDb(); await seedRbac();
    if (origRm === undefined) delete process.env.PAYMENTS_REAL_MONEY_ENABLED;
    else process.env.PAYMENTS_REAL_MONEY_ENABLED = origRm;
  });

  it("SUSPENDED connection refuses new submission (assertConnectionUsable)", async () => {
    const { club, admin } = await seed();
    const c = await createConnection(admin, {
      clubId: club.id, providerType: "SIMULATOR", connectionReference: "s1",
      environment: "SIMULATOR", credentialSecretRef: "kms:s1",
    });
    await activateConnection(admin, c.id);
    await setConnectionStatus(admin, c.id, "SUSPENDED");
    await expect(assertConnectionUsable(c.id)).rejects.toThrow(/SUSPENDED/);
  });

  it("REVOKED connection refuses new submission and cannot be revived", async () => {
    const { club, admin } = await seed();
    const c = await createConnection(admin, {
      clubId: club.id, providerType: "SIMULATOR", connectionReference: "r1",
      environment: "SIMULATOR", credentialSecretRef: "kms:r1",
    });
    await activateConnection(admin, c.id);
    await setConnectionStatus(admin, c.id, "REVOKED");
    await expect(assertConnectionUsable(c.id)).rejects.toThrow(/REVOKED/);
    await expect(activateConnection(admin, c.id)).rejects.toThrow(/REVOKED/);
  });

  it("DEGRADED connection refuses new submission but preserves history", async () => {
    const { club, admin } = await seed();
    const c = await createConnection(admin, {
      clubId: club.id, providerType: "SIMULATOR", connectionReference: "d1",
      environment: "SIMULATOR", credentialSecretRef: "kms:d1",
    });
    await activateConnection(admin, c.id);
    // Trip the breaker.
    for (let i = 0; i < 5; i++) await recordHealthSample({ connectionId: c.id, outcome: "FAILURE" });
    const cur = await db().paymentProviderConnection.findUniqueOrThrow({ where: { id: c.id } });
    expect(cur.status).toBe("DEGRADED");
    await expect(assertConnectionUsable(c.id)).rejects.toThrow(/DEGRADED/);
    // Neither the connection row nor the versions are deleted or altered.
    const v = await db().paymentProviderConnectionVersion.findFirst({ where: { connectionId: c.id } });
    expect(v?.deactivatedAt).toBeNull();
  });
});

describe("PAY-1B.1 · PRODUCTION-connection-on-staging structural refusal", () => {
  const origRm = process.env.PAYMENTS_REAL_MONEY_ENABLED;
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => {
    await resetDb(); await seedRbac();
    if (origRm === undefined) delete process.env.PAYMENTS_REAL_MONEY_ENABLED;
    else process.env.PAYMENTS_REAL_MONEY_ENABLED = origRm;
  });

  it("assertEnvironmentAllowed refuses PRODUCTION when real-money off — even if row exists", async () => {
    delete process.env.PAYMENTS_REAL_MONEY_ENABLED;
    const { club } = await seed();
    // Bypass createConnection to write a PRODUCTION row directly.
    await db().paymentProviderConnection.create({
      data: {
        clubId: club.id, providerType: "SIMULATOR", connectionReference: "prod-attack",
        environment: "PRODUCTION", status: "ACTIVE",
      },
    });
    await db().paymentProviderConnectionVersion.create({
      data: {
        connectionId: (await db().paymentProviderConnection.findFirstOrThrow({ where: { environment: "PRODUCTION" } })).id,
        version: 1, credentialSecretRef: "kms:injected", activatedAt: new Date(),
      },
    });
    expect(() => assertEnvironmentAllowed("PRODUCTION")).toThrow(/PRODUCTION/);
    await expect(resolveActiveConnection(club.id, "SIMULATOR")).rejects.toThrow(/PRODUCTION/);
  });

  it("PRODUCTION resolve fails structurally even with a fully-formed ACTIVE row + version + credential ref", async () => {
    delete process.env.PAYMENTS_REAL_MONEY_ENABLED;
    const { club } = await seed();
    const c = await db().paymentProviderConnection.create({
      data: {
        clubId: club.id, providerType: "SIMULATOR", connectionReference: "prod2",
        environment: "PRODUCTION", status: "ACTIVE",
      },
    });
    await db().paymentProviderConnectionVersion.create({
      data: { connectionId: c.id, version: 1, credentialSecretRef: "kms:PROD-ref", activatedAt: new Date() },
    });
    // Even though the DB has a fully-formed ACTIVE PRODUCTION connection
    // with a versioned credential, resolve throws.
    await expect(resolveActiveConnection(club.id, "SIMULATOR")).rejects.toThrow(/PRODUCTION/);
  });

  it("SANDBOX connections resolve safely on staging", async () => {
    delete process.env.PAYMENTS_REAL_MONEY_ENABLED;
    const { club, admin } = await seed();
    const c = await createConnection(admin, {
      clubId: club.id, providerType: "MOCK_CDN_RAIL", connectionReference: "sbx1",
      environment: "SANDBOX", credentialSecretRef: "kms:sbx1",
    });
    await activateConnection(admin, c.id);
    const active = await resolveActiveConnection(club.id, "MOCK_CDN_RAIL");
    expect(active.environment).toBe("SANDBOX");
  });
});
