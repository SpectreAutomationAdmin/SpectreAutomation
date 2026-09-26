// PAY-1A/1 — schema + primitive invariants.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import {
  paymentsEnabled, realMoneyEnabled,
  assertPaymentsEnabled, assertRealMoneyEnabled,
  assertProviderConstructionAllowed,
  RealMoneyDisabledError, PaymentsDisabledError,
} from "@/lib/payments/kill-switch";
import { instructionFingerprint, paymentFingerprint } from "@/lib/payments/fingerprint";
import { canTransitionRunState } from "@/lib/payments/types";
import { assertReconciles, assertMaterialFieldsUnchanged } from "@/lib/payments/instruction";
import type { PaymentInstructionMaterialFields } from "@/lib/payments/types";
import { resetDb, seedRbac } from "../util/db";

describe("PAY-1A/1 · Kill-switch", () => {
  const orig = {
    en: process.env.PAYMENTS_ENABLED,
    rm: process.env.PAYMENTS_REAL_MONEY_ENABLED,
  };
  beforeEach(() => {
    if (orig.en === undefined) delete process.env.PAYMENTS_ENABLED; else process.env.PAYMENTS_ENABLED = orig.en;
    if (orig.rm === undefined) delete process.env.PAYMENTS_REAL_MONEY_ENABLED; else process.env.PAYMENTS_REAL_MONEY_ENABLED = orig.rm;
  });

  it("PAYMENTS_ENABLED defaults to true", () => {
    delete process.env.PAYMENTS_ENABLED;
    expect(paymentsEnabled()).toBe(true);
  });

  it("PAYMENTS_ENABLED=false blocks", () => {
    process.env.PAYMENTS_ENABLED = "false";
    expect(paymentsEnabled()).toBe(false);
    expect(() => assertPaymentsEnabled()).toThrow(PaymentsDisabledError);
  });

  it("PAYMENTS_REAL_MONEY_ENABLED defaults to false", () => {
    delete process.env.PAYMENTS_REAL_MONEY_ENABLED;
    expect(realMoneyEnabled()).toBe(false);
    expect(() => assertRealMoneyEnabled()).toThrow(RealMoneyDisabledError);
  });

  it("real-money capable providers cannot construct when real-money disabled", () => {
    delete process.env.PAYMENTS_REAL_MONEY_ENABLED;
    expect(() => assertProviderConstructionAllowed({
      providerType: "HYPOTHETICAL_REAL_PROVIDER",
      movesRealMoney: true,
    })).toThrow(RealMoneyDisabledError);
  });

  it("simulator (movesRealMoney:false) can always construct", () => {
    delete process.env.PAYMENTS_REAL_MONEY_ENABLED;
    expect(() => assertProviderConstructionAllowed({
      providerType: "SIMULATOR",
      movesRealMoney: false,
    })).not.toThrow();
  });

  it("even simulator is blocked when PAYMENTS_ENABLED=false (defense in depth)", () => {
    process.env.PAYMENTS_ENABLED = "false";
    expect(() => assertProviderConstructionAllowed({
      providerType: "SIMULATOR",
      movesRealMoney: false,
    })).toThrow(PaymentsDisabledError);
  });
});

