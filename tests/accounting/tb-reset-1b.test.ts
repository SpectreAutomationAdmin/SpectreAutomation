// TB-RESET-1b — Manifest integrity unit tests.
//
// No DB, no I/O. These verify the immutable manifest constants match
// the 1a evidence and that the reversal set + preserved set are
// mutually exclusive and cover exactly the 29 POSTED JEs the founder
// authorized in the 1b brief.

import { describe, expect, it } from "vitest";
import {
  TB_RESET_1B_ACCEPTANCE_SPEC,
  TB_RESET_1B_ALL_29_JES_AT_ANCHOR,
  TB_RESET_1B_CONFIRM_TOKEN,
  TB_RESET_1B_COULEE_CLUB_ID,
  TB_RESET_1B_PAY1A_ACCOUNT_ID,
  TB_RESET_1B_PAY1A_BANK_ACCOUNT_ID,
  TB_RESET_1B_PAY1A_NEW_ACCOUNT_NAME,
  TB_RESET_1B_PAY1A_NEW_ACCOUNT_NUMBER,
  TB_RESET_1B_PRESERVED_PAIRED_JES,
  TB_RESET_1B_REVERSAL_TARGETS,
  TB_RESET_1B_ROLLBACK_ANCHOR_FLY_RELEASE,
  TB_RESET_1B_ROLLBACK_ANCHOR_SHA,
} from "@/lib/accounting/tb-reset-1b";

