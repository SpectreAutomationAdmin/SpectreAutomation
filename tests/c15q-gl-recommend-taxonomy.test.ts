// Sprint 3 · Checkpoint 15Q (revised, 2026-07-28) — generalized GL
// recommendation tests.
//
// Founder rejection of the earlier 15Q slice: for the actual
// professional-membership invoice, the recommender picked
// "Score Cards & Printing" and previously "Accounting Fees" —
// neither is correct. Coulee Ridge's actual account 6064
// "Membership & Dues" (FS Group IS_MEMBERSHIPS_SUBS) was missed
// because:
//   1. The role-name regex required "membership dues" adjacent
//      or "dues & memberships" (reverse order). "Membership & Dues"
//      didn't match.
//   2. The economic-purpose role match consulted account.name only.
//      "Memberships & Subscriptions" FS Group was ignored.
//   3. The recommender conflated semantic match with posting
//      eligibility: if an account was "blocked" (fundApplicability
//      unmapped), an unrelated postable account could win instead.
//
// These tests prove:
//   • professional-membership invoices select a membership-role
//     account over accounting-fees accounts
//   • role matching considers account.name, FS Group AND category
//   • a blocked but conceptually-correct account remains the leader
//   • blocked / unmapped posting eligibility prevents auto-approval
//   • an unrelated eligible account does NOT outrank the correct
//     blocked account solely because it is postable
//   • external accountants' invoices still route to Accounting Fees
//   • member-revenue invoices do NOT route to employee-membership
//     accounts
//   • tenant-scoping stays intact (no cross-club leakage)
//
// GENERALIZED — no account-number literals in production, no
// vendor-specific rules, no acceptance-invoice references.

import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { recommendGlAccount } from "@/lib/ap-intelligence/gl-recommend";

const token = "c15q-tax-" + Math.random().toString(36).slice(2, 8);
let CLUB_A: string;
let CLUB_B: string;

// Coulee-Ridge-shaped COA on CLUB_A:
let CLUB_A_MEMBERSHIP_UNMAPPED_ID: string;   // "Membership & Dues" — fundApplicability null (BLOCKED in UI)
let CLUB_A_MEMBERSHIP_MAPPED_ID: string;     // "Membership Dues Expense" — fundApplicability OPERATING (postable)
let CLUB_A_ACCOUNTING_FEES_ID: string;       // "Accounting Fees" — postable
let CLUB_A_SCORE_CARDS_ID: string;           // "Score Cards & Printing" — postable (adversarial)
let CLUB_A_MEMBERSHIP_REVENUE_ID: string;    // "Membership Dues Revenue" — REVENUE side

// Club-B has ONLY Accounting Fees + Score Cards — no membership account:
let CLUB_B_ACCOUNTING_FEES_ID: string;
let CLUB_B_SCORE_CARDS_ID: string;

