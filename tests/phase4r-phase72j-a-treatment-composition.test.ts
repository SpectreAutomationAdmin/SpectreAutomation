// Phase 4R · Phase 7.2J-A (2026-08-13) — treatment-composition tests.
//
// Founder controls per §12 "Mandatory before/after tests" of the
// Phase 7.2J-A directive. Every composition branch is tested for:
//   - the resulting expectedDebitRole
//   - the statementRole
//   - defensibility (STRONG / WEAK / UNRESOLVED)
//   - the composed natureLeader that flows into globalSignals
//   - the composed natureIsDefensible that flows into globalSignals
//   - the winningSource provenance
//   - contradictions surfaced
//
// The composition is a PURE function so tests exercise it directly.

import { describe, expect, it } from "vitest";
import { composeAccountingTreatment } from "@/lib/ap-intelligence/treatment-composition";
import type { AccountingNature, AccountingNatureAssessment } from "@/lib/ap-intelligence/accounting-nature";
import type { CapitalVsOperatingState } from "@/lib/ap-intelligence/types";

function nature(
  leader: AccountingNature,
  isDefensible: boolean,
  score = isDefensible ? 20 : 5,
): AccountingNatureAssessment {
  return {
    leader,
    leaderConfidence: score,
    isDefensible,
    ranked: [{ nature: leader, score, supportingEvidence: isDefensible ? ["strong:test"] : [], contradictingEvidence: [] }],
    contradictedPurposes: [],
  };
}

describe("Phase 7.2J-A · composeAccountingTreatment — priority 1: capital=CAPITAL is authoritative", () => {
  it("capital=CAPITAL + nature=UNKNOWN → CAPITAL_ASSET, STRONG, composedNatureIsDefensible=true", () => {
    const r = composeAccountingTreatment({
      capitalState: "CAPITAL",
      capitalSupportingEvidence: ["Invoice total $50000 exceeds threshold.", `Capital-suggesting keyword: "install".`],
      nature: nature("UNKNOWN", false),
    });
    expect(r.expectedDebitRole).toBe("CAPITAL_ASSET");
    expect(r.statementRole).toBe("BALANCE_SHEET_CAPITAL_ASSET");
    expect(r.defensibility).toBe("STRONG");
    expect(r.composedNatureLeader).toBe("CAPITAL_ASSET");
    expect(r.composedNatureIsDefensible).toBe(true);
    expect(r.provenance.winningSource).toBe("capital_classifier_strong");
    expect(r.contradictions).toEqual([]);
  });

  it("capital=CAPITAL + defensible nature=OPERATING_EXPENSE → surfaces contradiction, still CAPITAL", () => {
    const r = composeAccountingTreatment({
      capitalState: "CAPITAL",
      capitalSupportingEvidence: [`Capital-suggesting keyword: "acquisition".`],
      nature: nature("OPERATING_EXPENSE", true),
    });
    expect(r.expectedDebitRole).toBe("CAPITAL_ASSET");
    expect(r.contradictions).toContain("capital=CAPITAL but accounting-nature=OPERATING_EXPENSE (defensible)");
  });
});

