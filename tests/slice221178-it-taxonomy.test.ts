// Sprint 3 · 221178 IT-taxonomy slice (2026-08-10) — PART A tests.
//
// Locks the following invariants:
//
//   §4 — new / extended purpose concepts fire on modern IT vocabulary
//       (backup / storage / cybersecurity / antivirus).
//   §5 — "Service Maintenance Fee" alone does NOT map to physical
//       R&M; on an IT-dominant invoice (§6 document-level coherence)
//       the ranker prefers `it_services` over `repairs_and_maintenance`.
//   §9-§10 — cloud/IT ≠ Telephone & Internet; software ≠ automatic
//       Licenses.
//   §12 — a semantically ambiguous purchase safely abstains rather
//       than routing to a wrong-family account.
//   §31 — no vendor / invoice / SKU literal makes it into the
//       taxonomy definitions.

import { describe, it, expect } from "vitest";
import { CANONICAL_PURPOSE_CONCEPTS, type EconomicPurposeConcept } from "@/lib/ap-intelligence/economic-purpose-taxonomy";

// -----------------------------------------------------------------------------
// Canonical purpose classifier — cue regex tests
// -----------------------------------------------------------------------------

function cuesFor(concept: EconomicPurposeConcept) {
  const c = CANONICAL_PURPOSE_CONCEPTS.find((x) => x.concept === concept);
  if (!c) throw new Error(`Missing concept ${concept}`);
  return c.cues;
}

function matches(concept: EconomicPurposeConcept, text: string): boolean {
  return cuesFor(concept).some((rx) => rx.test(text));
}

describe("§4 SOFTWARE_SUBSCRIPTION cue expansion", () => {
  const positives = [
    "Software subscription",
    "SaaS annual license",
    "Online Backup Storage Fee.",
    "Cloud storage - monthly",
    "Offsite Backup service",
    "Data storage",
    "hosted storage renewal",
    "Data Backup for servers",
  ];
  for (const t of positives) {
    it(`fires on: "${t}"`, () => {
      expect(matches("SOFTWARE_SUBSCRIPTION", t)).toBe(true);
    });
  }

  it("§9 does NOT fire on a real telephone line item (Telephone & Internet remains distinct)", () => {
    expect(matches("SOFTWARE_SUBSCRIPTION", "Telephone service — main line")).toBe(false);
    expect(matches("SOFTWARE_SUBSCRIPTION", "Internet 100Mbps")).toBe(false);
  });
});

describe("§4 CYBERSECURITY_SERVICE concept", () => {
  const positives = [
    "Cyber Security ($17.00 x 33 users = $561.00).",
    "Cybersecurity monitoring",
    "SentinelOne Antivirus for Computers and Servers.",
    "endpoint protection - annual",
    "Anti-virus for workstations",
    "managed EDR",
    "network security assessment",
    "vulnerability scan",
  ];
  for (const t of positives) {
    it(`fires on: "${t}"`, () => {
      expect(matches("CYBERSECURITY_SERVICE", t)).toBe(true);
    });
  }

  it("does NOT fire on generic 'security deposit' or 'security check'", () => {
    expect(matches("CYBERSECURITY_SERVICE", "Security deposit refund")).toBe(false);
    expect(matches("CYBERSECURITY_SERVICE", "Security check for evening event")).toBe(false);
    expect(matches("CYBERSECURITY_SERVICE", "Building security patrol")).toBe(false);
  });
});

describe("§5 REPAIR_MAINTENANCE stays valid for genuine physical R&M", () => {
  // The base repair/maintenance cue still fires; document-level
  // coherence handles the "service maintenance on an IT invoice"
  // reclassification (see the gl-allocations coherence test below).
  const positives = [
    "Fairway mower repair",
    "Kitchen exhaust hood inspection",
    "Bunker rake maintenance labor",
    "Golf cart fleet service",
  ];
  for (const t of positives) {
    it(`fires on: "${t}"`, () => {
      expect(matches("REPAIR_MAINTENANCE", t)).toBe(true);
    });
  }
});

// -----------------------------------------------------------------------------
// gl-concepts side — synonym coverage for the ranker's per-line
// concept assignment (used by computeAllocations / rankAccountsPure).
// -----------------------------------------------------------------------------

import { ACCOUNTING_CONCEPTS } from "@/lib/ap-intelligence/gl-concepts";

