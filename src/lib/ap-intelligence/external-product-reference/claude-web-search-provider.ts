// Sprint 3 · Phase 4 Slice 5.6 (2026-08-09) — ClaudeWebSearch
// ProductReferenceProvider.
//
// Concrete provider that uses Anthropic's messages API with the
// `web_search_20250305` tool to answer bounded product-identity
// questions. Advantages per §3 + §6:
//   • Anthropic performs the search — bounded, no arbitrary browsing;
//   • Results arrive as structured tool_use blocks with source URLs
//     (§25 auditability);
//   • Uses the existing @anthropic-ai/sdk dependency via optional
//     import — no new HTTP client.
//
// The provider constructs candidate-specific questions (§9-§10) so
// competing hypotheses are tested explicitly, then returns structured
// ExternalProductEvidence keyed to the Anthropic-cited source URLs.
//
// Founder §1 invariant: this provider NEVER asks accounting questions.
// Prompts are deliberately about "what is this product" only.

import { optionalImport } from "../../integrations/optional-import";
import {
  fingerprintProductRequest,
  type ProductReferenceProvider,
  type ProductReferenceRequest,
  type ProductReferenceResult,
  type ProductReferenceEvidence,
  type ProductPriceObservation,
} from "../product-reference-provider";
import { classifySourceTier } from "./source-tier";
import { sanitizeProductReferenceRequest } from "./query-sanitizer";
import {
  DEFAULT_RATE_LIMIT,
  circuitBreakerAllowed,
  circuitBreakerRecordFailure,
  circuitBreakerRecordSuccess,
  type RateLimitConfig,
} from "./rate-limiter";

// -----------------------------------------------------------------------------
// Provider config
// -----------------------------------------------------------------------------

export interface ClaudeWebSearchProviderConfig {
  apiKey: string;
  model?: string;
  rateLimit?: RateLimitConfig;
  /** Provider name used in logs + circuit-breaker keying. */
  providerName?: string;
}

// -----------------------------------------------------------------------------
// Provider
// -----------------------------------------------------------------------------

export class ClaudeWebSearchProductReferenceProvider implements ProductReferenceProvider {
  private readonly config: ClaudeWebSearchProviderConfig;

  constructor(config: ClaudeWebSearchProviderConfig) {
    this.config = {
      model: "claude-sonnet-4-5",   // current-family default; override via PRODUCT_REFERENCE_MODEL env var
      providerName: "claude-web-search",
      rateLimit: DEFAULT_RATE_LIMIT,
      ...config,
    };
  }

