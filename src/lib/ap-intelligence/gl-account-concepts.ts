// Sprint 3 · Checkpoint 15U (2026-07-28) — extract accounting
// concepts from a tenant Account row.
//
// For each account we produce a list of AccountConceptMatch:
// concept id + how strongly the account name / FS group / category
// matches that concept + how the match was made. This is the
// account-side half of the ranker's evidence comparison.
//
// Every account gets at least one concept match (worst case: an
// unknown-shape account produces a single low-strength "no known
// concept" placeholder). No account is invisible to the ranker.

import { ACCOUNTING_CONCEPTS, type AccountingConcept } from "./gl-concepts";
import { matchStrongestPhrase, tokenOverlap } from "./gl-similarity";

export interface AccountView {
  id: string;
  accountNumber: string;
  name: string;
  categoryKey: string | null;
  categoryName: string | null;
  fsGroupKey: string | null;
  fsGroupName: string | null;
}

export interface AccountConceptMatch {
  conceptId: string;
  concept: AccountingConcept;
  nameMatchStrength: number;      // 0..100 — synonym match on the account NAME
  fsGroupMatchStrength: number;   // 0..100 — canonical FS-group key hint match
  categoryMatchStrength: number;  // 0..100 — canonical category key hint match
  taxonomyTokenOverlap: number;   // 0..100 — Jaccard overlap of tokens across name + fsGroup + category
  totalMatchStrength: number;     // 0..100 — combined
  nameMatchKind: string | null;
}

export function extractConceptsForAccount(a: AccountView): AccountConceptMatch[] {
  const out: AccountConceptMatch[] = [];
  const combinedTaxonomy = [a.name, a.fsGroupName, a.categoryName]
    .filter((s): s is string => !!s)
    .join(" ");

  for (const concept of ACCOUNTING_CONCEPTS) {
    const nameHit = matchStrongestPhrase(a.name, concept.synonyms, { minStrength: 40 });
    const fsHit = concept.fsGroupKeyHints.length > 0 && a.fsGroupKey && concept.fsGroupKeyHints.includes(a.fsGroupKey);
    const catHit = concept.categoryKeyHints.length > 0 && a.categoryKey && concept.categoryKeyHints.includes(a.categoryKey);

    const nameMatchStrength = nameHit?.strength ?? 0;
    const fsGroupMatchStrength = fsHit ? 100 : 0;
    const categoryMatchStrength = catHit ? 100 : 0;

    // Coarse token-overlap similarity between the account taxonomy
    // (name + fsGroup + category) and the concept's canonical name.
    const overlap = tokenOverlap(combinedTaxonomy, concept.canonicalName);

    // Combined — a name match is strongest, then FS group, then
    // category, then coarse overlap.
    const total =
      Math.max(nameMatchStrength, fsGroupMatchStrength * 0.9, categoryMatchStrength * 0.75, overlap * 0.6);

    if (total < 30) continue;   // only surface meaningful matches

    out.push({
      conceptId: concept.id,
      concept,
      nameMatchStrength,
      fsGroupMatchStrength,
      categoryMatchStrength,
      taxonomyTokenOverlap: Math.round(overlap),
      totalMatchStrength: Math.round(total),
      nameMatchKind: nameHit?.kind ?? null,
    });
  }

  // Deterministic order — strongest first, ties broken by concept id.
  out.sort((x, y) => {
    if (y.totalMatchStrength !== x.totalMatchStrength) return y.totalMatchStrength - x.totalMatchStrength;
    if (y.nameMatchStrength !== x.nameMatchStrength) return y.nameMatchStrength - x.nameMatchStrength;
    return x.conceptId.localeCompare(y.conceptId);
  });

  return out;
}