beforeAll(async () => {
  const a = await prisma.club.create({
    data: { slug: `${token}-a`, name: "C15Q Tax Test Club A" },
    select: { id: true },
  });
  CLUB_A = a.id;
  const b = await prisma.club.create({
    data: { slug: `${token}-b`, name: "C15Q Tax Test Club B" },
    select: { id: true },
  });
  CLUB_B = b.id;

  // FS Groups for Club A. Use the canonical keys defined in
  // src/lib/accounting/coa-template.ts so the recommender's
  // ROLE_TAXONOMY_KEYS mapping resolves correctly.
  const membSubs = await prisma.financialStatementGroup.create({
    data: { clubId: CLUB_A, key: "IS_MEMBERSHIPS_SUBS", name: "Memberships & Subscriptions", statement: "INCOME_STATEMENT" },
    select: { id: true },
  });
  const profFees = await prisma.financialStatementGroup.create({
    data: { clubId: CLUB_A, key: "IS_PROFESSIONAL_FEES", name: "Professional Fees", statement: "INCOME_STATEMENT" },
    select: { id: true },
  });
  const memberRevenue = await prisma.financialStatementGroup.create({
    data: { clubId: CLUB_A, key: "IS_MEMBERSHIP_DUES", name: "Membership Dues", statement: "INCOME_STATEMENT" },
    select: { id: true },
  });
  const printing = await prisma.financialStatementGroup.create({
    data: { clubId: CLUB_A, key: "IS_OTHER_OPEX", name: "Other Operating Expenses", statement: "INCOME_STATEMENT" },
    select: { id: true },
  });

  // Coulee-Ridge-shape 6064: exists, active, allowManualPosting true,
  // fundApplicability null → BLOCKED in the COA UI, but posting is
  // NOT blocked (fund unmapped only fails reporting-package inclusion).
  // We assert both semantic leadership AND the accurate posting
  // blocker in tests below.
  const membershipUnmapped = await prisma.account.create({
    data: {
      clubId: CLUB_A, accountNumber: "6064", name: "Membership & Dues",
      type: "EXPENSE", normalBalance: "DEBIT",
      isActive: true, allowManualPosting: true, isHeader: false,
      fundApplicability: null,   // ← unmapped
      fsGroupId: membSubs.id,
      sortOrder: 640,
    },
    select: { id: true },
  });
  CLUB_A_MEMBERSHIP_UNMAPPED_ID = membershipUnmapped.id;

  const membershipMapped = await prisma.account.create({
    data: {
      clubId: CLUB_A, accountNumber: "6065", name: "Professional Membership Dues",
      type: "EXPENSE", normalBalance: "DEBIT",
      isActive: true, allowManualPosting: true, isHeader: false,
      fundApplicability: "OPERATING",
      fsGroupId: membSubs.id,
      sortOrder: 641,
    },
    select: { id: true },
  });
  CLUB_A_MEMBERSHIP_MAPPED_ID = membershipMapped.id;

  const acctFees = await prisma.account.create({
    data: {
      clubId: CLUB_A, accountNumber: "6061", name: "Accounting Fees",
      type: "EXPENSE", normalBalance: "DEBIT",
      isActive: true, allowManualPosting: true, isHeader: false,
      fundApplicability: "OPERATING",
      fsGroupId: profFees.id,
      sortOrder: 606,
    },
    select: { id: true },
  });
  CLUB_A_ACCOUNTING_FEES_ID = acctFees.id;

  const scoreCards = await prisma.account.create({
    data: {
      clubId: CLUB_A, accountNumber: "6045", name: "Score Cards & Printing",
      type: "EXPENSE", normalBalance: "DEBIT",
      isActive: true, allowManualPosting: true, isHeader: false,
      fundApplicability: "OPERATING",
      fsGroupId: printing.id,
      sortOrder: 604,
    },
    select: { id: true },
  });
  CLUB_A_SCORE_CARDS_ID = scoreCards.id;

  const membRev = await prisma.account.create({
    data: {
      clubId: CLUB_A, accountNumber: "4000", name: "Membership Dues Revenue",
      type: "REVENUE", normalBalance: "CREDIT",
      isActive: true, allowManualPosting: true, isHeader: false,
      fundApplicability: "OPERATING",
      fsGroupId: memberRevenue.id,
      sortOrder: 400,
    },
    select: { id: true },
  });
  CLUB_A_MEMBERSHIP_REVENUE_ID = membRev.id;

  // Club B — deliberately WITHOUT a membership account.
  const bProfFees = await prisma.financialStatementGroup.create({
    data: { clubId: CLUB_B, key: "IS_PROFESSIONAL_FEES", name: "Professional Fees", statement: "INCOME_STATEMENT" },
    select: { id: true },
  });
  const bPrinting = await prisma.financialStatementGroup.create({
    data: { clubId: CLUB_B, key: "IS_OTHER_OPEX", name: "Other Operating Expenses", statement: "INCOME_STATEMENT" },
    select: { id: true },
  });
  const bAcctFees = await prisma.account.create({
    data: {
      clubId: CLUB_B, accountNumber: "6061", name: "Accounting Fees",
      type: "EXPENSE", normalBalance: "DEBIT",
      isActive: true, allowManualPosting: true, isHeader: false,
      fundApplicability: "OPERATING",
      fsGroupId: bProfFees.id,
      sortOrder: 606,
    },
    select: { id: true },
  });
  CLUB_B_ACCOUNTING_FEES_ID = bAcctFees.id;
  const bScoreCards = await prisma.account.create({
    data: {
      clubId: CLUB_B, accountNumber: "6045", name: "Score Cards & Printing",
      type: "EXPENSE", normalBalance: "DEBIT",
      isActive: true, allowManualPosting: true, isHeader: false,
      fundApplicability: "OPERATING",
      fsGroupId: bPrinting.id,
      sortOrder: 604,
    },
    select: { id: true },
  });
  CLUB_B_SCORE_CARDS_ID = bScoreCards.id;
});