  async resolve(rawRequest: ProductReferenceRequest): Promise<ProductReferenceResult> {
    const providerName = this.config.providerName!;
    const rateLimit = this.config.rateLimit!;

    // Circuit breaker first — refuse the call if provider has been
    // failing.
    const breaker = circuitBreakerAllowed(providerName, rateLimit);
    if (!breaker.allowed) {
      return {
        state: "PROVIDER_UNAVAILABLE",
        callCount: 0, products: [], prices: [],
        diagnostic: `provider=${providerName} circuit_breaker: ${breaker.reason ?? "open"}`,
      };
    }

    // Sanitize (§4). Even though the caller-side ProductReferenceRequest
    // is already privacy-typed, this is the last defence.
    const sanitized = sanitizeProductReferenceRequest(rawRequest);

    if (
      sanitized.request.brandCandidates.length === 0
      && sanitized.request.modelCandidates.length === 0
      && sanitized.request.skuCandidates.length === 0
    ) {
      return {
        state: "NO_RESULTS",
        callCount: 0, products: [], prices: [],
        diagnostic: `provider=${providerName} sanitizer removed all identity candidates: ${sanitized.rejectionReasons.join("|")}`,
      };
    }

    const fingerprint = fingerprintProductRequest(sanitized.request);

    // Load SDK (optional import — provider degrades to
    // PROVIDER_UNAVAILABLE when the sdk is missing).
    const mod = await optionalImport("@anthropic-ai/sdk");
    if (!mod) {
      return {
        state: "PROVIDER_UNAVAILABLE",
        callCount: 0, products: [], prices: [],
        diagnostic: `provider=${providerName} @anthropic-ai/sdk not available`,
      };
    }
    const Anthropic = mod.default ?? mod.Anthropic;
    const client = new Anthropic({ apiKey: this.config.apiKey });

    // Build the bounded question. §4: use ONLY sanitized product-
    // identity fields. §9-§10: test competing hypotheses inside the
    // prompt so Claude explores both interpretations rather than
    // confirming the leading one.
    const query = this.buildQuery(sanitized.request);

    let callCount = 0;
    const started = Date.now();
    const products: ProductReferenceEvidence[] = [];
    const prices: ProductPriceObservation[] = [];
    let state: ProductReferenceResult["state"] = "NO_RESULTS";
    let providerDiagnostic = "";

    try {
      // Single bounded call. §18: perRequestMaxQueries defaults to 3
      // but the Anthropic web_search_20250305 tool internally issues
      // multiple searches. We surface this as one "call" to the
      // rate-limiter — Anthropic controls the inner query budget via
      // max_uses.
      callCount = 1;
      const response = await withTimeout(
        client.messages.create({
          model: this.config.model!,
          max_tokens: 1500,
          system: SYSTEM_PROMPT,
          tools: [{
            type: "web_search_20250305",
            name: "web_search",
            max_uses: rateLimit.perRequestMaxQueries,
          }],
          messages: [{ role: "user", content: query }],
        }),
        rateLimit.wholeJobTimeoutMs,
      );

      const parsed = parseClaudeResponse(response, fingerprint);
      for (const p of parsed.products) products.push(p);
      for (const p of parsed.prices) prices.push(p);
      providerDiagnostic = parsed.diagnostic;

      if (products.length === 0 && prices.length === 0) {
        state = "NO_RESULTS";
      } else if (parsed.hasConflicts) {
        state = "CONFLICTING_RESULTS";
      } else if (parsed.hasOnlyLowQuality) {
        state = "LOW_QUALITY_RESULTS";
      } else if (parsed.products.length > 0) {
        state = "RESOLVED";
      } else {
        state = "PARTIAL";
      }
      circuitBreakerRecordSuccess(providerName);
    } catch (err) {
      circuitBreakerRecordFailure(providerName, rateLimit);
      const msg = err instanceof Error ? err.message : String(err);
      state = /timeout/i.test(msg) ? "TIMEOUT" : "PROVIDER_UNAVAILABLE";
      providerDiagnostic = `provider=${providerName} error: ${msg}`;
    }

    const elapsedMs = Date.now() - started;
    return {
      state,
      callCount,
      products,
      prices,
      diagnostic: `provider=${providerName} model=${this.config.model} fingerprint=${fingerprint} elapsed=${elapsedMs}ms ${providerDiagnostic}`,
    };
  }

  // -------------------------------------------------------------------------
  // Query construction (§4 + §9 + §10)
  // -------------------------------------------------------------------------

  private buildQuery(req: ProductReferenceRequest): string {
    const brand = req.brandCandidates.slice(0, 3).join(", ");
    const model = req.modelCandidates.slice(0, 3).join(", ");
    const sku = req.skuCandidates.slice(0, 3).join(", ");

    return [
      "I need to identify what kind of product the following manufacturer + model + SKU represents.",
      "",
      brand ? `Manufacturer candidate(s): ${brand}` : "",
      model ? `Model candidate(s): ${model}` : "",
      sku ? `SKU / product-code candidate(s): ${sku}` : "",
      req.descriptionExcerpt ? `Short description context: ${req.descriptionExcerpt}` : "",
      "",
      "Please use web search to establish the product's identity. Test these competing hypotheses:",
      "  (A) A complete machine / standalone equipment unit.",
      "  (B) A replacement engine, transmission, or major assembly for another machine.",
      "  (C) A small component or repair part.",
      "  (D) A consumable (fuel / chemical / oil / etc.).",
      "  (E) A service (labour / installation / inspection).",
      "",
      "If the description names two manufacturers (e.g. 'Brand-A ModelX Brand-B ENGINE'), determine",
      "whether Brand-B is a component installed in a Brand-A complete machine — this is a common",
      "pattern where an OEM builds a machine using another manufacturer's engine.",
      "",
      "If price ranges are relevant to distinguishing hypotheses, report typical new-OEM and used-marketplace",
      "ranges with source citations. Do NOT ask about accounting, capitalisation, or tenant policy.",
      "",
      "Reply with a compact structured JSON payload at the END of your response, inside a fenced code block",
      "labelled ```product-evidence — the following shape (omit fields you cannot support):",
      "",
      "{",
      '  "hypothesis": "COMPLETE_MACHINE"|"REPLACEMENT_ENGINE"|"REPLACEMENT_COMPONENT"|"CONSUMABLE"|"SERVICE"|"UNKNOWN",',
      '  "hypothesisConfidence": 0-100,',
      '  "manufacturer": string | null,',
      '  "model": string | null,',
      '  "productFamily": string | null,',
      '  "componentRelationship": { "componentBrand": string, "installedInBrand": string, "installedInModel": string } | null,',
      '  "priceRanges": [ { "priceType": "OEM_LIST"|"DEALER_NEW"|"USED"|"AUCTION"|"PART", "low": number, "high": number, "currency": "USD"|"CAD"|"EUR"|"GBP", "sourceUrl": string } ],',
      '  "contradictions": [ string ]',
      "}",
      "",
      "Only cite sources that are manufacturer / OEM pages, authorised dealers, or established equipment marketplaces.",
      "If you cannot find authoritative evidence, set hypothesis to UNKNOWN.",
    ].filter(Boolean).join("\n");
  }
}

