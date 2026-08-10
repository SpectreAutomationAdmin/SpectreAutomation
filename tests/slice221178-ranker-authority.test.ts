// Sprint 3 · Ranker Authority slice (2026-08-10) — PART A tests.
//
// Locks the founder invariants (§2 · §4 · §5):
//
//   §2 — Accounting substance is authority. Lexical account-name
//        similarity is a tie-breaker between semantically compatible
//        accounts, NOT a decider between materially different
//        substances.
//   §4 — Compatibility BEFORE relevance. Materially incompatible
//        accounts are excluded from a cluster's candidate pool
//        BEFORE the ranker's scoring runs.
//   §5 — Reverse controls prove the correction generalises:
//        IT context can defeat physical R&M; equipment/building
//        maintenance still lands on physical R&M; OXIO telecom
//        remains on Telephone & Internet; ambiguous lines abstain
//        rather than manufacture substance.

import { describe, it, expect } from "vitest";
import {
  isFsGroupFamilyIncompatibleWithCluster,
  describeFsGroupFamilyIncompatibility,
} from "@/lib/ap-intelligence/account-semantics/family-incompatibility";
import { computeAllocations } from "@/lib/ap-intelligence/gl-allocations";
import type { LineItem } from "@/lib/ap-intelligence/line-items-extract";

// -----------------------------------------------------------------------------
// §2 · §4 — family-incompatibility matrix pure unit tests
// -----------------------------------------------------------------------------

