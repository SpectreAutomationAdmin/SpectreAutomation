// Sprint 3 · Phase 4 Slice 5.6 (2026-08-09) — Source authority tiers.
//
// Founder §5: not all web evidence is equal. Explicit tiers:
//   TIER 1 AUTHORITATIVE — manufacturer / OEM / product / spec / manual
//   TIER 2 STRONG COMMERCIAL — authorised dealers, distributors
//   TIER 3 CORROBORATIVE — used-equipment marketplaces, auctions
//   TIER 4 WEAK / DISCOVERY — snippets, forums, unverified pages
//
// This module maps a source URL / domain to a tier via a closed list
// of pattern rules. Domains not in the list default to TIER_4. A
// TIER_4 evidence source may support but NEVER independently resolve
// product identity.

export type SourceTier = "TIER_1_OEM" | "TIER_2_DEALER" | "TIER_3_MARKETPLACE" | "TIER_4_DISCOVERY";

interface TierRule {
  pattern: RegExp;
  tier: SourceTier;
  reason: string;
}

// -----------------------------------------------------------------------------
// Tier rules — GENERIC domain-shape signals, no accounting-specific
// or supplier-specific literals. Extendable additively.
// -----------------------------------------------------------------------------

const TIER_RULES: TierRule[] = [
  // TIER 1 — manufacturer / OEM shape signals
  {
    pattern: /\/(?:products?|catalog(?:ue)?|specification|specs|manual|parts?|literature|product-details)(?:\/|$)/i,
    tier: "TIER_1_OEM",
    reason: "authoritative product / spec / manual path",
  },
  // Common OEM domain shapes: singular manufacturer domain (no
  // marketplace/reseller pattern in the host).
  {
    pattern: /^https?:\/\/(?:[a-z0-9-]+\.)?(?:oem\.|manufacturer\.|corp\.|corporate\.)?[a-z0-9-]+\.(?:com|net|co|io|us|ca|uk|de|jp|fr)(?::\d+)?\/(?:us|en|na|global)\/(?:products?|shop\/products?|catalog)/i,
    tier: "TIER_1_OEM",
    reason: "manufacturer product-catalog path",
  },
  // TIER 2 — authorised dealer shape
  {
    pattern: /\/(?:dealer|distributor|dealers|authorized|authorised)(?:\/|$)/i,
    tier: "TIER_2_DEALER",
    reason: "dealer / distributor context",
  },
  // TIER 3 — marketplace / auction shape
  {
    pattern: /(?:machinery-?trader|machinerytrader|equipmenttrader|iron-?planet|ironplanet|ritchiebros|purplewave|proxibid|govdeals|equipmentwatch|marketbook|auctiontime|hibid)\.com/i,
    tier: "TIER_3_MARKETPLACE",
    reason: "established equipment marketplace / auction",
  },
  {
    pattern: /(?:ebay\.com|craigslist\.org|kijiji\.ca|facebook\.com\/marketplace|marketplace\.facebook\.com)/i,
    tier: "TIER_3_MARKETPLACE",
    reason: "consumer marketplace",
  },
  // TIER 4 — discovery / weak (explicit patterns; anything else
  // also defaults to TIER 4)
  {
    pattern: /(?:reddit\.com|quora\.com|forums?\.|forum\.|discuss\.|community\.)/i,
    tier: "TIER_4_DISCOVERY",
    reason: "forum / discussion",
  },
  {
    pattern: /(?:wikipedia\.org|wiki\.)/i,
    tier: "TIER_4_DISCOVERY",
    reason: "wiki / encyclopaedic — general reference, not authoritative product source",
  },
];

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export interface SourceTierResult {
  tier: SourceTier;
  reason: string;
  matchedRule: string | null;
}

export function classifySourceTier(sourceUrl: string): SourceTierResult {
  const url = (sourceUrl ?? "").trim();
  if (url.length === 0) {
    return { tier: "TIER_4_DISCOVERY", reason: "empty url", matchedRule: null };
  }
  for (const rule of TIER_RULES) {
    if (rule.pattern.test(url)) {
      return { tier: rule.tier, reason: rule.reason, matchedRule: rule.pattern.source };
    }
  }
  // Domains that match a manufacturer-like shape (no marketplace
  // hallmarks in host, product-relevant path) are still classified
  // TIER_2 by default rather than TIER_4 — this gives dealer /
  // distributor pages the corroborative weight the founder's §5
  // hierarchy grants them. But the caller SHOULD confirm the domain
  // in evidence-fusion when relying on Tier 2 for authority.
  return {
    tier: "TIER_4_DISCOVERY",
    reason: "domain not in known-authority list — defaults to discovery/weak",
    matchedRule: null,
  };
}

/** Independence check (§9): two source URLs are INDEPENDENT if they
 *  have different eTLD+1 (roughly) hosts. Five pages on the same
 *  domain count as ONE source. */
export function areIndependentSources(a: string, b: string): boolean {
  const hostA = extractHost(a);
  const hostB = extractHost(b);
  if (!hostA || !hostB) return false;
  return effectiveDomain(hostA) !== effectiveDomain(hostB);
}

function extractHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function effectiveDomain(host: string): string {
  // Rough eTLD+1 — strip leading subdomains except when the total
  // label count is 2 or fewer. Not a full PSL parse but sufficient
  // to catch "www.x.com" vs "shop.x.com" collapsing to "x.com".
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  return parts.slice(-2).join(".");
}
