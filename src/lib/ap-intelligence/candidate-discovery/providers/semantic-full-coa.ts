// Phase 4R · Phase 7.2 (2026-08-13) — Semantic full-COA discovery.
//
// v206's base ranker (recommendGlAccount) scored EVERY eligible
// account against line-item text via account-name similarity +
// concept synonym matches. That gave the founder's original engine
// the ability to find, for example, "Bank Charges" for a payment-
// processor fee even when no purpose concept had committed.
//
// This mirror is discover-only: it walks every account in the
// eligible pool, matches account name / category / fsGroup / concept
// synonyms against cluster line-item descriptions, and yields
// accounts with any lexical hit. Threshold is deliberately lax —
// discovery is meant to be OVER-inclusive; canonical ranking rejects
// noise.

import type { CandidateDiscoveryInput, DiscoveryHit, DiscoveryProvider } from "..";
import { extractConceptsForAccount } from "../../gl-account-concepts";

function tokenize(s: string): string[] {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s&+/-]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

export const semanticFullCoaDiscovery: DiscoveryProvider = {
  kind: "semantic_full_coa",
  *discover(input: CandidateDiscoveryInput): Iterable<DiscoveryHit> {
    // Build a bag of tokens from all cluster line-item descriptions.
    const lineTokens = new Set<string>();
    for (const desc of input.clusterLineDescriptions) {
      for (const t of tokenize(desc)) lineTokens.add(t);
    }
    if (lineTokens.size === 0) return;

    for (const acct of input.eligibleAccounts) {
      // 1. Account-name token overlap — one shared 3+ char token is
      //    enough to include (canonical ranker scores strength).
      const nameTokens = new Set(tokenize(acct.name));
      let nameOverlap = false;
      for (const t of nameTokens) if (lineTokens.has(t)) { nameOverlap = true; break; }
      // 2. Category / fsGroup token overlap.
      let catOverlap = false;
      if (!nameOverlap) {
        const catTokens = new Set([
          ...tokenize(acct.categoryKey ?? ""),
          ...tokenize(acct.categoryName ?? ""),
          ...tokenize(acct.fsGroupKey ?? ""),
          ...tokenize(acct.fsGroupName ?? ""),
        ]);
        for (const t of catTokens) if (lineTokens.has(t)) { catOverlap = true; break; }
      }
      // 3. Concept-synonym match — walks the concept catalog for
      //    account-side taxonomy hits, then intersects with line
      //    tokens. Uses extractConceptsForAccount so it stays in sync
      //    with the concept vocabulary the ranker already trusts.
      let conceptHit = false;
      if (!nameOverlap && !catOverlap) {
        const concepts = extractConceptsForAccount(acct);
        outer: for (const c of concepts) {
          if (c.totalMatchStrength < 40) continue;
          for (const synonym of c.concept.synonyms) {
            const synTokens = tokenize(synonym);
            for (const t of synTokens) if (lineTokens.has(t)) { conceptHit = true; break outer; }
          }
        }
      }
      if (nameOverlap || catOverlap || conceptHit) {
        yield {
          accountId: acct.id,
          accountNumber: acct.accountNumber,
          source: {
            kind: "semantic_full_coa",
            reason: nameOverlap ? "account-name overlap" : catOverlap ? "taxonomy overlap" : "concept-synonym overlap",
          },
        };
      }
    }
  },
};