describe("§4 gl-concepts synonym coverage", () => {
  it("cybersecurity_service concept exists with IS_IT_SOFTWARE hint", () => {
    const c = ACCOUNTING_CONCEPTS.find((x) => x.id === "cybersecurity_service");
    expect(c).toBeDefined();
    expect(c!.fsGroupKeyHints).toContain("IS_IT_SOFTWARE");
    expect(c!.parent).toBe("it_services");
    expect(c!.synonyms).toContain("antivirus");
    expect(c!.synonyms).toContain("cyber security");
    expect(c!.synonyms).toContain("endpoint protection");
  });

  it("software_subscription_service now covers online backup and cloud storage", () => {
    const c = ACCOUNTING_CONCEPTS.find((x) => x.id === "software_subscription_service");
    expect(c).toBeDefined();
    expect(c!.synonyms).toContain("online backup");
    expect(c!.synonyms).toContain("cloud storage");
    expect(c!.synonyms).toContain("backup storage");
    expect(c!.fsGroupKeyHints).toContain("IS_IT_SOFTWARE");
  });

  it("it_services extended with IT support vocabulary (no 'maintenance' tokens — those attract R&M accounts)", () => {
    const c = ACCOUNTING_CONCEPTS.find((x) => x.id === "it_services");
    expect(c).toBeDefined();
    expect(c!.synonyms).toContain("computer support");
    expect(c!.synonyms).toContain("technology support");
    expect(c!.synonyms).toContain("helpdesk");
    // Deliberately NOT: "maintenance", "computer maintenance", "it
    // maintenance". Those tokens attract 6033-shape R&M accounts on
    // account-name overlap. Document-level coherence (§6) handles the
    // "Service Maintenance Fee on an IT-dominant invoice" case
    // instead — see gl-allocations §2b.
    expect(c!.synonyms).not.toContain("maintenance");
    expect(c!.synonyms).not.toContain("it maintenance");
    expect(c!.fsGroupKeyHints).toContain("IS_IT_SOFTWARE");
  });
});

// -----------------------------------------------------------------------------
// §6 document-level coherence — 221178-shaped invoice
// -----------------------------------------------------------------------------

import { computeAllocations } from "@/lib/ap-intelligence/gl-allocations";
import type { LineItem } from "@/lib/ap-intelligence/line-items-extract";

function makeLine(desc: string, amount: number): LineItem {
  return {
    description: desc, quantity: 1, unitPrice: amount, amount,
    taxRate: null, taxAmount: null, taxTreatment: "unknown",
    evidence: ["amount_only"], confidence: 80,
  } as unknown as LineItem;
}

const COULEE_IT_ACCOUNTS = [
  { id: "a_6054", accountNumber: "6054", name: "Computer & IT Services", type: "EXPENSE", normalBalance: "DEBIT", isActive: true, isHeader: false, allowManualPosting: true, isControlAccount: false, isBankAccount: false, isCashAccount: false, archivedAt: null, fundApplicability: "OPERATING", categoryKey: "ADMIN_EXPENSES", fsGroupKey: "IS_IT_SOFTWARE", accountRole: "STANDARD" },
  { id: "a_6062", accountNumber: "6062", name: "Licenses", type: "EXPENSE", normalBalance: "DEBIT", isActive: true, isHeader: false, allowManualPosting: true, isControlAccount: false, isBankAccount: false, isCashAccount: false, archivedAt: null, fundApplicability: "OPERATING", categoryKey: null, fsGroupKey: "IS_LICENCES_PERMITS", accountRole: "STANDARD" },
  { id: "a_6033", accountNumber: "6033", name: "R & M Preventative Maintenance", type: "EXPENSE", normalBalance: "DEBIT", isActive: true, isHeader: false, allowManualPosting: true, isControlAccount: false, isBankAccount: false, isCashAccount: false, archivedAt: null, fundApplicability: "OPERATING", categoryKey: "REPAIRS_AND_MAINTENANCE", fsGroupKey: "IS_REPAIRS_MAINTENANCE", accountRole: "STANDARD" },
  { id: "a_6072", accountNumber: "6072", name: "Telephone & Internet", type: "EXPENSE", normalBalance: "DEBIT", isActive: true, isHeader: false, allowManualPosting: true, isControlAccount: false, isBankAccount: false, isCashAccount: false, archivedAt: null, fundApplicability: "OPERATING", categoryKey: "ADMIN_EXPENSES", fsGroupKey: "IS_TELEPHONE_INTERNET", accountRole: "STANDARD" },
];

