// PAY-1B/4 — operational exceptions + circuit breaker health.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { createConnection, activateConnection } from "@/lib/payments/provider/connection";
import { recordHealthSample, assertConnectionUsable } from "@/lib/payments/provider/health";
import { raiseOperationalException } from "@/lib/payments/operational-exceptions";

async function seed() {
  const club = await makeClub("H " + Math.random().toString(36).slice(2));
  const adminE = `a-${Math.random().toString(36).slice(2)}@t.test`;
  await makeUser({ email: adminE, role: "CLUB_ADMIN", clubId: club.id });
  const admin = await principalFor(adminE);
  const conn = await createConnection(admin, {
    clubId: club.id, providerType: "SIMULATOR",
    connectionReference: "h1", environment: "SIMULATOR",
    credentialSecretRef: "kms:h1",
  });
  await activateConnection(admin, conn.id);
  return { club, admin, connectionId: conn.id };
}

describe("PAY-1B/4 · Operational exceptions", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("raises Work Intake item with correct domain + subtype", async () => {
    const { club } = await seed();
    const r = await raiseOperationalException({
      clubId: club.id,
      kind: "AMOUNT_MISMATCH",
      summary: "Amount mismatch on event XYZ",
      detail: "event=$99 auth=$100",
    });
    const wi = await db().workIntakeItem.findUniqueOrThrow({ where: { id: r.workIntakeItemId } });
    expect(wi.workDomain).toBe("PAYROLL");
    expect(wi.workIntent).toBe("REVIEW");
    expect(wi.workSubtype).toBe("PAYMENT_EXCEPTION_AMOUNT_MISMATCH");
    expect(wi.status).toBe("OPEN");
    expect(wi.judgmentRequired).toBe(true);
  });
});

describe("PAY-1B/4 · Circuit breaker health", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("5 consecutive failures flip ACTIVE → DEGRADED", async () => {
    const { connectionId } = await seed();
    for (let i = 0; i < 4; i++) {
      const r = await recordHealthSample({ connectionId, outcome: "FAILURE" });
      expect(r.status).toBe("ACTIVE");
      expect(r.consecutiveFailures).toBe(i + 1);
    }
    const r5 = await recordHealthSample({ connectionId, outcome: "FAILURE" });
    expect(r5.status).toBe("DEGRADED");
    expect(r5.flipped).toBe(true);
    expect(r5.consecutiveFailures).toBe(5);
  });

  it("first OK sample after DEGRADED flips back to ACTIVE + resets counter", async () => {
    const { connectionId } = await seed();
    for (let i = 0; i < 5; i++) {
      await recordHealthSample({ connectionId, outcome: "FAILURE" });
    }
    const r = await recordHealthSample({ connectionId, outcome: "OK" });
    expect(r.status).toBe("ACTIVE");
    expect(r.consecutiveFailures).toBe(0);
    expect(r.flipped).toBe(true);
  });

  it("assertConnectionUsable refuses DEGRADED / SUSPENDED / REVOKED", async () => {
    const { connectionId } = await seed();
    await expect(assertConnectionUsable(connectionId)).resolves.toBeUndefined();
    for (let i = 0; i < 5; i++) {
      await recordHealthSample({ connectionId, outcome: "FAILURE" });
    }
    await expect(assertConnectionUsable(connectionId)).rejects.toThrow(/DEGRADED/);
  });
});