// A minimal professional-body-membership extraction. Fictional
// vendor name (not CPA Alberta / Canada).
function membershipExtraction() {
  return {
    vendor: {
      guessedName: "Provincial Institute of Professional Sciences",
      guessedEmail: null, guessedTaxNumber: null, guessedDomain: null,
    },
    description: null,
    lineItems: [
      { description: "Annual professional dues", quantity: null, unitCost: null, amount: "500.00" },
      { description: "Regional membership fee",  quantity: null, unitCost: null, amount: "150.00" },
      { description: "Late-payment penalty",     quantity: null, unitCost: null, amount: "40.00"  },
    ],
  };
}

describe("15Q · GL taxonomy — membership dues route to membership account", () => {
  it("selects the account with FS Group IS_MEMBERSHIPS_SUBS over Accounting Fees + Score Cards", async () => {
    const r = await recommendGlAccount({
      clubId: CLUB_A, vendorId: null,
      capitalState: "OPERATING", capitalClass: null,
      extraction: membershipExtraction(),
    });
    // Leader must be one of the two membership accounts on Club A.
    expect([CLUB_A_MEMBERSHIP_UNMAPPED_ID, CLUB_A_MEMBERSHIP_MAPPED_ID])
      .toContain(r.candidates[0].accountId);
    // Must NOT be Accounting Fees or Score Cards.
    expect(r.accountNumber).not.toBe("6061");
    expect(r.accountNumber).not.toBe("6045");
  });

  it("role match uses FS Group taxonomy, not only account name", async () => {
    const r = await recommendGlAccount({
      clubId: CLUB_A, vendorId: null,
      capitalState: "OPERATING", capitalClass: null,
      extraction: membershipExtraction(),
    });
    // The 6064 name ("Membership & Dues") specifically uses `&` as
    // a connector — proving the role-name regex accepts that AND
    // the FS Group (IS_MEMBERSHIPS_SUBS) contributes even for
    // accounts whose name is oddly worded.
    const membershipCandidate = r.candidates.find((c) => c.accountId === CLUB_A_MEMBERSHIP_UNMAPPED_ID);
    expect(membershipCandidate).toBeDefined();
    expect(membershipCandidate!.evidence.some((e) => e.kind === "ECONOMIC_PURPOSE")).toBe(true);
  });

  it("a blocked (fundApplicability=null) semantic leader REMAINS the leader (not silently swapped for a postable unrelated account)", async () => {
    // Delete the mapped-membership account temporarily so only the
    // BLOCKED 6064 remains as the semantic match. Assert 6064 still
    // wins over Score Cards and Accounting Fees.
    await prisma.account.update({
      where: { id: CLUB_A_MEMBERSHIP_MAPPED_ID },
      data: { isActive: false },
    });
    try {
      const r = await recommendGlAccount({
        clubId: CLUB_A, vendorId: null,
        capitalState: "OPERATING", capitalClass: null,
        extraction: membershipExtraction(),
      });
      expect(r.candidates[0].accountId).toBe(CLUB_A_MEMBERSHIP_UNMAPPED_ID);
      expect(r.accountNumber).toBe("6064");
      // But the leader IS NOT postable due to fund-applicability blocker.
      expect(r.leaderIsPostable).toBe(false);
      expect(r.leaderPostingBlockers).toContain("FUND_APPLICABILITY_UNMAPPED");
      // Auto-approval must be denied for a blocked leader.
      expect(r.autoApprovalEligible).toBe(false);
      // The reason string names the blocker so the reviewer can act.
      expect(r.reason.toLowerCase()).toContain("fund");
    } finally {
      // Restore for other tests in the describe block.
      await prisma.account.update({
        where: { id: CLUB_A_MEMBERSHIP_MAPPED_ID },
        data: { isActive: true },
      });
    }
  });

  it("auto-approval is allowed only when leader is postable AND confidence >= threshold", async () => {
    const r = await recommendGlAccount({
      clubId: CLUB_A, vendorId: null,
      capitalState: "OPERATING", capitalClass: null,
      extraction: membershipExtraction(),
    });
    // Postable leader (the MAPPED one wins because both members get
    // the same boost but MAPPED has no posting blocker).
    if (r.leaderIsPostable) {
      // Auto-approval iff confidence >= 85.
      const expected = r.confidence != null && r.confidence >= 85;
      expect(r.autoApprovalEligible).toBe(expected);
    }
  });
});