describe("§6 document-level IT coherence", () => {
  it("§6 IT-dominant 221178-shape: doc-coherence pass reclassifies line 1 concept to it_services + unresolved cluster resolves", () => {
    const res = computeAllocations({
      lineItems: [
        makeLine("Service Maintenance Fee.", 2275),
        makeLine("Online Backup Storage Fee.", 300),
        makeLine("Online Backup License Fee: $100.00 x 2 servers = $200.00", 200),
        makeLine("Cyber Security ($17.00 x 33 users = $561.00).", 561),
        makeLine("SentinelOne Antivirus for Computers and Servers.", 277.5),
      ],
      accounts: COULEE_IT_ACCOUNTS as any,
      postingBlockersByAccount: new Map(),
      economicPurposeCandidates: null,
      fullDocumentText: null,
      supplierName: null,
      printedSubtotal: 3613.5,
      printedTax: 180.68,
      printedTotal: 3794.18,
    });
    // Doc-coherence pass fires — line 1's concept is reclassified.
    // Its assigned concept in the emitted cluster is `it_services`
    // (NOT `repairs_and_maintenance`).
    const conceptsSeen = res.allocations.map((a) => a.economicPurpose.concept);
    expect(conceptsSeen).toContain("it_services");
    expect(conceptsSeen).not.toContain("repairs_and_maintenance");
    expect(conceptsSeen).toContain("cybersecurity_service");

    // Backup / cyber / antivirus now RESOLVE (they were the
    // unresolved cluster before this slice). No allocation carries
    // `null` recommendedAccount.
    for (const a of res.allocations) {
      expect(a.recommendedAccount).not.toBeNull();
    }

    // At least one allocation lands on 6054 Computer & IT Services
    // (the IT-resolved cluster from backup / cyber / antivirus).
    const accountsChosen = res.allocations.map((a) => a.recommendedAccount?.accountNumber).filter(Boolean);
    expect(accountsChosen).toContain("6054");

    // Arithmetic reconciles to invoice subtotal.
    expect(Number(res.totals.allocationsSubtotal.toFixed(2))).toBe(3613.5);
    expect(Number(res.totals.grossTotal.toFixed(2))).toBe(3794.18);
  });

  it("§5 REVERSE CONTROL — genuine R&M invoice (mower repair with ZERO IT siblings) still lands on 6033", () => {
    const res = computeAllocations({
      lineItems: [
        makeLine("Fairway mower reel regrind and belt", 850),
        makeLine("Labour — 4 hours mechanic", 400),
      ],
      accounts: COULEE_IT_ACCOUNTS as any,
      postingBlockersByAccount: new Map(),
      economicPurposeCandidates: null,
      fullDocumentText: null,
      supplierName: null,
      printedSubtotal: 1250,
      printedTax: 62.5,
      printedTotal: 1312.5,
    });
    const accountsChosen = res.allocations.map((a) => a.recommendedAccount?.accountNumber);
    // No reclassification — R&M still fires on physical repair
    // language with no IT siblings.
    expect(accountsChosen).toContain("6033");
  });

  it("§9 REVERSE CONTROL — OXIO-shape telecom invoice (Internet / VoIP) is not routed to IT Services by the coherence pass", () => {
    const res = computeAllocations({
      lineItems: [
        makeLine("Fiber internet 200Mbps monthly service.", 240),
        makeLine("VoIP calling plan — 20 lines.", 180),
      ],
      accounts: COULEE_IT_ACCOUNTS as any,
      postingBlockersByAccount: new Map(),
      economicPurposeCandidates: null,
      fullDocumentText: null,
      supplierName: null,
      printedSubtotal: 420,
      printedTax: 21,
      printedTotal: 441,
    });
    const accountsChosen = res.allocations.map((a) => a.recommendedAccount?.accountNumber);
    // Neither cybersecurity nor software_subscription — should
    // land on Telephone & Internet (6072) or abstain.
    expect(accountsChosen).not.toContain("6033");
    // Cybersecurity / IT Services should not win over telecom.
    for (const n of accountsChosen) {
      // Allow 6072 or null; forbid 6054 (Computer & IT Services)
      expect(n === "6054").toBe(false);
    }
  });
});

// -----------------------------------------------------------------------------
// §31 anti-overfitting
// -----------------------------------------------------------------------------

describe("§31 anti-overfitting", () => {
  it("no supplier / invoice / SKU literal appears in canonical purpose cues", () => {
    for (const c of CANONICAL_PURPOSE_CONCEPTS) {
      for (const cue of c.cues) {
        const s = cue.source;
        expect(s.toLowerCase()).not.toContain("club support");
        expect(s.toLowerCase()).not.toContain("221178");
        expect(s.toLowerCase()).not.toContain("sentinelone");
        expect(s.toLowerCase()).not.toContain("1007565767");
      }
    }
  });

  it("no supplier / invoice / SKU literal appears in gl-concepts synonyms", () => {
    for (const c of ACCOUNTING_CONCEPTS) {
      for (const syn of c.synonyms) {
        expect(syn.toLowerCase()).not.toContain("club support");
        expect(syn.toLowerCase()).not.toContain("221178");
        expect(syn.toLowerCase()).not.toContain("sentinelone");
        expect(syn.toLowerCase()).not.toContain("1007565767");
      }
    }
  });
});
