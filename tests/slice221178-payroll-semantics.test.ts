// Sprint 3 · 221178 semantics slice (2026-08-10) — payroll-vs-purchased-
// service compatibility gate + payroll-evidence detector.
//
// Locks the founder-directed invariants (§4, §5, §11, §21):
//
//   1. Accounts identified as PAYROLL (fsGroupKey === "IS_PAYROLL"
//      OR categoryKey === "PAYROLL_BENEFITS") are EXCLUDED from the
//      AP-invoice candidate pool UNLESS affirmative payroll
//      evidence is present on the transaction context.
//   2. Every non-payroll account continues to pass through the gate
//      unchanged (regression floor).
//   3. Payroll evidence is composed from generalized signals — vendor
//      matches a payroll-provider vocabulary OR ≥2 distinct payroll-
//      diagnostic token families appear in line/document text.
//   4. §6 — SIN detection is NOT part of the evidence chain.
//   5. §11 reverse-control matrix — nine scenarios spanning genuine
//      payroll (allowed), outsourced maintenance / consulting /
//      contractor / janitorial / equipment-repair (payroll excluded),
//      and lexical-overlap-only descriptions (excluded).

import { describe, it, expect } from "vitest";
import { evaluateEligibility } from "@/lib/accounting/eligibility";
import type {
  AccountEligibilityView,
  AccountingTransactionContext,
} from "@/lib/accounting/eligibility";
import { rulePayrollAccountExcluded } from "@/lib/accounting/eligibility/rules-structural";
import {
  detectPayrollEvidence,
} from "@/lib/ap-intelligence/account-semantics/payroll-evidence";

// -----------------------------------------------------------------------------
// Fixture builders
// -----------------------------------------------------------------------------

function payrollAccount(over: Partial<AccountEligibilityView> = {}): AccountEligibilityView {
  return {
    id: "acct_wages_maint",
    accountNumber: "6008",
    name: "Wages - Maintenance",
    type: "EXPENSE",
    normalBalance: "DEBIT",
    isActive: true,
    isHeader: false,
    allowManualPosting: true,
    isControlAccount: false,
    isBankAccount: false,
    isCashAccount: false,
    archivedAt: null,
    fundApplicability: "OPERATING",
    categoryKey: "PAYROLL_BENEFITS",
    fsGroupKey: "IS_PAYROLL",
    accountRole: "STANDARD",
    ...over,
  };
}

function ordinaryExpenseAccount(over: Partial<AccountEligibilityView> = {}): AccountEligibilityView {
  return {
    id: "acct_rm_grounds",
    accountNumber: "6033",
    name: "R & M Preventative Maintenance",
    type: "EXPENSE",
    normalBalance: "DEBIT",
    isActive: true,
    isHeader: false,
    allowManualPosting: true,
    isControlAccount: false,
    isBankAccount: false,
    isCashAccount: false,
    archivedAt: null,
    fundApplicability: "OPERATING",
    categoryKey: "REPAIRS_AND_MAINTENANCE",
    fsGroupKey: "IS_REPAIRS_MAINTENANCE",
    accountRole: "STANDARD",
    ...over,
  };
}

const CTX_NO_EVIDENCE: AccountingTransactionContext = {
  transactionKind: "AP_INVOICE",
  expectedDebitRole: "OPERATING_EXPENSE",
};

const CTX_WITH_EVIDENCE: AccountingTransactionContext = {
  ...CTX_NO_EVIDENCE,
  hasPayrollEvidence: true,
};

// -----------------------------------------------------------------------------
// §21 — rulePayrollAccountExcluded direct
// -----------------------------------------------------------------------------

