// PAY-1C/2 — canonical rail-neutral instruction mapping.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { db, resetDb, seedRbac, makeClub } from "../util/db";
import {
  deriveCanonicalRailInstructions,
  computeEndToEndId,
  correlateExternalReference,
  assertNoBankSecretsInCanonical,
} from "@/lib/payments/rail/canonical";

async function seedAuthorizedRun(clubId: string, opts: { instructions: { recipientId: string; amount: string }[] }) {
  const c = db();
  const bankAcc = await c.account.create({
    data: {
      clubId, accountNumber: "10" + Math.floor(Math.random() * 1_000_000), name: "Bank", type: "ASSET",
      normalBalance: "DEBIT", isBankAccount: true, isCashAccount: true, isActive: true,
      allowManualPosting: false, accountRole: "CASH",
    },
  });
  const bank = await c.bankAccount.create({
    data: {
      clubId, institutionReference: "SIM-0100",
      displayName: "Ops ***0100", maskedIdentifier: "***0100",
      currency: "CAD", status: "ACTIVE", glAccountId: bankAcc.id,
    },
  });
  const run = await c.paymentRun.create({
    data: {
      clubId, runNumber: "PR-" + Math.floor(Math.random() * 1_000_000),
      sourceType: "PAYROLL_BATCH", sourceId: null,
      fundingBankAccountId: bank.id, currency: "CAD",
      requestedExecutionDate: new Date("2026-11-30"),
      totalAmount: new Prisma.Decimal("0.00"),
      instructionCount: opts.instructions.length,
      status: "AUTHORIZED",
      createdByUserId: "user-1",
    },
  });
  let total = new Prisma.Decimal("0.00");
  for (const [i, spec] of opts.instructions.entries()) {
    const dest = await c.paymentDestinationSnapshot.create({
      data: {
        clubId, recipientType: "EMPLOYEE",
        recipientId: spec.recipientId, sourceModel: "EmployeeBankAccount",
        sourceId: `eba-${spec.recipientId}`, sourceVersion: 1,
        maskedIdentifier: `***${String(i).padStart(4, "0")}`,
        institutionSecretRef: "kms:i-" + i,
        transitSecretRef: "kms:t-" + i,
        accountSecretRef: "kms:a-" + i,
        currency: "CAD",
      },
    });
    await c.paymentInstruction.create({
      data: {
        clubId, runId: run.id,
        sourceType: "PAYROLL_BATCH", sourceReference: "emp-" + spec.recipientId,
        recipientType: "EMPLOYEE", recipientId: spec.recipientId,
        amount: new Prisma.Decimal(spec.amount), currency: "CAD",
        destinationSnapshotId: dest.id,
        requestedExecutionDate: new Date("2026-11-30"),
        status: "AUTHORIZED", instructionFingerprint: `ifp-${i}`,
        authorizedAt: new Date(),
      },
    });
    total = total.plus(new Prisma.Decimal(spec.amount));
  }
  await c.paymentRun.update({ where: { id: run.id }, data: { totalAmount: total } });
  return { runId: run.id, bankMask: "***0100" };
}