describe("Phase 7.2J-A · composeAccountingTreatment — priority 2-6: defensible nature paths", () => {
  it("defensible CAPITAL_ASSET nature + capital=AMBIGUOUS → CAPITAL_ASSET (Phase 7.2I-b preserved)", () => {
    const r = composeAccountingTreatment({
      capitalState: "AMBIGUOUS",
      capitalSupportingEvidence: ["Amount over threshold.", "No capital keyword."],
      nature: nature("CAPITAL_ASSET", true),
    });
    expect(r.expectedDebitRole).toBe("CAPITAL_ASSET");
    expect(r.statementRole).toBe("BALANCE_SHEET_CAPITAL_ASSET");
    expect(r.defensibility).toBe("STRONG");
    expect(r.composedNatureLeader).toBe("CAPITAL_ASSET");
    expect(r.composedNatureIsDefensible).toBe(true);
    expect(r.provenance.winningSource).toBe("nature_defensible");
  });

  it("defensible INVENTORY nature + capital=AMBIGUOUS → INVENTORY, BALANCE_SHEET_CURRENT_ASSET", () => {
    const r = composeAccountingTreatment({
      capitalState: "AMBIGUOUS",
      capitalSupportingEvidence: [],
      nature: nature("INVENTORY", true),
    });
    expect(r.expectedDebitRole).toBe("INVENTORY");
    expect(r.statementRole).toBe("BALANCE_SHEET_CURRENT_ASSET");
    expect(r.defensibility).toBe("STRONG");
    expect(r.composedNatureLeader).toBe("INVENTORY");
    expect(r.composedNatureIsDefensible).toBe(true);
  });

  it("defensible PREPAID_EXPENSE nature → PREPAID_EXPENSE, BALANCE_SHEET_CURRENT_ASSET", () => {
    const r = composeAccountingTreatment({
      capitalState: "AMBIGUOUS",
      capitalSupportingEvidence: [],
      nature: nature("PREPAID_EXPENSE", true),
    });
    expect(r.expectedDebitRole).toBe("PREPAID_EXPENSE");
    expect(r.statementRole).toBe("BALANCE_SHEET_CURRENT_ASSET");
    expect(r.defensibility).toBe("STRONG");
  });

  it("defensible REPAIR_AND_MAINTENANCE nature → REPAIR_AND_MAINTENANCE, OPERATING_EXPENSE statement", () => {
    const r = composeAccountingTreatment({
      capitalState: "AMBIGUOUS",
      capitalSupportingEvidence: [],
      nature: nature("REPAIR_AND_MAINTENANCE", true),
    });
    expect(r.expectedDebitRole).toBe("REPAIR_AND_MAINTENANCE");
    expect(r.statementRole).toBe("OPERATING_EXPENSE");
    expect(r.defensibility).toBe("STRONG");
    expect(r.composedNatureLeader).toBe("REPAIR_AND_MAINTENANCE");
  });

  it("defensible COST_OF_SALES nature → OPERATING_EXPENSE debit role (COGS accounts are EXPENSE) but COST_OF_SALES statement", () => {
    const r = composeAccountingTreatment({
      capitalState: "OPERATING",
      capitalSupportingEvidence: ["Total below threshold.", "No capital keywords detected."], // weak base OPERATING
      nature: nature("COST_OF_SALES", true),
    });
    expect(r.expectedDebitRole).toBe("OPERATING_EXPENSE");
    expect(r.statementRole).toBe("COST_OF_SALES");
    expect(r.defensibility).toBe("STRONG");
    expect(r.composedNatureLeader).toBe("COST_OF_SALES");
  });

  it.each(["OPERATING_EXPENSE", "PROFESSIONAL_SERVICE", "UTILITY_OR_RECURRING_SERVICE", "TAX_OR_REGULATORY", "INTEREST_OR_PENALTY"] as const)(
    "defensible %s nature → OPERATING_EXPENSE",
    (n) => {
      const r = composeAccountingTreatment({
        capitalState: "AMBIGUOUS",
        capitalSupportingEvidence: [],
        nature: nature(n, true),
      });
      expect(r.expectedDebitRole).toBe("OPERATING_EXPENSE");
      expect(r.statementRole).toBe("OPERATING_EXPENSE");
      expect(r.defensibility).toBe("STRONG");
      expect(r.composedNatureLeader).toBe(n);
    },
  );
});

describe("Phase 7.2J-A · composeAccountingTreatment — priority 7-8: capital classifier fallback", () => {
  it("capital=OPERATING with strong operating keyword → OPERATING_EXPENSE, STRONG", () => {
    const r = composeAccountingTreatment({
      capitalState: "OPERATING",
      capitalSupportingEvidence: [`Operating-suggesting keyword: "maintenance".`],
      nature: nature("UNKNOWN", false),
    });
    expect(r.expectedDebitRole).toBe("OPERATING_EXPENSE");
    expect(r.statementRole).toBe("OPERATING_EXPENSE");
    expect(r.defensibility).toBe("STRONG");
    expect(r.composedNatureLeader).toBe("OPERATING_EXPENSE");
    expect(r.composedNatureIsDefensible).toBe(true);
    expect(r.provenance.winningSource).toBe("capital_classifier_strong");
  });

  it("capital=OPERATING via base state (no keywords, below threshold) → WEAK, no forced defensibility", () => {
    const r = composeAccountingTreatment({
      capitalState: "OPERATING",
      capitalSupportingEvidence: ["Total $1499.35 is below the capitalisation threshold of $5000.00.", "No capital keywords detected."],
      nature: nature("UNKNOWN", false),
    });
    expect(r.expectedDebitRole).toBe("OPERATING_EXPENSE");
    expect(r.statementRole).toBe("OPERATING_EXPENSE");
    expect(r.defensibility).toBe("WEAK");
    // Founder §5: weak/base-state OPERATING must NOT propagate as
    // defensible nature — otherwise identical downstream contradiction
    // as strong verdicts.
    expect(r.composedNatureIsDefensible).toBe(false);
    expect(r.provenance.winningSource).toBe("capital_classifier_weak_operating");
  });
});

