// Phase 4R · Phase 7.2 (2026-08-13) — Capital-aware discovery.
//
// v206's `rankCapitalAwareAccounts` (accounting-nature-compatibility.ts)
// searched the WHOLE eligible COA for capital-appropriate accounts
// whenever the capital classifier committed. This is the single most
// important recovery for the Oakcreek 1091559 regression: pre-Phase-7,
// this authority discovered account 1506 for a novel-vendor capital
// equipment acquisition even when the purpose classifier had no
// concept for the asset category.
//
// In discover-only mode we DO NOT invoke the ranker — we mirror only
// the account-discovery portion: identify accounts whose semantics
// match the committed capital decision (ASSET vs REPAIR_MAINTENANCE
// vs OPERATING), and return their identities. Canonical ranking then
// evaluates whether ONE of them is the correct answer.
//
// No winner. No rank. No score. No status.

import type { CandidateDiscoveryInput, DiscoveryHit, DiscoveryProvider } from "..";

// Category / role tokens that identify an account as capital-asset
// oriented. Purely LEXICAL — the canonical ranker still has to prove
// the account is right; discovery only surfaces plausible candidates.
const CAPITAL_ASSET_CATEGORY_KEYS = new Set([
  "CAPITAL_ASSETS", "FIXED_ASSETS", "PPE", "PROPERTY_PLANT_EQUIPMENT",
  "LAND_AND_BUILDINGS", "MACHINERY_AND_EQUIPMENT", "VEHICLES",
]);
const CAPITAL_ASSET_ROLES = new Set([
  "CAPITAL_ASSET", "FIXED_ASSET", "PROPERTY_PLANT_EQUIPMENT",
]);
const CAPITAL_ASSET_FS_GROUPS = new Set([
  "BS_FIXED_ASSETS", "BS_PPE", "BS_LAND_BUILDINGS", "BS_MACHINERY",
  "BS_VEHICLES", "BS_CAPITAL_ASSETS",
]);
// Hard exclusions — accum-depreciation and other contra-asset accounts
// are NEVER discovered as capital candidates even though they are
// ASSET-type. Mirrors v206 nature-scoped-ranker.ts §8 rule + the
// safety floor established by the pre-refactor engine (0 unsafe on
// the sealed corpus).
const CONTRA_ASSET_NAME_PATTERNS = [
  /\baccum(?:ulated)?\.?\s*deprec/i,   // Accum Deprec, Accumulated Depreciation, Accum. Deprec
  /\bamortization\b/i,
  /depreciation\s*[-—]/i,               // "Depreciation - " / "Depreciation —"
  /allowance\s+for\s+doubtful/i,
  /contra[-\s]*asset/i,
];
function isContraAsset(name: string): boolean {
  for (const p of CONTRA_ASSET_NAME_PATTERNS) if (p.test(name)) return true;
  return false;
}
const RM_EXPENSE_NAME_HINTS = /\b(?:repair|maintenance|r\s*&\s*m|service|labor|labour)\b/i;
const RM_EXPENSE_CATEGORY_KEYS = new Set(["REPAIRS_MAINTENANCE", "R_AND_M"]);
const RM_EXPENSE_FS_GROUPS = new Set(["IS_REPAIRS_MAINTENANCE"]);

export const capitalAwareDiscovery: DiscoveryProvider = {
  kind: "capital_aware",
  *discover(input: CandidateDiscoveryInput): Iterable<DiscoveryHit> {
    const g = input.globalSignals;
    const decision = g.capitalDecision;
    const conf = g.capitalConfidence;
    // Commit floor mirrors v206 rankCapitalAwareAccounts default (40).
    if (!decision || decision === "UNRESOLVED" || conf < 40) return;
    for (const acct of input.eligibleAccounts) {
      if (decision === "CAPITAL_CANDIDATE") {
        // v206 §8 hard exclusion — contra-asset / accum-depreciation
        // accounts are NEVER discoverable as capital candidates.
        if (isContraAsset(acct.name)) continue;
        // Discover CAPITAL accounts via account-side taxonomy signals.
        // Phase 7.2 directive §12 forbids scoring changes, so this
        // provider must not rely on `acct.type === "ASSET"` (that
        // field is deliberately not propagated to AccountView — see
        // analyse.ts). Instead we walk category / fsGroup / role /
        // name to identify a capital-asset account. This is narrower
        // than v206's rankCapitalAwareAccounts (which used type),
        // but avoids the flooder pattern that surfaces inventory,
        // prepaid, and A/R accounts alongside true capital assets.
        const isAsset =
          (acct.categoryKey != null && CAPITAL_ASSET_CATEGORY_KEYS.has(acct.categoryKey))
          || (acct.accountRole != null && CAPITAL_ASSET_ROLES.has(acct.accountRole))
          || (acct.fsGroupKey != null && CAPITAL_ASSET_FS_GROUPS.has(acct.fsGroupKey))
          || /\b(?:equipment|fixtures?|machinery|vehicle|building|leasehold|improvement|land|hardware)\b/i.test(acct.name);
        if (isAsset) {
          yield {
            accountId: acct.id,
            accountNumber: acct.accountNumber,
            source: { kind: "capital_aware", decision, reason: "asset-type match" },
          };
        }
      } else if (decision === "REPAIR_MAINTENANCE") {
        // Discover EXPENSE R&M accounts by category / fsGroup / name.
        const isRm = acct.type === "EXPENSE"
          && ((acct.categoryKey != null && RM_EXPENSE_CATEGORY_KEYS.has(acct.categoryKey))
              || (acct.fsGroupKey != null && RM_EXPENSE_FS_GROUPS.has(acct.fsGroupKey))
              || RM_EXPENSE_NAME_HINTS.test(acct.name));
        if (isRm) {
          yield {
            accountId: acct.id,
            accountNumber: acct.accountNumber,
            source: { kind: "capital_aware", decision, reason: "R&M expense match" },
          };
        }
      }
      // OPERATING → do not narrow; general/semantic discovery handles it.
    }
  },
};
