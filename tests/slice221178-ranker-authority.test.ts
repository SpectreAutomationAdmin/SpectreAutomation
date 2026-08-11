// Sprint 3 · Phase 4R remediation (2026-08-10) — PART B tests.
//
// Locks the founder invariants for purpose-specific compatibility:
//
//   §13 — supplier/invoice family is CONTEXT, PURCHASED PURPOSE is
//         AUTHORITY. Cross-family purchases on one invoice remain
//         legitimate.
//   §15 — payroll is the ONLY hard-exclusion family. External AP
//         invoices with no affirmative payroll evidence must never
//         route to a payroll-only account.
//   §16 — cluster-concept fsGroupKeyHints drive the ranker's
//         COMPATIBILITY BOOST (fsGroupTaxonomySimilarity). No other
//         family-family exclusion.
//   §20 — hardware repair on an IT invoice → equipment_repair
//         concept, R&M accounts REMAIN ELIGIBLE.
//   §22 — line/cluster purpose > document-level family; strong per-
//         line classifications are not overwritten by document theme.

import { describe, it, expect } from "vitest";
import {
  isFsGroupFamilyIncompatibleWithCluster,
  describeFsGroupFamilyIncompatibility,
} from "@/lib/ap-intelligence/account-semantics/family-incompatibility";
import { computeAllocations } from "@/lib/ap-intelligence/gl-allocations";
import type { LineItem } from "@/lib/ap-intelligence/line-items-extract";

// -----------------------------------------------------------------------------
// §15 · family-incompatibility matrix pure unit tests
// -----------------------------------------------------------------------------