describe("Phase 7.2J-A · composeAccountingTreatment — priority 9: unresolved", () => {
  it("capital=AMBIGUOUS + no defensible nature → UNKNOWN, UNRESOLVED", () => {
    const r = composeAccountingTreatment({
      capitalState: "AMBIGUOUS",
      capitalSupportingEvidence: ["Amount over threshold.", "No capital keyword."],
      nature: nature("UNKNOWN", false),
    });
    expect(r.expectedDebitRole).toBe("UNKNOWN");
    expect(r.statementRole).toBe("UNKNOWN");
    expect(r.defensibility).toBe("UNRESOLVED");
    expect(r.composedNatureIsDefensible).toBe(false);
    expect(r.provenance.winningSource).toBe("capital_ambiguous_default");
  });

  it("capital=INSUFFICIENT_EVIDENCE → UNKNOWN, UNRESOLVED", () => {
    const r = composeAccountingTreatment({
      capitalState: "INSUFFICIENT_EVIDENCE",
      capitalSupportingEvidence: [],
      nature: nature("UNKNOWN", false),
    });
    expect(r.defensibility).toBe("UNRESOLVED");
    expect(r.composedNatureIsDefensible).toBe(false);
    expect(r.provenance.winningSource).toBe("default_unknown");
  });
});

