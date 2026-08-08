// Sprint 3 · Phase 4 Slice 5.2 (2026-08-08) — economic purpose
// → GL account name-substring ontology.
//
// Founder amendment #2 (approved as WEAK SIGNAL):
//   Approve concept→GL mapping ONLY as a weak ontology/ranking
//   signal, NOT a direct account selector. Strings such as
//   FUEL → fuel/diesel or EQUIPMENT_PARTS → parts/R&M may help
//   RANK the full eligible tenant COA, but must NOT become the
//   new dominant keyword engine. Broad terms such as "supplies"
//   must not indiscriminately boost unrelated departmental
//   accounts. Final ranking must still incorporate purpose,
//   account metadata, department evidence, eligibility and other
//   defensible signals.
//
// Consequently:
//   - Every substring here MUST be discriminative (a substring
//     match on a random tenant account name should almost always
//     indicate a real accounting affinity, not just co-occurrence
//     of a common word).
//   - Broad terms are DELIBERATELY OMITTED — no bare "supplies",
//     no bare "expense", no bare "account".
//   - The ranker treats these as a small additive boost (weight
//     ~8), comparable to a weak legacy signal.
//   - The ontology never substitutes for eligibility, department,
//     or nature compatibility.

import type { EconomicPurposeConcept } from "./economic-purpose-taxonomy";

/** Bounded per-concept discriminative name-substrings. */
const PURPOSE_ACCOUNT_NAME_SUBSTRINGS: Partial<Record<EconomicPurposeConcept, ReadonlyArray<string>>> = {
  FUEL: [
    "fuel", "diesel", "gasoline", "petroleum",
  ],
  LUBRICANTS: [
    "lubricant", "grease", "hydraulic oil", "engine oil", "motor oil",
  ],
  EQUIPMENT_PARTS: [
    "equipment parts", "r & m", "r&m", "repair and maintenance",
    "repair & maintenance", "maintenance parts",
  ],
  REPAIR_MAINTENANCE: [
    "r & m", "r&m", "repair", "maintenance",
  ],
  CAPITAL_EQUIPMENT: [
    "equipment", "vehicle",
  ],
  TELECOMMUNICATIONS: [
    "telephone", "telecom", "communications",
  ],
  INTERNET_CONNECTIVITY: [
    "internet", "connectivity", "telephone", "telecom",
  ],
  SOFTWARE_SUBSCRIPTION: [
    "software", "subscription", "saas",
  ],
  PROFESSIONAL_MEMBERSHIP: [
    "membership", "dues", "professional dues",
  ],
  PROFESSIONAL_SERVICES: [
    "professional services", "consulting", "audit", "accounting fees",
    "legal", "advisory",
  ],
  FOOD: [
    "food", "kitchen", "produce", "meat", "dairy",
  ],
  BEVERAGE: [
    "beverage", "beer", "wine", "liquor", "spirits",
  ],
  FREIGHT_DELIVERY: [
    "freight", "shipping", "delivery", "courier",
  ],
  BUILDING_MAINTENANCE: [
    "building maintenance", "clubhouse maintenance", "janitorial",
    "cleaning services",
  ],
  COURSE_MAINTENANCE: [
    "course maintenance", "grounds maintenance", "turf", "fertilizer",
    "irrigation", "sod",
  ],
  OFFICE_SUPPLIES: [
    "office supplies", "stationery", "toner",
  ],
  INTEREST: [
    "interest expense", "finance charge",
  ],
  PENALTY: [
    "penalty", "late fee",
  ],
};

// -----------------------------------------------------------------------------
// Boost weight
// -----------------------------------------------------------------------------

/** The ONE boost this ontology contributes to an account's score.
 *  Deliberately modest — comparable to a weak legacy support signal
 *  (5-8 points). NEVER dominant. */
export const PURPOSE_ONTOLOGY_BOOST = 8;

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export interface PurposeOntologyMatch {
  concept: EconomicPurposeConcept;
  matchedSubstring: string;
  boost: number;
}

/** Return a modest boost when the account name contains a
 *  discriminative substring for the given committed purpose concept.
 *  Returns null when there's no match — the ranker adds no signal. */
export function evaluatePurposeAccountAffinity(
  concept: EconomicPurposeConcept | null,
  accountName: string | null,
): PurposeOntologyMatch | null {
  if (!concept || !accountName) return null;
  const subs = PURPOSE_ACCOUNT_NAME_SUBSTRINGS[concept];
  if (!subs) return null;
  const name = accountName.toLowerCase();
  for (const s of subs) {
    if (name.includes(s)) {
      return { concept, matchedSubstring: s, boost: PURPOSE_ONTOLOGY_BOOST };
    }
  }
  return null;
}

/** Bulk evaluation — used by the ranker to attach a diagnostic to
 *  each candidate account. */
export function evaluateOntologyForAccounts<T extends { accountName?: string | null }>(
  concept: EconomicPurposeConcept | null,
  accounts: T[],
): Array<{ account: T; match: PurposeOntologyMatch | null }> {
  return accounts.map((a) => ({
    account: a,
    match: evaluatePurposeAccountAffinity(concept, a.accountName ?? null),
  }));
}