describe("PAY-1A/1 · Fingerprint determinism", () => {
  const base: PaymentInstructionMaterialFields = {
    clubId: "club-1",
    runId: "run-1",
    sourceType: "PAYROLL",
    sourceId: "payroll-batch-1",
    recipientType: "EMPLOYEE",
    recipientId: "emp-1",
    amount: "3037.33",
    currency: "CAD",
    destinationSnapshotId: "snap-1",
    requestedExecutionDate: "2026-09-30T00:00:00.000Z",
    fundingBankAccountId: "bank-1",
  };

  it("instructionFingerprint is deterministic", () => {
    const a = instructionFingerprint(base);
    const b = instructionFingerprint({ ...base });
    expect(a).toBe(b);
    expect(a).toMatch(/^ifp-v1-[0-9a-f]{64}$/);
  });

  it("field-order independence", () => {
    const scrambled = Object.fromEntries(
      Object.entries(base).reverse(),
    ) as unknown as PaymentInstructionMaterialFields;
    expect(instructionFingerprint(scrambled)).toBe(instructionFingerprint(base));
  });

  it("amount change flips fingerprint", () => {
    const a = instructionFingerprint(base);
    const b = instructionFingerprint({ ...base, amount: "3037.34" });
    expect(a).not.toBe(b);
  });

  it("destination change flips fingerprint", () => {
    const a = instructionFingerprint(base);
    const b = instructionFingerprint({ ...base, destinationSnapshotId: "snap-2" });
    expect(a).not.toBe(b);
  });

  it("passing a numeric amount is rejected (Decimal-safety)", () => {
    expect(() => instructionFingerprint({ ...base, amount: 3037.33 as unknown as string }))
      .toThrow(/numeric type not permitted/);
  });

  it("paymentFingerprint is order-invariant across instructionFingerprints", () => {
    const runFields = {
      clubId: "club-1", runNumber: "PR-2026-000001",
      sourceType: "PAYROLL" as const, sourceId: "payroll-batch-1",
      fundingBankAccountId: "bank-1", currency: "CAD",
      requestedExecutionDate: "2026-09-30T00:00:00.000Z",
      totalAmount: "6000.00",
    };
    const fpA = paymentFingerprint({ ...runFields, instructionFingerprints: ["a","b","c"] });
    const fpB = paymentFingerprint({ ...runFields, instructionFingerprints: ["c","a","b"] });
    expect(fpA).toBe(fpB);
    expect(fpA).toMatch(/^pfp-v1-[0-9a-f]{64}$/);
  });
});

describe("PAY-1A/1 · State machine", () => {
  it("legal PREPARED → PENDING_AUTHORIZATION", () => {
    expect(canTransitionRunState("PREPARED", "PENDING_AUTHORIZATION")).toBe(true);
  });
  it("illegal PREPARED → SETTLED", () => {
    expect(canTransitionRunState("PREPARED", "SETTLED")).toBe(false);
  });
  it("SETTLED can go to RETURNED (returns after settlement)", () => {
    expect(canTransitionRunState("SETTLED", "RETURNED")).toBe(true);
  });
  it("SETTLED cannot go back to AUTHORIZED", () => {
    expect(canTransitionRunState("SETTLED", "AUTHORIZED")).toBe(false);
  });
  it("REJECTED / CANCELLED / RETURNED are terminal", () => {
    for (const t of ["REJECTED","CANCELLED","RETURNED"] as const) {
      expect(canTransitionRunState(t, "SETTLED")).toBe(false);
      expect(canTransitionRunState(t, "AUTHORIZED")).toBe(false);
      expect(canTransitionRunState(t, "PREPARED")).toBe(false);
    }
  });
});

describe("PAY-1A/1 · Reconciliation + immutability guards", () => {
  it("assertReconciles accepts equal Decimals", () => {
    expect(() => assertReconciles("100.00", "100.00")).not.toThrow();
    expect(() => assertReconciles(new Prisma.Decimal("100.00"), new Prisma.Decimal("100.00"))).not.toThrow();
  });
  it("assertReconciles rejects a one-cent delta", () => {
    expect(() => assertReconciles("100.00", "99.99")).toThrow(/reconciliation failed/);
  });
  it("assertMaterialFieldsUnchanged rejects amount change", () => {
    const before: PaymentInstructionMaterialFields = {
      clubId: "c", runId: "r", sourceType: "PAYROLL", sourceId: "s",
      recipientType: "EMPLOYEE", recipientId: "e", amount: "10.00", currency: "CAD",
      destinationSnapshotId: "d", requestedExecutionDate: "2026-09-30T00:00:00.000Z",
      fundingBankAccountId: "b",
    };
    expect(() => assertMaterialFieldsUnchanged(before, { ...before, amount: "10.01" })).toThrow(/amount/);
  });
  it("assertMaterialFieldsUnchanged rejects destination change", () => {
    const before: PaymentInstructionMaterialFields = {
      clubId: "c", runId: "r", sourceType: "PAYROLL", sourceId: "s",
      recipientType: "EMPLOYEE", recipientId: "e", amount: "10.00", currency: "CAD",
      destinationSnapshotId: "d", requestedExecutionDate: "2026-09-30T00:00:00.000Z",
      fundingBankAccountId: "b",
    };
    expect(() => assertMaterialFieldsUnchanged(before, { ...before, destinationSnapshotId: "d2" }))
      .toThrow(/destinationSnapshotId/);
  });
});
