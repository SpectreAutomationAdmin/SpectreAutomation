// PAY-1C.1 — incident-driven containment via legitimate PAY-1B
// setConnectionStatus service + append-only incident timeline record.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import {
  createConnection, activateConnection, setConnectionStatus,
} from "@/lib/payments/provider/connection";
import { assertConnectionUsable } from "@/lib/payments/provider/health";
import {
  openIncident,
  linkIncidentEntities,
  appendIncidentAction,
  readIncidentTimeline,
} from "@/lib/payments/incidents";

async function seed() {
  const club = await makeClub("IC " + Math.random().toString(36).slice(2));
  const admE = `adm-${Math.random().toString(36).slice(2)}@t.test`;
  await makeUser({ email: admE, role: "CLUB_ADMIN", clubId: club.id });
  const admin = await principalFor(admE);
  return { club, admin };
}

describe("PAY-1C.1 · incident-driven containment", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("legitimate containment: setConnectionStatus(SUSPENDED) + incident timeline records the action; new submissions refused; existing state preserved", async () => {
    const { club, admin } = await seed();
    const conn = await createConnection(admin, {
      clubId: club.id, providerType: "SIMULATOR", connectionReference: "ic1",
      environment: "SIMULATOR", credentialSecretRef: "kms:ic1",
    });
    await activateConnection(admin, conn.id);

    const { id: incidentId } = await openIncident({
      clubId: club.id, category: "PROVIDER_OUTAGE", severity: "SEV_2",
      summary: "PAY-1C.1 acceptance outage", detectedSource: "OPERATOR",
    });
    await linkIncidentEntities(incidentId, [
      { entityType: "PROVIDER_CONNECTION", entityId: conn.id },
    ]);

    // Legitimate containment via PAY-1B service.
    await setConnectionStatus(admin, conn.id, "SUSPENDED");
    await appendIncidentAction(incidentId, {
      actor: admin.id, event: "CONTAIN_CONNECTION",
      note: `connectionId=${conn.id} status=SUSPENDED`,
    });

    // Verify: new submissions refused via existing PAY-1B guard.
    await expect(assertConnectionUsable(conn.id)).rejects.toThrow(/SUSPENDED/);

    // Verify: connection row exists, versions unaltered.
    const cur = await db().paymentProviderConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(cur.status).toBe("SUSPENDED");
    const version = await db().paymentProviderConnectionVersion.findFirstOrThrow({ where: { connectionId: conn.id } });
    expect(version.deactivatedAt).toBeNull();

    // Verify: incident timeline recorded containment (append-only).
    const timeline = await readIncidentTimeline(incidentId);
    expect(timeline.map((e) => e.event)).toEqual(["DETECTED", "CONTAIN_CONNECTION"]);
    expect(timeline[1].note).toContain(conn.id);
  });

  it("restoration: setConnectionStatus(ACTIVE) + timeline records restore; connection usable again", async () => {
    const { club, admin } = await seed();
    const conn = await createConnection(admin, {
      clubId: club.id, providerType: "SIMULATOR", connectionReference: "ic2",
      environment: "SIMULATOR", credentialSecretRef: "kms:ic2",
    });
    await activateConnection(admin, conn.id);
    const { id: incidentId } = await openIncident({
      clubId: club.id, category: "PROVIDER_OUTAGE", severity: "SEV_3",
      summary: "outage-restored", detectedSource: "OPERATOR",
    });
    await setConnectionStatus(admin, conn.id, "SUSPENDED");
    await appendIncidentAction(incidentId, { actor: admin.id, event: "CONTAIN_CONNECTION", note: conn.id });
    await setConnectionStatus(admin, conn.id, "ACTIVE");
    await appendIncidentAction(incidentId, { actor: admin.id, event: "RESTORE_CONNECTION", note: conn.id });

    const cur = await db().paymentProviderConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(cur.status).toBe("ACTIVE");
    const usable = assertConnectionUsable(conn.id);
    await expect(usable).resolves.toBeUndefined();

    const timeline = await readIncidentTimeline(incidentId);
    expect(timeline.map((e) => e.event)).toEqual([
      "DETECTED", "CONTAIN_CONNECTION", "RESTORE_CONNECTION",
    ]);
  });

  it("cross-tenant containment is refused (setConnectionStatus honours tenant ownership)", async () => {
    const seedA = await seed();
    const seedB = await seed();
    const connA = await createConnection(seedA.admin, {
      clubId: seedA.club.id, providerType: "SIMULATOR", connectionReference: "ic-x",
      environment: "SIMULATOR", credentialSecretRef: "kms:ic-x",
    });
    await activateConnection(seedA.admin, connA.id);
    // seedB admin tries to suspend seedA's connection.
    await expect(setConnectionStatus(seedB.admin, connA.id, "SUSPENDED")).rejects.toThrow();
  });
});