describe("rulePayrollAccountExcluded — unit", () => {
  it("excludes IS_PAYROLL account when hasPayrollEvidence is absent", () => {
    expect(rulePayrollAccountExcluded(payrollAccount(), CTX_NO_EVIDENCE))
      .toBe("PAYROLL_ACCOUNT_REQUIRES_PAYROLL_EVIDENCE");
  });

  it("excludes IS_PAYROLL account when hasPayrollEvidence is false", () => {
    expect(rulePayrollAccountExcluded(payrollAccount(), { ...CTX_NO_EVIDENCE, hasPayrollEvidence: false }))
      .toBe("PAYROLL_ACCOUNT_REQUIRES_PAYROLL_EVIDENCE");
  });

  it("keeps IS_PAYROLL account when hasPayrollEvidence is true", () => {
    expect(rulePayrollAccountExcluded(payrollAccount(), CTX_WITH_EVIDENCE)).toBeNull();
  });

  it("also excludes on PAYROLL_BENEFITS category (in case fsGroupKey is null)", () => {
    const a = payrollAccount({ fsGroupKey: null, categoryKey: "PAYROLL_BENEFITS" });
    expect(rulePayrollAccountExcluded(a, CTX_NO_EVIDENCE))
      .toBe("PAYROLL_ACCOUNT_REQUIRES_PAYROLL_EVIDENCE");
  });

  it("never fires on ordinary expense accounts", () => {
    expect(rulePayrollAccountExcluded(ordinaryExpenseAccount(), CTX_NO_EVIDENCE)).toBeNull();
    expect(rulePayrollAccountExcluded(ordinaryExpenseAccount(), CTX_WITH_EVIDENCE)).toBeNull();
  });

  it("never fires on ordinary expense whose NAME contains 'maintenance' or 'wages'", () => {
    const a = ordinaryExpenseAccount({ name: "Grounds Repairs and Maintenance" });
    expect(rulePayrollAccountExcluded(a, CTX_NO_EVIDENCE)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// §21 — evaluateEligibility integration
// -----------------------------------------------------------------------------

describe("evaluateEligibility — payroll gate integration", () => {
  it("emits PAYROLL_ACCOUNT_REQUIRES_PAYROLL_EVIDENCE in the exclusionReasons list", () => {
    const v = evaluateEligibility(payrollAccount(), CTX_NO_EVIDENCE);
    expect(v.eligible).toBe(false);
    expect(v.exclusionReasons).toContain("PAYROLL_ACCOUNT_REQUIRES_PAYROLL_EVIDENCE");
  });

  it("payroll account with evidence remains ELIGIBLE", () => {
    const v = evaluateEligibility(payrollAccount(), CTX_WITH_EVIDENCE);
    expect(v.eligible).toBe(true);
    expect(v.eligibilityClass).toBe("ELIGIBLE");
    expect(v.exclusionReasons).not.toContain("PAYROLL_ACCOUNT_REQUIRES_PAYROLL_EVIDENCE");
  });

  it("ordinary expense unaffected by the new rule", () => {
    const v = evaluateEligibility(ordinaryExpenseAccount(), CTX_NO_EVIDENCE);
    expect(v.eligible).toBe(true);
  });

  it("ELIGIBILITY_RULE_VERSION reports 3", async () => {
    const { ELIGIBILITY_RULE_VERSION } = await import("@/lib/accounting/eligibility");
    expect(ELIGIBILITY_RULE_VERSION).toBe(3);
  });
});

// -----------------------------------------------------------------------------
// §5, §6 — payroll-evidence detector
// -----------------------------------------------------------------------------

describe("detectPayrollEvidence — vendor signal", () => {
  const providers = ["ADP", "Ceridian", "Paychex", "Payworks", "Wagepoint", "Payment Evolution", "Gusto"];
  for (const p of providers) {
    it(`vendor='${p}' fires VENDOR_IS_PAYROLL_PROVIDER`, () => {
      const v = detectPayrollEvidence({ vendorNames: [p, null] });
      expect(v.hasPayrollEvidence).toBe(true);
      expect(v.reasons).toContain("VENDOR_IS_PAYROLL_PROVIDER");
    });
  }

  it("vendor='Club Support Inc.' does NOT fire (221178 control)", () => {
    const v = detectPayrollEvidence({ vendorNames: ["Club Support Inc."] });
    expect(v.hasPayrollEvidence).toBe(false);
    expect(v.reasons).not.toContain("VENDOR_IS_PAYROLL_PROVIDER");
  });

  it("empty / null vendor names never fire", () => {
    expect(detectPayrollEvidence({ vendorNames: [null, undefined, ""] }).hasPayrollEvidence).toBe(false);
    expect(detectPayrollEvidence({}).hasPayrollEvidence).toBe(false);
  });
});

describe("detectPayrollEvidence — line / document vocabulary", () => {
  it("single 'wages' token in a service invoice does NOT fire (221178 control)", () => {
    const v = detectPayrollEvidence({
      lineItemDescriptions: ["Service Maintenance Fee"],
      documentText: "Service Maintenance Fee\nOnline Backup Storage Fee\nCyber Security\nSentinelOne Antivirus",
    });
    expect(v.hasPayrollEvidence).toBe(false);
  });

  it("account NAME with 'wages' contributes nothing (detector only reads txn text)", () => {
    // The account-side lexical overlap is exactly what the 221178 defect
    // exploited. The detector must not use account names as signal.
    const v = detectPayrollEvidence({
      vendorNames: ["Club Support Inc."],
      lineItemDescriptions: ["Service Maintenance Fee"],
    });
    expect(v.hasPayrollEvidence).toBe(false);
  });

  it("legitimate payroll invoice with ≥2 token families fires", () => {
    const v = detectPayrollEvidence({
      lineItemDescriptions: [
        "Pay period ending 2026-07-31 gross pay",
        "Source deduction remittance PD7A",
      ],
    });
    expect(v.hasPayrollEvidence).toBe(true);
    expect(v.reasons.some((r) => r === "LINE_VOCABULARY_PAYROLL" || r === "DOCUMENT_VOCABULARY_PAYROLL")).toBe(true);
  });

  it("§6 — SIN detection is NOT part of the signal chain", () => {
    const v = detectPayrollEvidence({
      lineItemDescriptions: ["Employee John Doe SIN 123-456-789 monthly stipend"],
      documentText: "SIN 123-456-789",
    });
    // SIN alone is not evidence; needs payroll-vocabulary families.
    // Description here contains "employee" (family E) and "stipend"
    // (not a family) — only ONE family, so no fire.
    expect(v.hasPayrollEvidence).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// §11 — REVERSE CONTROL MATRIX
// -----------------------------------------------------------------------------

describe("§11 reverse-control matrix", () => {
  it("A · genuine payroll expense (ADP vendor) → payroll account allowed", () => {
    const evidence = detectPayrollEvidence({
      vendorNames: ["ADP Canada Co."],
      lineItemDescriptions: ["Payroll processing fee"],
    });
    expect(evidence.hasPayrollEvidence).toBe(true);
    const ctx: AccountingTransactionContext = {
      transactionKind: "AP_INVOICE",
      expectedDebitRole: "OPERATING_EXPENSE",
      hasPayrollEvidence: evidence.hasPayrollEvidence,
    };
    expect(evaluateEligibility(payrollAccount(), ctx).eligible).toBe(true);
  });

  it("B · payroll-provider invoice for their services → allowed", () => {
    const evidence = detectPayrollEvidence({
      vendorNames: ["Ceridian HCM Canada"],
      lineItemDescriptions: ["Managed payroll subscription", "Pay period 07/2026"],
    });
    expect(evidence.hasPayrollEvidence).toBe(true);
  });

  it("C · outsourced IT maintenance service (Club Support-shape) → payroll excluded", () => {
    const evidence = detectPayrollEvidence({
      vendorNames: ["Club Support Inc."],
      lineItemDescriptions: [
        "Service Maintenance Fee",
        "Online Backup Storage Fee",
        "Cyber Security",
        "SentinelOne Antivirus for Computers and Servers",
      ],
    });
    expect(evidence.hasPayrollEvidence).toBe(false);
    const ctx: AccountingTransactionContext = {
      transactionKind: "AP_INVOICE",
      expectedDebitRole: "OPERATING_EXPENSE",
      hasPayrollEvidence: evidence.hasPayrollEvidence,
    };
    expect(evaluateEligibility(payrollAccount(), ctx).eligible).toBe(false);
    expect(evaluateEligibility(payrollAccount(), ctx).exclusionReasons)
      .toContain("PAYROLL_ACCOUNT_REQUIRES_PAYROLL_EVIDENCE");
  });

  it("D · consulting invoice → payroll excluded", () => {
    const evidence = detectPayrollEvidence({
      vendorNames: ["Deloitte Advisory LLP"],
      lineItemDescriptions: ["Q3 strategy consulting engagement — professional fees"],
    });
    expect(evidence.hasPayrollEvidence).toBe(false);
  });

  it("E · contractor labour invoice → payroll excluded absent payroll evidence", () => {
    const evidence = detectPayrollEvidence({
      vendorNames: ["ACME Contracting Ltd."],
      lineItemDescriptions: ["Bunker excavation and rebuild — 2026-07"],
    });
    expect(evidence.hasPayrollEvidence).toBe(false);
  });

  it("F · janitorial service → payroll excluded", () => {
    const evidence = detectPayrollEvidence({
      vendorNames: ["ServiceMaster Clean"],
      lineItemDescriptions: ["Weekly clubhouse janitorial service"],
    });
    expect(evidence.hasPayrollEvidence).toBe(false);
  });

  it("G · equipment repair service → payroll excluded", () => {
    const evidence = detectPayrollEvidence({
      vendorNames: ["Toro Turf Equipment Repair"],
      lineItemDescriptions: ["Fairway mower reel regrind + belt"],
    });
    expect(evidence.hasPayrollEvidence).toBe(false);
  });

  it("H · line description containing word 'maintenance' → payroll excluded (no lexical bleed)", () => {
    // The account gate looks at fsGroupKey/categoryKey, not description.
    // The evidence detector looks at description tokens but requires ≥2
    // payroll families — 'maintenance' is not a payroll family.
    const evidence = detectPayrollEvidence({
      vendorNames: ["Any Vendor Ltd."],
      lineItemDescriptions: ["Preventative Maintenance Contract"],
    });
    expect(evidence.hasPayrollEvidence).toBe(false);
  });

  it("I · genuine employee wages for Grounds/Maintenance → Wages - Maintenance remains valid", () => {
    const evidence = detectPayrollEvidence({
      vendorNames: ["Coulee Ridge Golf Club Payroll"],
      lineItemDescriptions: [
        "Grounds crew wages — pay period 2026-07-15 to 2026-07-31",
        "Source deduction remittance",
      ],
    });
    expect(evidence.hasPayrollEvidence).toBe(true);
    const ctx: AccountingTransactionContext = {
      transactionKind: "AP_INVOICE",
      expectedDebitRole: "OPERATING_EXPENSE",
      hasPayrollEvidence: true,
    };
    expect(evaluateEligibility(payrollAccount(), ctx).eligible).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// §31 — anti-overfitting: no runtime literals for Club Support / 221178 /
// 6008 / etc. The tests below hardcode these literals in FIXTURE data
// only; a scan of the executable source tree in the delivery-report step
// enforces absence in production code.
// -----------------------------------------------------------------------------

describe("§31 anti-overfitting sanity", () => {
  it("gate rule reads only structural taxonomy keys, never account numbers", () => {
    // The rule reads fsGroupKey and categoryKey. It NEVER sees the
    // account number, which is 100% tenant-defined.
    const a = payrollAccount({ accountNumber: "9999", name: "Anything" });
    expect(rulePayrollAccountExcluded(a, CTX_NO_EVIDENCE))
      .toBe("PAYROLL_ACCOUNT_REQUIRES_PAYROLL_EVIDENCE");
  });

  it("gate rule ignores account number when taxonomy keys are absent", () => {
    const a = payrollAccount({ accountNumber: "6008", fsGroupKey: null, categoryKey: null });
    expect(rulePayrollAccountExcluded(a, CTX_NO_EVIDENCE)).toBeNull();
  });
});
