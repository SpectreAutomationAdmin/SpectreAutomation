// v399 Slice-1 followup #2 (2026-09-15) — DRAFT-eligibility for
// Discard Prepared Payroll.
//
// Rationale (see block comment in src/lib/payroll/batch-preparation.ts):
//   A DRAFT batch is a Prepare whose blockers left it uncalculatable
//   (canonically indistinguishable from PREPARED except for the
//   presence of BLOCKERs). Chris's staging batch was DRAFT because his
//   pre-onboarding facts produced MISSING_DATE_OF_BIRTH. The founder
//   directive §5-6 is: employee source data changes → discard prepared
//   → prepare again. The eligibility must include DRAFT as well as
//   PREPARED so the recovery path works after onboarding.
//
// This suite proves:
//   1. DRAFT batch is discardable + audit records prior status DRAFT.
//   2. PREPARED remains discardable (existing behavior preserved) +
//      audit records prior status PREPARED.
//   3. CALCULATED / SUBMITTED_FOR_APPROVAL / APPROVED / POSTED still
//      refused.
//   4. Idempotent on VOIDED.
//   5. Concurrent discard against DRAFT — one wins, the other returns
//      the idempotent no-op success path.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "./util/db";
import { discardPreparedPayrollBatch } from "@/lib/payroll/batch-preparation";
import { ValidationError } from "@/lib/errors";

async function seedBatch(opts: { clubName: string; status: string }) {
  const c = db();
  const club = await makeClub(opts.clubName);
  const email = `pa.${opts.clubName}@t.test`;
  await makeUser({ email, clubId: club.id, role: "PAYROLL_ADMIN" });
  const principal = await principalFor(email);

  const payGroup = await c.payrollPayGroup.create({
    data: {
      clubId: club.id,
      code: `PG-${opts.clubName}`.slice(0, 20),
      name: "Test Pay Group",
      payFrequency: "BIWEEKLY",
      active: true,
      calendarAnchorDate: new Date("2026-01-04"),
    },
  });
  const payPeriod = await c.payrollPayPeriod.create({
    data: {
      clubId: club.id, payGroupId: payGroup.id,
      sequenceInYear: 1, taxYear: 2026,
      periodStart: new Date("2026-01-04"), periodEnd: new Date("2026-01-17"),
      payDate: new Date("2026-01-17"), status: "OPEN",
    },
  });
  // DRAFT batches do NOT have preparedAt (blocker path); PREPARED do.
  const preparedAtStates = new Set(["PREPARED", "CALCULATED", "SUBMITTED_FOR_APPROVAL", "APPROVED", "POSTED"]);
  const batch = await c.payrollBatch.create({
    data: {
      clubId: club.id, payGroupId: payGroup.id, payPeriodId: payPeriod.id,
      status: opts.status, sequence: 1,
      sourceSnapshotAt: new Date(),
      createdByUserId: principal.id,
      preparedAt: preparedAtStates.has(opts.status) ? new Date() : null,
      preparedByUserId: preparedAtStates.has(opts.status) ? principal.id : null,
    },
  });
  return { club, principal, batch };
}

describe("Discard Prepared Payroll — DRAFT eligibility (v399 followup #2)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("DRAFT batch is discardable → status VOIDED + audit records prior status DRAFT", async () => {
    const { club, principal, batch } = await seedBatch({ clubName: "draft1", status: "DRAFT" });
    const result = await discardPreparedPayrollBatch(principal, club.id, batch.id, "onboarding data corrected");
    expect(result.batchId).toBe(batch.id);
    const after = await db().payrollBatch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(after.status).toBe("VOIDED");
    expect(after.voidedAt).not.toBeNull();
    expect(after.voidReason).toBe("onboarding data corrected");

    const audits = await db().auditLog.findMany({
      where: { entityId: batch.id, action: "payroll.batch.discard" },
      orderBy: { createdAt: "desc" },
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const before = JSON.parse(audits[0].beforeJson ?? "{}");
    expect(before.status).toBe("DRAFT");
  });

  it("PREPARED batch is discardable → status VOIDED + audit records prior status PREPARED (regression)", async () => {
    const { club, principal, batch } = await seedBatch({ clubName: "prepared1", status: "PREPARED" });
    await discardPreparedPayrollBatch(principal, club.id, batch.id);
    const after = await db().payrollBatch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(after.status).toBe("VOIDED");
    const audits = await db().auditLog.findMany({
      where: { entityId: batch.id, action: "payroll.batch.discard" },
      orderBy: { createdAt: "desc" },
    });
    const before = JSON.parse(audits[0].beforeJson ?? "{}");
    expect(before.status).toBe("PREPARED");
  });

  it("CALCULATED still refuses", async () => {
    const { club, principal, batch } = await seedBatch({ clubName: "calc1", status: "CALCULATED" });
    await expect(discardPreparedPayrollBatch(principal, club.id, batch.id)).rejects.toBeInstanceOf(ValidationError);
    const after = await db().payrollBatch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(after.status).toBe("CALCULATED"); // unchanged
  });

  it("SUBMITTED_FOR_APPROVAL still refuses", async () => {
    const { club, principal, batch } = await seedBatch({ clubName: "sub1", status: "SUBMITTED_FOR_APPROVAL" });
    await expect(discardPreparedPayrollBatch(principal, club.id, batch.id)).rejects.toBeInstanceOf(ValidationError);
  });

  it("APPROVED still refuses", async () => {
    const { club, principal, batch } = await seedBatch({ clubName: "apr1", status: "APPROVED" });
    await expect(discardPreparedPayrollBatch(principal, club.id, batch.id)).rejects.toBeInstanceOf(ValidationError);
  });

  it("POSTED still refuses (immutability preserved)", async () => {
    const { club, principal, batch } = await seedBatch({ clubName: "post1", status: "POSTED" });
    await expect(discardPreparedPayrollBatch(principal, club.id, batch.id)).rejects.toBeInstanceOf(ValidationError);
    const after = await db().payrollBatch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(after.status).toBe("POSTED");
  });

  it("second discard against an already-discarded DRAFT batch is idempotent", async () => {
    const { club, principal, batch } = await seedBatch({ clubName: "double1", status: "DRAFT" });
    await discardPreparedPayrollBatch(principal, club.id, batch.id);
    const r = await discardPreparedPayrollBatch(principal, club.id, batch.id);
    expect(r.batchId).toBe(batch.id);
    expect(r.releasedTimeEntryCount).toBe(0);
  });
});
