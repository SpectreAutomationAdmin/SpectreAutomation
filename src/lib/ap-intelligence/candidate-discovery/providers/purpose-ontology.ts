// Phase 4R · Phase 7.2 (2026-08-13) — Purpose-ontology discovery.
//
// Mirrors v206's `rankPurposeDrivenAccounts` — when the economic
// purpose is committed, the account taxonomy already knows which
// account CATEGORIES that purpose lives in. Discover any eligible
// account matching a category hint for the committed purpose.
//
// Discover-only. No score, no winner. Canonical ranking picks the
// best of the discovered candidates.

import type { CandidateDiscoveryInput, DiscoveryHit, DiscoveryProvider } from "..";

// Category hints per canonical purpose concept — closed list, mirrors
// PURPOSE_CATEGORY_HINTS in purpose-driven-ranker.ts.
const PURPOSE_CATEGORY_HINTS: Record<string, ReadonlyArray<string>> = {
  FUEL: ["REPAIRS_MAINTENANCE", "COST_OF_SALES"],
  LUBRICANTS: ["REPAIRS_MAINTENANCE"],
  EQUIPMENT_PARTS: ["REPAIRS_MAINTENANCE", "OTHER_EXPENSES"],
  REPAIR_MAINTENANCE: ["REPAIRS_MAINTENANCE"],
  CAPITAL_EQUIPMENT: ["CAPITAL_ASSETS", "FIXED_ASSETS"],
  TELECOMMUNICATIONS: ["ADMIN_EXPENSES", "UTILITIES"],
  INTERNET_CONNECTIVITY: ["ADMIN_EXPENSES", "UTILITIES"],
  SOFTWARE_SUBSCRIPTION: ["ADMIN_EXPENSES"],
  CYBERSECURITY_SERVICE: ["ADMIN_EXPENSES"],
  PROFESSIONAL_MEMBERSHIP: ["ADMIN_EXPENSES"],
  PROFESSIONAL_SERVICES: ["PROFESSIONAL_SERVICES", "ADMIN_EXPENSES"],
  BUILDING_MAINTENANCE: ["REPAIRS_MAINTENANCE", "UTILITIES"],
  COURSE_MAINTENANCE: ["OTHER_EXPENSES"],
  OFFICE_SUPPLIES: ["ADMIN_EXPENSES"],
  INTEREST: ["OTHER_EXPENSES", "FINANCE_EXPENSE"],
  PENALTY: ["OTHER_EXPENSES"],
  FOOD: ["COST_OF_SALES", "F&B_EXPENSES"],
  BEVERAGE: ["COST_OF_SALES", "F&B_EXPENSES"],
  FREIGHT_DELIVERY: ["OTHER_EXPENSES", "COST_OF_SALES"],
  EQUIPMENT: ["REPAIRS_MAINTENANCE", "CAPITAL_ASSETS"],
};

// Purpose → acceptable account type (mirrors PURPOSE_ACCOUNT_TYPE in
// purpose-driven-ranker.ts). Discovery includes accounts of ANY
// acceptable type — narrowing to the correct one is canonical
// ranking's job.
const PURPOSE_ACCOUNT_TYPE: Record<string, ReadonlyArray<string>> = {
  FUEL: ["EXPENSE"],
  LUBRICANTS: ["EXPENSE"],
  EQUIPMENT: ["ASSET", "EXPENSE"],
  EQUIPMENT_PARTS: ["EXPENSE"],
  REPAIR_MAINTENANCE: ["EXPENSE"],
  CAPITAL_EQUIPMENT: ["ASSET"],
  TELECOMMUNICATIONS: ["EXPENSE"],
  INTERNET_CONNECTIVITY: ["EXPENSE"],
  SOFTWARE_SUBSCRIPTION: ["EXPENSE", "ASSET"],
  CYBERSECURITY_SERVICE: ["EXPENSE"],
  PROFESSIONAL_MEMBERSHIP: ["EXPENSE"],
  PROFESSIONAL_SERVICES: ["EXPENSE"],
  FOOD: ["EXPENSE"],
  BEVERAGE: ["EXPENSE"],
  FREIGHT_DELIVERY: ["EXPENSE"],
  BUILDING_MAINTENANCE: ["EXPENSE"],
  COURSE_MAINTENANCE: ["EXPENSE"],
  OFFICE_SUPPLIES: ["EXPENSE"],
  INTEREST: ["EXPENSE"],
  PENALTY: ["EXPENSE"],
};

export const purposeOntologyDiscovery: DiscoveryProvider = {
  kind: "purpose_ontology",
  *discover(input: CandidateDiscoveryInput): Iterable<DiscoveryHit> {
    // We source the purpose concept from the cluster concept id (Phase
    // 7.1 already threads a canonical purpose into cluster identity
    // when committed). We ALSO honor global capitalDecision as an
    // implicit purpose hint (CAPITAL_CANDIDATE → CAPITAL_EQUIPMENT
    // category hints; REPAIR_MAINTENANCE → same category hints).
    const g = input.globalSignals;
    const conceptCandidates: string[] = [];
    if (input.clusterConceptId) conceptCandidates.push(input.clusterConceptId.toUpperCase());
    if (g.capitalDecision === "CAPITAL_CANDIDATE") conceptCandidates.push("CAPITAL_EQUIPMENT");
    if (g.capitalDecision === "REPAIR_MAINTENANCE") conceptCandidates.push("REPAIR_MAINTENANCE");

    const categories = new Set<string>();
    const acceptableTypes = new Set<string>();
    for (const c of conceptCandidates) {
      for (const cat of PURPOSE_CATEGORY_HINTS[c] ?? []) categories.add(cat);
      for (const t of PURPOSE_ACCOUNT_TYPE[c] ?? []) acceptableTypes.add(t);
    }
    if (categories.size === 0 && acceptableTypes.size === 0) return;

    for (const acct of input.eligibleAccounts) {
      const catHit = acct.categoryKey != null && categories.has(acct.categoryKey);
      const typeHit = acct.type != null && acceptableTypes.has(acct.type);
      if (catHit || typeHit) {
        yield {
          accountId: acct.id,
          accountNumber: acct.accountNumber,
          source: {
            kind: "purpose_ontology",
            concept: conceptCandidates.join(","),
            reason: catHit ? `category-hint match (${acct.categoryKey})` : `acceptable-type match (${acct.type})`,
          },
        };
      }
    }
  },
};