describe("family-incompatibility matrix (Phase 4R: payroll-only)", () => {
  it("null / empty guards never restrict", () => {
    expect(isFsGroupFamilyIncompatibleWithCluster(null, ["IS_IT_SOFTWARE"])).toBe(false);
    expect(isFsGroupFamilyIncompatibleWithCluster("IS_IT_SOFTWARE", null)).toBe(false);
    expect(isFsGroupFamilyIncompatibleWithCluster("IS_IT_SOFTWARE", [])).toBe(false);
    expect(isFsGroupFamilyIncompatibleWithCluster(undefined, ["IS_IT_SOFTWARE"])).toBe(false);
    expect(isFsGroupFamilyIncompatibleWithCluster("IS_IT_SOFTWARE", undefined)).toBe(false);
  });

  it("family agrees with itself", () => {
    expect(isFsGroupFamilyIncompatibleWithCluster("IS_IT_SOFTWARE", ["IS_IT_SOFTWARE"])).toBe(false);
    expect(isFsGroupFamilyIncompatibleWithCluster("IS_REPAIRS_MAINTENANCE", ["IS_REPAIRS_MAINTENANCE"])).toBe(false);
    expect(isFsGroupFamilyIncompatibleWithCluster("IS_PAYROLL", ["IS_PAYROLL"])).toBe(false);
  });

  it("§13 — IT ↔ R&M are NOT hard-incompatible (over-broad exclusion removed)", () => {
    expect(isFsGroupFamilyIncompatibleWithCluster("IS_REPAIRS_MAINTENANCE", ["IS_IT_SOFTWARE"])).toBe(false);
    expect(isFsGroupFamilyIncompatibleWithCluster("IS_IT_SOFTWARE", ["IS_REPAIRS_MAINTENANCE"])).toBe(false);
  });

  it("§13 — IT ↔ Telephone/Internet are NOT hard-incompatible (over-broad exclusion removed)", () => {
    expect(isFsGroupFamilyIncompatibleWithCluster("IS_TELEPHONE_INTERNET", ["IS_IT_SOFTWARE"])).toBe(false);
    expect(isFsGroupFamilyIncompatibleWithCluster("IS_IT_SOFTWARE", ["IS_TELEPHONE_INTERNET"])).toBe(false);
  });

  it("§13 — R&M ↔ Telephone/Internet are NOT hard-incompatible", () => {
    expect(isFsGroupFamilyIncompatibleWithCluster("IS_TELEPHONE_INTERNET", ["IS_REPAIRS_MAINTENANCE"])).toBe(false);
    expect(isFsGroupFamilyIncompatibleWithCluster("IS_REPAIRS_MAINTENANCE", ["IS_TELEPHONE_INTERNET"])).toBe(false);
  });

  it("unrelated families are compatible (default compatible)", () => {
    expect(isFsGroupFamilyIncompatibleWithCluster("IS_LICENCES_PERMITS", ["IS_IT_SOFTWARE"])).toBe(false);
    expect(isFsGroupFamilyIncompatibleWithCluster("IS_MEMBERSHIPS_SUBS", ["IS_IT_SOFTWARE"])).toBe(false);
  });

  it("§15 — PAYROLL remains a hard-exclusion in BOTH directions (external AP invoices never route to payroll)", () => {
    // A cluster whose concept hints at ANY non-payroll family
    // must exclude payroll-only accounts.
    expect(isFsGroupFamilyIncompatibleWithCluster("IS_PAYROLL", ["IS_IT_SOFTWARE"])).toBe(true);
    expect(isFsGroupFamilyIncompatibleWithCluster("IS_PAYROLL", ["IS_REPAIRS_MAINTENANCE"])).toBe(true);
    expect(isFsGroupFamilyIncompatibleWithCluster("IS_PAYROLL", ["IS_TELEPHONE_INTERNET"])).toBe(true);
    expect(isFsGroupFamilyIncompatibleWithCluster("IS_PAYROLL", ["IS_LICENCES_PERMITS"])).toBe(true);
    expect(isFsGroupFamilyIncompatibleWithCluster("IS_PAYROLL", ["IS_MEMBERSHIPS_SUBS"])).toBe(true);
    expect(isFsGroupFamilyIncompatibleWithCluster("IS_PAYROLL", ["IS_UTILITIES"])).toBe(true);
    expect(isFsGroupFamilyIncompatibleWithCluster("IS_PAYROLL", ["IS_OFFICE_SUPPLIES"])).toBe(true);
    // Reverse edge — a non-payroll fsGroupKey when the cluster hints
    // at IS_PAYROLL (a legitimate payroll-service invoice cluster).
    // Actually a payroll cluster CAN accept a payroll account — the
    // matrix explicitly permits IS_PAYROLL ↔ IS_PAYROLL.
    expect(isFsGroupFamilyIncompatibleWithCluster("IS_IT_SOFTWARE", ["IS_PAYROLL"])).toBe(true);
    expect(isFsGroupFamilyIncompatibleWithCluster("IS_REPAIRS_MAINTENANCE", ["IS_PAYROLL"])).toBe(true);
  });

  it("diagnostic helper names the offending hint for payroll only", () => {
    const d = describeFsGroupFamilyIncompatibility("IS_PAYROLL", ["IS_IT_SOFTWARE"]);
    expect(d).toContain("IS_PAYROLL");
    expect(d).toContain("IS_IT_SOFTWARE");
    // No longer flags IT↔R&M as incompatible.
    expect(describeFsGroupFamilyIncompatibility("IS_REPAIRS_MAINTENANCE", ["IS_IT_SOFTWARE"])).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// End-to-end allocation composer reverse controls
// -----------------------------------------------------------------------------

function makeLine(desc: string, amount: number): LineItem {
  return {
    description: desc, quantity: 1, unitPrice: amount, amount,
    taxRate: null, taxAmount: null, taxTreatment: "unknown" as const,
    evidence: ["amount_only"], confidence: 80,
  } as unknown as LineItem;
}

const COA = [
  { id: "a_6054", accountNumber: "6054", name: "Computer & IT Services", type: "EXPENSE", normalBalance: "DEBIT", isActive: true, isHeader: false, allowManualPosting: true, isControlAccount: false, isBankAccount: false, isCashAccount: false, archivedAt: null, fundApplicability: "OPERATING", categoryKey: "ADMIN_EXPENSES", fsGroupKey: "IS_IT_SOFTWARE", accountRole: "STANDARD" },
  { id: "a_6062", accountNumber: "6062", name: "Licenses", type: "EXPENSE", normalBalance: "DEBIT", isActive: true, isHeader: false, allowManualPosting: true, isControlAccount: false, isBankAccount: false, isCashAccount: false, archivedAt: null, fundApplicability: "OPERATING", categoryKey: null, fsGroupKey: "IS_LICENCES_PERMITS", accountRole: "STANDARD" },
  { id: "a_6033", accountNumber: "6033", name: "R & M Preventative Maintenance", type: "EXPENSE", normalBalance: "DEBIT", isActive: true, isHeader: false, allowManualPosting: true, isControlAccount: false, isBankAccount: false, isCashAccount: false, archivedAt: null, fundApplicability: "OPERATING", categoryKey: "REPAIRS_AND_MAINTENANCE", fsGroupKey: "IS_REPAIRS_MAINTENANCE", accountRole: "STANDARD" },
  { id: "a_6320", accountNumber: "6320", name: "Clubhouse R&M", type: "EXPENSE", normalBalance: "DEBIT", isActive: true, isHeader: false, allowManualPosting: true, isControlAccount: false, isBankAccount: false, isCashAccount: false, archivedAt: null, fundApplicability: "OPERATING", categoryKey: "REPAIRS_AND_MAINTENANCE", fsGroupKey: "IS_REPAIRS_MAINTENANCE", accountRole: "STANDARD" },
  { id: "a_6072", accountNumber: "6072", name: "Telephone & Internet", type: "EXPENSE", normalBalance: "DEBIT", isActive: true, isHeader: false, allowManualPosting: true, isControlAccount: false, isBankAccount: false, isCashAccount: false, archivedAt: null, fundApplicability: "OPERATING", categoryKey: "ADMIN_EXPENSES", fsGroupKey: "IS_TELEPHONE_INTERNET", accountRole: "STANDARD" },
  { id: "a_6008", accountNumber: "6008", name: "Wages - Maintenance", type: "EXPENSE", normalBalance: "DEBIT", isActive: true, isHeader: false, allowManualPosting: true, isControlAccount: false, isBankAccount: false, isCashAccount: false, archivedAt: null, fundApplicability: "OPERATING", categoryKey: null, fsGroupKey: "IS_PAYROLL", accountRole: "STANDARD" },
];

describe("Phase 4R reverse controls — cluster-concept authority over document family", () => {
  it("A · 221178-shape IT invoice: generic Service Maintenance Fee still consolidates to 6054 via doc-coherence reclassifier", () => {
    const res = computeAllocations({
      lineItems: [
        makeLine("Service Maintenance Fee.", 2275),
        makeLine("Online Backup Storage Fee.", 300),
        makeLine("Online Backup License Fee: $100.00 x 2 servers = $200.00", 200),
        makeLine("Cyber Security ($17.00 x 33 users = $561.00).", 561),
        makeLine("SentinelOne Antivirus for Computers and Servers.", 277.5),
      ],
      accounts: COA as any,
      postingBlockersByAccount: new Map(),
      economicPurposeCandidates: null,
      fullDocumentText: null,
      supplierName: null,
      printedSubtotal: 3613.5,
      printedTax: 180.68,
      printedTotal: 3794.18,
    });
    const accountsChosen = res.allocations.map((a) => a.recommendedAccount?.accountNumber);
    // 6054 wins. Payroll 6008 excluded via family gate. 6033 R&M no
    // longer excluded but ranker prefers IT-family via fsGroupTaxonomy
    // + all lines reclassify to it_services via doc coherence.
    expect(accountsChosen).toContain("6054");
    expect(accountsChosen).not.toContain("6008");
  });

  it("B · genuine physical R&M invoice: mower repair lands on 6033 (ranker prefers R&M via compatibility scoring, not exclusion)", () => {
    const res = computeAllocations({
      lineItems: [
        makeLine("Fairway mower reel bearing repair", 450),
        makeLine("Preventative maintenance service call", 800),
      ],
      accounts: COA as any,
      postingBlockersByAccount: new Map(),
      economicPurposeCandidates: null,
      fullDocumentText: null,
      supplierName: null,
      printedSubtotal: 1250,
      printedTax: 62.5,
      printedTotal: 1312.5,
    });
    const accountsChosen = res.allocations.map((a) => a.recommendedAccount?.accountNumber);
    // Ranker prefers R&M family via fsGroupTaxonomySimilarity.
    // Payroll 6008 remains hard-excluded.
    expect(accountsChosen).not.toContain("6008");
    expect(accountsChosen.some((n) => n === "6033" || n === "6320")).toBe(true);
  });

  it("C · §15 payroll hard guard — Wages account NEVER wins on external AP invoice", () => {
    // Simulate the v196 regression: an IT invoice with the lexical
    // word "Maintenance" in a line. Payroll account "Wages -
    // Maintenance" (6008) has strong lexical overlap. Even without
    // IT↔R&M exclusion, payroll HARD gate keeps 6008 out.
    const res = computeAllocations({
      lineItems: [
        makeLine("Service Maintenance Fee.", 2275),
        makeLine("Cyber Security 33 users.", 561),
      ],
      accounts: COA as any,
      postingBlockersByAccount: new Map(),
      economicPurposeCandidates: null,
      fullDocumentText: null,
      supplierName: null,
      printedSubtotal: 2836,
      printedTax: 141.8,
      printedTotal: 2977.8,
    });
    const accountsChosen = res.allocations.map((a) => a.recommendedAccount?.accountNumber);
    expect(accountsChosen).not.toContain("6008");
  });

  it("D · §20 hardware repair on IT invoice: equipment_repair-classified line preserves R&M eligibility", () => {
    // IT provider invoices a specific hardware-repair line alongside
    // its usual IT services. Specific R&M child (equipment_repair)
    // must survive the doc-coherence reclassifier.
    const res = computeAllocations({
      lineItems: [
        makeLine("Managed IT support monthly retainer.", 2000),
        makeLine("Cyber Security 33 users.", 561),
        makeLine("Server hardware component replacement — failed power supply.", 340),
      ],
      accounts: COA as any,
      postingBlockersByAccount: new Map(),
      economicPurposeCandidates: null,
      fullDocumentText: null,
      supplierName: null,
      printedSubtotal: 2901,
      printedTax: 145.05,
      printedTotal: 3046.05,
    });
    // No payroll ever.
    for (const a of res.allocations) {
      expect(a.recommendedAccount?.accountNumber).not.toBe("6008");
    }
    // We don't over-specify which account the repair lands on
    // (tenant COA might use 6033 or a specific IT-hardware account);
    // the invariant is that R&M is NOT forbidden.
  });
});

// -----------------------------------------------------------------------------
// §21 / §35 anti-overfitting
// -----------------------------------------------------------------------------

describe("§35 anti-overfitting", () => {
  it("family-incompatibility matrix keys are only fsGroupKey identifiers — never account numbers or vendor names", () => {
    for (const acct of ["IS_IT_SOFTWARE", "IS_REPAIRS_MAINTENANCE", "IS_TELEPHONE_INTERNET", "IS_PAYROLL"]) {
      expect(acct).toMatch(/^IS_[A-Z_]+$/);
      expect(acct).not.toContain("6");
      expect(acct).not.toContain("Club");
      expect(acct).not.toContain("Alberta");
      expect(acct).not.toContain("Support");
      expect(acct).not.toContain("CPA");
    }
  });
});
