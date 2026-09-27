// PAY-1B/2 — PaymentProviderConnection boundary + rotation model.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import {
  createConnection,
  activateConnection,
  setConnectionStatus,
  rotateConnectionCredential,
  resolveActiveConnection,
} from "@/lib/payments/provider/connection";

async function ctx() {
  const club = await makeClub("PB " + Math.random().toString(36).slice(2));
  const adminEmail = `admin-${Math.random().toString(36).slice(2)}@t.test`;
  await makeUser({ email: adminEmail, role: "CLUB_ADMIN", clubId: club.id });
  const admin = await principalFor(adminEmail);
  return { club, admin };
}

describe("PAY-1B/2 · PaymentProviderConnection", () => {
  const orig = { rm: process.env.PAYMENTS_REAL_MONEY_ENABLED };
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => {
    await resetDb(); await seedRbac();
    if (orig.rm === undefined) delete process.env.PAYMENTS_REAL_MONEY_ENABLED;
    else process.env.PAYMENTS_REAL_MONEY_ENABLED = orig.rm;
  });

  it("creates a SIMULATOR connection with a versioned credential ref", async () => {
    const { club, admin } = await ctx();
    const r = await createConnection(admin, {
      clubId: club.id, providerType: "SIMULATOR",
      connectionReference: "coulee-sim-1", environment: "SIMULATOR",
      credentialSecretRef: "kms:sim/coulee-sim-1/v1",
      capabilities: { supportsSubmission: true, supportsAsyncEvents: true },
    });
    expect(r.id).toBeTruthy();
    const c = await db().paymentProviderConnection.findUniqueOrThrow({ where: { id: r.id } });
    expect(c.environment).toBe("SIMULATOR");
    expect(c.status).toBe("CONFIGURING");
    const v = await db().paymentProviderConnectionVersion.findUniqueOrThrow({ where: { id: r.versionId } });
    expect(v.version).toBe(1);
    expect(v.credentialSecretRef).toBe("kms:sim/coulee-sim-1/v1");
  });

  it("staging (PAYMENTS_REAL_MONEY_ENABLED=false) REFUSES a PRODUCTION connection at create", async () => {
    delete process.env.PAYMENTS_REAL_MONEY_ENABLED;
    const { club, admin } = await ctx();
    await expect(createConnection(admin, {
      clubId: club.id, providerType: "SIMULATOR",
      connectionReference: "coulee-prod", environment: "PRODUCTION",
      credentialSecretRef: "kms:prod",
    })).rejects.toThrow(/PRODUCTION/);
  });

  it("staging REFUSES to ACTIVATE a PRODUCTION row even if it somehow exists in DB", async () => {
    delete process.env.PAYMENTS_REAL_MONEY_ENABLED;
    const { club, admin } = await ctx();
    // Bypass createConnection by writing directly (simulates a
    // malicious or accidental DB row).
    const row = await db().paymentProviderConnection.create({
      data: {
        clubId: club.id, providerType: "SIMULATOR", connectionReference: "hidden",
        environment: "PRODUCTION", status: "CONFIGURING",
      },
    });
    await expect(activateConnection(admin, row.id)).rejects.toThrow(/PRODUCTION/);
    await expect(setConnectionStatus(admin, row.id, "ACTIVE")).rejects.toThrow(/PRODUCTION/);
  });

  it("SANDBOX connection can activate on staging", async () => {
    delete process.env.PAYMENTS_REAL_MONEY_ENABLED;
    const { club, admin } = await ctx();
    const r = await createConnection(admin, {
      clubId: club.id, providerType: "MOCK_CDN_RAIL",
      connectionReference: "coulee-sbx", environment: "SANDBOX",
      credentialSecretRef: "kms:sbx",
    });
    await activateConnection(admin, r.id);
    const c = await db().paymentProviderConnection.findUniqueOrThrow({ where: { id: r.id } });
    expect(c.status).toBe("ACTIVE");
  });

  it("REVOKED is terminal — cannot be transitioned back", async () => {
    const { club, admin } = await ctx();
    const r = await createConnection(admin, {
      clubId: club.id, providerType: "SIMULATOR",
      connectionReference: "c1", environment: "SIMULATOR",
      credentialSecretRef: "kms:c1",
    });
    await setConnectionStatus(admin, r.id, "REVOKED");
    await expect(activateConnection(admin, r.id)).rejects.toThrow(/REVOKED/);
    await expect(setConnectionStatus(admin, r.id, "ACTIVE")).rejects.toThrow(/REVOKED/);
    await expect(rotateConnectionCredential(admin, r.id, "kms:new")).rejects.toThrow(/REVOKED/);
  });

  it("rotation creates v2, deactivates v1, preserves historical version rows", async () => {
    const { club, admin } = await ctx();
    const r = await createConnection(admin, {
      clubId: club.id, providerType: "SIMULATOR",
      connectionReference: "cr", environment: "SIMULATOR",
      credentialSecretRef: "kms:v1",
    });
    await activateConnection(admin, r.id);
    const rot = await rotateConnectionCredential(admin, r.id, "kms:v2");
    expect(rot.activatedVersion).toBe(2);
    const versions = await db().paymentProviderConnectionVersion.findMany({
      where: { connectionId: r.id }, orderBy: { version: "asc" },
    });
    expect(versions).toHaveLength(2);
    expect(versions[0].deactivatedAt).not.toBeNull();
    expect(versions[1].deactivatedAt).toBeNull();
    expect(versions[1].credentialSecretRef).toBe("kms:v2");
  });

  it("resolveActiveConnection returns only the ACTIVE connection's current-version credential ref", async () => {
    const { club, admin } = await ctx();
    const r = await createConnection(admin, {
      clubId: club.id, providerType: "SIMULATOR",
      connectionReference: "cr", environment: "SIMULATOR",
      credentialSecretRef: "kms:vA",
    });
    await activateConnection(admin, r.id);
    await rotateConnectionCredential(admin, r.id, "kms:vB");
    const active = await resolveActiveConnection(club.id, "SIMULATOR");
    expect(active.connectionId).toBe(r.id);
    expect(active.credentialSecretRef).toBe("kms:vB");
    expect(active.environment).toBe("SIMULATOR");
  });

  it("resolveActiveConnection refuses when no ACTIVE connection exists", async () => {
    const { club } = await ctx();
    await expect(resolveActiveConnection(club.id, "SIMULATOR")).rejects.toThrow(/no ACTIVE/);
  });
});