describe("15Q · GL taxonomy — negative cases (no regression of correct behaviour)", () => {
  it("external accountants' service invoice (LLP + audit lines) still selects Accounting Fees", async () => {
    const r = await recommendGlAccount({
      clubId: CLUB_A, vendorId: null,
      capitalState: "OPERATING", capitalClass: null,
      extraction: {
        vendor: { guessedName: "Smith Rowley & Partners LLP", guessedEmail: null, guessedTaxNumber: null, guessedDomain: null },
        description: null,
        lineItems: [
          { description: "Audit services for year ended 2025-12-31", quantity: null, unitCost: null, amount: "6500.00" },
          { description: "Tax return preparation",                    quantity: null, unitCost: null, amount: "500.00" },
        ],
      },
    });
    expect(r.accountNumber).toBe("6061");
    expect(r.accountName?.toLowerCase()).toContain("accounting");
  });

  it("member paying club (REVENUE direction) does NOT route to Employee Membership expense", async () => {
    // The economic-purpose classifier is direction-aware; but even
    // if a caller mislabels, the recommender's ROLE_TAXONOMY_KEYS
    // maps MEMBER_DUES_REVENUE only to FS Group IS_MEMBERSHIP_DUES
    // (REVENUE side), never to IS_MEMBERSHIPS_SUBS (EXPENSE side).
    const r = await recommendGlAccount({
      clubId: CLUB_A, vendorId: null,
      capitalState: "OPERATING", capitalClass: null,
      extraction: {
        vendor: { guessedName: null, guessedEmail: null, guessedTaxNumber: null, guessedDomain: null },
        description: null,
        lineItems: [
          { description: "Member annual dues 2026", quantity: null, unitCost: null, amount: "5000.00" },
        ],
      },
    });
    // Should not route to an EXPENSE-side membership account.
    expect(r.accountNumber).not.toBe("6064");
    expect(r.accountNumber).not.toBe("6065");
  });

  it("tenant Chart-of-Accounts scoping: Club A extraction never proposes Club B accounts", async () => {
    // Run the extraction against Club A. Assert every candidate is a
    // Club A account. (Cross-club leakage would violate multi-tenant
    // isolation.)
    const r = await recommendGlAccount({
      clubId: CLUB_A, vendorId: null,
      capitalState: "OPERATING", capitalClass: null,
      extraction: membershipExtraction(),
    });
    const clubBIds = new Set([CLUB_B_ACCOUNTING_FEES_ID, CLUB_B_SCORE_CARDS_ID]);
    for (const c of r.candidates) {
      expect(clubBIds.has(c.accountId)).toBe(false);
    }
  });

  it("on a tenant without a membership account, we do NOT invent one — the recommender returns whatever the semantic pass produces (never silently substitutes)", async () => {
    // Club B has ONLY Accounting Fees + Score Cards; no membership
    // account. The recommender must be honest — return the closest
    // semantic match even if wrong-family, not fabricate a "membership"
    // account. Also must NOT invent an account number.
    const r = await recommendGlAccount({
      clubId: CLUB_B, vendorId: null,
      capitalState: "OPERATING", capitalClass: null,
      extraction: membershipExtraction(),
    });
    // Whatever it picks, it must be an EXISTING Club B account.
    if (r.accountNumber) {
      const knownIds = new Set([CLUB_B_ACCOUNTING_FEES_ID, CLUB_B_SCORE_CARDS_ID]);
      const found = r.candidates.find((c) => c.accountNumber === r.accountNumber);
      expect(found).toBeDefined();
      expect(knownIds.has(found!.accountId)).toBe(true);
    }
  });
});
