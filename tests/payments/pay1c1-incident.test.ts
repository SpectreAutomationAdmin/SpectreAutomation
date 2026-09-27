// PAY-1C/1 — Payment incident architecture unit tests.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub } from "../util/db";
import {
  openIncident,
  linkIncidentEntities,
  transitionIncident,
  readIncidentTimeline,
} from "@/lib/payments/incidents";

describe("PAY-1C/1 · payment incident architecture", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("opens an incident with a stable incidentNumber + initial timeline entry", async () => {
    const club = await makeClub("PC1 " + Math.random().toString(36).slice(2));
    const { id, incidentNumber } = await openIncident({
      clubId: club.id,
      category: "PROVIDER_OUTAGE",
      severity: "SEV_2",
      summary: "Simulator connection flipped DEGRADED after 5 failures",
      detectedSource: "AUTOMATED_HEALTH",
      links: [{ entityType: "PROVIDER_CONNECTION", entityId: "conn-1" }],
    });
    expect(incidentNumber).toMatch(/^INC-\d{4}-\d{6}$/);
    const row = await db().paymentIncident.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("DETECTED");
    expect(row.category).toBe("PROVIDER_OUTAGE");
    const timeline = await readIncidentTimeline(id);
    expect(timeline).toHaveLength(1);
    expect(timeline[0].event).toBe("DETECTED");
  });

  it("supports the full lifecycle DETECTED → TRIAGED → CONTAINED → INVESTIGATING → RECOVERED → RESOLVED with timeline growth", async () => {
    const club = await makeClub("PC1L " + Math.random().toString(36).slice(2));
    const { id } = await openIncident({
      clubId: club.id,
      category: "PROVIDER_OUTAGE",
      severity: "SEV_2",
      summary: "outage",
      detectedSource: "AUTOMATED_HEALTH",
    });
    await transitionIncident(id, "TRIAGED", "operator-A");
    await transitionIncident(id, "CONTAINED", "operator-A", "connection suspended");
    await transitionIncident(id, "INVESTIGATING", "operator-B");
    await transitionIncident(id, "RECOVERED", "operator-B");
    await transitionIncident(id, "RESOLVED", "operator-B");
    const row = await db().paymentIncident.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("RESOLVED");
    expect(row.triagedAt).not.toBeNull();
    expect(row.containedAt).not.toBeNull();
    expect(row.investigatedAt).not.toBeNull();
    expect(row.recoveredAt).not.toBeNull();
    expect(row.resolvedAt).not.toBeNull();
    const timeline = await readIncidentTimeline(id);
    expect(timeline.map((e) => e.event)).toEqual([
      "DETECTED", "TRIAGED", "CONTAINED", "INVESTIGATING", "RECOVERED", "RESOLVED",
    ]);
  });

  it("refuses illegal transitions (RESOLVED → DETECTED)", async () => {
    const club = await makeClub("PC1I " + Math.random().toString(36).slice(2));
    const { id } = await openIncident({
      clubId: club.id,
      category: "SUSPECTED_DUPLICATE_EXECUTION",
      severity: "SEV_1",
      summary: "dup",
      detectedSource: "OPERATOR",
    });
    await transitionIncident(id, "TRIAGED", "operator");
    await transitionIncident(id, "RESOLVED", "operator");
    await expect(transitionIncident(id, "DETECTED" as never, "operator")).rejects.toThrow(
      /cannot transition/,
    );
  });

  it("linkIncidentEntities is idempotent (same entity twice does not create duplicates)", async () => {
    const club = await makeClub("PC1K " + Math.random().toString(36).slice(2));
    const { id } = await openIncident({
      clubId: club.id,
      category: "RECONCILIATION_DISCREPANCY",
      severity: "SEV_3",
      summary: "recon",
      detectedSource: "RECONCILIATION",
    });
    await linkIncidentEntities(id, [
      { entityType: "PAYMENT_RUN", entityId: "run-1" },
      { entityType: "PAYMENT_RUN", entityId: "run-1" },
      { entityType: "PAYMENT_INSTRUCTION", entityId: "inst-1" },
    ]);
    const links = await db().paymentIncidentLink.findMany({ where: { incidentId: id } });
    expect(links).toHaveLength(2);
  });

  it("regulatoryAssessmentRequired flag is stored verbatim; never auto-decided", async () => {
    const club = await makeClub("PC1R " + Math.random().toString(36).slice(2));
    const { id: idFalse } = await openIncident({
      clubId: club.id,
      category: "PROVIDER_OUTAGE",
      severity: "SEV_4",
      summary: "minor outage",
      detectedSource: "AUTOMATED_HEALTH",
    });
    const { id: idTrue } = await openIncident({
      clubId: club.id,
      category: "CREDENTIAL_COMPROMISE",
      severity: "SEV_1",
      summary: "credentials leaked",
      detectedSource: "OPERATOR",
      regulatoryAssessmentRequired: true,
    });
    const rows = await db().paymentIncident.findMany({ where: { id: { in: [idFalse, idTrue] } } });
    const flags = Object.fromEntries(rows.map((r) => [r.id, r.regulatoryAssessmentRequired]));
    expect(flags[idFalse]).toBe(false);
    expect(flags[idTrue]).toBe(true);
  });

  it("timeline is APPEND-ONLY — a new transition never rewrites earlier entries", async () => {
    const club = await makeClub("PC1T " + Math.random().toString(36).slice(2));
    const { id } = await openIncident({
      clubId: club.id,
      category: "PROVIDER_OUTAGE",
      severity: "SEV_2",
      summary: "outage",
      detectedSource: "AUTOMATED_HEALTH",
    });
    const initial = await readIncidentTimeline(id);
    await transitionIncident(id, "TRIAGED", "actor", "note-1");
    await transitionIncident(id, "CONTAINED", "actor", "note-2");
    const finalTimeline = await readIncidentTimeline(id);
    expect(finalTimeline.slice(0, 1)).toEqual(initial);
    expect(finalTimeline[1].note).toBe("note-1");
    expect(finalTimeline[2].note).toBe("note-2");
  });

  it("platform-wide incident (clubId=null) is permitted and returns cleanly", async () => {
    const { id } = await openIncident({
      clubId: null,
      category: "CALLBACK_VERIFICATION_ATTACK",
      severity: "SEV_1",
      summary: "multi-tenant callback forge attempt detected",
      detectedSource: "OPERATOR",
    });
    const row = await db().paymentIncident.findUniqueOrThrow({ where: { id } });
    expect(row.clubId).toBeNull();
  });
});