describe("Phase 7.2J-A · composeAccountingTreatment — founder §12 mandatory controls", () => {
  it("§12 strong-operating-service — ASSET stays visible; operating nature is defensibly composed", () => {
    // Landscape maintenance service. Capital classifier says OPERATING
    // via "maintenance" keyword (strong). Nature classifier says
    // R&M defensible.
    const r = composeAccountingTreatment({
      capitalState: "OPERATING",
      capitalSupportingEvidence: [`Operating-suggesting keyword: "maintenance".`],
      nature: nature("REPAIR_AND_MAINTENANCE", true),
    });
    // Defensible R&M nature wins (priority 5 > capital strong OPERATING at 7).
    // Downstream ranker uses NATURE_INCOMPATIBLE_PENALTY (-18) on ASSET
    // candidates via the existing bounded mechanism — no new weight.
    expect(r.composedNatureLeader).toBe("REPAIR_AND_MAINTENANCE");
    expect(r.composedNatureIsDefensible).toBe(true);
    expect(r.defensibility).toBe("STRONG");
  });

  it("§12 strong-capital-acquisition — EXPENSE stays visible; capital nature is defensibly composed", () => {
    const r = composeAccountingTreatment({
      capitalState: "CAPITAL",
      capitalSupportingEvidence: ["Invoice total $199053.75 exceeds the capitalisation threshold.", `Capital-suggesting keyword: "acquisition".`],
      nature: nature("PROFESSIONAL_SERVICE", false), // weak
    });
    // Capital STRONG wins (priority 1). EXPENSE candidates like 6065
    // will receive NATURE_INCOMPATIBLE_PENALTY at the ranker but are
    // NOT removed from the candidate universe.
    expect(r.composedNatureLeader).toBe("CAPITAL_ASSET");
    expect(r.composedNatureIsDefensible).toBe(true);
    expect(r.expectedDebitRole).toBe("CAPITAL_ASSET");
  });

  it("§12 ambiguous-repair-vs-capital — both families remain competitive (UNRESOLVED)", () => {
    const r = composeAccountingTreatment({
      capitalState: "AMBIGUOUS",
      capitalSupportingEvidence: ["Amount over threshold.", "No capital keyword."],
      nature: nature("UNKNOWN", false),
    });
    expect(r.defensibility).toBe("UNRESOLVED");
    expect(r.composedNatureIsDefensible).toBe(false); // no forced penalty either direction
  });

  it("§12 inventory-acquisition — INVENTORY-defensible sets ASSET admission + INVENTORY nature", () => {
    const r = composeAccountingTreatment({
      capitalState: "OPERATING",
      capitalSupportingEvidence: [], // weak
      nature: nature("INVENTORY", true),
    });
    expect(r.expectedDebitRole).toBe("INVENTORY"); // widens ASSET admission
    expect(r.statementRole).toBe("BALANCE_SHEET_CURRENT_ASSET");
    expect(r.composedNatureLeader).toBe("INVENTORY");
  });

  it("§12 immediate-consumable-expense (no inventory defensibility) — falls back to weak operating; no ASSET admission widening", () => {
    // No nature commits (food-service invoice with beef/salmon that doesn't hit COST_OF_SALES lexicon).
    const r = composeAccountingTreatment({
      capitalState: "OPERATING",
      capitalSupportingEvidence: ["Total below threshold.", "No capital keywords detected."],
      nature: nature("UNKNOWN", false),
    });
    expect(r.expectedDebitRole).toBe("OPERATING_EXPENSE");
    expect(r.defensibility).toBe("WEAK");
    // Not defensibly composed → downstream ranker does NOT forcibly
    // penalise ASSET candidates. Correct: with weak evidence, the
    // ranker must decide from other signals.
    expect(r.composedNatureIsDefensible).toBe(false);
  });

  it("§12 prepaid-acquisition — PREPAID-defensible admits ASSET; statementRole = BALANCE_SHEET_CURRENT_ASSET", () => {
    const r = composeAccountingTreatment({
      capitalState: "OPERATING",
      capitalSupportingEvidence: [`Operating-suggesting keyword: "insurance premium".`],
      nature: nature("PREPAID_EXPENSE", true),
    });
    expect(r.expectedDebitRole).toBe("PREPAID_EXPENSE");
    expect(r.composedNatureLeader).toBe("PREPAID_EXPENSE");
  });

  it("§12 current-period expense (no prepaid defensibility) — expense candidate is not displaced by weak annual/service wording", () => {
    // "annual subscription" mentioned but not defensibly PREPAID.
    const r = composeAccountingTreatment({
      capitalState: "OPERATING",
      capitalSupportingEvidence: [`Operating-suggesting keyword: "subscription".`],
      nature: nature("UNKNOWN", false),
    });
    expect(r.expectedDebitRole).toBe("OPERATING_EXPENSE");
    expect(r.composedNatureLeader).toBe("OPERATING_EXPENSE");
    // ASSET (prepaid) accounts not automatically admitted just because
    // "annual" or "subscription" appears — need defensible PREPAID nature.
  });
});

describe("Phase 7.2J-A · composeAccountingTreatment — safety invariants", () => {
  it("no capital state ever produces UNKNOWN expectedDebitRole when a defensible nature is present", () => {
    for (const capState of ["CAPITAL", "OPERATING", "AMBIGUOUS", "INSUFFICIENT_EVIDENCE"] as const) {
      const r = composeAccountingTreatment({
        capitalState: capState as CapitalVsOperatingState,
        capitalSupportingEvidence: [],
        nature: nature("OPERATING_EXPENSE", true),
      });
      expect(r.expectedDebitRole).not.toBe("UNKNOWN");
    }
  });

  it("UNRESOLVED composition never claims composedNatureIsDefensible=true", () => {
    const r = composeAccountingTreatment({
      capitalState: "AMBIGUOUS",
      capitalSupportingEvidence: [],
      nature: nature("UNKNOWN", false),
    });
    expect(r.defensibility).toBe("UNRESOLVED");
    expect(r.composedNatureIsDefensible).toBe(false);
  });

  it("WEAK composition never claims composedNatureIsDefensible=true", () => {
    const r = composeAccountingTreatment({
      capitalState: "OPERATING",
      capitalSupportingEvidence: ["Total below threshold.", "No capital keywords detected."],
      nature: nature("UNKNOWN", false),
    });
    expect(r.defensibility).toBe("WEAK");
    expect(r.composedNatureIsDefensible).toBe(false);
  });
});