describe("PAY-1C/2 · canonical rail mapping", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("derives one canonical instruction per PaymentInstruction with amount/currency preserved exactly", async () => {
    const club = await makeClub("RAIL " + Math.random().toString(36).slice(2));
    const { runId } = await seedAuthorizedRun(club.id, {
      instructions: [
        { recipientId: "emp-1", amount: "1234.56" },
        { recipientId: "emp-2", amount: "9876.10" },
      ],
    });
    const canonical = await deriveCanonicalRailInstructions(runId);
    expect(canonical).toHaveLength(2);
    const amounts = canonical.map((c) => c.amount).sort();
    expect(amounts).toEqual(["1234.56", "9876.1"].sort());
    for (const c of canonical) {
      expect(c.currency).toBe("CAD");
      expect(c.debtorMaskedIdentifier).toBe("***0100");
    }
  });

  it("endToEndId is deterministic + stable across two derivation passes", async () => {
    const club = await makeClub("RAILE " + Math.random().toString(36).slice(2));
    const { runId } = await seedAuthorizedRun(club.id, {
      instructions: [{ recipientId: "emp-A", amount: "500.00" }],
    });
    const first = await deriveCanonicalRailInstructions(runId);
    const second = await deriveCanonicalRailInstructions(runId);
    expect(first[0].endToEndId).toBe(second[0].endToEndId);
    expect(first[0].endToEndId).toMatch(/^E2E-v1-[0-9a-f]{32}$/);
  });

  it("computeEndToEndId depends on economic identity — same inputs, same output", async () => {
    const e1 = computeEndToEndId({
      clubId: "club-1", paymentRunId: "run-A", paymentInstructionId: "inst-A",
      destinationSnapshotId: "dest-A", amount: "100.00", currency: "CAD",
      requestedExecutionDate: "2026-12-01",
    });
    const e2 = computeEndToEndId({
      clubId: "club-1", paymentRunId: "run-A", paymentInstructionId: "inst-A",
      destinationSnapshotId: "dest-A", amount: "100.00", currency: "CAD",
      requestedExecutionDate: "2026-12-01",
    });
    expect(e1).toBe(e2);
    // Change amount => different.
    const e3 = computeEndToEndId({
      clubId: "club-1", paymentRunId: "run-A", paymentInstructionId: "inst-A",
      destinationSnapshotId: "dest-A", amount: "100.01", currency: "CAD",
      requestedExecutionDate: "2026-12-01",
    });
    expect(e3).not.toBe(e1);
  });

  it("refuses to derive canonical from a PREPARED run (not yet authorized)", async () => {
    const club = await makeClub("RAILP " + Math.random().toString(36).slice(2));
    const c = db();
    const bankAcc = await c.account.create({
      data: {
        clubId: club.id, accountNumber: "1010" + Math.floor(Math.random() * 1000),
        name: "B", type: "ASSET", normalBalance: "DEBIT",
        isBankAccount: true, isCashAccount: true, isActive: true,
        allowManualPosting: false, accountRole: "CASH",
      },
    });
    const bank = await c.bankAccount.create({
      data: {
        clubId: club.id, institutionReference: "SIM",
        displayName: "B", maskedIdentifier: "***",
        currency: "CAD", status: "ACTIVE", glAccountId: bankAcc.id,
      },
    });
    const run = await c.paymentRun.create({
      data: {
        clubId: club.id, runNumber: "PR-PREP",
        sourceType: "PAYROLL_BATCH", sourceId: null,
        fundingBankAccountId: bank.id, currency: "CAD",
        requestedExecutionDate: new Date("2026-11-30"),
        totalAmount: new Prisma.Decimal("0"),
        instructionCount: 0,
        status: "PREPARED",
        createdByUserId: "u",
      },
    });
    await expect(deriveCanonicalRailInstructions(run.id)).rejects.toThrow(/not authorized/);
  });

  it("canonical projection never leaks bank secret refs", async () => {
    const club = await makeClub("RAILS " + Math.random().toString(36).slice(2));
    const { runId } = await seedAuthorizedRun(club.id, {
      instructions: [{ recipientId: "emp-X", amount: "42.00" }],
    });
    const canonical = await deriveCanonicalRailInstructions(runId);
    for (const c of canonical) {
      assertNoBankSecretsInCanonical(c);
      const s = JSON.stringify(c);
      expect(s).not.toMatch(/institutionSecretRef|transitSecretRef|accountSecretRef/);
    }
  });

  it("correlateExternalReference resolves an endToEndId back to PaymentInstruction + Run + Club", async () => {
    const club = await makeClub("RAILC " + Math.random().toString(36).slice(2));
    const { runId } = await seedAuthorizedRun(club.id, {
      instructions: [{ recipientId: "emp-C", amount: "77.77" }],
    });
    const canonical = await deriveCanonicalRailInstructions(runId);
    const r = await correlateExternalReference(canonical[0].endToEndId);
    expect(r).not.toBeNull();
    expect(r?.paymentRunId).toBe(runId);
    expect(r?.paymentInstructionId).toBe(canonical[0].spectrePaymentInstructionId);
    expect(r?.clubId).toBe(club.id);
  });

  it("correlateExternalReference returns null for an unknown reference (no fuzzy matching)", async () => {
    const r = await correlateExternalReference("E2E-v1-deadbeef");
    expect(r).toBeNull();
  });
});