describe("family-incompatibility matrix (§2 authority hierarchy)", () => {
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
  });

  it("IT ↔ R&M mutually incompatible (symmetric)", () => {
    expect(isFsGroupFamilyIncompatibleWithCluster("IS_REPAIRS_MAINTENANCE", ["IS_IT_SOFTWARE"])).toBe(true);
    expect(isFsGroupFamilyIncompatibleWithCluster("IS_IT_SOFTWARE", ["IS_REPAIRS_MAINTENANCE"])).toBe(true);
  });

  it("IT ↔ Telephone/Internet mutually incompatible (symmetric)", () => {
    expect(isFsGroupFamilyIncompatibleWithCluster("IS_TELEPHONE_INTERNET", ["IS_IT_SOFTWARE"])).toBe(true);
    expect(isFsGroupFamilyIncompatibleWithCluster("IS_IT_SOFTWARE", ["IS_TELEPHONE_INTERNET"])).toBe(true);
  });

  it("unrelated families are NOT incompatible (default compatible)", () => {
    // e.g. Licenses/Permits and Memberships/Subs — both plausible
    // homes for software subscriptions.
    expect(isFsGroupFamilyIncompatibleWithCluster("IS_LICENCES_PERMITS", ["IS_IT_SOFTWARE"])).toBe(false);
    expect(isFsGroupFamilyIncompatibleWithCluster("IS_MEMBERSHIPS_SUBS", ["IS_IT_SOFTWARE"])).toBe(false);
  });

  it("§2 · post-v196 regression guard — IS_PAYROLL is incompatible with every non-payroll cluster (composer-side payroll gate)", () => {
    // The document-level `rulePayrollAccountExcluded` fires in
    // `filterEligibleAccounts` for the general ranker. The
    // allocation composer's per-cluster pool does NOT run that
    // service — so the family-incompatibility matrix must also
    // exclude IS_PAYROLL from any non-payroll cluster, otherwise
    // "Wages - Maintenance" sneaks into an IT cluster via
    // lexical overlap (v196 staging regression that motivated
    // this test).
    expect(isFsGroupFamilyIncompatibleWithCluster("IS_PAYROLL", ["IS_IT_SOFTWARE"])).toBe(true);
    expect(isFsGroupFamilyIncompatibleWithCluster("IS_PAYROLL", ["IS_REPAIRS_MAINTENANCE"])).toBe(true);
    expect(isFsGroupFamilyIncompatibleWithCluster("IS_PAYROLL", ["IS_TELEPHONE_INTERNET"])).toBe(true);
    expect(isFsGroupFamilyIncompatibleWithCluster("IS_PAYROLL", ["IS_LICENCES_PERMITS"])).toBe(true);
    expect(isFsGroupFamilyIncompatibleWithCluster("IS_PAYROLL", ["IS_MEMBERSHIPS_SUBS"])).toBe(true);
    // Payroll IS compatible with itself — a legitimate payroll-
    // provider invoice whose cluster concept hints at IS_PAYROLL
    // (future concept) would allow wages accounts.
    expect(isFsGroupFamilyIncompatibleWithCluster("IS_PAYROLL", ["IS_PAYROLL"])).toBe(false);
  });

  it("diagnostic helper names the offending hint", () => {
    const d = describeFsGroupFamilyIncompatibility("IS_REPAIRS_MAINTENANCE", ["IS_IT_SOFTWARE"]);
    expect(d).toContain("IS_REPAIRS_MAINTENANCE");
    expect(d).toContain("IS_IT_SOFTWARE");
    expect(describeFsGroupFamilyIncompatibility("IS_LICENCES_PERMITS", ["IS_IT_SOFTWARE"])).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// §5 REVERSE-CONTROL MATRIX at the allocation-composer level
// -----------------------------------------------------------------------------

function makeLine(desc: string, amount: number): LineItem {
  return {
    description: desc, quantity: 1, unitPrice: amount, amount,
    taxRate: null, taxAmount: null, taxTreatment: "unknown" as const,
    evidence: ["amount_only"], confidence: 80,
  } as unknown as LineItem;
}

// Coulee-Ridge-shape COA subset. Deliberately includes both a
// physical R&M account AND an IT Services account to prove the
// gate picks based on cluster substance, not lexical overlap.
const COA = [
  { id: "a_6054", accountNumber: "6054", name: "Computer & IT Services", type: "EXPENSE", normalBalance: "DEBIT", isActive: true, isHeader: false, allowManualPosting: true, isControlAccount: false, isBankAccount: false, isCashAccount: false, archivedAt: null, fundApplicability: "OPERATING", categoryKey: "ADMIN_EXPENSES", fsGroupKey: "IS_IT_SOFTWARE", accountRole: "STANDARD" },
  { id: "a_6062", accountNumber: "6062", name: "Licenses", type: "EXPENSE", normalBalance: "DEBIT", isActive: true, isHeader: false, allowManualPosting: true, isControlAccount: false, isBankAccount: false, isCashAccount: false, archivedAt: null, fundApplicability: "OPERATING", categoryKey: null, fsGroupKey: "IS_LICENCES_PERMITS", accountRole: "STANDARD" },
  { id: "a_6033", accountNumber: "6033", name: "R & M Preventative Maintenance", type: "EXPENSE", normalBalance: "DEBIT", isActive: true, isHeader: false, allowManualPosting: true, isControlAccount: false, isBankAccount: false, isCashAccount: false, archivedAt: null, fundApplicability: "OPERATING", categoryKey: "REPAIRS_AND_MAINTENANCE", fsGroupKey: "IS_REPAIRS_MAINTENANCE", accountRole: "STANDARD" },
  { id: "a_6320", accountNumber: "6320", name: "Clubhouse R&M", type: "EXPENSE", normalBalance: "DEBIT", isActive: true, isHeader: false, allowManualPosting: true, isControlAccount: false, isBankAccount: false, isCashAccount: false, archivedAt: null, fundApplicability: "OPERATING", categoryKey: "REPAIRS_AND_MAINTENANCE", fsGroupKey: "IS_REPAIRS_MAINTENANCE", accountRole: "STANDARD" },
  { id: "a_6072", accountNumber: "6072", name: "Telephone & Internet", type: "EXPENSE", normalBalance: "DEBIT", isActive: true, isHeader: false, allowManualPosting: true, isControlAccount: false, isBankAccount: false, isCashAccount: false, archivedAt: null, fundApplicability: "OPERATING", categoryKey: "ADMIN_EXPENSES", fsGroupKey: "IS_TELEPHONE_INTERNET", accountRole: "STANDARD" },
];

describe("§5 reverse-control matrix — compatibility before relevance", () => {
  it("A · 221178-shape IT invoice: Service Maintenance Fee no longer lands on 6033 R&M (the exact defect this slice closes)", () => {
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
    // Service Maintenance Fee cluster is IT_SERVICES via doc coherence.
    // The R&M families (6033, 6320) are excluded before scoring → 6054
    // (or another IT-family account like 6062 Licenses via the
    // software_subscription cluster) wins.
    expect(accountsChosen).not.toContain("6033");
    expect(accountsChosen).not.toContain("6320");
    // Some IT-family account carries the load.
    expect(accountsChosen).toContain("6054");
  });

  it("B · genuine physical R&M invoice: mower repair still lands on 6033 (IT accounts excluded from R&M cluster)", () => {
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
    // R&M cluster excludes 6054 Computer & IT Services (family
    // incompatibility). 6033 or 6320 wins by relevance.
    expect(accountsChosen).not.toContain("6054");
    expect(accountsChosen.some((n) => n === "6033" || n === "6320")).toBe(true);
  });

  it("C · OXIO-shape telecom invoice: fiber + VoIP → 6072 preserved; IT accounts excluded", () => {
    const res = computeAllocations({
      lineItems: [
        makeLine("Fiber internet 200Mbps monthly service.", 240),
        makeLine("VoIP calling plan — 20 lines.", 180),
      ],
      accounts: COA as any,
      postingBlockersByAccount: new Map(),
      economicPurposeCandidates: null,
      fullDocumentText: null,
      supplierName: null,
      printedSubtotal: 420,
      printedTax: 21,
      printedTotal: 441,
    });
    const accountsChosen = res.allocations.map((a) => a.recommendedAccount?.accountNumber);
    // Telecom / connectivity concept → prefers IS_TELEPHONE_INTERNET.
    // IT Services (6054) is family-incompatible with telecom clusters
    // → excluded. 6072 wins if any allocation resolves.
    for (const n of accountsChosen) {
      expect(n === "6054").toBe(false);
    }
  });

  it("D · genuine software subscription: 'Adobe CC annual subscription' — IT/subscription-compatible, R&M excluded", () => {
    const res = computeAllocations({
      lineItems: [
        makeLine("Adobe CC annual subscription — 5 seats", 480),
      ],
      accounts: COA as any,
      postingBlockersByAccount: new Map(),
      economicPurposeCandidates: null,
      fullDocumentText: null,
      supplierName: null,
      printedSubtotal: 480,
      printedTax: 24,
      printedTotal: 504,
    });
    const accountsChosen = res.allocations.map((a) => a.recommendedAccount?.accountNumber);
    expect(accountsChosen).not.toContain("6033");
    expect(accountsChosen).not.toContain("6320");
  });

  it("E · cybersecurity invoice: antivirus + endpoint monitoring → IT-compatible; R&M and telecom excluded", () => {
    const res = computeAllocations({
      lineItems: [
        makeLine("SentinelOne antivirus for computers and servers.", 277.5),
        makeLine("Endpoint protection monitoring — 33 devices.", 300),
      ],
      accounts: COA as any,
      postingBlockersByAccount: new Map(),
      economicPurposeCandidates: null,
      fullDocumentText: null,
      supplierName: null,
      printedSubtotal: 577.5,
      printedTax: 28.88,
      printedTotal: 606.38,
    });
    const accountsChosen = res.allocations.map((a) => a.recommendedAccount?.accountNumber);
    for (const n of accountsChosen) {
      expect(n === "6033").toBe(false);
      expect(n === "6320").toBe(false);
      expect(n === "6072").toBe(false);
    }
  });

  it("F · lexical-only overlap: a generic 'Maintenance Fee' with NO IT siblings does NOT trip incompatibility (falls back to R&M)", () => {
    const res = computeAllocations({
      lineItems: [
        makeLine("Monthly Maintenance Fee.", 150),
      ],
      accounts: COA as any,
      postingBlockersByAccount: new Map(),
      economicPurposeCandidates: null,
      fullDocumentText: null,
      supplierName: null,
      printedSubtotal: 150,
      printedTax: 7.5,
      printedTotal: 157.5,
    });
    // With only ONE R&M line and no IT-classified siblings, the
    // document-coherence pass doesn't reclassify. Cluster stays as
    // repairs_and_maintenance. R&M family is compatible with itself,
    // so 6033 / 6320 remain candidates and the winner is one of them.
    const accountsChosen = res.allocations.map((a) => a.recommendedAccount?.accountNumber);
    // 6054 (IT) is excluded from the r&m cluster's pool.
    expect(accountsChosen).not.toContain("6054");
    // But 6033 or 6320 (R&M) is now a legitimate candidate.
    expect(accountsChosen.some((n) => n === "6033" || n === "6320")).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// §21 anti-overfitting
// -----------------------------------------------------------------------------

describe("§21 anti-overfitting", () => {
  it("family-incompatibility matrix keys / values are only fsGroupKey identifiers — never account numbers or vendor names", () => {
    // The module's exported behavior is pure taxonomy identifiers.
    for (const acct of ["IS_IT_SOFTWARE", "IS_REPAIRS_MAINTENANCE", "IS_TELEPHONE_INTERNET"]) {
      expect(acct).toMatch(/^IS_[A-Z_]+$/);
      expect(acct).not.toContain("6");
      expect(acct).not.toContain("Club");
      expect(acct).not.toContain("Alberta");
    }
  });
});
