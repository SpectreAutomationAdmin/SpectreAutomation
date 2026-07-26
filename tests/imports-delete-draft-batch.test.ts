// deleteDraftBatch — service-layer unit tests.
//
// Covers the founder's acceptance criteria for the Delete affordance
// on the Data Imports list:
//
//   1. A DRAFT batch can be deleted; the batch row, every ImportRow,
//      and every ImportError tied to it cascade away.
//   2. Non-DRAFT batches (VALIDATED, COMMITTED, ROLLED_BACK) are
//      rejected with a ConflictError — UI hides the button for those
//      states; the service is the authoritative gate against a
//      crafted POST.
//   3. Tenant scoping: one club's admin cannot delete another club's
//      batch.
//   4. The audit log records the deletion (`import.batch.delete`)
//      with the original batch details for compliance.
//   5. UNKNOWN batchId surfaces a NotFoundError.
//
// The server-action wrapper (`deleteDraftBatchAction`) is a thin
// pass-through to this library fn — the cookie / revalidatePath
// plumbing is the same shape as `createBatchAction` and is covered
// indirectly by the e2e spec.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "@/lib/errors";
import { createBatch, deleteDraftBatch, validateBatch } from "@/lib/imports";

import { db, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";

async function admin(clubId: string) {
  const email = `admin-${Math.random().toString(36).slice(2, 10)}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}

async function uploadCoaBatch(
  p: Awaited<ReturnType<typeof admin>>,
  clubId: string,
  rows: Record<string, string>[],
  fileName = "test-coa.csv",
) {
  return createBatch(p, {
    clubId,
    domain: "COA",
    rows: rows as Record<string, string | number | boolean | null>[],
    source: "CSV",
    fileName,
  });
}

describe("deleteDraftBatch", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("deletes a DRAFT batch and cascades every ImportRow + ImportError", async () => {
    const club = await bootstrapAPClub("DEL-1");
    const p = await admin(club.id);
    const batch = await uploadCoaBatch(p, club.id, [
      { number: "9001", name: "Abandoned upload" },
      { number: "9002", name: "Second row" },
    ]);

    // Run validate so an ImportError row exists (the missing
    // type/categoryKey/fsGroupKey will fail the COA resolver).
    await validateBatch(p, batch.id);
    expect(
      await db().importError.count({ where: { batchId: batch.id } }),
    ).toBeGreaterThan(0);

    // Flip the batch back to DRAFT (validateBatch left it
    // VALIDATED; the founder spec says "still in DRAFT"). The
    // founder-typical state — abandoned right after upload — is
    // already DRAFT; we use this manual flip to also exercise the
    // cascade against ImportError rows.
    await db().importBatch.update({
      where: { id: batch.id },
      data: { status: "DRAFT" },
    });

    const result = await deleteDraftBatch(p, batch.id);
    expect(result.deleted).toBe(true);

    expect(await db().importBatch.findUnique({ where: { id: batch.id } })).toBeNull();
    expect(await db().importRow.count({ where: { batchId: batch.id } })).toBe(0);
    expect(await db().importError.count({ where: { batchId: batch.id } })).toBe(0);
  });

  // Founder rule 2026-07-12: only COMMITTED batches are
  // protected from deletion. DRAFT / VALIDATED / FAILED /
  // ARCHIVED / SUPERSEDED / ROLLED_BACK are all deletable so
  // the Data Imports list stays clean.
  it("deletes a VALIDATED batch (founder rule 2026-07-12)", async () => {
    const club = await bootstrapAPClub("DEL-VAL");
    const p = await admin(club.id);
    const batch = await uploadCoaBatch(p, club.id, [
      { number: "9101", name: "Validated batch" },
    ]);
    await db().importBatch.update({
      where: { id: batch.id },
      data: { status: "VALIDATED" },
    });

    const result = await deleteDraftBatch(p, batch.id);
    expect(result.deleted).toBe(true);
    expect(await db().importBatch.findUnique({ where: { id: batch.id } })).toBeNull();
  });

  it("deletes a FAILED batch", async () => {
    const club = await bootstrapAPClub("DEL-FAILED");
    const p = await admin(club.id);
    const batch = await uploadCoaBatch(p, club.id, [
      { number: "9111", name: "Failed batch" },
    ]);
    await db().importBatch.update({
      where: { id: batch.id },
      data: { status: "FAILED" },
    });
    const result = await deleteDraftBatch(p, batch.id);
    expect(result.deleted).toBe(true);
    expect(await db().importBatch.findUnique({ where: { id: batch.id } })).toBeNull();
  });

  it("deletes an ARCHIVED batch (the founder's new lifecycle status for overridden COA imports)", async () => {
    const club = await bootstrapAPClub("DEL-ARC");
    const p = await admin(club.id);
    const batch = await uploadCoaBatch(p, club.id, [
      { number: "9121", name: "Archived batch" },
    ]);
    await db().importBatch.update({
      where: { id: batch.id },
      data: { status: "ARCHIVED" },
    });
    const result = await deleteDraftBatch(p, batch.id);
    expect(result.deleted).toBe(true);
    expect(await db().importBatch.findUnique({ where: { id: batch.id } })).toBeNull();
  });

  it("refuses to delete a COMMITTED batch (audit-history protection)", async () => {
    const club = await bootstrapAPClub("DEL-COM");
    const p = await admin(club.id);
    const batch = await uploadCoaBatch(p, club.id, [
      { number: "9201", name: "Committed batch" },
    ]);
    await db().importBatch.update({
      where: { id: batch.id },
      data: { status: "COMMITTED" },
    });

    let caught: unknown;
    try {
      await deleteDraftBatch(p, batch.id);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as ConflictError).safeMessage.toLowerCase()).toContain("committed");
    expect((caught as ConflictError).safeMessage.toLowerCase()).toContain("audit history");
    expect(await db().importBatch.findUnique({ where: { id: batch.id } })).not.toBeNull();
  });

  it("deletes a ROLLED_BACK batch (only COMMITTED is protected)", async () => {
    const club = await bootstrapAPClub("DEL-RB");
    const p = await admin(club.id);
    const batch = await uploadCoaBatch(p, club.id, [
      { number: "9301", name: "Rolled-back batch" },
    ]);
    await db().importBatch.update({
      where: { id: batch.id },
      data: { status: "ROLLED_BACK" },
    });
    const result = await deleteDraftBatch(p, batch.id);
    expect(result.deleted).toBe(true);
    expect(await db().importBatch.findUnique({ where: { id: batch.id } })).toBeNull();
  });

  it("tenant safety: an admin from another club cannot delete the batch", async () => {
    const clubA = await bootstrapAPClub("DEL-TENANT-A");
    const clubB = await bootstrapAPClub("DEL-TENANT-B");
    const adminA = await admin(clubA.id);
    const adminB = await admin(clubB.id);

    const batchA = await uploadCoaBatch(adminA, clubA.id, [
      { number: "9401", name: "Club A batch" },
    ]);

    // Admin B tries to delete Club A's batch.
    await expect(deleteDraftBatch(adminB, batchA.id)).rejects.toBeInstanceOf(ForbiddenError);

    // The batch is untouched.
    const survivor = await db().importBatch.findUnique({ where: { id: batchA.id } });
    expect(survivor).not.toBeNull();
    expect(survivor!.status).toBe("DRAFT");
  });

  it("returns NotFoundError for an unknown batchId", async () => {
    const club = await bootstrapAPClub("DEL-MISSING");
    const p = await admin(club.id);
    await expect(deleteDraftBatch(p, "definitely-not-a-batch-id")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("writes an `import.batch.delete` audit-log entry with the original batch metadata", async () => {
    const club = await bootstrapAPClub("DEL-AUDIT");
    const p = await admin(club.id);
    const batch = await uploadCoaBatch(
      p,
      club.id,
      [{ number: "9501", name: "Audit me" }],
      "audit-test.csv",
    );

    await deleteDraftBatch(p, batch.id);

    const audits = await db().auditLog.findMany({
      where: { entityId: batch.id, action: "import.batch.delete" },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].clubId).toBe(club.id);
    // `before` payload captures the doomed batch's metadata.
    const before = JSON.parse(audits[0].beforeJson ?? "{}");
    expect(before).toMatchObject({
      domain: "COA",
      status: "DRAFT",
      fileName: "audit-test.csv",
    });
  });
});
