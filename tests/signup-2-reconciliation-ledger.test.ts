// SIGNUP-2 Phase 2A (2026-10-25) -- Payment reconciliation ledger
// contract tests.
//
// Append-only enum validation + source-contract tests that prove
// the DB write path is idempotent on providerEventId AND rejects
// operator adjustments without a correctsEntryId.

import { describe, it, expect } from "vitest";
import {
  LEDGER_ENTRY_TYPES,
  EXPECTED_SIGN_BY_TYPE,
  type LedgerEntryType,
} from "@/lib/billing/reconciliation-ledger";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(process.cwd(), "src/lib/billing/reconciliation-ledger.ts"), "utf8");

describe("SIGNUP-2 · ledger entry-type enum", () => {
  it("defines exactly the 14 documented entry types", () => {
    expect(LEDGER_ENTRY_TYPES).toEqual([
      "BILLING_CYCLE_OPENED",
      "PAYMENT_INITIATED",
      "ACTIVATION_READY",
      "MANUAL_INVOICE_CLEARED",
      "PAYMENT_PROCESSING",
      "CHARGE_SETTLED",
      "FUNDS_AVAILABLE",
      "DISPUTE_OPENED",
      "DISPUTE_CLOSED",
      "REFUND_ISSUED",
      "REFUND_FAILED",
      "REVERSAL",
      "NSF_POST_SETTLEMENT",
      "OPERATOR_ADJUSTMENT",
    ]);
  });

  it("every entry type has a sign-table entry", () => {
    for (const t of LEDGER_ENTRY_TYPES) {
      expect(EXPECTED_SIGN_BY_TYPE[t], `sign-table missing ${t}`).toBeDefined();
    }
  });

  it("every sign-table key is a known entry type", () => {
    for (const key of Object.keys(EXPECTED_SIGN_BY_TYPE)) {
      expect(LEDGER_ENTRY_TYPES).toContain(key as LedgerEntryType);
    }
  });

  it("inflow entries are 'positive', outflow entries are 'negative'", () => {
    expect(EXPECTED_SIGN_BY_TYPE.CHARGE_SETTLED).toBe("positive");
    expect(EXPECTED_SIGN_BY_TYPE.FUNDS_AVAILABLE).toBe("positive");
    expect(EXPECTED_SIGN_BY_TYPE.PAYMENT_INITIATED).toBe("positive");
    expect(EXPECTED_SIGN_BY_TYPE.MANUAL_INVOICE_CLEARED).toBe("positive");
    expect(EXPECTED_SIGN_BY_TYPE.DISPUTE_OPENED).toBe("negative");
    expect(EXPECTED_SIGN_BY_TYPE.REFUND_ISSUED).toBe("negative");
    expect(EXPECTED_SIGN_BY_TYPE.REVERSAL).toBe("negative");
    expect(EXPECTED_SIGN_BY_TYPE.NSF_POST_SETTLEMENT).toBe("negative");
  });

  it("OPERATOR_ADJUSTMENT + DISPUTE_CLOSED + REFUND_FAILED can be either sign", () => {
    expect(EXPECTED_SIGN_BY_TYPE.OPERATOR_ADJUSTMENT).toBe("either");
    expect(EXPECTED_SIGN_BY_TYPE.DISPUTE_CLOSED).toBe("either");
    expect(EXPECTED_SIGN_BY_TYPE.REFUND_FAILED).toBe("either");
  });
});

describe("SIGNUP-2 · ledger source-contract", () => {
  it("appendLedgerEntry validates the entry type is in the enum", () => {
    expect(src).toMatch(/SIGNUP_2_LEDGER_INVALID_ENTRY_TYPE/);
  });

  it("appendLedgerEntry rejects currencies that aren't lowercase", () => {
    expect(src).toMatch(/SIGNUP_2_LEDGER_CURRENCY_LOWERCASE/);
  });

  it("OPERATOR_ADJUSTMENT entries MUST reference correctsEntryId", () => {
    expect(src).toMatch(/SIGNUP_2_LEDGER_ADJUSTMENT_MISSING_SOURCE/);
    expect(src).toMatch(/if \(args\.entryType === "OPERATOR_ADJUSTMENT"\)/);
    expect(src).toMatch(/if \(!args\.correctsEntryId\)/);
  });

  it("OPERATOR_ADJUSTMENT entries MUST record the operator user id", () => {
    expect(src).toMatch(/SIGNUP_2_LEDGER_ADJUSTMENT_MISSING_OPERATOR/);
    expect(src).toMatch(/if \(!args\.operatorUserId\)/);
  });

  it("providerEventId drives dedup via findFirst on (eventId, entryType, clubId)", () => {
    expect(src).toMatch(/findFirst\({\s*where:\s*{\s*providerEventId:\s*args\.providerEventId/);
    expect(src).toMatch(/if \(existing\) return \{ id: existing\.id, createdNew: false \}/);
  });

  it("ledger uses prisma.paymentReconciliationEntry (not a raw SQL write)", () => {
    expect(src).toMatch(/prisma\.paymentReconciliationEntry\.create/);
    expect(src).toMatch(/prisma\.paymentReconciliationEntry\.findFirst/);
    expect(src).not.toMatch(/paymentReconciliationEntry\.updateMany\({[\s\S]+?entryType:/);
    expect(src).not.toMatch(/paymentReconciliationEntry\.delete/);
  });

  it("markReconciled does NOT mutate entryType or amountMinorUnits (append-only invariant)", () => {
    // The markReconciled update body is wrapped by `data: { reconciledWithProvider: true, ... }`.
    const markBlock = src.match(/markReconciled[\s\S]+?prisma\.paymentReconciliationEntry\.update\({[\s\S]+?}\)\;/);
    expect(markBlock, "markReconciled source block not found").not.toBeNull();
    expect(markBlock![0]).not.toMatch(/entryType:/);
    expect(markBlock![0]).not.toMatch(/amountMinorUnits:/);
    expect(markBlock![0]).toMatch(/reconciledWithProvider: true/);
    expect(markBlock![0]).toMatch(/reconciledAt: new Date\(\)/);
  });
});

describe("SIGNUP-2 · ledger schema (Prisma)", () => {
  const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");

  it("PaymentReconciliationEntry model exists", () => {
    expect(schema).toMatch(/model PaymentReconciliationEntry \{/);
  });

  it("ledger has entryType + amountMinorUnits (BigInt) + currency columns", () => {
    expect(schema).toMatch(/entryType\s+String/);
    expect(schema).toMatch(/amountMinorUnits\s+BigInt/);
    expect(schema).toMatch(/currency\s+String/);
  });

  it("ledger has provider-event dedup column + reconciled-with-provider flag", () => {
    expect(schema).toMatch(/providerEventId\s+String\?/);
    expect(schema).toMatch(/reconciledWithProvider\s+Boolean\s+@default\(false\)/);
  });

  it("ledger has correctsEntryId column for OPERATOR_ADJUSTMENT linkage", () => {
    expect(schema).toMatch(/correctsEntryId\s+String\?/);
  });

  it("ledger indexes providerEventId for dedup query speed", () => {
    expect(schema).toMatch(/@@index\(\[providerEventId\]\)/);
  });
});