// -----------------------------------------------------------------------------
// System prompt — enforces the §1 boundary structurally
// -----------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  "You are a bounded product-identification research assistant.",
  "You ONLY answer 'what is this product?' questions.",
  "You NEVER answer accounting questions.",
  "You NEVER recommend a GL account.",
  "You NEVER decide whether a purchase should be capitalised.",
  "You NEVER speculate about which department should own the purchase.",
  "You never expose the identity of the requesting tenant, member, or invoice.",
  "You only cite authoritative sources (manufacturer / OEM / authorised dealer / established equipment marketplace).",
  "When the evidence is weak or inconclusive, honestly report UNKNOWN.",
].join("\n");

// -----------------------------------------------------------------------------
// Response parsing
// -----------------------------------------------------------------------------

interface ParsedResponse {
  products: ProductReferenceEvidence[];
  prices: ProductPriceObservation[];
  hasConflicts: boolean;
  hasOnlyLowQuality: boolean;
  diagnostic: string;
}

function parseClaudeResponse(response: unknown, queryFingerprint: string): ParsedResponse {
  const products: ProductReferenceEvidence[] = [];
  const prices: ProductPriceObservation[] = [];
  const now = new Date().toISOString();

  const r = response as {
    content?: Array<{ type?: string; text?: string; source?: { url?: string; title?: string } }>;
  };
  const contentBlocks = r.content ?? [];

  // Collect cited source URLs from the tool_use / tool_result blocks
  // so we can attribute individual evidence facts. Each search result
  // Anthropic returns arrives as a block with source info.
  const citedSources: Array<{ url: string; title: string; tier: ReturnType<typeof classifySourceTier> }> = [];
  for (const block of contentBlocks) {
    const src = (block as { source?: { url?: string; title?: string } }).source;
    if (src?.url) {
      citedSources.push({
        url: src.url,
        title: src.title ?? "",
        tier: classifySourceTier(src.url),
      });
    }
  }

  // Concatenate assistant text blocks and extract the trailing
  // JSON payload from the ```product-evidence fenced block.
  const textAll = contentBlocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");

  const fenceMatch = textAll.match(/```product-evidence\s*\n?([\s\S]*?)```/);
  let parsedFact: {
    hypothesis?: string;
    hypothesisConfidence?: number;
    manufacturer?: string | null;
    model?: string | null;
    productFamily?: string | null;
    componentRelationship?: { componentBrand?: string; installedInBrand?: string; installedInModel?: string } | null;
    priceRanges?: Array<{ priceType?: string; low?: number; high?: number; currency?: string; sourceUrl?: string }>;
    contradictions?: string[];
  } | null = null;
  if (fenceMatch) {
    try {
      parsedFact = JSON.parse(fenceMatch[1].trim());
    } catch {
      parsedFact = null;
    }
  }

  if (!parsedFact) {
    return {
      products: [], prices: [],
      hasConflicts: false, hasOnlyLowQuality: citedSources.every((s) => s.tier.tier === "TIER_4_DISCOVERY"),
      diagnostic: `no structured product-evidence block; text_len=${textAll.length} cited_sources=${citedSources.length}`,
    };
  }

  const hypothesisToObjectType = (h?: string): string => {
    switch ((h ?? "").toUpperCase()) {
      case "COMPLETE_MACHINE": return "COMPLETE_MACHINE";
      case "REPLACEMENT_ENGINE": return "REPLACEMENT_ENGINE";
      case "REPLACEMENT_COMPONENT": return "COMPONENT";
      case "CONSUMABLE": return "CONSUMABLE";
      case "SERVICE": return "SERVICE";
      default: return "UNKNOWN";
    }
  };

  // Emit one ProductReferenceEvidence per cited source, all tied
  // together by the queryFingerprint.
  const highestTier = citedSources.length > 0
    ? citedSources.reduce((best, s) => tierOrder(s.tier.tier) < tierOrder(best) ? s.tier.tier : best, "TIER_4_DISCOVERY" as ReturnType<typeof classifySourceTier>["tier"])
    : "TIER_4_DISCOVERY";
  const evidenceType = mapEvidenceType(highestTier);

  for (const src of citedSources) {
    products.push({
      evidenceType,
      sourceDomain: safeHost(src.url),
      sourceTitle: src.title || null,
      retrievedAt: now,
      queryFingerprint,
      matchedManufacturer: parsedFact.manufacturer ?? null,
      matchedModel: parsedFact.model ?? null,
      matchedPartNumber: null,
      matchedProductFamily: parsedFact.productFamily ?? null,
      observedPrice: null,
      currency: null,
      confidence: parsedFact.hypothesisConfidence ?? 0,
      evidenceSnippet: `${src.tier.tier}: hypothesis=${hypothesisToObjectType(parsedFact.hypothesis)} confidence=${parsedFact.hypothesisConfidence ?? 0}${parsedFact.componentRelationship ? ` component=${parsedFact.componentRelationship.componentBrand} in=${parsedFact.componentRelationship.installedInBrand}` : ""}`,
    });
  }

  // If Claude answered UNKNOWN, emit nothing — do not fabricate.
  if ((parsedFact.hypothesis ?? "").toUpperCase() === "UNKNOWN" && products.length === 0) {
    return { products: [], prices: [], hasConflicts: false, hasOnlyLowQuality: false, diagnostic: "provider returned UNKNOWN" };
  }

  // Price observations — one per priceRange with authoritative source.
  for (const pr of parsedFact.priceRanges ?? []) {
    if (typeof pr.low !== "number" || typeof pr.high !== "number") continue;
    const midpoint = (pr.low + pr.high) / 2;
    const tier = pr.sourceUrl ? classifySourceTier(pr.sourceUrl) : { tier: "TIER_4_DISCOVERY", reason: "no url", matchedRule: null };
    prices.push({
      sourceDomain: pr.sourceUrl ? safeHost(pr.sourceUrl) : null,
      sourceTitle: null,
      retrievedAt: now,
      matchedManufacturer: parsedFact.manufacturer ?? null,
      matchedModel: parsedFact.model ?? null,
      observedPrice: midpoint,
      currency: pr.currency ?? null,
      observedAt: now,
      isNew: pr.priceType === "OEM_LIST" || pr.priceType === "DEALER_NEW",
      modelYear: null,
      isTaxInclusive: null,
      confidence: tier.tier === "TIER_1_OEM" ? 85 : tier.tier === "TIER_2_DEALER" ? 65 : tier.tier === "TIER_3_MARKETPLACE" ? 45 : 25,
    });
  }

  const hasOnlyLowQuality = products.length > 0 && products.every((p) => p.evidenceType === "PRICE_PLAUSIBILITY");
  const hasConflicts = (parsedFact.contradictions?.length ?? 0) > 0;

  return {
    products, prices,
    hasConflicts, hasOnlyLowQuality,
    diagnostic: `parsed hypothesis=${parsedFact.hypothesis} conf=${parsedFact.hypothesisConfidence} sources=${citedSources.length} tiers=[${citedSources.map((s) => s.tier.tier).join(",")}]`,
  };
}

function tierOrder(t: ReturnType<typeof classifySourceTier>["tier"]): number {
  switch (t) {
    case "TIER_1_OEM": return 1;
    case "TIER_2_DEALER": return 2;
    case "TIER_3_MARKETPLACE": return 3;
    case "TIER_4_DISCOVERY": return 4;
  }
}

function mapEvidenceType(t: ReturnType<typeof classifySourceTier>["tier"]): ProductReferenceEvidence["evidenceType"] {
  switch (t) {
    case "TIER_1_OEM": return "OEM_PRODUCT_MATCH";
    case "TIER_2_DEALER": return "AUTHORIZED_DEALER_MATCH";
    case "TIER_3_MARKETPLACE": return "MARKET_COMPARABLE";
    case "TIER_4_DISCOVERY": return "OEM_SPECIFICATION";
  }
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}