describe("TB-RESET-1b manifest integrity", () => {
  it("targets Coulee Ridge staging club only", () => {
    expect(TB_RESET_1B_COULEE_CLUB_ID).toBe("cmrvdeny7000144372ktmmg9c");
  });

  it("carries the rollback anchor", () => {
    expect(TB_RESET_1B_ROLLBACK_ANCHOR_SHA).toBe("9ea0ad4c15bd42c41158cc1e36d5102b37e62aad");
    expect(TB_RESET_1B_ROLLBACK_ANCHOR_FLY_RELEASE).toBe(595);
    expect(TB_RESET_1B_CONFIRM_TOKEN).toBe("COULEE-9EA0AD4");
  });

  it("reverses exactly 13 JournalEntries (per founder authorization)", () => {
    expect(TB_RESET_1B_REVERSAL_TARGETS.length).toBe(13);
  });

  it("preserves exactly 16 already-netted JournalEntries", () => {
    expect(TB_RESET_1B_PRESERVED_PAIRED_JES.length).toBe(16);
  });

  it("total coverage is exactly 29 JEs (matches 1a evidence)", () => {
    expect(TB_RESET_1B_ALL_29_JES_AT_ANCHOR.length).toBe(29);
  });

  it("reversal-target JE ids are unique", () => {
    const ids = TB_RESET_1B_REVERSAL_TARGETS.map((t) => t.jeId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("preserved paired JE ids are unique", () => {
    const ids = TB_RESET_1B_PRESERVED_PAIRED_JES.map((p) => p.jeId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reversal set and preserved set are disjoint (no double-classification)", () => {
    const targets = new Set(TB_RESET_1B_REVERSAL_TARGETS.map((t) => t.jeId));
    const preserved = new Set(TB_RESET_1B_PRESERVED_PAIRED_JES.map((p) => p.jeId));
    for (const t of targets) expect(preserved.has(t)).toBe(false);
    for (const p of preserved) expect(targets.has(p)).toBe(false);
  });

  it("reversal-target entryNumbers are the 13 the founder authorized in 1b", () => {
    const nums = new Set(TB_RESET_1B_REVERSAL_TARGETS.map((t) => t.entryNumber));
    const expected = new Set([
      "JE-2026-000001", // Microsoft AP
      "JE-2026-000002", // PAY1A-ACC known fixture
      "JE-2026-000003", // CRGCC-SM unpaired original
      "JE-2026-000008", // CRGCC-SM corrected re-post
      "JE-2026-000013",
      "JE-2026-000016",
      "JE-2026-000019",
      "JE-2026-000022",
      "JE-2026-000023", // PAY-1A unpaired settlements
      "JE-2026-000024",
      "JE-2026-000027",
      "JE-2026-000028",
      "JE-2026-000029",
    ]);
    expect(nums).toEqual(expected);
  });

  it("preserved set covers exactly the 16 already-netted JEs", () => {
    const nums = new Set(TB_RESET_1B_PRESERVED_PAIRED_JES.map((p) => p.entryNumber));
    const expected = new Set([
      // 7 CRGCC-SM payroll original+reversal pairs (14 JEs)
      "JE-2026-000004", "JE-2026-000005",
      "JE-2026-000006", "JE-2026-000007",
      "JE-2026-000009", "JE-2026-000010",
      "JE-2026-000011", "JE-2026-000012",
      "JE-2026-000014", "JE-2026-000015",
      "JE-2026-000017", "JE-2026-000018",
      "JE-2026-000020", "JE-2026-000021",
      // 1 PAY-1A settle+return pair (2 JEs)
      "JE-2026-000025", "JE-2026-000026",
    ]);
    expect(nums).toEqual(expected);
  });

  it("reversal-target totalDebits sum matches 1a evidence residual + preserved contribution", () => {
    // Sum of reversal-target totalDebits = $56,837.54
    //   Microsoft AP:                $31.29
    //   PAY1A-ACC PayrollBatch:       $2,156.63
    //   6 unpaired CRGCC-SM:         $49,598.39
    //   5 unpaired PAY-1A settle:     $5,051.23
    //   Total:                       $56,837.54
    const sum = TB_RESET_1B_REVERSAL_TARGETS.reduce(
      (acc, t) => acc + Number(t.totalDebits),
      0,
    );
    expect(sum).toBeCloseTo(56837.54, 2);
  });

  it("every preserved pair references its counterpart", () => {
    const byNum = new Map(TB_RESET_1B_PRESERVED_PAIRED_JES.map((p) => [p.entryNumber, p]));
    for (const p of TB_RESET_1B_PRESERVED_PAIRED_JES) {
      const other = byNum.get(p.pairedWith);
      expect(other, `pair ${p.entryNumber}->${p.pairedWith}`).toBeDefined();
      expect(other?.pairedWith).toBe(p.entryNumber);
      expect(other?.pairKind).toBe(p.pairKind);
    }
  });

  it("PAY1A account identifiers hard-coded from 1a evidence", () => {
    expect(TB_RESET_1B_PAY1A_ACCOUNT_ID).toBe("cmuizrvru0004gmti1pc1j002");
    expect(TB_RESET_1B_PAY1A_BANK_ACCOUNT_ID).toBe("cmuizrvw90006gmti4ounz5ix");
    expect(TB_RESET_1B_PAY1A_NEW_ACCOUNT_NUMBER).toBe("LEGACY-PAY1A");
    expect(TB_RESET_1B_PAY1A_NEW_ACCOUNT_NAME).toBe("LEGACY-PAY1A · Simulated Operating Cash");
  });

  it("acceptance spec matches founder Gate 1 + Gate 2 requirements", () => {
    expect(TB_RESET_1B_ACCEPTANCE_SPEC.derivedTb).toEqual({
      debit: "0.00", credit: "0.00", difference: "0.00",
    });
    expect(TB_RESET_1B_ACCEPTANCE_SPEC.activeLegitimateAccountCount).toBe(237);
    expect(TB_RESET_1B_ACCEPTANCE_SPEC.reversalContrasCreated).toBe(13);
    expect(TB_RESET_1B_ACCEPTANCE_SPEC.originalPOSTEDCount).toBe(29);
    expect(TB_RESET_1B_ACCEPTANCE_SPEC.totalPOSTEDCountAfter).toBe(42);
    expect(TB_RESET_1B_ACCEPTANCE_SPEC.pay1a.accountNumber).toBe("LEGACY-PAY1A");
    expect(TB_RESET_1B_ACCEPTANCE_SPEC.pay1a.isActive).toBe(false);
    expect(TB_RESET_1B_ACCEPTANCE_SPEC.pay1a.bankAccountStatus).toBe("INACTIVE");
  });

  it("cannot mutate reversal targets at runtime (Object.freeze holds)", () => {
    expect(Object.isFrozen(TB_RESET_1B_REVERSAL_TARGETS)).toBe(true);
    expect(Object.isFrozen(TB_RESET_1B_PRESERVED_PAIRED_JES)).toBe(true);
  });
});
